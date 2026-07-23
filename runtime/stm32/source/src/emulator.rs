// SPDX-License-Identifier: GPL-3.0-or-later

use std::{mem::MaybeUninit, sync::atomic::{AtomicU64, Ordering, AtomicBool}, cell::RefCell};
use svd_parser::svd::Device as SvdDevice;
use unicorn_engine::{unicorn_const::{Arch, Mode, HookType, MemType}, Unicorn, RegisterARM};
use crate::{config::Config, util::UniErr, Args, system::System, framebuffers::sdl_engine::{PUMP_EVENT_INST_INTERVAL, SDL}};
use anyhow::{Context as _, Result, bail};
use capstone::prelude::*;

#[repr(C)]
struct VectorTable {
    pub sp: u32,
    pub reset: u32,
}

impl VectorTable {
    pub fn from_memory(uc: &Unicorn<()>, addr: u32) -> Result<Self> {
        unsafe {
            let mut self_ = MaybeUninit::<Self>::uninit();
            let buf = std::slice::from_raw_parts_mut(self_.as_mut_ptr() as *mut u8, std::mem::size_of::<Self>());
            uc.mem_read(addr.into(), buf).map_err(UniErr)?;
            Ok(self_.assume_init())
        }
    }
}

fn thumb(pc: u64) -> u64 {
    pc | 1
}

const FLASH_BASE: u64 = 0x0800_0000;
const FLASH_SCAN_SIZE: usize = 0x0010_0000;
const ENCLAVE_VERIFY_PROLOGUE: &[u8] =
    &[0x2d, 0xe9, 0xf0, 0x4f, 0x0e, 0x46, 0x85, 0xb0, 0x07, 0x46, 0x18, 0xb9, 0x4f, 0xf0, 0x02, 0x0c];
const ENCLAVE_VERIFY_LOOP_TAIL_OFFSET: usize = 0x68;
const ENCLAVE_VERIFY_LOOP_TAIL: &[u8] =
    &[0x0a, 0xf1, 0x10, 0x0a, 0xba, 0xf1, 0xa0, 0x0f, 0x08, 0xf1, 0x01, 0x08, 0xd8, 0xd1];

fn find_enclave_verify(image: &[u8]) -> Option<usize> {
    let required_len = ENCLAVE_VERIFY_LOOP_TAIL_OFFSET + ENCLAVE_VERIFY_LOOP_TAIL.len();
    let mut matches = image
        .windows(required_len)
        .enumerate()
        .filter(|(_, window)| {
            window.starts_with(ENCLAVE_VERIFY_PROLOGUE)
                && window[ENCLAVE_VERIFY_LOOP_TAIL_OFFSET..].starts_with(ENCLAVE_VERIFY_LOOP_TAIL)
        })
        .map(|(offset, _)| offset);

    let address = matches.next()?;
    if matches.next().is_none() {
        Some(address)
    } else {
        None
    }
}

// PC + instruction size
pub static mut LAST_INSTRUCTION: (u32, u8) = (0,0);
pub static NUM_INSTRUCTIONS: AtomicU64 = AtomicU64::new(0);
static CONTINUE_EXECUTION: AtomicBool = AtomicBool::new(false);
static BUSY_LOOP_REACHED: AtomicBool = AtomicBool::new(false);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static INTERRUPT_BOUNDARY_REQUESTED: AtomicBool = AtomicBool::new(false);
static VIRTUAL_ENCLAVE_BOUNDARY_REQUESTED: AtomicBool = AtomicBool::new(false);
static STOP_ADDRESS_REACHED: AtomicBool = AtomicBool::new(false);

fn disassemble_instruction(diassembler: &Capstone, uc: &Unicorn<()>, pc: u64) -> String {
    let mut instr = [0; 4];
    if uc.mem_read(pc, &mut instr).is_err() {
        return "failed to read memory at pc".to_string();
    }

    if let Ok(disasm) = diassembler.disasm_count(&instr, pc, 1) {
        if let Some(instr) = disasm.first() {
            return format!("{:5} {}", instr.mnemonic().unwrap(), instr.op_str().unwrap());
        }
    }

    return "??".to_string();
}

pub fn dump_stack(uc: &mut Unicorn<()>, count: usize) {
    for (name, reg) in [
        ("r0", RegisterARM::R0),
        ("r1", RegisterARM::R1),
        ("r2", RegisterARM::R2),
        ("r3", RegisterARM::R3),
        ("r4", RegisterARM::R4),
        ("r5", RegisterARM::R5),
        ("r6", RegisterARM::R6),
        ("r7", RegisterARM::R7),
        ("r8", RegisterARM::R8),
        ("r9", RegisterARM::R9),
        ("r10", RegisterARM::R10),
        ("r11", RegisterARM::R11),
        ("r12", RegisterARM::R12),
        ("lr", RegisterARM::LR),
        ("sp", RegisterARM::SP),
        ("pc", RegisterARM::PC),
        ("xpsr", RegisterARM::XPSR),
    ] {
        info!("REG {:>4}=0x{:08x}", name, uc.reg_read(reg).unwrap());
    }
    let mut sp = uc.reg_read(RegisterARM::SP).unwrap();

    for _ in 0..count {
        let mut v = [0,0,0,0];
        if uc.mem_read(sp, &mut v).is_err() {
            info!("stack dump finished due to mem read error");
            return;
        }
        let v = u32::from_le_bytes(v);

        if (0x0800_0000..0x0810_0000).contains(&v) {
            // Probably a return address
            info!("*** 0x{:08x} (sp=0x{:08x})", v, sp);
        } else {
            info!("    0x{:08x} (sp=0x{:08x})", v, sp);
        }

        sp += 4;
    }
}

pub fn run_emulator(config: Config, svd_device: SvdDevice, args: Args) -> Result<()> {
    let mut uc = Unicorn::new(Arch::ARM, Mode::MCLASS | Mode::LITTLE_ENDIAN)
        .map_err(UniErr).context("Failed to initialize Unicorn instance")?;

    let vector_table_addr = config.cpu.vector_table;

    let (sys, framebuffers) = crate::system::prepare(&mut uc, config, svd_device)?;
    let runtime_peripherals = sys.p.clone();
    let runtime_devices = sys.d.clone();

    let diassembler = Capstone::new()
        .arm()
        .mode(arch::arm::ArchMode::Thumb)
        .build()
        .expect("failed to initialize capstone");

    // Stock and custom Flipper firmware verify ten factory enclave slots
    // before starting the desktop event loop. Without the physical wireless
    // core, the firmware's failure path retains its crypto mutex and blocks
    // forever on slot two. Discover the stable verifier structure instead of
    // relying on a firmware-version-specific address, then complete that one
    // boot-time capability check as a virtual secure enclave.
    let virtual_enclave_verify = {
        let mut image = vec![0u8; FLASH_SCAN_SIZE];
        if sys.uc.borrow().mem_read(FLASH_BASE, &mut image).is_ok() {
            find_enclave_verify(&image).map(|offset| FLASH_BASE + offset as u64)
        } else {
            None
        }
    };
    // A firmware with this verifier cannot start its desktop scene until the
    // simulator has supplied the virtual enclave result below. Hold host
    // button events until that boot boundary so an early click is not lost.
    crate::peripherals::gpio::set_button_ui_ready(virtual_enclave_verify.is_none());

    // We hook on each instructions, but we could skip this.
    // The slowdown is less than 50%. It's okay for now.
    {
        let trace_instructions = crate::verbose() >= 4;
        let busy_loop_stop = args.busy_loop_stop;
        let p = sys.p.clone();
        let d = sys.d.clone();
        let interrupt_period = args.interrupt_period;
        let stop_addr = args.stop_addr;
        sys.uc.borrow_mut().add_code_hook(0, u64::MAX, move |uc, pc, size| {
            // Unicorn does not reliably honor `emu_start`'s end address when
            // Cortex-M execution is repeatedly stopped and resumed around
            // software-injected exceptions. Enforce the requested breakpoint
            // in the instruction hook as an architectural address instead.
            if stop_addr.is_some_and(|address| address & !1 == pc as u32 & !1) {
                STOP_ADDRESS_REACHED.store(true, Ordering::Release);
                uc.emu_stop().unwrap();
                return;
            }

            if virtual_enclave_verify == Some(pc) {
                // Stop before changing registers. Unicorn may otherwise run
                // the remainder of its already translated verifier block
                // after PC is changed from inside this hook.
                VIRTUAL_ENCLAVE_BOUNDARY_REQUESTED.store(true, Ordering::Release);
                uc.emu_stop().unwrap();
                return;
            }
            // FreeRTOS's first-task SVC is intentionally non-returning. Under
            // unlucky early interrupt timing Unicorn can surface the stacked
            // caller frame instead, falling through into the aligned
            // 0xE000ED08 VTOR literal after `svc 0`. Recognize that exact
            // port-start sequence and retry the synchronous SVC exception.
            if size == 2 && pc >= 2 {
                let mut svc_start = [0u8; 10];
                if uc.mem_read(pc - 2, &mut svc_start).is_ok() &&
                    svc_start == [0x00, 0xdf, 0x00, 0xbf, 0x00, 0x00, 0x08, 0xed, 0x00, 0xe0]
                {
                    warn!("Recovering FreeRTOS first-task SVC fall-through at 0x{:08x}", pc);
                    let sys = System {
                        uc: RefCell::new(uc),
                        p: p.clone(),
                        d: d.clone(),
                    };
                    p.nvic.borrow_mut().run_exception(&sys, vector_table_addr, 11);
                    sys.uc.borrow_mut().emu_stop().unwrap();
                    return;
                }
            }

            // Unicorn's Cortex-M exception-exit hook handles `bx lr`, but not
            // the equally valid Thumb `pop {..., pc}` form used by Momentum.
            // If the stacked PC is an EXC_RETURN token, complete the software
            // pop here and pass the hardware frame to our NVIC model.
            if size == 2 {
                let mut bytes = [0u8; 2];
                if uc.mem_read(pc, &mut bytes).is_ok() {
                    let instruction = u16::from_le_bytes(bytes);
                    let is_pop_pc = instruction & 0xFF00 == 0xBD00;
                    if is_pop_pc {
                        let register_mask = instruction as u8;
                        let register_count = register_mask.count_ones() as u64;
                        let sp = uc.reg_read(RegisterARM::SP).unwrap();
                        let mut saved_pc_bytes = [0u8; 4];
                        if uc.mem_read(sp + register_count * 4, &mut saved_pc_bytes).is_ok() {
                            let saved_pc = u32::from_le_bytes(saved_pc_bytes);
                            if saved_pc & 0xFFFF_FF00 == 0xFFFF_FF00 {
                                let registers = [
                                    RegisterARM::R0, RegisterARM::R1,
                                    RegisterARM::R2, RegisterARM::R3,
                                    RegisterARM::R4, RegisterARM::R5,
                                    RegisterARM::R6, RegisterARM::R7,
                                ];
                                let mut offset = 0u64;
                                for (bit, register) in registers.iter().enumerate() {
                                    if register_mask & (1 << bit) != 0 {
                                        let mut value = [0u8; 4];
                                        uc.mem_read(sp + offset, &mut value).unwrap();
                                        uc.reg_write(*register, u32::from_le_bytes(value) as u64).unwrap();
                                        offset += 4;
                                    }
                                }
                                let handler_sp = sp + (register_count + 1) * 4;
                                uc.reg_write(RegisterARM::SP, handler_sp).unwrap();
                                uc.reg_write(RegisterARM::MSP, handler_sp).unwrap();
                                uc.reg_write(RegisterARM::LR, saved_pc as u64).unwrap();

                                let sys = System {
                                    uc: RefCell::new(uc),
                                    p: p.clone(),
                                    d: d.clone(),
                                };
                                p.nvic.borrow_mut().return_from_interrupt(&sys);
                                p.nvic.borrow_mut().run_pending_interrupts(
                                    &sys,
                                    vector_table_addr,
                                );
                                sys.uc.borrow_mut().emu_stop().unwrap();
                                return;
                            }
                        }
                    }
                }
            }

            unsafe {
                if busy_loop_stop && LAST_INSTRUCTION.0 == pc as u32 {
                    info!("Busy loop reached");
                    uc.emu_stop().unwrap();
                    BUSY_LOOP_REACHED.store(true, Ordering::Release);
                }
                LAST_INSTRUCTION = (pc as u32, size as u8);
            }

            let n = NUM_INSTRUCTIONS.fetch_add(1, Ordering::Acquire);
            let mut sync_instruction = [0u8; 2];
            if size == 2 &&
                uc.mem_read(pc, &mut sync_instruction).is_ok() &&
                matches!(sync_instruction, [0x20, 0xBF] | [0x30, 0xBF] | [0x40, 0xBF])
            {
                // A single-core desktop session has no M0+ radio CPU to wake
                // or wait for. Resume at the following Thumb instruction.
                uc.reg_write(RegisterARM::PC, thumb(pc + 2)).unwrap();
                uc.emu_stop().unwrap();
                return;
            }

            if trace_instructions {
                info!("{}", disassemble_instruction(&diassembler, uc, pc));
            }

            if n % interrupt_period as u64 == 0 {
                let sys = System { uc: RefCell::new(uc), p: p.clone(), d: d.clone() };
                let mut button_irqs = crate::peripherals::gpio::take_button_irqs();
                while button_irqs != 0 {
                    let irq = button_irqs.trailing_zeros() as i32;
                    button_irqs &= !(1u64 << irq);
                    p.nvic.borrow_mut().set_intr_pending(irq);
                }
                if p.nvic.borrow_mut().pending_interrupt_ready(&sys) {
                    // Unicorn can finish the current translated block after
                    // emu_stop() is requested. Stop before changing PC/LR/SP;
                    // the outer loop injects the exception at the resulting
                    // architectural boundary.
                    INTERRUPT_BOUNDARY_REQUESTED.store(true, Ordering::Release);
                    sys.uc.borrow_mut().emu_stop().unwrap();
                    return;
                }
            }

            if n & PUMP_EVENT_INST_INTERVAL == 0 {
                for fb in &framebuffers.sdls {
                    fb.borrow_mut().maybe_redraw();
                }
                if !SDL.lock().unwrap().pump_events(&framebuffers.sdls) {
                    STOP_REQUESTED.store(true, Ordering::Relaxed);
                    uc.emu_stop().unwrap();
                }
            }
        }).expect("add_code_hook failed");
    }

    {
        let p = sys.p.clone();
        let d = sys.d.clone();
        sys.uc.borrow_mut().add_intr_hook(move |uc, exception| {
            match exception {
                /*
                    EXCP_UDEF            1   /* undefined instruction */
                    EXCP_SWI             2   /* software interrupt */
                    EXCP_PREFETCH_ABORT  3
                    EXCP_DATA_ABORT      4
                    EXCP_IRQ             5
                    EXCP_FIQ             6
                    EXCP_BKPT            7
                    EXCP_EXCEPTION_EXIT  8   /* Return from v7M exception.  */
                    EXCP_KERNEL_TRAP     9   /* Jumped to kernel code page.  */
                    EXCP_HVC            11   /* HyperVisor Call */
                    EXCP_HYP_TRAP       12
                    EXCP_SMC            13   /* Secure Monitor Call */
                    EXCP_VIRQ           14
                    EXCP_VFIQ           15
                    EXCP_SEMIHOST       16   /* semihosting call */
                    EXCP_NOCP           17   /* v7M NOCP UsageFault */
                    EXCP_INVSTATE       18   /* v7M INVSTATE UsageFault */
                    EXCP_STKOF          19   /* v8M STKOF UsageFault */
                    EXCP_LAZYFP         20   /* v7M fault during lazy FP stacking */
                    EXCP_LSERR          21   /* v8M LSERR SecureFault */
                    EXCP_UNALIGNED      22   /* v7M UNALIGNED UsageFault */
                    */
                8 => {
                    // Return from interrupt
                    let sys = System { uc: RefCell::new(uc), p: p.clone(), d: d.clone() };
                    p.nvic.borrow_mut().return_from_interrupt(&sys);
                    p.nvic.borrow_mut().run_pending_interrupts(&sys, vector_table_addr);
                    // The restored PC (or a tail-chained pending vector) must
                    // begin in a fresh translated block.
                    sys.uc.borrow_mut().emu_stop().unwrap();
                }
                2 => {
                    // SVC is exception vector 11 on Cortex-M. FreeRTOS uses it
                    // to restore the first task context.
                    let sys = System { uc: RefCell::new(uc), p: p.clone(), d: d.clone() };
                    p.nvic.borrow_mut().run_exception(&sys, vector_table_addr, 11);
                    sys.uc.borrow_mut().emu_stop().unwrap();
                }
                3 => {
                    let pc = uc.reg_read(RegisterARM::PC).unwrap_or(0);
                    let lr = uc.reg_read(RegisterARM::LR).unwrap_or(0);
                    let sp = uc.reg_read(RegisterARM::SP).unwrap_or(0);
                    let msp = uc.reg_read(RegisterARM::MSP).unwrap_or(0);
                    let psp = uc.reg_read(RegisterARM::PSP).unwrap_or(0);
                    let ipsr = uc.reg_read(RegisterARM::IPSR).unwrap_or(0);
                    let control = uc.reg_read(RegisterARM::CONTROL).unwrap_or(0);
                    error!(
                        "CPU prefetch fault pc=0x{:08x} lr=0x{:08x} sp=0x{:08x} msp=0x{:08x} psp=0x{:08x} ipsr={} control=0x{:x}; stopping firmware",
                        pc, lr, sp, msp, psp, ipsr, control
                    );
                    STOP_REQUESTED.store(true, Ordering::Relaxed);
                    uc.emu_stop().unwrap();
                }
                _ => {
                    error!("intr_hook intno={:08x}", exception);
                    std::process::exit(1);
                }
            }
        }).expect("add_intr_hook failed");
    }

    sys.uc.borrow_mut().add_insn_invalid_hook(|uc| {
        let (pc, size) = unsafe { LAST_INSTRUCTION };
        let mut instruction = [0u8; 2];
        if uc.mem_read(pc as u64, &mut instruction).is_ok() &&
            matches!(instruction, [0x20, 0xBF] | [0x30, 0xBF] | [0x40, 0xBF])
        {
            // Unicorn 2 reports Cortex-M WFE/SEV as invalid. With no second
            // radio core scheduled, both are safe synchronization no-ops.
            uc.reg_write(RegisterARM::PC, thumb(pc as u64 + size as u64)).unwrap();
            return true;
        }
        false
    }).expect("add_insn_invalid_hook failed");

    uc.add_mem_hook(HookType::MEM_UNMAPPED, 0, u64::MAX, |uc, type_, addr, size, value| {
        if type_ == MemType::WRITE_UNMAPPED {
            warn!("{:?} addr=0x{:08x} size={} value=0x{:08x}", type_, addr, size, value);
        } else {
            warn!("{:?} addr=0x{:08x} size={}", type_, addr, size);
        }

        unsafe {
            let pc = uc.reg_read(RegisterARM::PC).expect("failed to get pc");
            assert!(pc as u32 == LAST_INSTRUCTION.0);
            uc.reg_write(RegisterARM::PC, thumb(pc as u64 + LAST_INSTRUCTION.1 as u64)).unwrap();
        }

        CONTINUE_EXECUTION.store(true, Ordering::Release);

        false
    }).expect("add_mem_hook failed");

    let vector_table = VectorTable::from_memory(&uc, vector_table_addr)?;
    let mut pc = vector_table.reset as u64;
    // Reset hardware loads MSP from vector word zero. Initialize every exposed
    // SP view explicitly so resumed M-profile execution begins in reset state.
    uc.reg_write(RegisterARM::SP, vector_table.sp.into()).map_err(UniErr)?;
    uc.reg_write(RegisterARM::MSP, vector_table.sp.into()).map_err(UniErr)?;
    uc.reg_write(RegisterARM::PSP, vector_table.sp.into()).map_err(UniErr)?;
    // Cortex-M reset state. Unicorn does not consistently zero all special
    // registers when an M-class instance is created.
    uc.reg_write(RegisterARM::PRIMASK, 0).map_err(UniErr)?;
    uc.reg_write(RegisterARM::BASEPRI, 0).map_err(UniErr)?;
    uc.reg_write(RegisterARM::CONTROL, 0).map_err(UniErr)?;
    uc.reg_write(RegisterARM::IPSR, 0).map_err(UniErr)?;
    //uc.reg_write(RegisterARM::LR, 0xFFFF_FFFF).map_err(UniErr)?;

    info!("Starting emulation");

    loop {
        let max_instructions = args.max_instructions.map(|limit|
            limit.saturating_sub(NUM_INSTRUCTIONS.load(Ordering::Relaxed))
        );
        if max_instructions == Some(0) {
            info!("Reached target number of instructions. Done");
            break;
        }

        let result = uc.emu_start(
            // Unicorn reports the architectural (even) PC when a bounded
            // chunk or hook stops. Every Cortex-M resume still needs the
            // Thumb-state bit, just like the reset vector does.
            thumb(pc),
            args.stop_addr.unwrap_or(0) as u64,
            0,
            max_instructions.unwrap_or(0) as usize,
        ).map_err(UniErr);
        pc = uc.reg_read(RegisterARM::PC).expect("failed to get pc");

        if VIRTUAL_ENCLAVE_BOUNDARY_REQUESTED.swap(false, Ordering::AcqRel) {
            let keys_total = uc.reg_read(RegisterARM::R0).map_err(UniErr)?;
            let keys_valid = uc.reg_read(RegisterARM::R1).map_err(UniErr)?;
            uc.mem_write(keys_total, &[10]).map_err(UniErr)?;
            uc.mem_write(keys_valid, &[10]).map_err(UniErr)?;
            uc.reg_write(RegisterARM::R0, 1).map_err(UniErr)?;
            pc = uc.reg_read(RegisterARM::LR).map_err(UniErr)? & !1;
            uc.reg_write(RegisterARM::PC, pc).map_err(UniErr)?;
            crate::peripherals::gpio::set_button_ui_ready(true);
            info!("Virtual secure enclave ready for firmware simulation");
            continue;
        }

        if INTERRUPT_BOUNDARY_REQUESTED.swap(false, Ordering::AcqRel) {
            {
                let boundary_sys = System {
                    uc: RefCell::new(&mut uc),
                    p: runtime_peripherals.clone(),
                    d: runtime_devices.clone(),
                };
                runtime_peripherals
                    .nvic
                    .borrow_mut()
                    .run_pending_interrupts(&boundary_sys, vector_table_addr);
            }
            pc = uc.reg_read(RegisterARM::PC).expect("failed to get interrupt vector");
            continue;
        }

        if STOP_ADDRESS_REACHED.swap(false, Ordering::AcqRel) {
            info!("Stop address reached, stopping");
            break;
        }

        if STOP_REQUESTED.load(Ordering::Relaxed) {
            info!("Stop requested");
            break;
        }

        if let Err(e) = result {
            if CONTINUE_EXECUTION.swap(false, Ordering::AcqRel) {
                // This was a bad memory access, we keep going.
                if crate::verbose() >= 3 {
                    trace!("Resuming execution pc={:08x}", pc);
                }
                pc = thumb(pc);
                continue;
            } else {
                error!("Unrecoverable emulator error at pc=0x{:08x}", pc);
                dump_stack(&mut uc, 8);
                bail!(e);
            }
        }

        if args.stop_addr == Some(pc as u32) {
            info!("Stop address reached, stopping");
            break;
        }

        if BUSY_LOOP_REACHED.load(Ordering::Relaxed) {
            break;
        }
    }

    if let Some(n) = args.dump_stack {
        dump_stack(&mut uc, n);
    }

    for fb in framebuffers.images {
        fb.borrow().write_to_disk()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        find_enclave_verify, ENCLAVE_VERIFY_LOOP_TAIL, ENCLAVE_VERIFY_LOOP_TAIL_OFFSET,
        ENCLAVE_VERIFY_PROLOGUE,
    };

    fn insert_verifier(image: &mut [u8], offset: usize) {
        image[offset..offset + ENCLAVE_VERIFY_PROLOGUE.len()]
            .copy_from_slice(ENCLAVE_VERIFY_PROLOGUE);
        let tail = offset + ENCLAVE_VERIFY_LOOP_TAIL_OFFSET;
        image[tail..tail + ENCLAVE_VERIFY_LOOP_TAIL.len()]
            .copy_from_slice(ENCLAVE_VERIFY_LOOP_TAIL);
    }

    #[test]
    fn finds_one_structurally_matching_enclave_verifier() {
        let mut image = vec![0u8; 512];
        insert_verifier(&mut image, 37);

        assert_eq!(find_enclave_verify(&image), Some(37));
    }

    #[test]
    fn rejects_missing_or_ambiguous_enclave_verifiers() {
        let mut image = vec![0u8; 512];
        assert_eq!(find_enclave_verify(&image), None);

        insert_verifier(&mut image, 17);
        insert_verifier(&mut image, 211);
        assert_eq!(find_enclave_verify(&image), None);
    }
}
