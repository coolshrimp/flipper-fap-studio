// SPDX-License-Identifier: GPL-3.0-or-later

use std::collections::HashMap;

use super::Peripheral;
use crate::system::System;

const ISR: u32 = 0x000c;
const ISR_ALRAWF: u32 = 1 << 0;
const ISR_ALRBWF: u32 = 1 << 1;
const ISR_WUTWF: u32 = 1 << 2;
const ISR_RSF: u32 = 1 << 5;
const ISR_INITF: u32 = 1 << 6;
const ISR_INIT: u32 = 1 << 7;

/// Small STM32WB RTC model.
///
/// Most RTC registers only need ordinary retained read/write behavior for the
/// firmware simulator. ISR is different: firmware writes masks containing
/// ones in reserved and read-only status fields. Treating that write as RAM
/// asserts ALRAF and launches the clock-alarm application on every boot,
/// leaving an invisible fullscreen viewport in front of the desktop.
#[derive(Default)]
pub struct Rtc {
    registers: HashMap<u32, u32>,
    init_mode: bool,
}

impl Rtc {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        if name == "RTC" {
            Some(Box::new(Self::default()))
        } else {
            None
        }
    }

    fn status(&self) -> u32 {
        // The desktop model has no running alarm/wakeup source. The writable
        // resource-ready and synchronization flags are kept ready so the
        // STM32 LL initialization loops complete just as they do in hardware.
        ISR_ALRAWF
            | ISR_ALRBWF
            | ISR_WUTWF
            | ISR_RSF
            | if self.init_mode {
                ISR_INIT | ISR_INITF
            } else {
                0
            }
    }

    fn write_status(&mut self, value: u32) {
        // INIT is the only control bit in ISR. ALRAF and the other event flags
        // are hardware-owned/W0C and must never be asserted by a mask write.
        self.init_mode = value & ISR_INIT != 0;
    }
}

impl Peripheral for Rtc {
    fn read(&mut self, _sys: &System, offset: u32) -> u32 {
        if offset == ISR {
            self.status()
        } else {
            self.registers.get(&offset).copied().unwrap_or(0)
        }
    }

    fn write(&mut self, _sys: &System, offset: u32, value: u32) {
        if offset == ISR {
            self.write_status(value);
        } else {
            self.registers.insert(offset, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mask_writes_do_not_manufacture_an_alarm() {
        const ALRAF: u32 = 1 << 8;
        let mut rtc = Rtc::default();

        assert_eq!(rtc.status() & ALRAF, 0);
        rtc.write_status(u32::MAX);
        assert_ne!(rtc.status() & ISR_INITF, 0);
        assert_eq!(rtc.status() & ALRAF, 0);

        rtc.write_status(u32::MAX & !ISR_INIT);
        assert_eq!(rtc.status() & ISR_INITF, 0);
        assert_eq!(rtc.status() & ALRAF, 0);
    }
}
