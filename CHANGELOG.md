# Changelog

All notable changes to Flipper FAP Studio are documented here.

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
