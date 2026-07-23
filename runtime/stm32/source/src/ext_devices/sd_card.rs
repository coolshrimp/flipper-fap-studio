// SPDX-License-Identifier: GPL-3.0-or-later

use std::{
    cell::Cell,
    collections::VecDeque,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    rc::Rc,
};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::{
    peripherals::gpio::{GpioPorts, Pin},
    system::System,
};

use super::ExtDevice;

const BLOCK_SIZE: usize = 512;
const DATA_TOKEN: u8 = 0xfe;

#[derive(Debug, Deserialize)]
pub struct SdCardConfig {
    pub peripheral: String,
    pub file: String,
    pub chip_select: String,
    pub card_detect: String,
}

struct PendingWrite {
    sector: u32,
    started: bool,
    data: Vec<u8>,
    crc_remaining: u8,
}

pub struct SdCard {
    pub config: SdCardConfig,
    name: String,
    image: File,
    sector_count: u32,
    selected: Rc<Cell<bool>>,
    select_epoch: Rc<Cell<u64>>,
    observed_select_epoch: u64,
    command: Vec<u8>,
    reply: VecDeque<u8>,
    pending_write: Option<PendingWrite>,
    idle: bool,
    app_command: bool,
}

impl SdCard {
    pub fn new(config: SdCardConfig, gpio: &mut GpioPorts) -> Result<Self> {
        let image = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&config.file)
            .with_context(|| format!("Failed to open SD-card image {}", config.file))?;
        let image_len = image
            .metadata()
            .with_context(|| format!("Failed to inspect SD-card image {}", config.file))?
            .len();
        if image_len < BLOCK_SIZE as u64 || image_len % BLOCK_SIZE as u64 != 0 {
            bail!(
                "SD-card image {} must contain a whole number of 512-byte sectors",
                config.file
            );
        }
        let sector_count =
            u32::try_from(image_len / BLOCK_SIZE as u64).context("SD-card image is too large")?;

        let selected = Rc::new(Cell::new(false));
        let select_epoch = Rc::new(Cell::new(0u64));
        let selected_for_gpio = selected.clone();
        let epoch_for_gpio = select_epoch.clone();
        gpio.add_write_callback(Pin::from_str(&config.chip_select), move |_sys, value| {
            selected_for_gpio.set(!value);
            epoch_for_gpio.set(epoch_for_gpio.get().wrapping_add(1));
            debug!("SD-card chip-select {}", if value { "high" } else { "low" });
        });

        // Flipper's socket switch pulls PC10 low when a card is inserted.
        gpio.add_read_callback(Pin::from_str(&config.card_detect), |_sys| false);

        Ok(Self {
            config,
            name: String::new(),
            image,
            sector_count,
            selected,
            select_epoch,
            observed_select_epoch: 0,
            command: Vec::with_capacity(6),
            reply: VecDeque::new(),
            pending_write: None,
            idle: true,
            app_command: false,
        })
    }

    fn synchronize_chip_select(&mut self) {
        let epoch = self.select_epoch.get();
        if epoch != self.observed_select_epoch {
            self.observed_select_epoch = epoch;
            self.command.clear();
            self.reply.clear();
            self.pending_write = None;
        }
    }

    fn read_bus_byte(&mut self) -> u8 {
        self.synchronize_chip_select();
        if !self.selected.get() {
            return 0xff;
        }
        self.reply.pop_front().unwrap_or(0xff)
    }

    fn write_bus_byte(&mut self, value: u8) {
        self.synchronize_chip_select();
        if !self.selected.get() {
            return;
        }

        if self.pending_write.is_some() {
            self.accept_write_data(value);
            return;
        }

        if self.command.is_empty() {
            if value & 0xc0 == 0x40 {
                self.command.push(value);
            }
            return;
        }

        self.command.push(value);
        if self.command.len() == 6 {
            let packet = std::mem::take(&mut self.command);
            self.process_command(&packet);
        }
    }

    fn r1(&self) -> u8 {
        if self.idle {
            0x01
        } else {
            0x00
        }
    }

    fn queue_register(&mut self, r1: u8, register: &[u8; 16]) {
        self.reply.push_back(r1);
        self.reply.push_back(0xff);
        self.reply.push_back(DATA_TOKEN);
        self.reply.extend(register);
        // Flipper currently ignores data CRC in SPI mode.
        self.reply.extend([0xff, 0xff]);
    }

    fn process_command(&mut self, packet: &[u8]) {
        let command = packet[0] & 0x3f;
        let argument = u32::from_be_bytes([packet[1], packet[2], packet[3], packet[4]]);
        let was_app_command = self.app_command;
        self.app_command = false;
        debug!(
            "{} CMD{} argument=0x{:08x} idle={}",
            self.name, command, argument, self.idle
        );

        match command {
            // GO_IDLE_STATE
            0 => {
                self.idle = true;
                self.reply.push_back(0x01);
            }
            // SEND_OP_COND (legacy initialization fallback)
            1 => {
                self.idle = false;
                self.reply.push_back(0x00);
            }
            // SEND_IF_COND
            8 => self.reply.extend([self.r1(), 0x00, 0x00, 0x01, 0xaa]),
            // SEND_CSD
            9 => {
                let csd = self.csd();
                self.queue_register(self.r1(), &csd);
            }
            // SEND_CID
            10 => {
                let cid = self.cid();
                self.queue_register(self.r1(), &cid);
            }
            // SEND_STATUS (R2)
            13 => self.reply.extend([self.r1(), 0x00]),
            // SET_BLOCKLEN: the backing store always exposes 512-byte blocks.
            16 => {
                self.reply.push_back(if argument == BLOCK_SIZE as u32 {
                    self.r1()
                } else {
                    0x40
                });
            }
            // READ_SINGLE_BLOCK
            17 => {
                if self.idle {
                    self.reply.push_back(0x01);
                } else if let Some(data) = self.read_sector(argument) {
                    self.reply.push_back(0x00);
                    self.reply.push_back(0xff);
                    self.reply.push_back(DATA_TOKEN);
                    self.reply.extend(data);
                    self.reply.extend([0xff, 0xff]);
                } else {
                    self.reply.push_back(0x20);
                }
            }
            // WRITE_SINGLE_BLOCK
            24 => {
                if self.idle || argument >= self.sector_count {
                    self.reply.push_back(if self.idle { 0x01 } else { 0x20 });
                } else {
                    self.reply.push_back(0x00);
                    self.pending_write = Some(PendingWrite {
                        sector: argument,
                        started: false,
                        data: Vec::with_capacity(BLOCK_SIZE),
                        crc_remaining: 2,
                    });
                }
            }
            // APP_CMD
            55 => {
                self.app_command = true;
                self.reply.push_back(self.r1());
            }
            // SD_SEND_OP_COND (ACMD41)
            41 if was_app_command => {
                self.idle = false;
                self.reply.push_back(0x00);
            }
            // READ_OCR. CCS=1 tells the firmware command arguments are sectors.
            58 => self.reply.extend([self.r1(), 0x40, 0xff, 0x80, 0x00]),
            _ => self.reply.push_back(self.r1() | 0x04),
        }
    }

    fn accept_write_data(&mut self, value: u8) {
        let mut completed = None;
        if let Some(pending) = self.pending_write.as_mut() {
            if !pending.started {
                if value == DATA_TOKEN {
                    pending.started = true;
                }
                return;
            }

            if pending.data.len() < BLOCK_SIZE {
                pending.data.push(value);
                return;
            }

            if pending.crc_remaining > 0 {
                pending.crc_remaining -= 1;
                if pending.crc_remaining == 0 {
                    completed = Some((pending.sector, std::mem::take(&mut pending.data)));
                }
            }
        }

        if let Some((sector, data)) = completed {
            self.pending_write = None;
            if self.write_sector(sector, &data) {
                // "Data accepted". A real card remains busy for a short time;
                // returning ready immediately is deterministic and valid.
                self.reply.push_back(0x05);
            } else {
                self.reply.push_back(0x0d);
            }
        }
    }

    fn read_sector(&mut self, sector: u32) -> Option<Vec<u8>> {
        if sector >= self.sector_count {
            return None;
        }
        let mut data = vec![0u8; BLOCK_SIZE];
        let offset = sector as u64 * BLOCK_SIZE as u64;
        if self.image.seek(SeekFrom::Start(offset)).is_err()
            || self.image.read_exact(&mut data).is_err()
        {
            warn!("{} failed to read sector {}", self.name, sector);
            None
        } else {
            Some(data)
        }
    }

    fn write_sector(&mut self, sector: u32, data: &[u8]) -> bool {
        if sector >= self.sector_count || data.len() != BLOCK_SIZE {
            return false;
        }
        let offset = sector as u64 * BLOCK_SIZE as u64;
        if self.image.seek(SeekFrom::Start(offset)).is_err()
            || self.image.write_all(data).is_err()
            || self.image.flush().is_err()
        {
            warn!("{} failed to write sector {}", self.name, sector);
            false
        } else {
            true
        }
    }

    fn csd(&self) -> [u8; 16] {
        // CSD v2 capacity is encoded in 512-KiB units. The virtual image may
        // be smaller than a physical SDHC card, which the firmware tolerates.
        let units = (u64::from(self.sector_count) + 1023) / 1024;
        let c_size = units.saturating_sub(1).min(0x3f_ffff) as u32;
        [
            0x40,
            0x0e,
            0x00,
            0x32,
            0x5b,
            0x59,
            0x00,
            (c_size >> 16) as u8 & 0x3f,
            (c_size >> 8) as u8,
            c_size as u8,
            0x7f,
            0x80,
            0x0a,
            0x40,
            0x00,
            0xff,
        ]
    }

    fn cid(&self) -> [u8; 16] {
        // Deterministic simulator identity: manufacturer 0x7f, "SIMSD".
        [
            0x7f, b'S', b'I', b'M', b'S', b'D', 0x10, 0x00, 0x00, 0x00, 0x01, 0x01, 0x26, 0x70,
            0x00, 0xff,
        ]
    }

    #[cfg(test)]
    fn clock_for_test(&mut self, value: u8) -> u8 {
        let response = self.read_bus_byte();
        self.write_bus_byte(value);
        response
    }
}

impl ExtDevice<(), u8> for SdCard {
    fn connect_peripheral(&mut self, peripheral: &str) -> String {
        self.name = format!("{} SD-card", peripheral);
        info!(
            "{} image={} sectors={}",
            self.name, self.config.file, self.sector_count
        );
        self.name.clone()
    }

    fn read(&mut self, _sys: &System, _addr: ()) -> u8 {
        self.read_bus_byte()
    }

    fn write(&mut self, _sys: &System, _addr: (), value: u8) {
        self.write_bus_byte(value);
    }

    fn is_selected(&self) -> bool {
        self.selected.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn image_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "stm32-emulator-sd-{}-{}.img",
            std::process::id(),
            nonce
        ))
    }

    fn command(card: &mut SdCard, command: u8, argument: u32, crc: u8) -> Vec<u8> {
        let arg = argument.to_be_bytes();
        for value in [0x40 | command, arg[0], arg[1], arg[2], arg[3], crc] {
            assert_eq!(card.clock_for_test(value), 0xff);
        }
        let mut response = Vec::new();
        for _ in 0..8 {
            let value = card.clock_for_test(0xff);
            if value != 0xff || !response.is_empty() {
                response.push(value);
                break;
            }
        }
        response
    }

    fn initialize(card: &mut SdCard) {
        assert_eq!(command(card, 0, 0, 0x95), [0x01]);
        let arg = 0x1aa_u32.to_be_bytes();
        for value in [0x48, arg[0], arg[1], arg[2], arg[3], 0x87] {
            card.clock_for_test(value);
        }
        assert_eq!(
            (0..5)
                .map(|_| card.clock_for_test(0xff))
                .collect::<Vec<_>>(),
            [0x01, 0x00, 0x00, 0x01, 0xaa]
        );
        assert_eq!(command(card, 55, 0, 0xff), [0x01]);
        assert_eq!(command(card, 41, 0x4000_0000, 0xff), [0x00]);
        let arg = 0_u32.to_be_bytes();
        for value in [0x7a, arg[0], arg[1], arg[2], arg[3], 0xff] {
            card.clock_for_test(value);
        }
        assert_eq!(
            (0..5)
                .map(|_| card.clock_for_test(0xff))
                .collect::<Vec<_>>(),
            [0x00, 0x40, 0xff, 0x80, 0x00]
        );
    }

    #[test]
    fn initializes_and_persists_single_block_reads_and_writes() {
        let path = image_path();
        let mut image = vec![0u8; BLOCK_SIZE * 4];
        for (index, byte) in image[BLOCK_SIZE..BLOCK_SIZE * 2].iter_mut().enumerate() {
            *byte = index as u8;
        }
        fs::write(&path, &image).unwrap();

        let config = SdCardConfig {
            peripheral: "SPI2".into(),
            file: path.to_string_lossy().into_owned(),
            chip_select: "PC12".into(),
            card_detect: "PC10".into(),
        };
        let mut gpio = GpioPorts::default();
        let mut card = SdCard::new(config, &mut gpio).unwrap();
        card.selected.set(true);
        initialize(&mut card);

        assert_eq!(command(&mut card, 17, 1, 0xff), [0x00]);
        assert_eq!(card.clock_for_test(0xff), 0xff);
        assert_eq!(card.clock_for_test(0xff), DATA_TOKEN);
        let read_back = (0..BLOCK_SIZE)
            .map(|_| card.clock_for_test(0xff))
            .collect::<Vec<_>>();
        assert_eq!(read_back, image[BLOCK_SIZE..BLOCK_SIZE * 2]);
        assert_eq!(card.clock_for_test(0xff), 0xff);
        assert_eq!(card.clock_for_test(0xff), 0xff);

        let replacement = (0..BLOCK_SIZE)
            .map(|index| 255u8.wrapping_sub(index as u8))
            .collect::<Vec<_>>();
        assert_eq!(command(&mut card, 24, 2, 0xff), [0x00]);
        card.clock_for_test(0xff);
        card.clock_for_test(0xff);
        card.clock_for_test(DATA_TOKEN);
        for &byte in &replacement {
            card.clock_for_test(byte);
        }
        card.clock_for_test(0xff);
        card.clock_for_test(0xff);
        assert_eq!(card.clock_for_test(0xff), 0x05);

        drop(card);
        let stored = fs::read(&path).unwrap();
        assert_eq!(
            &stored[BLOCK_SIZE * 2..BLOCK_SIZE * 3],
            replacement.as_slice()
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn reports_csd_and_cid_registers() {
        let path = image_path();
        fs::write(&path, vec![0u8; BLOCK_SIZE * 2048]).unwrap();
        let config = SdCardConfig {
            peripheral: "SPI2".into(),
            file: path.to_string_lossy().into_owned(),
            chip_select: "PC12".into(),
            card_detect: "PC10".into(),
        };
        let mut gpio = GpioPorts::default();
        let mut card = SdCard::new(config, &mut gpio).unwrap();
        card.selected.set(true);
        initialize(&mut card);

        for command_number in [9, 10] {
            assert_eq!(command(&mut card, command_number, 0, 0xff), [0x00]);
            assert_eq!(card.clock_for_test(0xff), 0xff);
            assert_eq!(card.clock_for_test(0xff), DATA_TOKEN);
            let register = (0..16)
                .map(|_| card.clock_for_test(0xff))
                .collect::<Vec<_>>();
            assert_eq!(register.len(), 16);
            assert_ne!(register, vec![0u8; 16]);
            card.clock_for_test(0xff);
            card.clock_for_test(0xff);
        }

        drop(card);
        fs::remove_file(path).unwrap();
    }
}
