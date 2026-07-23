// SPDX-License-Identifier: GPL-3.0-or-later

use super::Peripheral;
use crate::system::System;
use std::collections::HashMap;

pub struct Rcc {
    registers: HashMap<u32, u32>,
}

impl Rcc {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        if name == "RCC" {
            // Flipper's early HAL deliberately verifies that peripheral buses
            // begin disabled and held in reset. The original emulator returned
            // zero for every RCC register and ignored writes, which causes that
            // safety check to crash before the OS starts.
            let mut registers = HashMap::new();
            for offset in [0x28, 0x2c, 0x30, 0x38, 0x3c, 0x40] {
                registers.insert(offset, u32::MAX);
            }
            registers.insert(0x00, 0x0000_0001);
            Some(Box::new(Rcc { registers }))
        } else {
            None
        }
    }
}

impl Peripheral for Rcc {
    fn read(&mut self, _sys: &System, offset: u32) -> u32 {
        match offset {
            0x0000 => {
                // CR oscillator ready flags follow their enable bits.
                let value = self.registers.get(&offset).copied().unwrap_or(0);
                let mut ready = 0;
                for (enable, status) in [(0, 1), (8, 10), (16, 17), (24, 25), (26, 27)] {
                    if value & (1 << enable) != 0 {
                        ready |= 1 << status;
                    }
                }
                value | ready
            }
            0x0008 => {
                // CFGR: mirror the requested system-clock source (SW) into
                // the clock-status field (SWS) once selected.
                let value = self.registers.get(&offset).copied().unwrap_or(0);
                (value & !0x0c) | ((value & 0x03) << 2)
            }
            0x0090 | 0x0094 => {
                // WB55 RTC clock setup waits for the oscillator-ready bit
                // immediately above its enable bit.
                let value = self.registers.get(&offset).copied().unwrap_or(0);
                value | ((value & 1) << 1)
            }
            _ => self.registers.get(&offset).copied().unwrap_or(0),
        }
    }

    fn write(&mut self, _sys: &System, offset: u32, value: u32) {
        if offset == 0 {
            let ready_mask = (1 << 1) | (1 << 10) | (1 << 17) | (1 << 25) | (1 << 27);
            self.registers.insert(offset, value & !ready_mask);
        } else {
            self.registers.insert(offset, value);
        }
    }
}
