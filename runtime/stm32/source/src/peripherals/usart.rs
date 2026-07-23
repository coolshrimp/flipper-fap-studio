// SPDX-License-Identifier: GPL-3.0-or-later

use std::cell::RefCell;
use std::rc::Rc;

use super::Peripheral;
use crate::ext_devices::{ExtDevice, ExtDevices};
use crate::system::System;

#[derive(Default)]
pub struct Usart {
    pub name: String,
    pub modern_layout: bool,
    pub cr1: u32,
    pub ext_device: Option<Rc<RefCell<dyn ExtDevice<(), u8>>>>,
}

impl Usart {
    pub fn new(name: &str, ext_devices: &ExtDevices) -> Option<Box<dyn Peripheral>> {
        if name.starts_with("USART") || name.starts_with("LPUART") {
            let ext_device = ext_devices.find_serial_device(&name);
            // The bundled engine targets STM32WB55, whose USART1 and LPUART1
            // both use the CR1/ISR/RDR/TDR register layout.
            let modern_layout = true;
            let name = ext_device
                .as_ref()
                .map(|d| d.borrow_mut().connect_peripheral(name))
                .unwrap_or_else(|| name.to_string());
            Some(Box::new(Self {
                name,
                modern_layout,
                ext_device,
                ..Default::default()
            }))
        } else {
            None
        }
    }
}

impl Peripheral for Usart {
    fn read(&mut self, sys: &System, offset: u32) -> u32 {
        if self.modern_layout {
            return match offset {
                0x0000 => self.cr1,
                0x001C => {
                    // STM32WB ISR. Transmission is immediately complete in
                    // the desktop model; acknowledge enabled transmitter and
                    // receiver state so the HAL can finish initialization.
                    (1 << 7) | (1 << 6) | (1 << 21) | (1 << 22)
                }
                0x0024 => {
                    let value = self
                        .ext_device
                        .as_ref()
                        .map(|device| device.borrow_mut().read(sys, ()))
                        .unwrap_or_default() as u32;
                    trace!("{} read={:02x}", self.name, value);
                    value
                }
                _ => 0,
            };
        }
        match offset {
            0x0000 => {
                // SR register
                // Bit 7 TXE: Transmit data register empty
                // Bit 6 TC: Transmission complete
                // Bit 5 RXNE: Read data register not empty
                // Bit 4 IDLE: IDLE line detected
                // We could do something smarter to indicate that there's data to read
                (1 << 7) | (1 << 6) | (1 << 5) | (1 << 4)
            }
            0x0004 => {
                // DR register
                let v = self
                    .ext_device
                    .as_ref()
                    .map(|d| d.borrow_mut().read(sys, ()))
                    .unwrap_or_default() as u32;

                trace!("{} read={:02x}", self.name, v);
                v
            }
            _ => 0,
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        if self.modern_layout {
            match offset {
                0x0000 => self.cr1 = value,
                0x0028 => {
                    if let Some(device) = &self.ext_device {
                        device.borrow_mut().write(sys, (), value as u8);
                    }
                    trace!("{} write={:02x}", self.name, value as u8);
                }
                _ => {}
            }
            return;
        }
        match offset {
            0x0004 => {
                // DR register
                self.ext_device
                    .as_ref()
                    .map(|d| d.borrow_mut().write(sys, (), value as u8));

                trace!("{} write={:02x}", self.name, value as u8);
            }
            _ => {}
        }
    }
}
