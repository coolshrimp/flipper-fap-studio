// SPDX-License-Identifier: GPL-3.0-or-later

use super::Peripheral;
use crate::{ext_devices::ExtDevice, system::System};

use crate::ext_devices::ExtDevices;

use std::{cell::RefCell, collections::VecDeque, rc::Rc};

#[derive(Default)]
pub struct Spi {
    pub name: String,
    pub cr1: u32,
    pub rx_buffer: u32,
    pub ext_devices: Vec<Rc<RefCell<dyn ExtDevice<(), u8>>>>,
}

impl Spi {
    pub fn new(name: &str, ext_devices: &ExtDevices) -> Option<Box<dyn Peripheral>> {
        if name.starts_with("SPI") {
            let devices = ext_devices.find_spi_devices(name);
            let connected = devices
                .iter()
                .map(|device| device.borrow_mut().connect_peripheral(name))
                .collect::<Vec<_>>();
            let display_name = if connected.is_empty() {
                name.to_string()
            } else {
                connected.join(", ")
            };
            Some(Box::new(Self {
                name: display_name,
                ext_devices: devices,
                ..Default::default()
            }))
        } else {
            None
        }
    }

    pub fn is_16bits(&self) -> bool {
        self.cr1 & (1 << 11) != 0
    }

    fn transfer_byte(&mut self, sys: &System, value: u8) -> u8 {
        let selected = self
            .ext_devices
            .iter()
            .filter(|device| device.borrow().is_selected())
            .cloned()
            .collect::<Vec<_>>();

        // MISO floats high on an idle SPI bus. Preserve the former display
        // behavior (zero) while it is selected, but let an SD card supply the
        // byte when its own chip-select is active.
        let response = selected
            .first()
            .map(|device| device.borrow_mut().read(sys, ()))
            .unwrap_or(0xff);
        for device in selected {
            device.borrow_mut().write(sys, (), value);
        }
        response
    }
}

impl Peripheral for Spi {
    fn read(&mut self, _sys: &System, offset: u32) -> u32 {
        match offset {
            0x0000 => self.cr1,
            0x0008 => {
                // SR register
                // RXNE and TXE. Transfers complete synchronously in this
                // model, so both flags remain ready after every data write.
                // Alternating the flags deadlocks firmware that checks TXE
                // and RXNE in separate reads of the same polling loop.
                0b11
            }
            0x000C => {
                // DR register
                let v = self.rx_buffer;
                if self.is_16bits() {
                    trace!("{} read={:04x?}", self.name, v as u16);
                } else {
                    trace!("{} read={:02x?}", self.name, v as u8);
                }

                v
            }
            _ => 0,
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        match offset {
            0x0000 => {
                // CR1 register
                self.cr1 = value;
            }
            0x000C => {
                // DR register

                if self.is_16bits() {
                    let h = self.transfer_byte(sys, (value >> 8) as u8) as u32;
                    let l = self.transfer_byte(sys, value as u8) as u32;
                    self.rx_buffer = (h << 8) | l;

                    trace!("{} write={:04x?}", self.name, value as u16);
                } else {
                    let v = value as u8;
                    self.rx_buffer = self.transfer_byte(sys, v) as u32;
                    trace!("{} write={:02x?}", self.name, v);
                }
            }
            _ => {}
        }
    }

    fn read_dma(&mut self, sys: &System, offset: u32, size: usize) -> VecDeque<u8> {
        if offset != 0x000c {
            return (0..size).map(|_| self.read(sys, offset) as u8).collect();
        }

        // STM32 master-receive mode generates dummy clocks while DMA drains
        // the data register. Model the whole byte exchange so an SD card can
        // advance through its data token, payload, and CRC stream.
        (0..size).map(|_| self.transfer_byte(sys, 0xff)).collect()
    }

    fn write_dma(&mut self, sys: &System, offset: u32, value: VecDeque<u8>) {
        if offset != 0x000c {
            for byte in value {
                self.write(sys, offset, byte.into());
            }
            return;
        }

        for byte in value {
            self.rx_buffer = self.transfer_byte(sys, byte) as u32;
        }
    }
}
