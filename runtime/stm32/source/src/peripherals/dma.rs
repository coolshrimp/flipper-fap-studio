// SPDX-License-Identifier: GPL-3.0-or-later

use super::Peripheral;
use super::Peripherals;
use crate::system::System;
use crate::util::UniErr;
use svd_parser::svd::RegisterInfo;

pub struct Dma {
    name: String,
    layout: DmaLayout,
    streams: [Stream; 8],
    channels: [Channel; 7],
    channel_isr: u32,
}

impl Dma {
    pub fn new(name: &str, registers: &[RegisterInfo]) -> Option<Box<dyn Peripheral>> {
        if name == "DMA1" || name == "DMA2" {
            let name = name.to_string();
            let layout = if registers.iter().any(|register| register.name == "CCR1") {
                DmaLayout::Channels
            } else {
                DmaLayout::Streams
            };
            Some(Box::new(Self {
                name,
                layout,
                streams: Default::default(),
                channels: Default::default(),
                channel_isr: 0,
            }))
        } else {
            None
        }
    }

    fn channel_irq(&self, channel: usize) -> i32 {
        if self.name == "DMA2" {
            55 + channel as i32
        } else {
            11 + channel as i32
        }
    }

    fn read_channel(&mut self, offset: u32) -> u32 {
        match ChannelAccess::from_offset(offset) {
            ChannelAccess::Status => self.channel_isr,
            ChannelAccess::Clear => 0,
            ChannelAccess::Register(channel, register) => self.channels[channel].read(register),
            ChannelAccess::Unknown => 0,
        }
    }

    fn write_channel(&mut self, sys: &System, offset: u32, value: u32) {
        match ChannelAccess::from_offset(offset) {
            ChannelAccess::Status | ChannelAccess::Unknown => {}
            ChannelAccess::Clear => self.channel_isr &= !value,
            ChannelAccess::Register(channel, register) => {
                if register != ChannelRegister::Ccr {
                    self.channels[channel].write(register, value);
                    return;
                }

                let enabling = value & 1 != 0;
                self.channels[channel].ccr = value;
                if enabling {
                    self.channels[channel].do_xfer(&self.name, sys);
                    self.channels[channel].ccr &= !1;
                    self.channels[channel].cndtr = 0;
                    let shift = channel * 4;
                    self.channel_isr |= (1 << shift) | (1 << (shift + 1));
                    if value & (1 << 1) != 0 {
                        sys.p
                            .nvic
                            .borrow_mut()
                            .set_intr_pending(self.channel_irq(channel));
                    }
                }
            }
        }
    }
}

impl Peripheral for Dma {
    fn read(&mut self, sys: &System, offset: u32) -> u32 {
        match self.layout {
            DmaLayout::Channels => self.read_channel(offset),
            DmaLayout::Streams => match Access::from_offset(offset) {
                Access::StreamReg(i, offset) => self.streams[i].read(&self.name, sys, offset),
                _ => 0,
            },
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        match self.layout {
            DmaLayout::Channels => self.write_channel(sys, offset, value),
            DmaLayout::Streams => match Access::from_offset(offset) {
                Access::StreamReg(i, offset) => {
                    self.streams[i].write(&self.name, sys, offset, value)
                }
                _ => {}
            },
        }
    }
}

enum DmaLayout {
    Streams,
    Channels,
}

fn expand_memory_source(buffer: Vec<u8>, size: usize, increment: bool) -> Vec<u8> {
    if increment {
        buffer
    } else {
        buffer.into_iter().cycle().take(size).collect()
    }
}

#[derive(Default)]
struct Channel {
    ccr: u32,
    cndtr: u32,
    cpar: u32,
    cmar: u32,
}

impl Channel {
    fn read(&self, register: ChannelRegister) -> u32 {
        match register {
            ChannelRegister::Ccr => self.ccr,
            ChannelRegister::Cndtr => self.cndtr,
            ChannelRegister::Cpar => self.cpar,
            ChannelRegister::Cmar => self.cmar,
        }
    }

    fn write(&mut self, register: ChannelRegister, value: u32) {
        match register {
            ChannelRegister::Ccr => self.ccr = value,
            ChannelRegister::Cndtr => self.cndtr = value & 0xffff,
            ChannelRegister::Cpar => self.cpar = value,
            ChannelRegister::Cmar => self.cmar = value,
        }
    }

    fn memory_word_size(&self) -> usize {
        match (self.ccr >> 10) & 0b11 {
            0b00 => 1,
            0b01 => 2,
            0b10 => 4,
            _ => 1,
        }
    }

    fn do_xfer(&self, name: &str, sys: &System) {
        let memory_to_peripheral = self.ccr & (1 << 4) != 0;
        let memory_increment = self.ccr & (1 << 7) != 0;
        let word_size = self.memory_word_size();
        let size = self.memory_word_size() * self.cndtr as usize;
        if size == 0 {
            return;
        }
        let Some(peripheral) = Peripherals::get_peripheral(&sys.p.peripherals, self.cpar) else {
            warn!(
                "{} channel transfer references unknown peripheral address 0x{:08x}",
                name, self.cpar
            );
            return;
        };
        let peripheral_offset = self.cpar - peripheral.start;

        debug!(
            "{} channel xfer peripheral={} direction={} memory=0x{:08x} size={}",
            name,
            sys.p.addr_desc(self.cpar),
            if memory_to_peripheral {
                "write"
            } else {
                "read"
            },
            self.cmar,
            size
        );

        if memory_to_peripheral {
            let read_size = if memory_increment { size } else { word_size };
            match sys.uc.borrow().mem_read_as_vec(self.cmar.into(), read_size) {
                Ok(buffer) => {
                    let transfer = expand_memory_source(buffer, size, memory_increment);
                    peripheral.peripheral.borrow_mut().write_dma(
                        sys,
                        peripheral_offset,
                        transfer.into(),
                    )
                }
                Err(error) => warn!(
                    "{} DMA memory read failed addr=0x{:08x} size={} error={}",
                    name,
                    self.cmar,
                    size,
                    UniErr(error)
                ),
            }
        } else {
            let mut buffer =
                peripheral
                    .peripheral
                    .borrow_mut()
                    .read_dma(sys, peripheral_offset, size);
            let memory_result = if memory_increment {
                sys.uc
                    .borrow_mut()
                    .mem_write(self.cmar.into(), buffer.make_contiguous())
            } else {
                let last_word_start = buffer.len().saturating_sub(word_size);
                let last_word = buffer
                    .make_contiguous()
                    .get(last_word_start..)
                    .unwrap_or_default();
                sys.uc.borrow_mut().mem_write(self.cmar.into(), last_word)
            };
            if let Err(error) = memory_result {
                warn!(
                    "{} DMA memory write failed addr=0x{:08x} size={} error={}",
                    name,
                    self.cmar,
                    size,
                    UniErr(error)
                );
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChannelRegister {
    Ccr,
    Cndtr,
    Cpar,
    Cmar,
}

enum ChannelAccess {
    Status,
    Clear,
    Register(usize, ChannelRegister),
    Unknown,
}

impl ChannelAccess {
    fn from_offset(offset: u32) -> Self {
        match offset {
            0x00 => return Self::Status,
            0x04 => return Self::Clear,
            _ => {}
        }
        if offset < 0x08 {
            return Self::Unknown;
        }
        let relative = offset - 0x08;
        let channel = (relative / 0x14) as usize;
        if channel >= 7 {
            return Self::Unknown;
        }
        let register = match relative % 0x14 {
            0x00 => ChannelRegister::Ccr,
            0x04 => ChannelRegister::Cndtr,
            0x08 => ChannelRegister::Cpar,
            0x0c => ChannelRegister::Cmar,
            _ => return Self::Unknown,
        };
        Self::Register(channel, register)
    }
}

#[derive(Default)]
struct Stream {
    pub cr: u32,
    pub next_cr: Option<u32>,
    pub ndtr: u32,
    pub par: u32,
    pub m0ar: u32,
    pub m1ar: u32,
    pub fcr: u32,
}

impl Stream {
    fn channel(&self) -> u8 {
        ((self.cr >> 25) & 0b111) as u8
    }

    fn dir(&self) -> Dir {
        match (self.cr >> 6) & 0b11 {
            0b00 => Dir::Read,
            0b01 => Dir::Write,
            0b10 => Dir::MemCopy,
            _ => Dir::Invalid,
        }
    }

    // 1, 2, 4 (8bit, 16bit, 32bit)
    fn word_size(&self) -> usize {
        match (self.cr >> 11) & 0b11 {
            0b00 => 1,
            0b01 => 2,
            0b10 => 4,
            _ => 1,
        }
    }

    fn data_size(&self) -> usize {
        self.word_size() * self.ndtr as usize
    }

    fn data_addr(&self) -> u32 {
        if (self.cr >> 19) & 1 != 0 {
            self.m1ar
        } else {
            self.m0ar
        }
    }

    fn do_xfer(&self, name: &str, sys: &System) {
        let dir = self.dir();
        let data_addr = self.data_addr();
        let size = self.data_size();
        let peri_addr = self.par;

        let peri = Peripherals::get_peripheral(&sys.p.peripherals, peri_addr);

        let (src, dst) = match dir {
            Dir::Read => (peri_addr, data_addr),
            Dir::Write => (data_addr, peri_addr),
            Dir::MemCopy => (peri_addr, data_addr),
            Dir::Invalid => (0, 0),
        };

        if log::log_enabled!(log::Level::Debug) {
            let peri_desc = sys.p.addr_desc(peri_addr);
            debug!(
                "{} xfer initiated channel={} peri_{} dir={:?} addr=0x{:08x} size={}",
                name,
                self.channel(),
                peri_desc,
                dir,
                data_addr,
                size
            );
        }

        let buf = match dir {
            Dir::Read => peri.map(|p| {
                p.peripheral
                    .borrow_mut()
                    .read_dma(sys, peri_addr - p.start, size)
            }),
            Dir::Write | Dir::MemCopy => sys
                .uc
                .borrow()
                .mem_read_as_vec(src.into(), size)
                .map_err(|e| {
                    warn!(
                        "DMA read failed addr=0x{:08x} size={} e={}",
                        src,
                        size,
                        UniErr(e)
                    )
                })
                .map(|v| v.into())
                .ok(),
            Dir::Invalid => Some(vec![].into()),
        };

        let mut buf = buf.unwrap_or_else(|| {
            let mut rx = vec![];
            rx.resize(size, 0);
            rx.into()
        });

        trace!("{} xfer buf={:x?}", name, buf);

        match dir {
            Dir::Write => {
                peri.map(|p| {
                    p.peripheral
                        .borrow_mut()
                        .write_dma(sys, peri_addr - p.start, buf)
                });
            }
            Dir::Read | Dir::MemCopy => {
                if let Err(e) = sys
                    .uc
                    .borrow_mut()
                    .mem_write(dst.into(), buf.make_contiguous())
                {
                    warn!(
                        "DMA read failed addr=0x{:08x} size={} e={}",
                        dst,
                        size,
                        UniErr(e)
                    );
                }
            }
            Dir::Invalid => {}
        }
    }

    pub fn read(&mut self, _name: &str, _sys: &System, offset: u32) -> u32 {
        match offset {
            0x0000 => {
                let v = self.cr;
                if let Some(next_cr) = self.next_cr.take() {
                    self.cr = next_cr;
                }

                // The saturn firmware is a bit buggy. When doing a DMA write
                // with size=0, they don't enable the DMA channel, but they
                // wait for it to go to 1 and then 0, with a timeout. So they
                // are consistently hitting the timeout.
                // We'll do toggles on the ready flag to speed things up avoiding the timeout.
                if self.dir() == Dir::Write && self.data_size() == 0 {
                    self.next_cr = Some(self.cr ^ 1)
                }

                v
            }
            0x0004 => self.ndtr,
            0x0008 => self.par,
            0x000c => self.m0ar,
            0x0010 => self.m1ar,
            0x0014 => self.fcr,
            _ => 0,
        }
    }

    pub fn write(&mut self, name: &str, sys: &System, offset: u32, mut value: u32) {
        match offset {
            0x0000 => {
                self.cr = value;

                // CRx register
                if value & 1 != 0 {
                    // Enable is on. do the transfer.
                    self.do_xfer(name, sys);

                    value &= !1;
                    self.ndtr = 0;
                    self.next_cr = Some(value);
                }
            }
            0x0004 => {
                self.ndtr = value & 0xFFFF;
            }
            0x0008 => {
                self.par = value;
            }
            0x000c => {
                self.m0ar = value;
            }
            0x0010 => {
                self.m1ar = value;
            }
            0x0014 => {
                self.fcr = value;
            }
            _ => {}
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Dir {
    Read,
    Write,
    MemCopy,
    Invalid,
}

enum Access {
    Reg(u32),
    /// CR0, CR1, etc.
    StreamReg(usize, u32),
}

impl Access {
    pub fn from_offset(offset: u32) -> Self {
        if offset < 0x28 {
            Access::Reg(offset)
        } else {
            let stride = 0x18;
            let start = 0x10;

            let offset = offset - start;
            Access::StreamReg((offset / stride) as usize, offset % stride)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{expand_memory_source, ChannelAccess, ChannelRegister};

    #[test]
    fn decodes_stm32wb_dma_channel_register_layout() {
        assert!(matches!(
            ChannelAccess::from_offset(0x00),
            ChannelAccess::Status
        ));
        assert!(matches!(
            ChannelAccess::from_offset(0x04),
            ChannelAccess::Clear
        ));
        assert!(matches!(
            ChannelAccess::from_offset(0x08),
            ChannelAccess::Register(0, ChannelRegister::Ccr)
        ));
        assert!(matches!(
            ChannelAccess::from_offset(0x80),
            ChannelAccess::Register(6, ChannelRegister::Ccr)
        ));
        assert!(matches!(
            ChannelAccess::from_offset(0x84),
            ChannelAccess::Register(6, ChannelRegister::Cndtr)
        ));
        assert!(matches!(
            ChannelAccess::from_offset(0x88),
            ChannelAccess::Register(6, ChannelRegister::Cpar)
        ));
        assert!(matches!(
            ChannelAccess::from_offset(0x8c),
            ChannelAccess::Register(6, ChannelRegister::Cmar)
        ));
    }

    #[test]
    fn repeats_non_incrementing_dma_memory_source() {
        assert_eq!(expand_memory_source(vec![0xff], 8, false), vec![0xff; 8]);
        assert_eq!(
            expand_memory_source(vec![1, 2, 3, 4], 8, false),
            vec![1, 2, 3, 4, 1, 2, 3, 4]
        );
        assert_eq!(
            expand_memory_source(vec![1, 2, 3, 4], 4, true),
            vec![1, 2, 3, 4]
        );
    }
}
