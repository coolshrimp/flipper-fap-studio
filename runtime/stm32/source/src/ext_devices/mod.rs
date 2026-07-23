// SPDX-License-Identifier: GPL-3.0-or-later

mod display;
mod lcd;
mod sd_card;
mod spi_flash;
mod st7567;
mod touchscreen;
mod usart_probe;

use display::{Display, DisplayConfig};
use lcd::{Lcd, LcdConfig};
use sd_card::{SdCard, SdCardConfig};
use spi_flash::{SpiFlash, SpiFlashConfig};
use st7567::{St7567, St7567Config};
use touchscreen::{Touchscreen, TouchscreenConfig};
use usart_probe::{UsartProbe, UsartProbeConfig};

use anyhow::Result;
use serde::Deserialize;
use std::{cell::RefCell, rc::Rc};

use crate::{framebuffers::Framebuffers, peripherals::gpio::GpioPorts, system::System};

#[derive(Debug, Deserialize, Default)]
pub struct ExtDevicesConfig {
    pub spi_flash: Option<Vec<SpiFlashConfig>>,
    pub sd_card: Option<Vec<SdCardConfig>>,
    pub usart_probe: Option<Vec<UsartProbeConfig>>,
    pub display: Option<Vec<DisplayConfig>>,
    pub lcd: Option<Vec<LcdConfig>>,
    pub touchscreen: Option<Vec<TouchscreenConfig>>,
    pub st7567: Option<Vec<St7567Config>>,
}

pub struct ExtDevices {
    pub spi_flashes: Vec<Rc<RefCell<SpiFlash>>>,
    pub sd_cards: Vec<Rc<RefCell<SdCard>>>,
    pub usart_probes: Vec<Rc<RefCell<UsartProbe>>>,
    pub displays: Vec<Rc<RefCell<Display>>>,
    pub lcds: Vec<Rc<RefCell<Lcd>>>,
    pub touchscreens: Vec<Rc<RefCell<Touchscreen>>>,
    pub st7567: Vec<Rc<RefCell<St7567>>>,
}

impl ExtDevices {
    pub fn find_serial_device(
        &self,
        peri_name: &str,
    ) -> Option<Rc<RefCell<dyn ExtDevice<(), u8>>>> {
        self.spi_flashes
            .iter()
            .filter(|d| d.borrow().config.peripheral == peri_name)
            .next()
            .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>)
            .or_else(|| {
                self.usart_probes
                    .iter()
                    .filter(|d| d.borrow().config.peripheral == peri_name)
                    .next()
                    .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>)
            })
            .or_else(|| {
                self.lcds
                    .iter()
                    .filter(|d| d.borrow().config.peripheral == peri_name)
                    .next()
                    .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>)
            })
            .or_else(|| {
                self.st7567
                    .iter()
                    .filter(|d| d.borrow().config.peripheral == peri_name)
                    .next()
                    .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>)
            })
            .or_else(|| {
                self.touchscreens
                    .iter()
                    .filter(|d| d.borrow().config.peripheral == peri_name)
                    .next()
                    .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>)
            })
    }

    /// Return every device attached to a hardware SPI peripheral.
    ///
    /// Several boards use chip-select lines to share one physical SPI bus.
    /// In particular, Flipper Zero's ST7567 display and microSD card both use
    /// SPI2. USART and the legacy board profiles still use the single-device
    /// lookup above.
    pub fn find_spi_devices(&self, peri_name: &str) -> Vec<Rc<RefCell<dyn ExtDevice<(), u8>>>> {
        let mut devices: Vec<Rc<RefCell<dyn ExtDevice<(), u8>>>> = Vec::new();

        devices.extend(
            self.spi_flashes
                .iter()
                .filter(|d| d.borrow().config.peripheral == peri_name)
                .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>),
        );
        devices.extend(
            self.sd_cards
                .iter()
                .filter(|d| d.borrow().config.peripheral == peri_name)
                .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>),
        );
        devices.extend(
            self.st7567
                .iter()
                .filter(|d| d.borrow().config.peripheral == peri_name)
                .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>),
        );
        devices.extend(
            self.lcds
                .iter()
                .filter(|d| d.borrow().config.peripheral == peri_name)
                .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>),
        );
        devices.extend(
            self.touchscreens
                .iter()
                .filter(|d| d.borrow().config.peripheral == peri_name)
                .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<(), u8>>>),
        );

        devices
    }

    pub fn find_mem_device(&self, peri_name: &str) -> Option<Rc<RefCell<dyn ExtDevice<u32, u32>>>> {
        self.displays
            .iter()
            .filter(|d| d.borrow().config.peripheral == peri_name)
            .next()
            .map(|d| d.clone() as Rc<RefCell<dyn ExtDevice<u32, u32>>>)
    }
}

impl ExtDevicesConfig {
    pub fn into_ext_devices(
        self,
        gpio: &mut GpioPorts,
        framebuffers: &Framebuffers,
    ) -> Result<ExtDevices> {
        let spi_flashes = self
            .spi_flash
            .unwrap_or_default()
            .into_iter()
            .map(|config| SpiFlash::new(config).map(RefCell::new).map(Rc::new))
            .collect::<Result<_>>()?;

        let sd_cards = self
            .sd_card
            .unwrap_or_default()
            .into_iter()
            .map(|config| SdCard::new(config, gpio).map(RefCell::new).map(Rc::new))
            .collect::<Result<_>>()?;

        let usart_probes = self
            .usart_probe
            .unwrap_or_default()
            .into_iter()
            .map(|config| UsartProbe::new(config).map(RefCell::new).map(Rc::new))
            .collect::<Result<_>>()?;

        let displays = self
            .display
            .unwrap_or_default()
            .into_iter()
            .map(|config| {
                Display::new(config, framebuffers)
                    .map(RefCell::new)
                    .map(Rc::new)
            })
            .collect::<Result<_>>()?;

        let lcds = self
            .lcd
            .unwrap_or_default()
            .into_iter()
            .map(|config| {
                Lcd::new(config, framebuffers)
                    .map(RefCell::new)
                    .map(Rc::new)
            })
            .collect::<Result<_>>()?;

        let touchscreens = self
            .touchscreen
            .unwrap_or_default()
            .into_iter()
            .map(|config| {
                Touchscreen::new(config, gpio, framebuffers)
                    .map(RefCell::new)
                    .map(Rc::new)
            })
            .collect::<Result<_>>()?;
        let st7567 = self
            .st7567
            .unwrap_or_default()
            .into_iter()
            .map(|config| St7567::new(config, gpio).map(RefCell::new).map(Rc::new))
            .collect::<Result<_>>()?;

        Ok(ExtDevices {
            spi_flashes,
            sd_cards,
            usart_probes,
            displays,
            lcds,
            touchscreens,
            st7567,
        })
    }
}

///////////////////////////////////////////////////////////////////////////////////////

pub trait ExtDevice<A, T> {
    /// Should returns "{peri_name} {ext_device_name}"
    fn connect_peripheral<'a>(&mut self, peri_name: &str) -> String;
    fn read(&mut self, sys: &System, addr: A) -> T;
    fn write(&mut self, sys: &System, addr: A, v: T);

    /// Whether this device currently drives its shared serial bus.
    ///
    /// Devices without a chip-select line retain the historical behavior.
    fn is_selected(&self) -> bool {
        true
    }
}
