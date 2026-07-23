// SPDX-License-Identifier: GPL-3.0-or-later

pub mod dma;
pub mod dwt;
pub mod fsmc;
pub mod gpio;
pub mod i2c;
pub mod nvic;
pub mod rcc;
pub mod rtc;
pub mod scb;
pub mod spi;
pub mod sw_spi;
pub mod systick;
pub mod timer;
pub mod usart;

use dma::*;
use dwt::*;
use fsmc::*;
use gpio::*;
use i2c::*;
use nvic::*;
use rcc::*;
use rtc::*;
use scb::*;
use serde::Deserialize;
use spi::*;
use sw_spi::*;
use systick::*;
use timer::*;
use usart::*;

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap, VecDeque},
};
use svd_parser::svd::{Device as SvdDevice, RegisterInfo};

use crate::{ext_devices::ExtDevices, system::System};

#[derive(Debug, Deserialize, Default)]
pub struct PeripheralsConfig {
    pub software_spi: Option<Vec<SoftwareSpiConfig>>,
}

#[derive(Default)]
pub struct Peripherals {
    debug_peripherals: Vec<PeripheralSlot<GenericPeripheral>>,
    peripherals: Vec<PeripheralSlot<RefCell<Box<dyn Peripheral>>>>,
    pub nvic: RefCell<Nvic>,
    pub gpio: RefCell<GpioPorts>,
}

pub struct PeripheralSlot<T> {
    pub start: u32,
    pub end: u32,
    pub peripheral: T,
}

impl Peripherals {
    // start - end regions
    pub const MEMORY_MAPS: [(u32, u32); 2] =
        [(0x4000_0000, 0xB000_0000), (0xE000_0000, 0xE100_0000)];

    pub fn register_peripheral(
        &mut self,
        name: String,
        base: u32,
        registers: &[RegisterInfo],
        ext_devices: &ExtDevices,
    ) {
        let p = GenericPeripheral::new(name.clone(), registers);

        let (start, end) = (base, base + p.size());

        trace!(
            "Peripheral start=0x{:08x} end=0x{:08x} name={}",
            start,
            end,
            p.name()
        );

        self.debug_peripherals.push(PeripheralSlot {
            start,
            end,
            peripheral: p,
        });

        // The debug peripheral is just for to print registers right now. So we
        // change the (start, end) only for the real peripheral.
        let (start, end) = match name.as_str() {
            "FSMC" => (0x6000_0000, 0xA000_1000),
            _ => (start, end),
        };

        let p = None
            .or_else(|| NvicWrapper::new(&name))
            .or_else(|| SysTick::new(&name))
            .or_else(|| Scb::new(&name))
            .or_else(|| Gpio::new(&name))
            .or_else(|| Usart::new(&name, ext_devices))
            .or_else(|| Tim16Speaker::new(&name))
            .or_else(|| Fsmc::new(&name, ext_devices))
            .or_else(|| Rcc::new(&name))
            .or_else(|| Rtc::new(&name))
            .or_else(|| I2c::new(&name))
            .or_else(|| Dma::new(&name, registers))
            .or_else(|| Spi::new(&name, ext_devices))
            .or_else(|| Some(Box::new(RegisterBank::default())));

        if let Some(p) = p {
            self.peripherals.push(PeripheralSlot {
                start,
                end,
                peripheral: RefCell::new(p),
            });
        }
    }

    pub fn finish_registration(&mut self) {
        // We sort because we do binary searches to find peripherals
        self.debug_peripherals.sort_by_key(|p| p.start);
        self.peripherals.sort_by_key(|p| p.start);

        {
            // Let's check that peripherals don't overlap
            let a = self.debug_peripherals.iter();
            let mut b = self.debug_peripherals.iter();
            b.next();

            for (p1, p2) in a.zip(b) {
                if p1.end >= p2.start {
                    warn!(
                        "Overlapping SVD register blocks between {} and {}; debug names may be approximate",
                        p1.peripheral.name(),
                        p2.peripheral.name());
                }
            }
        }
    }

    pub fn from_svd(
        mut svd_device: SvdDevice,
        config: PeripheralsConfig,
        gpio: GpioPorts,
        ext_devices: &ExtDevices,
    ) -> Self {
        let mut peripherals = Self {
            gpio: RefCell::new(gpio),
            ..Peripherals::default()
        };

        svd_device.peripherals.sort_by_key(|f| f.base_address);
        let svd_peripherals = svd_device
            .peripherals
            .iter()
            .map(|d| (d.name.to_string(), d))
            .collect::<HashMap<_, _>>();

        for p in &svd_device.peripherals {
            let name = &p.name;
            let base = p.base_address;

            let p = if let Some(derived_from) = p.derived_from.as_ref() {
                svd_peripherals
                    .get(derived_from)
                    .as_ref()
                    .unwrap_or_else(|| panic!("Cannot find peripheral {}", derived_from))
            } else {
                p
            };

            let regs = crate::util::extract_svd_registers(p);

            peripherals.register_peripheral(name.to_string(), base as u32, &regs, ext_devices);

            if crate::verbose() >= 3 {
                for r in &regs {
                    trace!(
                        "p={} addr=0x{:08x} reg_name={}",
                        p.name,
                        p.base_address as u32 + r.address_offset,
                        r.name
                    );
                }
            }
        }

        // Cortex-M DWT is not present in the STM32WB55 peripheral SVD, but
        // Flipper's microsecond delays depend on CYCCNT advancing.
        peripherals.peripherals.push(PeripheralSlot {
            start: 0xE000_1000,
            end: 0xE000_1FFF,
            peripheral: RefCell::new(Box::new(Dwt)),
        });

        for sw_spi_config in config.software_spi.unwrap_or_default() {
            SoftwareSpi::register(
                sw_spi_config,
                &mut peripherals.gpio.borrow_mut(),
                ext_devices,
            );
        }

        peripherals.finish_registration();
        peripherals
    }

    /////////////////////////////////////////////////////////////////////////////////////////////////////////////

    pub fn get_peripheral<T>(
        peripherals: &Vec<PeripheralSlot<T>>,
        addr: u32,
    ) -> Option<&PeripheralSlot<T>> {
        let index = peripherals
            .binary_search_by_key(&addr, |p| p.start)
            .map_or_else(|e| e.checked_sub(1), |v| Some(v));

        index
            .map(|i| peripherals.get(i).filter(|p| addr <= p.end))
            .flatten()
    }

    pub fn addr_desc(&self, addr: u32) -> String {
        if let Some(p) = Self::get_peripheral(&self.debug_peripherals, addr) {
            format!(
                "addr=0x{:08x} peri={} {}",
                addr,
                p.peripheral.name,
                p.peripheral.reg_name(addr - p.start)
            )
        } else {
            format!("addr=0x{:08x} peri=????", addr)
        }
    }

    fn bitbanding(addr: u32) -> Option<(u32, u8)> {
        if (0x4200_0000..0x4400_0000).contains(&addr) {
            //let old_addr = addr;
            let bit_number = (addr % 32) / 4;
            let addr = 0x4000_0000 + (addr - 0x4200_0000) / 32;
            //trace!("bitbanding: 0x{:08x} -> addr=0x{:08x} bit={}", old_addr, addr, bit_number);
            return Some((addr, bit_number as u8));
        } else {
            None
        }
    }

    fn is_register(addr: u32) -> bool {
        // this is avoiding the FSMC banks, essentially
        !(0x6000_0000..0xA000_0000).contains(&addr)
    }

    fn align_addr_4(addr: u32) -> (u32, u8) {
        let byte_offset = (addr % 4) as u8;
        let addr = addr - byte_offset as u32;
        (addr, byte_offset)
    }

    pub fn read(&self, sys: &System, addr: u32, size: u8) -> u32 {
        if let Some((addr, bit_number)) = Self::bitbanding(addr) {
            return (self.read(sys, addr, 1) >> bit_number) & 1;
        }
        // EXTI_PR1 is write-one-to-clear. Button edges arrive from the
        // emulator control thread, so expose their pending lines to the
        // firmware IRQ handlers instead of the passive SVD register bank.
        if addr == 0x5800_080C {
            return gpio::exti_pending();
        }
        // STM32WB55 LPUART1 lacks its own address block in ST's SVD and may
        // otherwise be hidden by an adjacent inherited peripheral slot.
        if addr == 0x4000_801C || addr == 0x4001_381C {
            return (1 << 7) | (1 << 6) | (1 << 21) | (1 << 22);
        }
        // HSEM_HWCFGR: four hardware semaphores, matching STM32WB55.
        if addr == 0x5800_1494 {
            return 0x8000_0400;
        }
        if (0x5800_1480..=0x5800_14FC).contains(&addr) {
            // HSEM_RLR: one-step locks are immediately owned by CPU1.
            return 0x8000_0400;
        }
        if addr == 0x5800_1004 {
            return 1; // RNG_SR.DRDY
        }
        if addr == 0x5800_1008 {
            return (crate::emulator::NUM_INSTRUCTIONS.load(std::sync::atomic::Ordering::Relaxed)
                as u32)
                .wrapping_mul(0x9E37_79B9)
                .rotate_left(13);
        }

        let (addr, byte_offset) = if Self::is_register(addr) {
            // Reduce the access to 4 byte alignements to make things easier when dealing with registers
            Self::align_addr_4(addr)
        } else {
            (addr, 0)
        };

        assert!(byte_offset + size <= 4);

        let value = if let Some(p) = Self::get_peripheral(&self.peripherals, addr) {
            p.peripheral.borrow_mut().read(sys, addr - p.start) << (8 * byte_offset)
        } else {
            0
        };

        if crate::verbose() >= 3 {
            trace!("read:  {} read=0x{:08x}", self.addr_desc(addr), value);
        }

        value
    }

    pub fn write(&self, sys: &System, addr: u32, size: u8, mut value: u32) {
        if let Some((addr, bit_number)) = Self::bitbanding(addr) {
            let mut v = self.read(sys, addr, 1);
            v &= 1 << bit_number;
            v |= (value & 1) << bit_number;
            return self.write(sys, addr, 1, v);
        }
        if addr == 0x5800_080C {
            gpio::clear_exti_pending(value);
            return;
        }

        let (addr, byte_offset) = if Self::is_register(addr) {
            // Reduce the access to 4 byte alignements to make things easier when dealing with registers
            Self::align_addr_4(addr)
        } else {
            (addr, 0)
        };

        assert!(byte_offset + size <= 4);

        if byte_offset != 0 {
            let v = self.read(sys, addr, 4);
            value = (value << 8 * byte_offset) | (v & (0xFFFF_FFFF >> (32 - 8 * byte_offset)));
        }

        if let Some(p) = Self::get_peripheral(&self.peripherals, addr) {
            p.peripheral.borrow_mut().write(sys, addr - p.start, value)
        }

        if crate::verbose() >= 3 {
            trace!("write: {} write=0x{:08x}", self.addr_desc(addr), value);
        }
    }
}

pub trait Peripheral {
    fn read(&mut self, sys: &System, offset: u32) -> u32;
    fn write(&mut self, sys: &System, offset: u32, value: u32);

    fn read_dma(&mut self, sys: &System, offset: u32, size: usize) -> VecDeque<u8> {
        let mut v = VecDeque::with_capacity(size);
        for _ in 0..size {
            v.push_back(self.read(sys, offset) as u8);
        }
        v
    }
    fn write_dma(&mut self, sys: &System, offset: u32, value: VecDeque<u8>) {
        for v in value.into_iter() {
            self.write(sys, offset, v.into());
        }
    }
}

#[derive(Default)]
struct RegisterBank {
    values: HashMap<u32, u32>,
}

impl Peripheral for RegisterBank {
    fn read(&mut self, _sys: &System, offset: u32) -> u32 {
        self.values.get(&offset).copied().unwrap_or(0)
    }

    fn write(&mut self, _sys: &System, offset: u32, value: u32) {
        self.values.insert(offset, value);
    }
}

struct GenericPeripheral {
    pub name: String,
    // offset -> name
    pub registers: BTreeMap<u32, RegisterInfo>,
}

impl GenericPeripheral {
    pub fn new(name: String, registers: &[RegisterInfo]) -> Self {
        let registers = registers
            .iter()
            .map(|r| (r.address_offset, r.clone()))
            .collect();

        Self { name, registers }
    }

    pub fn reg_name(&self, offset: u32) -> String {
        assert!(offset % 4 == 0);
        let reg = self.registers.get(&offset);
        reg.map(|r| &r.name)
            .map(|r| format!("offset=0x{:04x} reg={}", offset, r))
            .unwrap_or_else(|| format!("offset=0x{:04x} reg=????", offset))
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn size(&self) -> u32 {
        self.registers.keys().cloned().max().unwrap_or(0) + 4
    }
}
