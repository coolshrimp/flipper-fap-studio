// SPDX-License-Identifier: GPL-3.0-or-later

use std::sync::atomic::Ordering;

use super::Peripheral;
use crate::system::System;

pub struct Dwt;

impl Peripheral for Dwt {
    fn read(&mut self, _sys: &System, offset: u32) -> u32 {
        match offset {
            0x0000 => 1, // CTRL: cycle counter support
            // Advance faster than the interpreted instruction count so
            // multi-second hardware settling delays do not dominate desktop
            // boot time.
            0x0004 => crate::emulator::NUM_INSTRUCTIONS
                .load(Ordering::Relaxed)
                .wrapping_mul(64) as u32,
            _ => 0,
        }
    }

    fn write(&mut self, _sys: &System, _offset: u32, _value: u32) {}
}
