// SPDX-License-Identifier: GPL-3.0-or-later

use super::Peripheral;
use crate::system::System;

use regex::Regex;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

const NUM_PORTS: usize = 11;
static BUTTON_UP: AtomicBool = AtomicBool::new(false);
static BUTTON_DOWN: AtomicBool = AtomicBool::new(false);
static BUTTON_LEFT: AtomicBool = AtomicBool::new(false);
static BUTTON_RIGHT: AtomicBool = AtomicBool::new(false);
static BUTTON_OK: AtomicBool = AtomicBool::new(false);
static BUTTON_BACK: AtomicBool = AtomicBool::new(false);
static BUTTON_UP_OBSERVED: AtomicBool = AtomicBool::new(false);
static BUTTON_DOWN_OBSERVED: AtomicBool = AtomicBool::new(false);
static BUTTON_LEFT_OBSERVED: AtomicBool = AtomicBool::new(false);
static BUTTON_RIGHT_OBSERVED: AtomicBool = AtomicBool::new(false);
static BUTTON_OK_OBSERVED: AtomicBool = AtomicBool::new(false);
static BUTTON_BACK_OBSERVED: AtomicBool = AtomicBool::new(false);
static BUTTON_UI_READY: AtomicBool = AtomicBool::new(true);
static BUTTON_IRQS: AtomicU64 = AtomicU64::new(0);
static EXTI_PENDING: AtomicU32 = AtomicU32::new(0);

fn button_observed(name: &str) -> Option<&'static AtomicBool> {
    match name {
        "UP" => Some(&BUTTON_UP_OBSERVED),
        "DOWN" => Some(&BUTTON_DOWN_OBSERVED),
        "LEFT" => Some(&BUTTON_LEFT_OBSERVED),
        "RIGHT" => Some(&BUTTON_RIGHT_OBSERVED),
        "OK" => Some(&BUTTON_OK_OBSERVED),
        "BACK" => Some(&BUTTON_BACK_OBSERVED),
        _ => None,
    }
}

/// Wait until firmware has sampled a button's idle level once.
///
/// Flipper logs "Startup complete" before InputSrv has initialized its GPIO
/// baseline. Applying a host press in that small window makes the pressed
/// level become the baseline, so firmware later emits a Short/Release without
/// the complementary Press and the GUI discards it. The stdin control thread
/// can wait here without stalling emulation.
pub fn wait_button_ready(name: &str, timeout: Duration) {
    let Some(observed) = button_observed(name) else {
        return;
    };
    let deadline = Instant::now() + timeout;
    while !(observed.load(Ordering::Acquire) && BUTTON_UI_READY.load(Ordering::Acquire))
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(1));
    }
}

pub fn set_button_ui_ready(ready: bool) {
    BUTTON_UI_READY.store(ready, Ordering::Release);
}

pub fn set_button(name: &str, pressed: bool) -> bool {
    let (state, irq, exti_line) = match name {
        "UP" => (&BUTTON_UP, 40, 10),
        "DOWN" => (&BUTTON_DOWN, 23, 6),
        "LEFT" => (&BUTTON_LEFT, 40, 11),
        "RIGHT" => (&BUTTON_RIGHT, 40, 12),
        "OK" => (&BUTTON_OK, 9, 3),
        "BACK" => (&BUTTON_BACK, 40, 13),
        _ => return false,
    };
    if state.swap(pressed, Ordering::AcqRel) == pressed {
        return true;
    }
    // Flipper's GPIO IRQ handlers dispatch callbacks only for EXTI lines
    // whose PR1 bit is set. Raising the NVIC vector alone enters the handler,
    // but it immediately returns without notifying the input service.
    EXTI_PENDING.fetch_or(1u32 << exti_line, Ordering::AcqRel);
    BUTTON_IRQS.fetch_or(1u64 << irq, Ordering::AcqRel);
    true
}

pub fn take_button_irqs() -> u64 {
    BUTTON_IRQS.swap(0, Ordering::AcqRel)
}

pub fn exti_pending() -> u32 {
    EXTI_PENDING.load(Ordering::Acquire)
}

pub fn clear_exti_pending(lines: u32) {
    EXTI_PENDING.fetch_and(!lines, Ordering::AcqRel);
}

fn button_pin_level(state: &AtomicBool, observed: &AtomicBool, active_low: bool) -> bool {
    observed.store(true, Ordering::Release);
    let pressed = state.load(Ordering::Acquire);
    if active_low {
        !pressed
    } else {
        pressed
    }
}

#[derive(Clone, Copy)]
pub struct Pin {
    port: u8,
    pin: u8,
}

impl Pin {
    pub fn from_str(name: &str) -> Self {
        let name = name.to_uppercase();
        let re = Regex::new(r"^P?([A-Z])(\d+)$").unwrap();
        let captures = re.captures(&name).expect("Pin name invalid");
        let port = captures.get(1).unwrap().as_str().chars().next().unwrap();
        let port = GpioPorts::port_index(port);
        let pin = captures.get(2).unwrap().as_str().parse().unwrap();
        assert!(pin < 16);
        Self { port, pin }
    }
}

pub struct GpioPorts {
    read_callbacks: [Vec<(u8, Box<dyn FnMut(&System) -> bool>)>; NUM_PORTS],
    write_callbacks: [Vec<(u8, Box<dyn FnMut(&System, bool)>)>; NUM_PORTS],
}

impl Default for GpioPorts {
    fn default() -> Self {
        let mut ports = Self {
            read_callbacks: Default::default(),
            write_callbacks: Default::default(),
        };
        for (pin, state, observed, active_low) in [
            ("PB10", &BUTTON_UP, &BUTTON_UP_OBSERVED, true),
            ("PC6", &BUTTON_DOWN, &BUTTON_DOWN_OBSERVED, true),
            ("PB11", &BUTTON_LEFT, &BUTTON_LEFT_OBSERVED, true),
            ("PB12", &BUTTON_RIGHT, &BUTTON_RIGHT_OBSERVED, true),
            // Unlike the other navigation keys, OK is pulled down and is
            // active-high on real Flipper Zero hardware.
            ("PH3", &BUTTON_OK, &BUTTON_OK_OBSERVED, false),
            ("PC13", &BUTTON_BACK, &BUTTON_BACK_OBSERVED, true),
        ] {
            ports.add_read_callback(Pin::from_str(pin), move |_sys| {
                button_pin_level(state, observed, active_low)
            });
        }
        ports
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_edges_have_the_flipper_pin_polarity_exti_line_and_irq() {
        BUTTON_UI_READY.store(true, Ordering::Release);
        let cases = [
            ("UP", &BUTTON_UP, &BUTTON_UP_OBSERVED, true, 10, 40),
            ("DOWN", &BUTTON_DOWN, &BUTTON_DOWN_OBSERVED, true, 6, 23),
            ("LEFT", &BUTTON_LEFT, &BUTTON_LEFT_OBSERVED, true, 11, 40),
            ("RIGHT", &BUTTON_RIGHT, &BUTTON_RIGHT_OBSERVED, true, 12, 40),
            ("OK", &BUTTON_OK, &BUTTON_OK_OBSERVED, false, 3, 9),
            ("BACK", &BUTTON_BACK, &BUTTON_BACK_OBSERVED, true, 13, 40),
        ];

        for (name, state, observed, active_low, exti_line, irq) in cases {
            state.store(false, Ordering::Release);
            observed.store(false, Ordering::Release);
            BUTTON_IRQS.store(0, Ordering::Release);
            EXTI_PENDING.store(0, Ordering::Release);

            assert!(
                !observed.load(Ordering::Acquire),
                "{name} starts unobserved"
            );
            assert_eq!(
                button_pin_level(state, observed, active_low),
                active_low,
                "{name} idle"
            );
            assert!(observed.load(Ordering::Acquire), "{name} becomes ready");
            assert!(set_button(name, true));
            assert_eq!(
                button_pin_level(state, observed, active_low),
                !active_low,
                "{name} pressed"
            );
            assert_eq!(exti_pending(), 1 << exti_line, "{name} EXTI press");
            assert_eq!(take_button_irqs(), 1 << irq, "{name} IRQ press");

            clear_exti_pending(1 << exti_line);
            assert!(set_button(name, false));
            assert_eq!(
                button_pin_level(state, observed, active_low),
                active_low,
                "{name} released"
            );
            assert_eq!(exti_pending(), 1 << exti_line, "{name} EXTI release");
            assert_eq!(take_button_irqs(), 1 << irq, "{name} IRQ release");
        }

        EXTI_PENDING.store((1 << 3) | (1 << 6), Ordering::Release);
        clear_exti_pending(1 << 3);
        assert_eq!(
            exti_pending(),
            1 << 6,
            "PR1 writes clear only selected lines"
        );
    }
}

impl GpioPorts {
    pub fn port_index(letter: char) -> u8 {
        match letter {
            'A'..='K' => letter as u8 - 'A' as u8,
            _ => panic!("Invalid GPIO port {}", letter),
        }
    }

    pub fn add_read_callback(&mut self, pin: Pin, cb: impl FnMut(&System) -> bool + 'static) {
        self.read_callbacks[pin.port as usize].push((pin.pin, Box::new(cb)));
    }

    pub fn add_write_callback(&mut self, pin: Pin, cb: impl FnMut(&System, bool) + 'static) {
        self.write_callbacks[pin.port as usize].push((pin.pin, Box::new(cb)));
    }

    pub fn read_port(&mut self, sys: &System, port: u8) -> u16 {
        // Flipper's navigation keys and boot strap inputs are active-low.
        // Floating every unmodelled pin low forces DFU/recovery at boot, so
        // treat unconnected inputs as pulled high and let devices pull them low.
        let mut v = u16::MAX;
        for (pin, cb) in &mut self.read_callbacks[port as usize] {
            if cb(sys) {
                v |= 1 << *pin;
            } else {
                v &= !(1 << *pin);
            }
        }
        v
    }

    pub fn write_port(&mut self, sys: &System, port: u8, pin: u8, value: bool) {
        for (pin_cb, cb) in &mut self.write_callbacks[port as usize] {
            if *pin_cb == pin {
                cb(sys, value);
            }
        }
    }
}

#[derive(Default)]
pub struct Gpio {
    port_letter: char,
    port: u8,

    mode: u32,
    otype: u32,
    ospeed: u32,
    pupd: u32,
    od: u32,
    lck: u32,
    afrl: u32,
    afrh: u32,
}

impl Gpio {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        if let Some(block) = name.strip_prefix("GPIO") {
            let port_letter = block.chars().next().unwrap();
            let port = GpioPorts::port_index(port_letter);
            Some(Box::new(Self {
                port_letter,
                port,
                ..Self::default()
            }))
        } else {
            None
        }
    }

    // f(port, values)
    fn iter_port_reg_changes(
        old_value: u32,
        new_value: u32,
        stride: u8,
        mut f: impl FnMut(u8, u8),
    ) {
        let mut changes = old_value ^ new_value;
        let stride_mask = 0xFF >> (8 - stride);
        while changes != 0 {
            let right_most_bit = changes.trailing_zeros() as u8;
            let pin = right_most_bit / stride;
            if pin <= 16 {
                let v = (new_value >> (pin * stride)) as u8 & stride_mask;
                f(pin, v);
            }
            changes &= !(stride_mask as u32) << (pin * stride);
        }
    }

    fn port_str(&self, pin: u8) -> String {
        format!("GPIO{} P{}{}", self.port_letter, self.port_letter, pin)
    }
}

impl Peripheral for Gpio {
    fn read(&mut self, sys: &System, offset: u32) -> u32 {
        match offset {
            0x0000 => self.mode,
            0x0004 => self.otype,
            0x0008 => self.ospeed,
            0x000C => self.pupd,
            0x0010 => {
                let v = sys.p.gpio.borrow_mut().read_port(sys, self.port);
                trace!("GPIO{} read v=0x{:04x}", self.port_letter, v);
                v as u32
            }
            0x0014 => self.od,
            0x0018 => 0, // bsr
            0x001C => self.lck,
            0x0020 => self.afrl,
            0x0024 => self.afrh,
            _ => {
                warn!("GPIO invalid offset=0x{:08x}", offset);
                0
            }
        }
    }

    fn write(&mut self, sys: &System, offset: u32, value: u32) {
        match offset {
            0x0000 => {
                Self::iter_port_reg_changes(self.mode, value, 2, |pin, v| {
                    let config = match v {
                        0b00 => "input",
                        0b01 => "output",
                        0b10 => "alternate",
                        0b11 => "analog",
                        _ => unreachable!(),
                    };
                    trace!("{} mode={}", self.port_str(pin), config);
                });
                self.mode = value;
            }
            0x0004 => {
                Self::iter_port_reg_changes(self.otype, value, 1, |pin, v| {
                    let config = match v {
                        0b0 => "push-pull",
                        0b1 => "open-drain",
                        _ => unreachable!(),
                    };
                    trace!("{} output_cfg={}", self.port_str(pin), config);
                });
                self.otype = value;
            }
            0x0008 => {
                Self::iter_port_reg_changes(self.ospeed, value, 2, |pin, v| {
                    let config = match v {
                        0b00 => "low",
                        0b01 => "medium",
                        0b10 => "high",
                        0b11 => "very-high",
                        _ => unreachable!(),
                    };
                    trace!("{} speed={}", self.port_str(pin), config);
                });
                self.ospeed = value;
            }
            0x000C => {
                Self::iter_port_reg_changes(self.pupd, value, 2, |pin, v| {
                    let config = match v {
                        0b00 => "regular",
                        0b01 => "pull-up",
                        0b10 => "pull-down",
                        0b11 => "reserved",
                        _ => unreachable!(),
                    };
                    trace!("{} input_cfg={}", self.port_str(pin), config);
                });
                self.pupd = value;
            }
            0x0010 => {
                // input data register. read-only
            }
            0x0014 => {
                let mut gpio = sys.p.gpio.borrow_mut();
                Self::iter_port_reg_changes(self.od, value, 1, |pin, v| {
                    gpio.write_port(sys, self.port, pin, v != 0);
                    trace!("{} output={}", self.port_str(pin), v);
                });
                self.od = value;
            }
            0x0018 => {
                let reset = value >> 16;
                let set = value & 0xFFFF;
                let mut gpio = sys.p.gpio.borrow_mut();

                Self::iter_port_reg_changes(0, set, 1, |pin, _| {
                    gpio.write_port(sys, self.port, pin, true);
                    trace!("{} output=1", self.port_str(pin));
                });

                Self::iter_port_reg_changes(0, reset, 1, |pin, _| {
                    gpio.write_port(sys, self.port, pin, false);
                    trace!("{} output=0", self.port_str(pin));
                });

                self.od &= !reset;
                self.od |= set;
            }
            0x001C => {
                trace!("GPIO{} port locked", self.port_letter);
                self.lck = value;
            }
            0x0020 => {
                Self::iter_port_reg_changes(self.afrl, value, 4, |pin, v| {
                    trace!("{} alternate_cfg=AF{}", self.port_str(pin), v);
                });
                self.afrl = value;
            }
            0x0024 => {
                Self::iter_port_reg_changes(self.afrh, value, 4, |pin, v| {
                    trace!("{} alternate_cfg=AF{}", self.port_str(pin + 8), v);
                });
                self.afrh = value;
            }
            _ => {
                warn!("GPIO invalid offset=0x{:08x}", offset);
            }
        }
    }
}
