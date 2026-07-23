# Changelog

All notable changes to Flipper FAP Studio are documented here.

## [0.13.6] — 2026-07-23

### Added — Simulator button holds
- Hold any on-screen D-pad, OK, or Back control for 550 ms to send a Flipper long-press event
- Supports the same holds with keyboard controls, including Enter/Space for OK and Escape/Backspace for Back
- Preserves one short press for quick taps and provides a visual pressed state during on-screen holds

### Documentation
- Added the new simulator screenshot and a step-by-step explanation of the STM32 firmware, virtual SD card, app bridge, input, display, sound, and persistence flow

---

## [0.13.5] — 2026-07-23

### Fixed — Simulator restart loops
- Auto-boots firmware only on the simulator panel's first render, preventing source or UI refreshes from starting duplicate sessions
- Ignores duplicate Boot requests while either simulator engine is starting or running
- Waits for the previous desktop app bridge process to fully exit before linking over its Windows executable, eliminating intermittent linker `Permission denied` failures

---

## [0.13.4] — 2026-07-23

### Added — Simulator sound passthrough
- Plays FAP speaker API tones and notification beeps through the PC using a low-volume Web Audio channel
- Decodes the selected stock/CFW firmware's real TIM16 speaker PWM into matching PC tones
- Adds a **Sound: On/Off** control and reliably silences both audio channels when their runtime stops

---

---

## [0.13.3] — 2026-07-23

### Added — Firmware preparation display
- Shows the current firmware setup message and a determinate progress bar directly on the simulated 128 × 64 display while resources are expanded and the virtual SD image is built
- Advances from initial target preparation through archive staging, FAT16 creation, and firmware startup, then hands the display to the first real STM32 framebuffer

### Fixed
- Locks simulator D-pad and keyboard input during firmware preparation so setup-time clicks cannot navigate the offline source preview or leak into firmware boot
- Makes the firmware display the initial source for Boot Target, while keeping the app bridge available through the display-source toggle

---

## [0.13.2] — 2026-07-23

### Added — Firmware-backed STM32 simulator sessions
- Resolves the firmware selected as **Target** and boots OEM/custom STM32WB55 `full.bin` images with the local ARM emulator
- Extracts packaged DfuSe `firmware.dfu` images, with validation of target addresses and image size
- Finds the target's STM32WB55 SVD, falling back to the managed OEM uFBT SVD for update-only firmware packages
- Builds and stages the active app under a persistent virtual `/ext/apps/<category>` SD-card tree
- Shares that storage tree with the desktop Flipper API runtime so app menus, input, timers, assets, and saves remain functional while the selected firmware executes
- Adds supervised firmware lifecycle/status logging and configurable emulator path/instruction limit
- Boots through CFW service startup, models STM32WB USART/HSEM/RNG/synchronization behavior, and decodes the real ST7567 SPI page buffer into the simulator
- Injects simulator D-pad actions through the firmware's real GPIO polarity and EXTI pending/interrupt paths so the raw firmware desktop/menu can be navigated
- Discovers OEM, Momentum, RogueMaster, and Unleashed update resources and safely extracts TAR, gzip, and Heatshrink archives into target-wide persistent virtual SD storage
- Builds a deterministic FAT16 card image with VFAT long names, emulates SPI2 card detection/read/write plus STM32WB DMA, and merges firmware-created saves back before later launches
- Lets stock and custom firmware browse packaged application folders and launch compatible FAPs through the native firmware loader

### Fixed — Firmware and app-runtime compatibility
- Initializes Cortex-M MSP/PSP from the firmware reset vector and preserves the separate handler/task stacks across exceptions
- Implements Momentum's Thumb `POP {..., PC}` exception-return form, preventing the `intr_hook intno=00000003` loop after CFW startup
- Models the reserved word in floating-point exception frames and stops unrecoverable CPU faults once with register diagnostics instead of flooding the simulator log
- Injects pending exceptions only at ARM translation boundaries, preventing long-running stock/CFW sessions from corrupting a task context while Unicorn finishes a translated block
- Models RTC status/control semantics without manufacturing an alarm flag, so a phantom clock viewport no longer hides the desktop
- Supplies a simulation-only result for the boot-time secure-enclave inventory when the absent wireless core would otherwise deadlock firmware before its desktop event loop
- Holds early simulator button events until firmware has sampled the GPIO idle level and its desktop is ready, preventing the first navigation click from being discarded
- Creates the desktop compiler workspace when a firmware session supplies shared virtual storage, fixing the missing `runtime_config.h` bridge failure
- Keeps mixed UI/hardware entry-point sources in desktop builds and supplies inert USB CDC, semaphore, and STM32 I²C compatibility APIs so apps such as Xbox Postcode Reader can run their real menus safely
- Keeps Build + Launch reserved as one atomic workflow through device hand-off, preventing double-clicked commands from starting two `ufbt launch` processes against the same COM port
- Completes a successful physical launch without blocking on Live View/RPC reconnection; serial recovery continues in the background while the FAP is running
- Recovers Momentum's non-returning first-task `SVC 0` sequence if early interrupt timing makes Unicorn fall through into the adjacent VTOR literal
- Treats a confirmed `Launching app:` followed by custom serial output as a successful uFBT RPC handoff, rather than reporting a false launch failure after the FAP is already running
- Latches and clears STM32WB EXTI pending bits for all six buttons, including the OK button's active-high polarity, so stock and custom-firmware menus receive real input callbacks
- Preserves Thumb state between bounded emulator chunks, preventing long-running firmware sessions from failing with an invalid instruction after the first instruction budget
- Adds the current `storage_common_mkdir` API and filesystem result types to the desktop bridge, allowing apps built against newer SDKs to compile and use persistent virtual storage
- Adds the replacing `furi_string_printf` API used by apps such as FlipBoy, including safe formatting when the replacement references the string's existing value
- Invalidates stopped firmware frames and keeps app/firmware input routing isolated, so a stale CFW screen cannot capture or leak input to the FAP bridge
- Opens the real synchronized `/ext` directory instead of the SD-image parent, and waits for the firmware engine to exit before importing card changes
- Non-destructively migrates files from the former per-app simulator storage folders into the new target-wide card so existing saves are not stranded

---

## [0.13.1] — 2026-07-22

### Added — Functional desktop simulator runtime
- Runs trusted Flipper app C source in a separate Windows process using its real entry point and input/menu logic
- Starts Functional mode automatically when the simulator opens, using static preview only as a fallback
- Streams live Canvas frames into the simulator and supports Furi queues, mutexes, strings, viewports, and common GUI helpers
- Adds functional `View`, `ViewDispatcher`, `SceneManager`, Submenu, Widget, and Variable Item List compatibility so standard Flipper menu/scene apps execute their real navigation callbacks
- Adds Furi event loops, loop timers, regular timers, event flags, queue/stream/mutex subscriptions, thread exit signals, and random APIs
- Generates missing app `*_icons.h` headers from 1/2/4/8-bit PNG and ASCII/binary PBM `fap_icon_assets`, with visible placeholders and warnings for unresolved symbols
- Redirects `/ext` and `/int` file APIs to persistent per-app virtual storage with a one-click folder shortcut
- Keeps radio, NFC, IR, BLE, GPIO, and other hardware APIs stubbed; physical-device testing remains available for exact behavior

### Changed — Unified application theme
- UI Designer, Flipper Simulator, Device Dashboard, Live View, Guide, Settings, and Firmware SDK views now share one charcoal-and-Flipper-orange design system
- Centralized surface, text, accent, status, typography, focus, scrollbar, radius, and shadow tokens prevent individual panels from drifting into unrelated color schemes
- Sidebar tree accents now use the same orange family as the webviews

### Fixed — Simulator text and screen composition
- Device Dashboard detects firmware where `/int` is a virtual directory backed by the SD filesystem; it now reports the directory's content size and “shares SD” instead of duplicating `/ext` capacity as fake internal storage
- Uses trimmed proportional glyph advances in the desktop renderer so text that fits the physical display no longer overflows as if every character were full-width
- MP3 Player now launches in Functional mode: Windows-backed Furi threads, file position/EOF/error APIs, saved-struct persistence, power-status stubs, and a safe no-audio replacement for its STM32 DMA/GPIO backend are supplied
- Draw callbacks now expand local Canvas helper functions with bounded parameter binding and loop unrolling, so callback-composed screens render instead of appearing as blank `Header`/`Row` pseudo-screens
- `switch` cases that call helpers become the real selectable screens, with `default` shown first as **Main**
- `canvas_draw_str_aligned` is rendered, constant string arrays are resolved, arithmetic coordinates are approximated safely, and runtime text uses visible placeholders instead of disappearing
- Draw helpers, static string arrays, and numeric constants are resolved in their source file first, while bounded per-screen and whole-preview budgets prevent pathological source expansion
- XBM coverage counts only arrays referenced by `canvas_draw_xbm`, keeps same-named arrays source-scoped (including helper arguments), and avoids false counts from unrelated codec lookup tables such as MP3 decoder tables

---

## [0.13.0] — 2026-07-22

### Added — Flipper Simulator (experimental)
- New **Flipper Simulator** sidebar action and Command Palette command open a dedicated VS Code popup
- Safe offline source preview for literal Flipper `canvas_*` calls, XBM arrays, soft buttons, and multi-screen draw callbacks; app source is parsed but never executed
- Automatic source reload, D-pad/keyboard screen controls, and 512×256 qFlipper-palette screenshot export
- OEM and local custom-firmware target profiles share the extension's existing build pipeline
- Built or manually selected `.fap` files are checked for the expected little-endian ARM ELF32 header; runtime/API compatibility is deliberately not claimed
- **Build + Run on Physical Flipper** provides the device-accurate path and opens the live screen mirror
- Offline scope is reported directly in the UI: firmware CPU/peripherals, dynamic app logic, firmware-owned icons, and hardware APIs are not emulated

---

## [0.12.3] — 2026-07-22

### Fixed
- Screenshots now save with qFlipper's exact palette — pure black `#000000` on `#FE8A2C` orange — instead of the stylized preview colors (`#1E1005` on `#FF8B27`). The Flipper App Catalog requires screenshots identical to a qFlipper export (512×256, exactly two colors), and PNGs saved with the old palette were flagged as recolored. The live screen mirror now uses the same authentic colors, so the preview matches what gets saved

---

## [0.12.2] — 2026-07-20

### Fixed
- Serial connection no longer drops during file transfers. Chunks were written to the port as fast as Node would take them, overrunning the Flipper's RPC receive buffer (USB delivers far faster than the firmware writes to SD) — that desynced the protobuf stream and killed the session mid-upload. Frames are now sent one at a time, draining the port between each, with a short pause every few frames
- Screen streaming is paused for the duration of a transfer instead of competing for the same RPC channel
- Chunked-write timeout now scales with file size — the firmware only replies after the *final* frame, so a large `.fap` could blow the fixed 30 s budget and report a timeout on a transfer that was still progressing normally
- A failed transfer now resyncs the RPC session, so the next operation doesn't inherit a half-parsed frame

---

## [0.12.1] — 2026-07-18

### Fixed
- BLE discovery no longer requires the advertised name to start with "Flipper" — Flippers are renameable (e.g. "Flip"), so the scan now collects every nearby BLE device, auto-matches flipper-ish names, and falls back to a device picker listing everything found

---

## [0.12.0] — 2026-07-18

### Added — Bluetooth LE (experimental)
- The dashboard's **ᗬ Bluetooth** button now actually connects: it scans for a device advertising as "Flipper …", opens the BLE serial service, and speaks the same protobuf RPC — our own implementation built from the Flipper's public GATT profile (serial service `8fe5b3d5…`, RX/TX/flow-control characteristics, firmware auto-opens RPC on connect)
- While connected, the dashboard stats, library counts, and **Install .fap** all ride BLE instead of USB; the button turns green and shows the device name, click again to disconnect
- Transport is the MIT-licensed `webbluetooth` package (SimpleBLE, ABI-stable N-API prebuilds for Windows/macOS/Linux — same mechanism as the bundled serialport module)
- Pair the Flipper with your PC first (no default PIN — it shows a one-time 6-digit code); Live Screen and the file browser sidebar remain USB-only for now

---

## [0.11.1] — 2026-07-18

### Changed
- **Install .fap** now opens a file picker (starting in the app's `dist/`) instead of silently installing the working directory's build, then asks which `/ext/apps` category folder to use — offering the category from `application.fam` (recommended), the existing folders read live from the device, the apps root, or a new folder name
- Bluetooth button tooltip/message now notes there is no default PIN — the Flipper shows a one-time 6-digit pairing code on its screen

---

## [0.11.0] — 2026-07-18

### Added — Device Dashboard
- One-page device health check over USB RPC: device name, firmware version/branch/fork, hardware model + UID, and an expandable "All Device Info" list
- Flipper device render in the device card (drop a `media/flipper-device.png` in to customize)
- Battery card — charge % with bar, voltage, current draw, temperature, health
- Combined storage card — SD card (`/ext`) and internal flash (`/int`) used/free/total with usage bars in one pane
- Library counts — Sub-GHz, Infrared, NFC, RFID, BadUSB, Apps (recursive SD scan with caps, fills in incrementally)
- **⛚ File Manager** button — jumps to the on-device file browser
- **⬇ Install .fap → SD** button — uploads the built `.fap` from `dist/` straight to `/ext/apps/<Category>/` over RPC (creates the category folder if needed)
- **ᛒ Bluetooth** button — placeholder; BLE transport is planned, USB-only for now
- New `Device Dashboard` sidebar button + command; read-only stats — borrows the RPC session only while loading
- Protocol: `SystemDeviceInfo`, `SystemPowerInfo`, and `StorageInfo` RPC messages added to the built-in protobuf codec

---

## [0.10.1] — 2026-07-17

### Changed
- README: added UI Designer screenshots

---

## [0.10.0] — 2026-07-17

### Added — UI Designer (lopaka feature parity, Flipper-only)
- **Import Image** — convert any PNG/JPG/GIF to 1-bit XBM with live threshold slider, invert toggle, width control, and preview; imported images become draggable icons saved inside the design
- **Pixel-perfect drawing** — ✎ PENCIL / ⌫ ERASE tools paint freehand pixels (right-drag also erases) onto a movable per-screen layer, exported as an auto-cropped XBM array
- **Resize handles** — drag the corner grip on boxes/frames, the radius grip on circles/discs, or either endpoint of a line
- **Draggable tool panels** — grab any panel by its header to reorder it or move it between the left/right columns; the layout persists
- **FontKeyboard** added to the text font choices; zoom range extended to 3–10×

### Fixed
- Soft-button preview now has properly rounded pill corners (rounded-rect corner math corrected for rbox/rframe too)

---

## [0.9.1] — 2026-07-17

### Added
- **UI Designer: live code panel with two-way sync** — the current screen's `canvas_*` code is shown below the canvas; designing updates the code, and editing the code updates the canvas (unrecognized lines are reported and skipped)
- **UI Designer: Flipper soft-buttons** — `elements_button_left/center/right` as a drag-in element with inverted-label preview; generated code adds `#include <gui/elements.h>` automatically (verified building to `.fap`)
- **UI Designer: starter templates** — Dialog, Menu, Splash, Button bar, and HUD prefab screens, one click each
- **GitHub release automation** — pushing a `v*` tag builds the `.vsix` in CI and publishes it as a GitHub Release

---

## [0.9.0] — 2026-07-17

### Added
- **UI Designer** — a lopaka.app-style visual editor for 128×64 Flipper screens (sidebar button / `Flipper FAP Studio: UI Designer`):
  - Live 1-bit canvas with zoom + pixel grid; text (3 fonts), box/frame, rbox/rframe, line, circle/disc, dot
  - **Icon palette with drag & drop** (18 built-in icons) and **Paste XBM** for custom bitmaps
  - **Multi-screen support** — add/rename/duplicate/reorder screens via tabs
  - Layers panel (z-order, duplicate, delete), per-element properties, drag-to-move, arrow-key nudge, undo/redo
  - **Code export**: Copy Screen Code (canvas_* calls + XBM arrays), Insert at Cursor into the active editor, Copy Full App `main.c`, and **Create App…** which scaffolds a complete buildable app (`application.fam` + `main.c`, screen switching with ◀/▶, Back to exit) and sets it active
  - Generated app output verified to compile to a `.fap` with ufbt (API 87.1)
  - Designs autosave; Export/Import as JSON

---

## [0.8.6] — 2026-07-17

### Added
- **Web updaters for all firmwares** (like Momentum's):
  - **Unleashed** → [web.unleashedflip.com](https://web.unleashedflip.com/)
  - **RogueMaster** → opens lab.flipper.net pre-loaded with the **latest RM release** (the link embeds the release archive from rogue-master.net, built from the live GitHub tag)
  - Web-update button now shows on every firmware row in the sidebar tree, not just OEM/Momentum

---

## [0.8.5] — 2026-07-17

### Added
- **Deeper, flavor-aware SDK scanning** — folders are searched up to 4 levels deep for `update.fuf` (extract-in-a-folder layouts just work), and when one parent folder holds several firmwares, each target picks out its own
- **Auto-assignment of cross-detected firmware** — if a scan finds a firmware sitting under the wrong target's path (e.g. RogueMaster inside the folder configured for Momentum), the correct target is pointed at it automatically, with a notification
- **↻ Refresh button in the Firmware SDKs header** — re-checks local versions, re-runs auto-assignment, and refetches the latest GitHub releases in one click
- RogueMaster version matching keys on the shared commit hash (`rm-420-3be1368f` ↔ release tag `RM0713-2232-3be1368f`), so up-to-date installs aren't flagged as stale

### Changed
- Unverifiable targets now simply show `Not found — latest <tag>` instead of verbose mismatch text (details remain in the tree tooltips)

---

## [0.8.4] — 2026-07-17

### Added
- **Real firmware SDK verification** — instead of only checking that the folder exists, the extension now reads the `update.fuf` manifest inside each configured SDK folder (searching up to two levels deep, matching how release archives extract):
  - Shows the exact firmware version found, e.g. `mntm-012 ✓ verified`
  - Flags folders containing the **wrong** firmware ("Found Momentum (mntm-012) — not RogueMaster") or no firmware at all
  - Compares against the **latest GitHub release** of each firmware (`mntm-012 → mntm-013 available`); the ⟳ re-check button refreshes both uFBT and release info
  - Same verification shown in the main tree's Firmware SDKs section tooltips

### Changed
- Live Screen controls tightened: the Back button now sits to the right of the D-pad with bottoms aligned (less vertical space)
- README: new screenshots (dashboard, sidebar, live-screen pop-out), panel-height tip, SDK verification docs

---

## [0.8.3] — 2026-07-17

### Changed
- **One panel instead of two** — the Serial Log view is merged into **Live Screen + Log**: the qFlipper-style LOGS box (dark, bordered, timestamped `[RPC]` events) now sits under the screen controls and also carries the device debug log (**▶ LOG** / **■** / **CLEAR** buttons in its header, ANSI colors, auto-scroll). Starting the device log pauses the screen stream; stopping it resumes the stream.
- **Screenshot / Pop Out buttons moved above the D-pad controls**, directly under the screen

### Added
- **⟳ RESET button** — reboots the Flipper over RPC (same effect as the LEFT+BACK hardware combo) for recovering frozen apps; two-click confirm, and the panel auto-reconnects once the device re-enumerates
- **COM BLOCKED indicator** — when the port can't be opened, the panel shows COM BLOCKED and names the likely holder (qFlipper, PuTTY, Tera Term, …) so you know what to close

---

## [0.8.2] — 2026-07-17

### Fixed
- **Live Screen panel could be missed after updating** — VS Code persists the sidebar layout, so the new panel could be appended at the bottom (collapsed) or hidden instead of sitting above Serial Log. A one-time prompt now offers to reveal it; drag its header to reorder, or run *View: Reset View Locations* to restore the default order.

---

## [0.8.1] — 2026-07-17

### Changed
- **Live Screen is now a sidebar panel** (above Serial Log), collapsed by default — expanding it starts streaming, collapsing hands the port back to the log; **⧉ Pop Out** opens the full-size editor tab
- RPC/connection events now stream into the **Serial Log** panel (`[RPC] …`, color-coded) instead of a separate strip in the sidebar preview
- Removed the redundant Live Screen Preview / Serial Log / Flipper Files buttons from the main list — each is its own panel now
- Files view renamed to **Flipper Files (on Device)**; added recursive **Upload Folder…** (bulk upload); the current app's `.fap` and category folder are highlighted with a **⊙ Reveal Current App** title button
- Version bumped so the update installs cleanly over 0.8.0

---

## [0.8.0] — 2026-07-17

### Added
- **Live Screen** (qFlipper-style) — a sidebar panel that mirrors the Flipper's 128×64 display in real time over USB, with a **⧉ Pop Out** button for a full-size editor tab:
  - Control the device with the on-screen D-pad/OK/Back buttons or the keyboard when the preview is focused (W/A/S/D or arrows, Space/Enter = OK, Backspace/Esc = Back; hold a key for long-press/repeat)
  - **Save Screenshot** exports a crisp 4× PNG; **Ctrl+C** copies the screenshot to the clipboard
  - Collapsible **LOGS** strip showing connection/RPC events, qFlipper-style
  - Streams only while the panel is visible — collapsing it hands the port back to the serial log
- **Serial Log** side-panel view — stream live device logs (CLI `log`) with Start/Stop/Clear, ANSI color rendering, and auto-scroll
- **Flipper Files (on Device)** side-panel view — browse the SD card and internal flash of the connected device: open files in the editor, upload (multi-select), bulk **Upload Folder** (recursive), download, rename, delete, create folders, copy device paths
  - The current app's `.fap` and its category folder are highlighted (★ green) on the device, with a **⊙ Reveal Current App** title button that jumps straight to it
  - File transfers verified against hardware (multi-chunk 50 KB write/read, MD5 integrity match, ~136 KB/s)
- **Automatic COM-port handover** — the serial connection (log or screen stream) pauses itself while **Build + Launch** pushes the `.fap` to the Flipper, then resumes automatically; the serial port is only ever held by one thing at a time
- `flipperFapStudio.serialPort` setting to pin a COM port (blank = auto-detect by USB VID/PID)
- Native Flipper RPC protocol implementation (protobuf over serial) with vendored `.proto` definitions — verified against real hardware (screen streaming, input injection, storage read/write/list/delete)

### Fixed
- Production dependencies are now actually packaged into the `.vsix` (previously `node_modules` was excluded wholesale); dropped the unused `archiver` dependency

---

## [0.7.2] — 2026-07-15

### Changed
- README: added VS Code Marketplace quick-install link and badges (version, installs); Marketplace listing added to Links

---

## [0.7.1] — 2026-07-15

### Changed
- README: Install section now links directly to the GitHub repository and the latest `.vsix` on GitHub Releases for easier install

---

## [0.7.0] — 2026-07-12

### Fixed
- **"Build Anyway"** button on the missing-`application.fam` warning now actually starts the build (previously it did nothing)
- **Cancel Build** on Windows now kills the entire ufbt process tree — previously only the wrapper shell was terminated and the build kept running in the background

### Added
- **Recent Projects panel** — valid Flipper apps you create, open, or build are tracked automatically with a "last worked on" time; click an entry to make it the current app folder, or use the inline buttons to open it in a new VS Code window or remove it from the list
- Marketplace metadata: extension icon (`media/icon.png`), repository/bugs/homepage links, license field, keywords, gallery banner
- `.gitignore` and project now under git version control

### Changed
- README updated with Marketplace install instructions and current panel layout
- Media files renamed to kebab-case (`fap-studio-icon.png`, `fap-studio-color-icon.png`, `logo-only.png`)

---

## [0.3.0 – 0.6.3] — 2026-06-25 *(consolidated)*

### Added
- **Settings panel** — custom webview for build output options, new-app defaults, and firmware SDK paths with folder pickers
- **Guide panel** — step-by-step usage guide opened from the sidebar or status bar
- **Firmware SDKs view** — live status webview showing each SDK (OEM/uFBT, RogueMaster, Momentum, Unleashed): configured path, found/missing state, and inline actions (set path, GitHub releases, web update pages)
- **uFBT version checking** — compares the installed pip version against the latest on PyPI; shows Install / Update buttons directly in the Firmware SDKs view
- **Status bar item** — shows build progress with a spinner; click to cancel a running build, or open the Guide when idle
- **Cancel Build** command with in-tree Building…/Cancel buttons while a build runs
- **Error hints** — build failures are matched against common problems (Flipper not detected, API mismatch, missing include, linker errors, stack size, manifest errors, app still running on device) and shown as actionable advice
- **Build output options** — prompt for a destination after each build (`askOnBuildOutput`) or auto-copy the built `.fap` to a fixed folder (`buildOutputDir`)
- **Default new-app folder** (`defaultCreateAppDir`) offered when creating starter apps
- App folder validation — warns before building a folder with no `application.fam`

---

## [0.2.0] — 2026-06-25

### Changed
- **Redesigned sidebar** — collapsed five separate panels (Project, Build, Targets, Updates, Flipper) into a single clean panel with 7 focused buttons
- **Create starter app** now always creates a named containing folder (`<parent>/<appname>/`) instead of placing files directly in the selected folder
- **Create starter app** now generates a working `main.c` with a real draw loop, input callback, and clean exit on Back — not just an empty stub

### Added
- Status info rows at top of panel showing current **App folder** and **Active target** at a glance
- **Install / Update uFBT** button — opens a visible terminal and runs `pip install -U ufbt`
- **Build + Launch on Flipper** button — builds then immediately runs `ufbt launch`
- **Select firmware target** button — opens a QuickPick list with all built-in and custom targets; includes an inline "Add custom target..." option
- App name validation in **Create starter app** (enforces snake_case, rejects invalid names before creating files)
- `.vscode/launch.json` and `.vscode/tasks.json` for F5 dev workflow (auto watch + Extension Development Host)
- `README.md` with full setup guide, button reference, settings table, security notes, and dev workflow
- `CHANGELOG.md` (this file)

### Removed
- Separate Project / Build / Firmware Targets / Updates / Flipper sub-panels
- Check application.fam button (panel info row covers this)
- Package Release ZIP button (moved to planned features)
- Detect Flipper / Upload FAP as separate buttons (merged into Build + Launch)
- Update checker buttons (moved to planned features)

---

## [0.1.0] — 2026-06-25

### Added — initial build

#### Extension scaffold
- VS Code extension with TypeScript + tsconfig, package.json manifest, LICENSE
- Activity Bar icon (`flipper-icon.svg`) and sidebar container

#### Five sidebar panels
- **Project** — Select App Folder, Create New App, Check application.fam, Open Output Folder
- **Build** — Build OEM FAP, Build Selected Target, Clean, Package Release ZIP
- **Firmware Targets** — OEM/uFBT, RogueMaster, Momentum, Unleashed with active indicator; Add Custom Target
- **Updates** — per-firmware status rows + Check buttons for uFBT, OEM, RogueMaster, Momentum, Unleashed
- **Flipper** — Detect Flipper, Upload FAP, Launch App

#### Core systems
- `StateManager` — reads/writes app folder and active target to VS Code global state and settings
- `ufbtRunner` — spawns `ufbt` as a child process, streams stdout/stderr to Output channel; `findSensitiveFiles` scans for `.env`, `*.pem`, `*.pfx`, etc.
- `updateChecker` — fetches latest release tag from GitHub API for uFBT, OEM firmware, RogueMaster, Momentum, Unleashed; opens release page URL only, never downloads
- Release ZIP packaging via `archiver` with automatic exclusion of sensitive files and confirmation prompt
- Auto-detects VS Code workspace folder on activation if no folder is saved
- All settings persisted to `flipperFapStudio.*` VS Code configuration keys

#### Packaged
- `flipper-fap-studio-0.1.0.vsix` — installable via Extensions: Install from VSIX
