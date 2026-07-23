# STM32 firmware engine

`stm32-emulator.exe` is a separately executed, patched build of
[`nviennot/stm32-emulator`](https://github.com/nviennot/stm32-emulator) at
commit `6622f2ce5047910a401ca958b7f6e91a0000f1b6`.

The executable is licensed under GPL-3.0-or-later. Its complete corresponding
source, including the Flipper Zero compatibility changes used to build this
binary, is included in the `source` directory beside it. The VS Code extension
itself remains MIT-licensed; it launches this program as a separate process.
The adjacent `SDL2.dll` is distributed under the zlib license reproduced in
`SDL2-LICENSE.txt`.

To rebuild on Windows:

1. Install the Rust toolchain and the native build dependencies documented in
   `source/README.md`.
2. Run `cargo build --release` from `source`.
3. Copy `source/target/release/stm32-emulator.exe` to this directory.

The compatibility layer executes real STM32WB55 firmware instructions and
renders the selected firmware's ST7567 display. Its Cortex-M exception model,
RTC status handling, GPIO/EXTI button path, and boot-time desktop-readiness
gate allow stock and custom-firmware menus to run and receive simulator input.
TIM16 channel 1 speaker PWM is decoded into structured frequency and volume
events so the simulator can reproduce firmware beeps through the PC.
It also emulates the Flipper's SPI2 SD-card path, including card detection,
single-block reads/writes, and STM32WB DMA transfers. The extension builds a
FAT16 image from the selected firmware's packaged resources and persistent
virtual `/ext` tree, then imports firmware writes before the next launch.
Because no M0+ wireless core is present, it supplies a simulation-only result
for the firmware's secure-enclave inventory check; no keys or cryptographic
operations are emulated.

The extension's separate desktop Flipper API runtime provides the selected
FAP's supported GUI, input, timers, and virtual storage. The compatibility
layer remains deliberately incomplete: raw `/int` flash storage, radio, NFC,
infrared output, Bluetooth, electrical GPIO, and exact hardware timing still
require a physical Flipper Zero.
