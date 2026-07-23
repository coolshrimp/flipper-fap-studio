// SPDX-License-Identifier: GPL-3.0-or-later

use super::{nvic::irq, Peripheral};
use crate::system::System;
use std::collections::HashMap;

#[derive(Default)]
pub struct Scb {
    registers: HashMap<u32, u32>,
}

impl Scb {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        if name == "SCB" {
            let mut registers = HashMap::new();
            registers.insert(0x0008, 0x0800_0000); // VTOR
            Some(Box::new(Self { registers }))
        } else {
            None
        }
    }
}

impl Peripheral for Scb {
    fn read(&mut self, _sys: &System, offset: u32) -> u32 {
        self.registers.get(&offset).copied().unwrap_or(0)
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        match offset {
            0x0004 => {
                // ICSR register
                // bit 26: set systick pending
                // bit 28: set PendSV pending
                if value & (1 << 26) != 0 {
                    sys.p.nvic.borrow_mut().set_intr_pending(irq::SYSTICK);
                }
                if value & (1 << 28) != 0 {
                    sys.p.nvic.borrow_mut().set_intr_pending(irq::PENDSV);
                }
            }
            _ => {
                self.registers.insert(offset, value);
            }
        }
    }
}
