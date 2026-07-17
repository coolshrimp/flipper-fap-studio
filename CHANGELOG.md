# Changelog

All notable changes to Flipper FAP Studio are documented here.

---

## [0.8.0] — 2026-07-17

### Added
- **Live Screen Preview** (qFlipper-style) — mirror the Flipper's 128×64 display in real time over USB:
  - Control the device with the on-screen D-pad/OK/Back buttons or the keyboard when the panel is focused (W/A/S/D or arrows, Space/Enter = OK, Backspace/Esc = Back; hold a key for long-press/repeat)
  - **Save Screenshot** exports a crisp 4× PNG; **Ctrl+C** copies the screenshot to the clipboard
  - Collapsible **LOGS** strip showing connection/RPC events, qFlipper-style
- **Serial Log** side-panel view — stream live device logs (CLI `log`) with Start/Stop/Clear, ANSI color rendering, and auto-scroll
- **Flipper Files** side-panel view — browse the SD card and internal flash of the connected device: open files in the editor, upload, download, rename, delete, create folders, copy device paths
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
