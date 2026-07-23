// SPDX-License-Identifier: GPL-3.0-or-later

use std::{cell::Cell, rc::Rc};

use anyhow::Result;
use serde::Deserialize;

use crate::{
    peripherals::gpio::{GpioPorts, Pin},
    system::System,
};

use super::ExtDevice;

#[derive(Debug, Deserialize)]
pub struct St7567Config {
    pub peripheral: String,
    pub data_command: String,
    pub chip_select: String,
}

pub struct St7567 {
    pub config: St7567Config,
    name: String,
    data_mode: Rc<Cell<bool>>,
    selected: Rc<Cell<bool>>,
    page: usize,
    column: usize,
    ram: Vec<u8>,
    dirty: bool,
}

impl St7567 {
    pub fn new(config: St7567Config, gpio: &mut GpioPorts) -> Result<Self> {
        let data_mode = Rc::new(Cell::new(false));
        let selected = Rc::new(Cell::new(false));
        let data_pin = Pin::from_str(&config.data_command);
        let select_pin = Pin::from_str(&config.chip_select);
        let data_state = data_mode.clone();
        let select_state = selected.clone();
        gpio.add_write_callback(data_pin, move |_sys, value| data_state.set(value));
        gpio.add_write_callback(select_pin, move |_sys, value| select_state.set(!value));
        Ok(Self {
            config,
            name: String::new(),
            data_mode,
            selected,
            page: 0,
            column: 0,
            ram: vec![0; 128 * 8],
            dirty: false,
        })
    }

    fn command(&mut self, value: u8) {
        match value {
            0xB0..=0xB7 => self.page = (value & 0x07) as usize,
            0x00..=0x0F => self.column = (self.column & 0xF0) | value as usize,
            0x10..=0x1F => self.column = (self.column & 0x0F) | (((value & 0x0F) as usize) << 4),
            0xE2 => {
                self.page = 0;
                self.column = 0;
                self.ram.fill(0);
                self.dirty = true;
            }
            _ => {}
        }
    }

    fn data(&mut self, value: u8) {
        // The controller exposes 132 columns; Flipper uses the visible 128.
        if self.page < 8 && self.column < 128 {
            self.ram[self.page * 128 + self.column] = value;
            self.dirty = true;
        }
        self.column = (self.column + 1) % 132;
        if self.dirty && self.page == 7 && self.column >= 128 {
            let mut encoded = String::with_capacity(self.ram.len() * 2);
            for byte in &self.ram {
                use std::fmt::Write;
                let _ = write!(encoded, "{:02x}", byte);
            }
            info!("FLIPPER_FRAME {}", encoded);
            self.dirty = false;
        }
    }
}

impl ExtDevice<(), u8> for St7567 {
    fn connect_peripheral(&mut self, peripheral: &str) -> String {
        self.name = format!("{} ST7567", peripheral);
        self.name.clone()
    }

    fn read(&mut self, _sys: &System, _addr: ()) -> u8 {
        0
    }

    fn write(&mut self, _sys: &System, _addr: (), value: u8) {
        if !self.selected.get() {
            return;
        }
        if self.data_mode.get() {
            self.data(value);
        } else {
            self.command(value);
        }
    }

    fn is_selected(&self) -> bool {
        self.selected.get()
    }
}
