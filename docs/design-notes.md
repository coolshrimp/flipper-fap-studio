Yes. That should be part of the plan.

## Project name

**Flipper FAP Studio**
A GUI-first VS Code extension for building Flipper Zero `.fap` apps with uFBT.

## Main idea

The extension uses the **current VS Code workspace folder by default**. If no folder is open, or the app/folder is unclear, it asks once and remembers the selected path.

uFBT still does the real building, but the user only sees buttons, panels, status, and logs.

## Default target paths

```text
C:\Flipper\RogueMaster
C:\Flipper\Momentum
C:\Flipper\Unleashed
```

Also include:

```text
OEM / Official uFBT SDK
Custom folder...
```

## Extension panel layout

```text
Flipper FAP Studio

Project
[ Select App Folder ]
[ Create New App ]
[ Check application.fam ]
[ Open Output Folder ]

Build
[ Build OEM FAP ]
[ Build Selected Target ]
[ Clean ]
[ Package Release ZIP ]

Firmware Targets
✓ OEM / uFBT
○ RogueMaster    C:\Flipper\RogueMaster
○ Momentum       C:\Flipper\Momentum
○ Unleashed      C:\Flipper\Unleashed
[ Add Custom Target ]

Updates
[ Check uFBT Version ]
[ Check OEM Firmware ]
[ Check RogueMaster ]
[ Check Momentum ]
[ Check Unleashed ]

Flipper
[ Detect Flipper ]
[ Upload FAP ]
[ Launch App ]
```

## Update checker behavior

Safe method:

```text
Check latest version online
Compare with local installed/version file/git tag
Show status:
  Current
  Outdated
  Unknown
Button: Open official download/release page
Do not auto-download
Do not auto-run installers
```

That keeps it secure. It only redirects users to official pages.

Example status:

```text
uFBT: Outdated
Installed: 0.3.x
Latest: 0.4.x
[ Open uFBT GitHub ]

RogueMaster: Unknown local version
[ Open RogueMaster releases ]
```

uFBT is the right base because it is officially described as a lightweight tool for building/debugging Flipper apps without building the whole firmware. It also supports VS Code development configs already, so your extension is basically a friendly control panel on top of it. ([GitHub][1])

## Security rules

The extension should never silently send code or files anywhere.

```text
No auto-upload to GitHub
No auto-download firmware
No auto-run unknown scripts
No token storage unless user enters it
No secrets shown in logs
No building from random folders without confirmation
```

Before building, it should scan for common secret files:

```text
.env
config.json
settings.json
tokens.json
credentials.json
*.pem
*.pfx
```

Then show:

```text
Warning: possible sensitive files found.
These will not be included in release ZIP unless you confirm.
```

## Saved settings

Store these in VS Code settings/global state:

```json
{
  "flipperFapStudio.defaultAppFolder": "",
  "flipperFapStudio.defaultTarget": "oem",
  "flipperFapStudio.targets.rogueMasterPath": "C:\\Flipper\\RogueMaster",
  "flipperFapStudio.targets.momentumPath": "C:\\Flipper\\Momentum",
  "flipperFapStudio.targets.unleashedPath": "C:\\Flipper\\Unleashed",
  "flipperFapStudio.askBeforeDownloads": true,
  "flipperFapStudio.checkUpdatesOnStartup": false
}
```

VS Code extensions can add side panels with Tree Views and can build richer custom panels with Webviews. Tree View is best for the left-side button/control panel; Webview is better later for a dashboard. ([Visual Studio Code][2])

## Build plan

Phase 1 — MVP:

```text
Create VS Code extension
Add sidebar panel
Detect workspace folder
Select app folder
Remember folder
Run uFBT build
Show output log
Open dist folder
```

Phase 2 — firmware targets:

```text
Add OEM target
Add custom target paths
Add RogueMaster/Momentum/Unleashed path settings
Validate target folders exist
Build selected target
```

Phase 3 — update checker:

```text
Check uFBT latest release
Check official Flipper firmware page
Check custom firmware release pages
Compare local version if possible
Show outdated/current/unknown
Open URL only, no downloading
```

Phase 4 — release helper:

```text
Package .fap
Generate release folder
Add README
Add version text
Exclude secrets
Create zip
```

Phase 5 — share with others:

```text
Create GitHub repo
Add README guide
Package as .vsix
Later publish to VS Code Marketplace
```

VS Code extensions can be packaged as `.vsix` files for sharing before publishing publicly. ([Visual Studio Code][3])

## Simple user flow

```text
1. Open VS Code
2. Open Flipper app folder
3. Click Flipper FAP Studio
4. Click Build OEM FAP
5. Click Upload FAP
6. Done
```

For your own FM radio app, the clean goal is:

```text
Main source repo:
coolshrimp/flipper-fm-radio

Extension uses:
current VS Code folder

Outputs:
dist/fm_radio-oem.fap
dist/fm_radio-rougemaster.fap
dist/fm_radio-momentum.fap
dist/fm_radio-unleashed.fap
```

[1]: https://github.com/flipperdevices/flipperzero-ufbt?utm_source=chatgpt.com "uFBT - micro Flipper Build Tool"
[2]: https://code.visualstudio.com/api/extension-guides/tree-view?utm_source=chatgpt.com "Tree View API"
[3]: https://code.visualstudio.com/api/working-with-extensions/publishing-extension?utm_source=chatgpt.com "Publishing Extensions"
