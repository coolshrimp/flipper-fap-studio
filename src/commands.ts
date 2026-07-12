import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './stateManager';
import { runUfbt, buildWithTarget } from './ufbtRunner';
import { SettingsPanel } from './settingsPanel';
import { showGuidePanel } from './guidePanel';
import { FirmwareStatusItem, FW_META } from './treeProviders';
import { buildState } from './buildState';
import { getErrorHints, formatHintsForModal } from './errorHints';

const out = vscode.window.createOutputChannel('Flipper FAP Studio');

export function registerCommands(
    context: vscode.ExtensionContext,
    state: StateManager,
    refresh: () => void
) {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    // ── Install / Update uFBT ────────────────────────────────────────────────
    reg('flipperFapStudio.installUfbt', () => {
        // Detect if already installed to pick the right command
        let alreadyInstalled = false;
        try {
            const { execSync } = require('child_process') as typeof import('child_process');
            execSync('pip show ufbt', { encoding: 'utf8', timeout: 4000, windowsHide: true });
            alreadyInstalled = true;
        } catch { /* not installed */ }

        const terminal = vscode.window.createTerminal(alreadyInstalled ? 'uFBT Update' : 'uFBT Install');
        terminal.show();
        // Fresh install: pip install ufbt
        // Upgrade:       python -m pip install --upgrade ufbt  (matches pip's own recommendation)
        terminal.sendText(alreadyInstalled
            ? 'python -m pip install --upgrade ufbt'
            : 'pip install ufbt'
        );
    });

    // ── Build .fap ───────────────────────────────────────────────────────────
    reg('flipperFapStudio.build', async () => {
        if (guardBuild()) { return; }
        const folder = requireFolder(state);
        if (!folder) { return; }
        if (!(await validateAppFolder(folder))) { return; }

        const targetPath = state.getTargetPath(state.getActiveTarget());
        refresh();

        const result = await buildWithTarget(folder, targetPath, out, p => buildState.begin(p));
        const elapsed = buildState.end();
        refresh();

        if (result.ok) {
            await handleBuildOutput(folder, state);
            const action = await vscode.window.showInformationMessage(
                `Build complete in ${elapsed}s`,
                'Open dist folder'
            );
            if (action === 'Open dist folder') {
                vscode.commands.executeCommand('flipperFapStudio.openDist');
            }
        } else {
            await showBuildError('Build failed', result.log);
        }
    });

    // ── Build + Launch ───────────────────────────────────────────────────────
    reg('flipperFapStudio.buildAndLaunch', async () => {
        if (guardBuild()) { return; }
        const folder = requireFolder(state);
        if (!folder) { return; }
        if (!(await validateAppFolder(folder))) { return; }

        const targetPath = state.getTargetPath(state.getActiveTarget());
        refresh();

        const buildResult = await buildWithTarget(folder, targetPath, out, p => buildState.begin(p));
        const elapsed = buildState.end();
        refresh();

        if (!buildResult.ok) {
            await showBuildError('Build failed — launch aborted', buildResult.log);
            return;
        }

        await handleBuildOutput(folder, state);

        const launching = vscode.window.setStatusBarMessage('$(sync~spin) Launching on Flipper…');
        buildState.begin({ kill: () => undefined } as never);
        refresh();
        const launchResult = await runUfbt(folder, ['launch'], out);
        buildState.end();
        launching.dispose();
        refresh();

        if (launchResult.ok) {
            vscode.window.showInformationMessage(`Built in ${elapsed}s — launched on Flipper.`);
        } else {
            await showBuildError('Launch failed', launchResult.log);
        }
    });

    // ── Cancel build ─────────────────────────────────────────────────────────
    reg('flipperFapStudio.cancelBuild', () => {
        if (!buildState.isBuilding) { return; }
        buildState.cancel();
        out.appendLine('\n⊘ Build cancelled by user.');
        refresh();
        vscode.window.showWarningMessage('Build cancelled.');
    });

    // ── Clean ────────────────────────────────────────────────────────────────
    reg('flipperFapStudio.clean', async () => {
        if (buildState.isBuilding) {
            vscode.window.showWarningMessage('Cannot clean while a build is running.');
            return;
        }
        const folder = requireFolder(state);
        if (!folder) { return; }
        await runUfbt(folder, ['clean'], out);
        vscode.window.showInformationMessage('Clean complete.');
    });

    // ── Open dist folder ─────────────────────────────────────────────────────
    reg('flipperFapStudio.openDist', () => {
        const folder = requireFolder(state);
        if (!folder) { return; }
        const dist = path.join(folder, 'dist');
        vscode.env.openExternal(vscode.Uri.file(fs.existsSync(dist) ? dist : folder));
    });

    // ── Create starter app ───────────────────────────────────────────────────
    reg('flipperFapStudio.createStarterApp', async () => {
        const name = await vscode.window.showInputBox({
            prompt: 'App name (snake_case)',
            placeHolder: 'my_flipper_app',
            validateInput: v => /^[a-z][a-z0-9_]*$/.test(v) ? undefined : 'Use lowercase letters, digits, and underscores only',
        });
        if (!name) { return; }

        const parentDir = await resolveCreateAppDir(state);
        if (!parentDir) { return; }

        const appDir = path.join(parentDir, name);
        if (fs.existsSync(appDir)) {
            vscode.window.showWarningMessage(`Folder already exists: ${appDir}`);
            return;
        }
        fs.mkdirSync(appDir, { recursive: true });

        const displayName = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        fs.writeFileSync(path.join(appDir, 'application.fam'), `App(
    appid="${name}",
    name="${displayName}",
    apptype=FlipperAppType.EXTERNAL,
    entry_point="app_main",
    requires=["gui"],
    stack_size=2048,
    fap_version=(1, 0),
    fap_category="Misc",
)
`);

        fs.writeFileSync(path.join(appDir, 'main.c'), `#include <furi.h>
#include <gui/gui.h>
#include <gui/view_port.h>

static void draw_callback(Canvas* canvas, void* ctx) {
    UNUSED(ctx);
    canvas_clear(canvas);
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 4, 12, "${displayName}");
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str(canvas, 4, 26, "Press Back to exit");
}

static void input_callback(InputEvent* event, void* ctx) {
    FuriMessageQueue* queue = ctx;
    furi_message_queue_put(queue, event, FuriWaitForever);
}

int32_t app_main(void* p) {
    UNUSED(p);

    FuriMessageQueue* queue = furi_message_queue_alloc(8, sizeof(InputEvent));

    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, draw_callback, NULL);
    view_port_input_callback_set(vp, input_callback, queue);

    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, vp, GuiLayerFullscreen);

    InputEvent event;
    while(furi_message_queue_get(queue, &event, FuriWaitForever) == FuriStatusOk) {
        if(event.type == InputTypeShort && event.key == InputKeyBack) {
            break;
        }
    }

    gui_remove_view_port(gui, vp);
    view_port_free(vp);
    furi_record_close(RECORD_GUI);
    furi_message_queue_free(queue);
    return 0;
}
`);

        state.setAppFolder(appDir);
        vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
            0,
            { uri: vscode.Uri.file(appDir), name }
        );

        refresh();
        vscode.window.showInformationMessage(`Created ${name} at ${appDir}`);
    });

    // ── Select firmware target ───────────────────────────────────────────────
    reg('flipperFapStudio.selectTarget', async () => {
        const choices = state.buildTargetChoices();
        const active = state.getActiveTarget();

        const items = choices.map(c => ({
            label: c.label,
            description: c.id === active ? '← active' : undefined,
            id: c.id,
        }));

        const picked = await vscode.window.showQuickPick(items, {
            title: 'Select Firmware Target',
            placeHolder: 'Choose the SDK to build against',
        });
        if (!picked) { return; }

        if (picked.id === '__add__') {
            const tName = await vscode.window.showInputBox({ prompt: 'Target name', placeHolder: 'MyCustomFW' });
            if (!tName) { return; }
            const folderResult = await vscode.window.showOpenDialog({
                canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
                openLabel: 'Select SDK folder',
            });
            if (!folderResult) { return; }
            state.addCustomTarget(tName, folderResult[0].fsPath);
            state.setActiveTarget(tName);
            vscode.window.showInformationMessage(`Custom target added and selected: ${tName}`);
        } else {
            state.setActiveTarget(picked.id);
            vscode.window.showInformationMessage(`Target: ${picked.label.replace(/^\$\(\w+\) /, '')}`);
        }

        refresh();
    });

    // ── Pick / change app folder ─────────────────────────────────────────────
    reg('flipperFapStudio.pickAppFolder', async () => {
        const result = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: 'Set as current app folder',
        });
        if (!result) { return; }
        state.setAppFolder(result[0].fsPath);
        refresh();
        vscode.window.showInformationMessage(`App folder set to: ${result[0].fsPath}`);
    });

    // ── Open Settings panel ──────────────────────────────────────────────────
    reg('flipperFapStudio.openSettings', () => {
        SettingsPanel.show(context, state, refresh);
    });

    // ── Open Guide panel ─────────────────────────────────────────────────────
    reg('flipperFapStudio.openGuide', () => {
        showGuidePanel();
    });

    // ── Firmware: set SDK path ───────────────────────────────────────────────
    reg('flipperFapStudio.fw.setPath', async (item: unknown) => {
        const fwItem = item as FirmwareStatusItem;
        const fwId = fwItem?.fwId;
        if (!fwId || fwId === 'oem') { return; }

        const meta = FW_META[fwId];
        const result = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: `Set ${meta?.label ?? fwId} SDK folder`,
        });
        if (!result) { return; }

        const cfg = vscode.workspace.getConfiguration('flipperFapStudio');
        const keyMap: Record<string, string> = {
            rogueMaster: 'targets.rogueMasterPath',
            momentum:    'targets.momentumPath',
            unleashed:   'targets.unleashedPath',
        };
        const cfgKey = keyMap[fwId];
        if (cfgKey) {
            await cfg.update(cfgKey, result[0].fsPath, vscode.ConfigurationTarget.Global);
            refresh();
            vscode.window.showInformationMessage(`${meta?.label} SDK path set to: ${result[0].fsPath}`);
        }
    });

    // ── Firmware: open GitHub releases ───────────────────────────────────────
    reg('flipperFapStudio.fw.openGitHub', (item: unknown) => {
        const fwItem = item as FirmwareStatusItem;
        const meta = FW_META[fwItem?.fwId];
        if (meta?.githubUrl) {
            vscode.env.openExternal(vscode.Uri.parse(meta.githubUrl));
        }
    });

    // ── Firmware: open web update page ───────────────────────────────────────
    reg('flipperFapStudio.fw.openWebPage', (item: unknown) => {
        const fwItem = item as FirmwareStatusItem;
        const meta = FW_META[fwItem?.fwId];
        if (meta?.webUrl) {
            vscode.env.openExternal(vscode.Uri.parse(meta.webUrl));
        }
    });

    // ── Refresh ──────────────────────────────────────────────────────────────
    reg('flipperFapStudio.refresh', () => refresh());
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function showBuildError(title: string, log: string): Promise<void> {
    const hints = getErrorHints(log);
    if (hints.length > 0) {
        const detail = formatHintsForModal(hints);
        const action = await vscode.window.showErrorMessage(
            title,
            { modal: true, detail },
            'Show Output'
        );
        if (action === 'Show Output') { out.show(); }
    } else {
        const action = await vscode.window.showErrorMessage(
            `${title} — see Output panel for details.`,
            'Show Output'
        );
        if (action) { out.show(); }
    }
}

function guardBuild(): boolean {
    if (buildState.isBuilding) {
        vscode.window.showWarningMessage(
            'A build is already in progress.',
            'Cancel Build'
        ).then(a => {
            if (a === 'Cancel Build') {
                vscode.commands.executeCommand('flipperFapStudio.cancelBuild');
            }
        });
        return true;
    }
    return false;
}

function requireFolder(state: StateManager): string | null {
    const folder = state.getAppFolder();
    if (!folder) {
        vscode.window.showWarningMessage(
            'No app folder set. Use "Create starter app" or "Set app folder…" first.'
        );
        return null;
    }
    return folder;
}

async function validateAppFolder(folder: string): Promise<boolean> {
    const fam = path.join(folder, 'application.fam');
    if (!fs.existsSync(fam)) {
        const choice = await vscode.window.showWarningMessage(
            `No application.fam found in "${path.basename(folder)}". This may not be a Flipper app folder.`,
            'Build Anyway'
        );
        return choice === 'Build Anyway';
    }
    return true;
}

async function resolveCreateAppDir(state: StateManager): Promise<string | null> {
    const defaultDir = state.getDefaultCreateAppDir();

    if (defaultDir) {
        const USE_DEFAULT = `Use default: ${defaultDir}`;
        const BROWSE = 'Browse for different location…';
        const choice = await vscode.window.showQuickPick([USE_DEFAULT, BROWSE], {
            title: 'Where should the new app be created?',
        });
        if (!choice) { return null; }
        if (choice === USE_DEFAULT) { return defaultDir; }
    }

    const result = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Create app inside this folder',
    });
    return result ? result[0].fsPath : null;
}

async function handleBuildOutput(appFolder: string, state: StateManager): Promise<void> {
    const askOnBuild = state.getAskOnBuildOutput();
    const autoDir = state.getBuildOutputDir();

    let destDir: string | undefined;

    if (askOnBuild) {
        const result = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: 'Copy .fap here',
            title: 'Where should the built .fap be copied?',
        });
        destDir = result?.[0].fsPath;
    } else if (autoDir) {
        destDir = autoDir;
    }

    if (!destDir) { return; }

    const distDir = path.join(appFolder, 'dist');
    if (!fs.existsSync(distDir)) { return; }

    try {
        if (!fs.existsSync(destDir)) { fs.mkdirSync(destDir, { recursive: true }); }
        const fapFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.fap'));
        for (const fap of fapFiles) {
            fs.copyFileSync(path.join(distDir, fap), path.join(destDir, fap));
        }
        if (fapFiles.length > 0) {
            out.appendLine(`\n→ Copied ${fapFiles.length} .fap file(s) to ${destDir}`);
        }
    } catch (err) {
        vscode.window.showWarningMessage(`Could not copy .fap to output directory: ${(err as Error).message}`);
    }
}
