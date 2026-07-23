use std::collections::HashMap;

use crate::system::System;

use super::Peripheral;

const CR1: u32 = 0x00;
const CCER: u32 = 0x20;
const PSC: u32 = 0x28;
const ARR: u32 = 0x2c;
const CCR1: u32 = 0x34;
const BDTR: u32 = 0x44;

#[derive(Default)]
pub struct Tim16Speaker {
    values: HashMap<u32, u32>,
    output: Option<(u32, u32)>,
    has_played: bool,
}

impl Tim16Speaker {
    pub fn new(name: &str) -> Option<Box<dyn Peripheral>> {
        (name == "TIM16").then(|| Box::new(Self::default()) as Box<dyn Peripheral>)
    }

    fn register(&self, offset: u32) -> u32 {
        self.values.get(&offset).copied().unwrap_or_default()
    }

    fn audio_state(&self) -> Option<(f32, f32)> {
        let enabled = self.register(CR1) & 1 != 0
            && self.register(CCER) & 1 != 0
            && self.register(BDTR) & (1 << 15) != 0;
        let prescaler = self.register(PSC);
        let period = self.register(ARR);
        let compare = self.register(CCR1);
        if !enabled || period == 0 || compare == 0 {
            return None;
        }

        let frequency = 64_000_000.0 / (prescaler as f32 + 1.0) / (period as f32 + 1.0);
        if !(20.0..=20_000.0).contains(&frequency) {
            return None;
        }
        let duty = (2.0 * compare as f32 / period as f32).clamp(0.0, 1.0);
        Some((frequency, duty.cbrt()))
    }

    fn update_audio(&mut self) {
        let state = self.audio_state();
        let quantized = state.map(|(frequency, volume)| {
            ((frequency * 10.0).round() as u32, (volume * 1000.0).round() as u32)
        });
        if quantized == self.output {
            return;
        }
        self.output = quantized;
        match state {
            Some((frequency, volume)) => {
                self.has_played = true;
                log::info!("FLIPPER_AUDIO START frequency={frequency:.3} volume={volume:.4}");
            }
            None if self.has_played => log::info!("FLIPPER_AUDIO STOP"),
            None => {}
        }
    }
}

impl Peripheral for Tim16Speaker {
    fn read(&mut self, _system: &System, offset: u32) -> u32 {
        self.register(offset)
    }

    fn write(&mut self, _system: &System, offset: u32, value: u32) {
        self.values.insert(offset, value);
        if matches!(offset, CR1 | CCER | PSC | ARR | CCR1 | BDTR) {
            self.update_audio();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_flipper_speaker_pwm() {
        let mut speaker = Tim16Speaker::default();
        speaker.values.insert(PSC, 499);
        speaker.values.insert(ARR, 290);
        speaker.values.insert(CCR1, 18);
        speaker.values.insert(CCER, 1);
        speaker.values.insert(BDTR, 1 << 15);
        speaker.values.insert(CR1, 1);

        let (frequency, volume) = speaker.audio_state().expect("speaker should be active");
        assert!((frequency - 440.0).abs() < 2.0);
        assert!(volume > 0.45 && volume < 0.55);

        speaker.values.insert(BDTR, 0);
        assert!(speaker.audio_state().is_none());
    }
}
