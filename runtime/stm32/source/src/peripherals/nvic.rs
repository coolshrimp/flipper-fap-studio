// SPDX-License-Identifier: GPL-3.0-or-later

use std::sync::atomic::Ordering;

use unicorn_engine::{RegisterARM, Unicorn};

use super::Peripheral;
use crate::system::System;

#[derive(Default)]
pub struct Nvic {
    pub systick_period: Option<u32>,
    pub last_systick_trigger: u64,

    // 128 different interrupts. Good enough for now
    pending: u128,
    in_interrupt: bool,
    handler_entry_msp: Option<u64>,
}

const IRQ_OFFSET: i32 = 16;

pub mod irq {
    pub const PENDSV: i32 = -2;
    pub const SYSTICK: i32 = -1;
}

// This is all poorly implemented. If this is not making much sense, it might be
// best to re-implement everything correctly. Right now, I'm just trying to get
// the saturn firmware to work just well enough.

impl Nvic {
    pub fn set_intr_pending(&mut self, irq: i32) {
        trace!("Set irq pending irq={}", irq);
        let bit = IRQ_OFFSET + irq;
        assert!(bit > 0);
        self.pending |= 1 << (IRQ_OFFSET + irq);
    }

    pub fn get_and_clear_next_intr_pending(&mut self) -> Option<i32> {
        if self.pending != 0 {
            let bit = self.pending.trailing_zeros();
            self.pending &= !(1 << bit);
            let irq = (bit as i32) - IRQ_OFFSET;
            Some(irq)
        } else {
            None
        }
    }

    pub fn maybe_set_systick_intr_pending(&mut self) {
        if let Some(systick_period) = self.systick_period {
            let n = crate::emulator::NUM_INSTRUCTIONS.load(Ordering::Relaxed);
            let delta_num_instructions = n - self.last_systick_trigger;
            if delta_num_instructions > (systick_period as u64) {
                self.last_systick_trigger = n;
                self.set_intr_pending(irq::SYSTICK);
            }
        }
    }

    fn are_interrupts_disabled(sys: &System) -> bool {
        let uc = sys.uc.borrow();
        let primask = uc.reg_read(RegisterARM::PRIMASK).unwrap();
        let basepri = uc.reg_read(RegisterARM::BASEPRI).unwrap();
        primask != 0 || basepri != 0
    }

    pub fn pending_interrupt_ready(&mut self, sys: &System) -> bool {
        self.maybe_set_systick_intr_pending();
        self.pending != 0 && !Self::are_interrupts_disabled(sys) && !self.in_interrupt
    }

    pub fn run_pending_interrupts(&mut self, sys: &System, vector_table_addr: u32) -> bool {
        self.maybe_set_systick_intr_pending();

        if Self::are_interrupts_disabled(sys) || self.in_interrupt {
            return false;
        }

        if let Some(irq) = self.get_and_clear_next_intr_pending() {
            self.run_interrupt(sys, vector_table_addr, irq);
            true
        } else {
            false
        }
    }

    fn read_vector_addr(sys: &System, vector_table_addr: u32, irq: i32) -> u32 {
        // 4 because of ptr size
        let vaddr = vector_table_addr + 4 * (IRQ_OFFSET + irq) as u32;

        let mut vector = [0, 0, 0, 0];
        sys.uc.borrow().mem_read(vaddr as u64, &mut vector).unwrap();
        u32::from_le_bytes(vector)
    }

    // SPSEL, bit[1], 0 means we use MSP, 1 means we use PSP.
    // FPCA, bit[2], if the processor includes the FP extension.

    fn run_interrupt(&mut self, sys: &System, vector_table_addr: u32, irq: i32) {
        let vector = Self::read_vector_addr(sys, vector_table_addr, irq);

        let mut uc = sys.uc.borrow_mut();

        // SPSEL, bit[1], 0 means we use MSP, 1 means we use PSP.
        // FPCA, bit[2], if the processor includes the FP extension.
        let control_reg = uc.reg_read(RegisterARM::CONTROL).unwrap();
        let spsel = control_reg & (1 << 1) != 0;
        let fpca = control_reg & (2 << 1) != 0;

        trace!(
            "Running interrupt irq={} spsel={} fpca={} vector={:#08x}",
            irq,
            spsel,
            fpca,
            vector,
        );

        Self::push_regs(&mut uc, spsel, fpca);
        self.handler_entry_msp = Some(uc.reg_read(RegisterARM::MSP).unwrap());

        // LR meaning:
        //   EXC_RETURN    Return to      Return stack Frame type
        //   0xFFFF_FFE1   Handler mode   Main         Extended
        //   0xFFFF_FFE9   Thread mode    Main         Extended
        //   0xFFFF_FFED   Thread mode    Process      Extended
        //   0xFFFF_FFF1   Handler mode   Main         Basic
        //   0xFFFF_FFF9   Thread mode    Main         Basic
        //   0xFFFF_FFFD   Thread mode    Process      Basic

        // Right now, we don't supposed nested interrupts.
        let mut lr: u32 = 0xFFFF_FFE9;
        if spsel {
            lr |= 0b0000_0100;
        }
        if !fpca {
            lr |= 0b0001_0000;
        } // Yes, no fpca means the bit is set
        uc.reg_write(RegisterARM::LR, lr.into()).unwrap();

        // IPSR contains the architectural exception number, not the signed
        // external-IRQ index used internally here. FreeRTOS checks IPSR to
        // distinguish thread and handler mode.
        uc.reg_write(RegisterARM::IPSR, (IRQ_OFFSET + irq) as u64)
            .unwrap();
        // The interrupted frame stays on PSP when thread mode selected it,
        // but every Cortex-M exception handler itself runs on MSP. Unicorn
        // does not perform that mode switch for our injected exception.
        if spsel {
            let handler_sp = uc.reg_read(RegisterARM::MSP).unwrap();
            uc.reg_write(RegisterARM::SP, handler_sp).unwrap();
        }
        uc.reg_write(RegisterARM::PC, vector as u64).unwrap();

        self.in_interrupt = true;
    }

    pub fn run_exception(&mut self, sys: &System, vector_table_addr: u32, exception: i32) {
        self.run_interrupt(sys, vector_table_addr, exception - IRQ_OFFSET);
    }

    pub fn return_from_interrupt(&mut self, sys: &System) {
        let mut uc = sys.uc.borrow_mut();

        // Unicorn may partially advance the banked MSP before it reports
        // EXCP_EXCEPTION_EXIT for a direct `bx lr`. Exception return to a PSP
        // thread must leave the handler stack exactly where exception entry
        // found it, so retain the architectural entry value separately.
        let handler_entry_msp = self
            .handler_entry_msp
            .unwrap_or_else(|| uc.reg_read(RegisterARM::MSP).unwrap());
        let lr = uc.reg_read(RegisterARM::LR).unwrap();
        let (restored_sp, return_uses_psp) = if lr & 0xFFFF_FF00 == 0xFFFF_FF00 {
            let spsel = lr & 0b0000_0100 != 0;
            let fpca = lr & 0b0001_0000 == 0; // 0 means yes here

            let restored_sp = Self::pop_regs(&mut uc, spsel, fpca);

            trace!(
                "Return from interrupt spsel={} fpca={} pc=0x{:08x} sp=0x{:08x} msp=0x{:08x} psp=0x{:08x}",
                spsel,
                fpca,
                uc.reg_read(RegisterARM::PC).unwrap(),
                uc.reg_read(RegisterARM::SP).unwrap(),
                uc.reg_read(RegisterARM::MSP).unwrap(),
                uc.reg_read(RegisterARM::PSP).unwrap(),
            );

            // SPSEL, bit[1], 0 means we use MSP, 1 means we use PSP.
            // FPCA, bit[2], if the processor includes the FP extension.
            let mut control_reg = uc.reg_read(RegisterARM::CONTROL).unwrap() & 1;
            if spsel {
                control_reg |= 1 << 1;
            }
            if fpca {
                control_reg |= 2 << 1;
            }
            uc.reg_write(RegisterARM::CONTROL, control_reg).unwrap();
            (restored_sp, spsel)
        } else {
            let control_reg = uc.reg_read(RegisterARM::CONTROL).unwrap();
            let spsel = control_reg & (1 << 1) != 0;
            let fpca = control_reg & (2 << 1) != 0;
            let restored_sp = Self::pop_regs(&mut uc, spsel, fpca);

            trace!(
                "Return from interrupt spsel={} fpca={} pc=0x{:08x} -- LR was not right",
                spsel,
                fpca,
                uc.reg_read(RegisterARM::PC).unwrap()
            );
            (restored_sp, spsel)
        };

        // Nested interrupts are not modeled, so returning always resumes
        // thread mode. Leaving SysTick/PendSV's exception number in IPSR makes
        // FreeRTOS believe every later API call is executing inside an ISR.
        //
        // This must happen before writing the general SP. In handler mode the
        // architectural SP alias always targets MSP, regardless of CONTROL.
        // Writing a restored PSP while IPSR was still non-zero poisoned MSP
        // and made the next handler return through address zero.
        uc.reg_write(RegisterARM::IPSR, 0).unwrap();
        uc.reg_write(RegisterARM::SP, restored_sp).unwrap();
        // Unicorn can surface EXCP_EXCEPTION_EXIT after partially advancing
        // the handler stack. Reassert the entry MSP on a PSP return so direct
        // tail returns cannot make it creep across successive exceptions.
        if return_uses_psp {
            uc.reg_write(RegisterARM::PSP, restored_sp).unwrap();
            uc.reg_write(RegisterARM::MSP, handler_entry_msp).unwrap();
        } else {
            uc.reg_write(RegisterARM::MSP, restored_sp).unwrap();
        }
        self.in_interrupt = false;
        self.handler_entry_msp = None;
    }

    const CONTEXT_REGS_EXTENDED: [RegisterARM; 17] = [
        RegisterARM::FPSCR,
        RegisterARM::S15,
        RegisterARM::S14,
        RegisterARM::S13,
        RegisterARM::S12,
        RegisterARM::S11,
        RegisterARM::S10,
        RegisterARM::S9,
        RegisterARM::S8,
        RegisterARM::S7,
        RegisterARM::S6,
        RegisterARM::S5,
        RegisterARM::S4,
        RegisterARM::S3,
        RegisterARM::S2,
        RegisterARM::S1,
        RegisterARM::S0,
    ];

    const CONTEXT_REGS: [RegisterARM; 8] = [
        RegisterARM::XPSR,
        RegisterARM::PC,
        RegisterARM::LR,
        RegisterARM::R12,
        RegisterARM::R3,
        RegisterARM::R2,
        RegisterARM::R1,
        RegisterARM::R0,
    ];

    fn push_regs(uc: &mut Unicorn<()>, spsel: bool, fpca: bool) {
        let sp_reg = if spsel {
            RegisterARM::PSP
        } else {
            RegisterARM::MSP
        };
        let mut sp = uc.reg_read(sp_reg).unwrap();

        if fpca {
            // A Cortex-M extended exception frame has an extra reserved word
            // above FPSCR. Omitting it makes every FP exception return advance
            // PSP/MSP by only 100 bytes instead of 104, eventually corrupting
            // a task's saved LR/PC.
            sp -= 4;
            uc.mem_write(sp, &0u32.to_le_bytes())
                .expect("Invalid SP pointer during FP interrupt");
        }

        let mut push_reg = |reg| {
            let v = uc.reg_read(reg).unwrap() as u32;
            //trace!("push sp=0x{:08x} {:5?}=0x{:08x}", sp, reg, v);
            sp -= 4;
            uc.mem_write(sp, &v.to_le_bytes())
                .expect("Invalid SP pointer during interrupt");
        };

        if fpca {
            for reg in Self::CONTEXT_REGS_EXTENDED {
                push_reg(reg);
            }
        }
        for reg in Self::CONTEXT_REGS {
            push_reg(reg);
        }
        uc.reg_write(sp_reg, sp).unwrap();
        uc.reg_write(RegisterARM::SP, sp).unwrap();
    }

    fn pop_regs(uc: &mut Unicorn<()>, spsel: bool, fpca: bool) -> u64 {
        let sp_reg = if spsel {
            RegisterARM::PSP
        } else {
            RegisterARM::MSP
        };
        let mut sp = uc.reg_read(sp_reg).unwrap();

        let mut pop_reg = |reg| {
            let mut v = [0, 0, 0, 0];
            uc.mem_read(sp, &mut v)
                .expect("Invalid SP pointer during interrupt return");
            let v = u32::from_le_bytes(v);
            //trace!("pop sp=0x{:08x} {:5?}=0x{:08x}", sp, reg, v);
            sp += 4;
            uc.reg_write(reg, v as u64).unwrap();
        };

        for reg in Self::CONTEXT_REGS.iter().rev() {
            pop_reg(*reg);
        }
        if fpca {
            for reg in Self::CONTEXT_REGS_EXTENDED.iter().rev() {
                pop_reg(*reg);
            }
            // Skip the architectural reserved word following FPSCR.
            sp += 4;
        }
        uc.reg_write(sp_reg, sp).unwrap();
        sp
    }
}

impl Peripheral for Nvic {
    fn read(&mut self, _sys: &System, _offset: u32) -> u32 {
        0
    }

    fn write(&mut self, _sys: &System, _offset: u32, _value: u32) {}
}

/// The next part is glue. Maybe we could have a better architecture.

pub struct NvicWrapper;

impl NvicWrapper {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        if name == "NVIC" {
            Some(Box::new(Self))
        } else {
            None
        }
    }
}

impl Peripheral for NvicWrapper {
    fn read(&mut self, sys: &System, offset: u32) -> u32 {
        sys.p.nvic.borrow_mut().read(sys, offset)
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        sys.p.nvic.borrow_mut().write(sys, offset, value)
    }
}

/*
0xE000E100 B  REGISTER ISER0 (rw): Interrupt Set-Enable Register
0xE000E104 B  REGISTER ISER1 (rw): Interrupt Set-Enable Register
0xE000E108 B  REGISTER ISER2 (rw): Interrupt Set-Enable Register

0xE000E180 B  REGISTER ICER0 (rw): Interrupt Clear-Enable Register
0xE000E184 B  REGISTER ICER1 (rw): Interrupt Clear-Enable Register
0xE000E188 B  REGISTER ICER2 (rw): Interrupt Clear-Enable Register

0xE000E200 B  REGISTER ISPR0 (rw): Interrupt Set-Pending Register
0xE000E204 B  REGISTER ISPR1 (rw): Interrupt Set-Pending Register
0xE000E208 B  REGISTER ISPR2 (rw): Interrupt Set-Pending Register

0xE000E280 B  REGISTER ICPR0 (rw): Interrupt Clear-Pending Register
0xE000E284 B  REGISTER ICPR1 (rw): Interrupt Clear-Pending Register
0xE000E288 B  REGISTER ICPR2 (rw): Interrupt Clear-Pending Register

0xE000E300 B  REGISTER IABR0 (ro): Interrupt Active Bit Register
0xE000E304 B  REGISTER IABR1 (ro): Interrupt Active Bit Register
0xE000E308 B  REGISTER IABR2 (ro): Interrupt Active Bit Register

0xE000E400 B  REGISTER IPR0 (rw): Interrupt Priority Register
0xE000E404 B  REGISTER IPR1 (rw): Interrupt Priority Register
0xE000E408 B  REGISTER IPR2 (rw): Interrupt Priority Register
0xE000E40C B  REGISTER IPR3 (rw): Interrupt Priority Register
0xE000E410 B  REGISTER IPR4 (rw): Interrupt Priority Register
0xE000E414 B  REGISTER IPR5 (rw): Interrupt Priority Register
0xE000E418 B  REGISTER IPR6 (rw): Interrupt Priority Register
0xE000E41C B  REGISTER IPR7 (rw): Interrupt Priority Register
0xE000E420 B  REGISTER IPR8 (rw): Interrupt Priority Register
0xE000E424 B  REGISTER IPR9 (rw): Interrupt Priority Register
0xE000E428 B  REGISTER IPR10 (rw): Interrupt Priority Register
0xE000E42C B  REGISTER IPR11 (rw): Interrupt Priority Register
0xE000E430 B  REGISTER IPR12 (rw): Interrupt Priority Register
0xE000E434 B  REGISTER IPR13 (rw): Interrupt Priority Register
0xE000E438 B  REGISTER IPR14 (rw): Interrupt Priority Register
0xE000E43C B  REGISTER IPR15 (rw): Interrupt Priority Register
0xE000E440 B  REGISTER IPR16 (rw): Interrupt Priority Register
0xE000E444 B  REGISTER IPR17 (rw): Interrupt Priority Register
0xE000E448 B  REGISTER IPR18 (rw): Interrupt Priority Register
0xE000E44C B  REGISTER IPR19 (rw): Interrupt Priority Register
*/
