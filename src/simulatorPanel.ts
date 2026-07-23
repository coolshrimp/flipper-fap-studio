import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateManager } from './stateManager';
import {
    parseSimulatorSources,
    SimulatorParseResult,
    SimulatorSource,
} from './simulatorParser';
import { FwFlavor, inspectSdkFolder } from './sdkCheck';
import { DesktopRuntime, DesktopRuntimeEvent } from './desktopRuntime';
import { Stm32Runtime, Stm32RuntimeAvailability, Stm32RuntimeEvent } from './stm32Runtime';
import { WEBVIEW_GRID_BACKGROUND, WEBVIEW_THEME } from './webviewTheme';

interface ManifestInfo {
    appId: string;
    name: string;
    entryPoint: string;
    category: string;
}

interface FapInfo {
    path: string;
    name: string;
    size: number;
    modified: string;
    valid: boolean;
    format: string;
    detail: string;
}

interface TargetOption {
    id: string;
    label: string;
    path: string;
}

interface FirmwareProfile {
    kind: 'managed' | 'source' | 'package' | 'folder' | 'missing' | 'mismatch';
    title: string;
    detail: string;
    path: string;
}

interface SimulatorModel {
    appFolder: string;
    appName: string;
    appId: string;
    entryPoint: string;
    targetId: string;
    targetOptions: TargetOption[];
    firmware: FirmwareProfile;
    fap: FapInfo | null;
    parse: SimulatorParseResult;
    engine: Stm32RuntimeAvailability;
}

interface SimulatorMessage {
    type?: string;
    target?: string;
    sourceFile?: string;
    dataUrl?: string;
    key?: string;
    inputType?: string;
    source?: 'app' | 'firmware';
}

const MAX_SOURCE_FILES = 120;
const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
const MAX_SOURCE_DIRS = 300;
const MAX_SOURCE_DEPTH = 12;
const MAX_SOURCE_ENTRIES_PER_DIR = 2_000;
const SKIP_DIRS = new Set(['.git', '.ufbt', 'node_modules', 'dist', 'build', 'built', 'out']);

// 5x7 GLCD font (classic Adafruit-GFX glcdfont, BSD licence), chars 32..126.
// It matches the approximation already used by the built-in UI Designer.
const FONT_B64 =
    'AAAAAAAAAF8AAAAHAAcAFH8UfxQkKn8qEiMTCGRiNklWIFAACAcDAAAcIkEAAEEiHAAqHH8cKggIPggIAIBwMAAICAgICAAAYGAAIBAIBAI+UUlFPgBCf0AAcklJSUYhQUlNMxgUEn8QJ0VFRTk8SklJMUEhEQkHNklJSTZGSUkpHgAAFAAAAEA0AAAACBQiQRQUFBQUAEEiFAgCAVkJBj5BXVlOfBIREnx/SUlJNj5BQUEif0FBQT5/SUlJQX8JCQkBPkFBUXN/CAgIfwBBf0EAIEBBPwF/CBQiQX9AQEBAfwIcAn9/BAgQfz5BQUE+fwkJCQY+QVEhXn8JGSlGJklJSTIDAX8BAz9AQEA/HyBAIB8/QDhAP2MUCBRjAwR4BANhWUlNQwB/QUFBAgQIECAAQUFBfwQCAQIEQEBAQEAAAwcIACBUVHhAfyhERDg4REREKDhERCh/OFRUVBgACH4JAhikpJx4fwgEBHgARH1AACBAQD0AfxAoRAAAQX9AAHwEeAR4fAgEBHg4REREOPwYJCQYGCQkGPx8CAQECEhUVFQkBAQ/RCQ8QEAgfBwgQCAcPEAwQDxEKBAoREyQkJB8RGRUTEQACDZBAAAAdwAAAEE2CAACAQIEAg==';

export class SimulatorPanel {
    static currentPanel: SimulatorPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private readonly state: StateManager;
    private watcher: vscode.FileSystemWatcher | undefined;
    private watchedFolder = '';
    private refreshTimer: NodeJS.Timeout | undefined;
    private selectedFap = '';
    private initialRender = true;
    private runtimeStarting = false;
    private readonly desktopRuntime: DesktopRuntime;
    private readonly stm32Runtime: Stm32Runtime;

    static show(context: vscode.ExtensionContext, state: StateManager): void {
        if (SimulatorPanel.currentPanel) {
            SimulatorPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            SimulatorPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'flipperSimulator',
            'Flipper Simulator',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        SimulatorPanel.currentPanel = new SimulatorPanel(panel, context, state);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        state: StateManager
    ) {
        this.panel = panel;
        this.context = context;
        this.state = state;
        this.desktopRuntime = new DesktopRuntime(context, (event: DesktopRuntimeEvent) => {
            void this.panel.webview.postMessage(event);
        });
        this.stm32Runtime = new Stm32Runtime(context, (event: Stm32RuntimeEvent) => {
            void this.panel.webview.postMessage(event);
        });

        this.panel.onDidDispose(() => this.dispose(), undefined, context.subscriptions);
        this.panel.webview.onDidReceiveMessage(
            (message: SimulatorMessage) => this.handleMessage(message),
            undefined,
            context.subscriptions
        );
        this.refresh();
    }

    private dispose(): void {
        this.desktopRuntime.stop();
        this.stm32Runtime.stop(false);
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.watcher?.dispose();
        SimulatorPanel.currentPanel = undefined;
    }

    private refresh(): void {
        const model = this.buildModel();
        this.ensureWatcher(model.appFolder);
        this.panel.webview.html = html(this.panel.webview, model, this.initialRender);
        this.initialRender = false;
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.refresh();
        }, 250);
    }

    private ensureWatcher(appFolder: string): void {
        if (appFolder === this.watchedFolder) { return; }
        this.watcher?.dispose();
        this.watcher = undefined;
        this.watchedFolder = appFolder;
        if (!appFolder || !fs.existsSync(appFolder)) { return; }

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(appFolder, '**/*.{c,h,fam}')
        );
        watcher.onDidCreate(() => this.scheduleRefresh());
        watcher.onDidChange(() => this.scheduleRefresh());
        watcher.onDidDelete(() => this.scheduleRefresh());
        this.watcher = watcher;
        this.context.subscriptions.push(watcher);
    }

    private async handleMessage(message: SimulatorMessage): Promise<void> {
        switch (message.type) {
            case 'refresh':
                this.refresh();
                return;

            case 'selectTarget': {
                const target = message.target || '';
                const allowed = this.state.buildTargetChoices()
                    .filter(item => item.id !== '__add__')
                    .some(item => item.id === target);
                if (!allowed) { return; }
                await this.state.setActiveTarget(target);
                this.selectedFap = '';
                this.refresh();
                return;
            }

            case 'build':
                await this.postStatus('build', 'Building the app against the selected firmware target...');
                await vscode.commands.executeCommand('flipperFapStudio.build');
                this.selectedFap = '';
                this.refresh();
                return;

            case 'runHardware':
                await this.postStatus('hardware', 'Building and launching on the connected Flipper...');
                if (await vscode.commands.executeCommand<boolean>('flipperFapStudio.buildAndLaunch')) {
                    await vscode.commands.executeCommand('flipperFapStudio.screen.openTab');
                } else {
                    await this.postStatus('hardware', 'Build or launch did not complete; live screen was not opened.');
                }
                return;

            case 'runtimeStart': {
                if (this.runtimeStarting || this.stm32Runtime.running || this.desktopRuntime.running) {
                    return;
                }
                this.runtimeStarting = true;
                const appFolder = this.state.getAppFolder();
                const manifest = readManifest(appFolder);
                const hasApp = Boolean(appFolder && manifest.entryPoint);
                try {
                    let fapPath = hasApp ? (this.selectedFap || findBuiltFap(appFolder, manifest.appId)) : '';
                    if (hasApp && !fapPath) {
                        await this.postStatus('build', 'No built app was found; building against the selected Target…');
                        await vscode.commands.executeCommand('flipperFapStudio.build');
                        fapPath = findBuiltFap(appFolder, manifest.appId);
                    }
                    if (hasApp && !fapPath) throw new Error('The build completed without producing a .fap in the app dist folder.');
                    await this.stm32Runtime.start({
                        targetId: this.state.getActiveTarget(),
                        targetPath: this.state.getTargetPath(this.state.getActiveTarget()),
                        appId: hasApp ? manifest.appId : 'firmware',
                        category: hasApp ? manifest.category : 'Misc',
                        fapPath,
                    });
                } catch (error) {
                    this.stm32Runtime.stop(false);
                    const text = error instanceof Error ? error.message : String(error);
                    await this.panel.webview.postMessage({ type: 'runtimeStatus', state: 'error', text });
                    vscode.window.showErrorMessage(text);
                    this.runtimeStarting = false;
                    return;
                }
                if (hasApp) {
                    try {
                        await this.desktopRuntime.start(appFolder, manifest, this.stm32Runtime.storagePath);
                    } catch (error) {
                        const text = error instanceof Error ? error.message : String(error);
                        await this.panel.webview.postMessage({
                            type: 'runtimeLog',
                            tag: 'BRIDGE',
                            level: 'warn',
                            text: `Desktop app bridge unavailable: ${text}. Raw firmware simulation is still running.`,
                        });
                        vscode.window.showWarningMessage('Desktop app bridge failed; the raw firmware simulator is still running.');
                    }
                }
                this.runtimeStarting = false;
                return;
            }

            case 'runtimeStop':
                this.desktopRuntime.stop();
                this.stm32Runtime.stop();
                return;

            case 'runtimeInput':
                if (message.source === 'firmware') {
                    this.stm32Runtime.sendInput(message.key || '', message.inputType || 'short');
                } else {
                    this.desktopRuntime.sendInput(message.key || '', message.inputType || 'short');
                }
                return;

            case 'runtimeOpenStorage':
                await this.stm32Runtime.openStorage();
                return;

            case 'chooseFap':
                await this.chooseFap();
                return;

            case 'openSource':
                await this.openSource(message.sourceFile || '');
                return;

            case 'saveScreenshot':
                await this.saveScreenshot(message.dataUrl || '');
                return;
        }
    }

    private async postStatus(kind: string, text: string): Promise<void> {
        await this.panel.webview.postMessage({ type: 'status', kind, text });
    }

    private async chooseFap(): Promise<void> {
        const appFolder = this.state.getAppFolder();
        const dist = path.join(appFolder || '.', 'dist');
        const picked = await vscode.window.showOpenDialog({
            title: 'Load a .fap for validation',
            openLabel: 'Load .fap',
            canSelectMany: false,
            defaultUri: vscode.Uri.file(fs.existsSync(dist) ? dist : (appFolder || '.')),
            filters: { 'Flipper application': ['fap'] },
        });
        if (!picked?.[0]) { return; }
        this.selectedFap = picked[0].fsPath;
        this.refresh();
    }

    private async openSource(relativeFile: string): Promise<void> {
        const appFolder = this.state.getAppFolder();
        if (!appFolder || !relativeFile) { return; }
        const root = path.resolve(appFolder);
        const candidate = path.resolve(root, relativeFile);
        if (!isInside(root, candidate) || !fs.existsSync(candidate)) { return; }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(candidate));
    }

    private async saveScreenshot(dataUrl: string): Promise<void> {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
        if (!match || match[1].length > 12_000_000) {
            vscode.window.showErrorMessage('Simulator screenshot data was invalid.');
            return;
        }
        const manifest = readManifest(this.state.getAppFolder());
        const destination = await vscode.window.showSaveDialog({
            title: 'Save simulator screenshot',
            defaultUri: vscode.Uri.file(path.join(
                this.state.getAppFolder() || os.homedir(),
                `${manifest.appId || 'flipper-app'}-simulator.png`
            )),
            filters: { PNG: ['png'] },
        });
        if (!destination) { return; }
        await fs.promises.writeFile(destination.fsPath, Buffer.from(match[1], 'base64'));
        vscode.window.showInformationMessage(`Simulator screenshot saved: ${destination.fsPath}`);
    }

    private buildModel(): SimulatorModel {
        const appFolder = this.state.getAppFolder();
        const manifest = readManifest(appFolder);
        const sources = collectSources(appFolder);
        const parsed = parseSimulatorSources(sources);
        const targetId = this.state.getActiveTarget();
        const targetOptions = this.state.buildTargetChoices()
            .filter(item => item.id !== '__add__')
            .map(item => ({
                id: item.id,
                label: stripThemeIcons(item.label),
                path: this.state.getTargetPath(item.id),
            }));

        const fapPath = this.selectedFap || findBuiltFap(appFolder, manifest.appId);
        return {
            appFolder,
            appName: manifest.name || (appFolder ? path.basename(appFolder) : 'No app selected'),
            appId: manifest.appId,
            entryPoint: manifest.entryPoint,
            targetId,
            targetOptions,
            firmware: inspectFirmwareProfile(targetId, this.state.getTargetPath(targetId)),
            fap: fapPath ? inspectFap(fapPath) : null,
            parse: parsed,
            engine: this.stm32Runtime.inspectAvailability(),
        };
    }
}

function collectSources(root: string): SimulatorSource[] {
    if (!root || !fs.existsSync(root)) { return []; }
    const result: SimulatorSource[] = [];
    let totalBytes = 0;
    let visitedDirs = 0;

    const walk = (dir: string, depth: number) => {
        if (
            result.length >= MAX_SOURCE_FILES ||
            totalBytes >= MAX_SOURCE_BYTES ||
            visitedDirs >= MAX_SOURCE_DIRS ||
            depth > MAX_SOURCE_DEPTH
        ) { return; }
        visitedDirs++;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        if (entries.length > MAX_SOURCE_ENTRIES_PER_DIR) {
            const main = entries.find(entry => entry.name === 'main.c');
            entries = entries.slice(0, MAX_SOURCE_ENTRIES_PER_DIR);
            if (main && !entries.includes(main)) { entries[entries.length - 1] = main; }
        }

        entries.sort((a, b) => {
            if (a.name === 'main.c') { return -1; }
            if (b.name === 'main.c') { return 1; }
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            if (result.length >= MAX_SOURCE_FILES || totalBytes >= MAX_SOURCE_BYTES) { break; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (visitedDirs >= MAX_SOURCE_DIRS) { break; }
                if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) { walk(full, depth + 1); }
                continue;
            }
            if (!entry.isFile() || !/\.[ch]$/i.test(entry.name)) { continue; }
            try {
                const stat = fs.statSync(full);
                if (stat.size > 750_000 || totalBytes + stat.size > MAX_SOURCE_BYTES) { continue; }
                result.push({
                    filePath: path.relative(root, full),
                    content: fs.readFileSync(full, 'utf8'),
                });
                totalBytes += stat.size;
            } catch { /* a partial source set is still useful */ }
        }
    };

    walk(root, 0);
    return result;
}

function readManifest(appFolder: string): ManifestInfo {
    const fallback: ManifestInfo = { appId: '', name: '', entryPoint: '', category: 'Misc' };
    if (!appFolder) { return fallback; }
    try {
        const text = fs.readFileSync(path.join(appFolder, 'application.fam'), 'utf8');
        return {
            appId: /\bappid\s*=\s*["']([^"']+)["']/.exec(text)?.[1] || '',
            name: /\bname\s*=\s*["']([^"']+)["']/.exec(text)?.[1] || '',
            entryPoint: /\bentry_point\s*=\s*["']([^"']+)["']/.exec(text)?.[1] || '',
            category: /\bfap_category\s*=\s*["']([^"']+)["']/.exec(text)?.[1] || 'Misc',
        };
    } catch {
        return fallback;
    }
}

function findBuiltFap(appFolder: string, appId: string): string {
    if (!appFolder) { return ''; }
    const dist = path.join(appFolder, 'dist');
    try {
        if (!fs.existsSync(dist)) { return ''; }
        if (appId) {
            const expected = path.join(dist, `${appId}.fap`);
            if (fs.existsSync(expected)) { return expected; }
        }
        const candidates = fs.readdirSync(dist)
            .filter(name => name.toLowerCase().endsWith('.fap'))
            .map(name => path.join(dist, name))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return candidates[0] || '';
    } catch {
        return '';
    }
}

function inspectFap(filePath: string): FapInfo {
    try {
        const stat = fs.statSync(filePath);
        const header = Buffer.alloc(64);
        let fd: number | undefined;
        let read = 0;
        try {
            fd = fs.openSync(filePath, 'r');
            read = fs.readSync(fd, header, 0, header.length, 0);
        } finally {
            if (fd !== undefined) { fs.closeSync(fd); }
        }
        const elf = read >= 28 && header[0] === 0x7f && header.toString('ascii', 1, 4) === 'ELF';
        const elf32 = elf && header[4] === 1;
        const little = elf && header[5] === 1;
        const machine = elf && little ? header.readUInt16LE(18) : -1;
        const arm = machine === 40;
        const entry = elf32 && little ? header.readUInt32LE(24) : 0;
        return {
            path: filePath,
            name: path.basename(filePath),
            size: stat.size,
            modified: stat.mtime.toISOString(),
            valid: elf32 && little && arm,
            format: elf ? `${elf32 ? 'ELF32' : 'ELF'} / ${arm ? 'ARM' : `machine ${machine}`}` : 'Not an ELF file',
            detail: elf32 && little && arm
                ? `ARM ELF32 header detected; entry 0x${entry.toString(16).padStart(8, '0')}. Runtime/API compatibility is not verified.`
                : 'A Flipper .fap should be a little-endian ARM ELF32 package.',
        };
    } catch (err) {
        return {
            path: filePath,
            name: path.basename(filePath),
            size: 0,
            modified: '',
            valid: false,
            format: 'Unreadable',
            detail: (err as Error).message,
        };
    }
}

function inspectFirmwareProfile(targetId: string, targetPath: string): FirmwareProfile {
    if (targetId === 'oem') {
        const managed = path.join(os.homedir(), '.ufbt', 'current');
        return {
            kind: 'managed',
            title: 'OEM / uFBT managed SDK',
            detail: fs.existsSync(managed)
                ? 'Local uFBT SDK found. Builds use its official API symbols and libraries.'
                : 'uFBT will download the official SDK when the app is built.',
            path: managed,
        };
    }
    if (!targetPath || !fs.existsSync(targetPath)) {
        return {
            kind: 'missing',
            title: 'Firmware path unavailable',
            detail: 'Set this target folder in Flipper FAP Studio Settings.',
            path: targetPath,
        };
    }
    if (
        fs.existsSync(path.join(targetPath, 'SConstruct')) &&
        (fs.existsSync(path.join(targetPath, 'fbt')) || fs.existsSync(path.join(targetPath, 'fbt.cmd')))
    ) {
        return {
            kind: 'source',
            title: 'Local firmware source tree',
            detail: 'Firmware source detected for reference. Building still requires a compatible uFBT SDK configuration.',
            path: targetPath,
        };
    }
    const expectedFlavor: FwFlavor | undefined = ({
        rogueMaster: 'rogueMaster',
        momentum: 'momentum',
        unleashed: 'unleashed',
    } as Record<string, FwFlavor>)[targetId];
    const info = inspectSdkFolder(targetPath, expectedFlavor);
    if (info.ok && (!expectedFlavor || info.flavor === expectedFlavor)) {
        return {
            kind: 'package',
            title: `${info.version || 'Custom'} firmware package`,
            detail: 'Update package detected for version matching only. It is not a uFBT build SDK or CPU emulator.',
            path: info.dir || targetPath,
        };
    }
    if (info.ok && expectedFlavor && info.flavor !== expectedFlavor) {
        return {
            kind: 'mismatch',
            title: 'Firmware target mismatch',
            detail: `Selected ${expectedFlavor}, but this folder contains ${info.flavor || 'another firmware'}. Choose the matching package or SDK folder.`,
            path: info.dir || targetPath,
        };
    }
    return {
        kind: 'folder',
        title: 'Custom SDK folder',
        detail: 'Configured target folder. Builds require a compatible uFBT SDK; no runnable emulator image was detected.',
        path: targetPath,
    };
}

function stripThemeIcons(label: string): string {
    return label.replace(/\$\([^)]+\)\s*/g, '').replace(/\s{2,}/g, ' ').trim();
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function html(webview: vscode.Webview, model: SimulatorModel, autoStart = true): string {
    const nonce = randomNonce();
    const data = JSON.stringify(model).replace(/</g, '\\u003c');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;">
<title>Flipper Simulator</title>
<style nonce="${nonce}">
    ${WEBVIEW_THEME}
    :root {
        color-scheme: dark;
        --orange: var(--fap-accent);
        --orange-2: var(--fap-accent-strong);
        --bg: var(--fap-bg);
        --panel: var(--fap-surface);
        --panel-2: var(--fap-surface-raised);
        --line: var(--fap-line);
        --text: var(--fap-text);
        --muted: var(--fap-muted);
        --good: var(--fap-good);
        --warn: var(--fap-warn);
        --bad: var(--fap-danger);
    }
    * { box-sizing: border-box; }
    body {
        margin: 0; padding: 22px;
        background: ${WEBVIEW_GRID_BACKGROUND};
        background-size: 36px 36px, 36px 36px, auto, auto;
        color: var(--text); font: 14px/1.45 var(--vscode-font-family, "Segoe UI", sans-serif);
    }
    button, select { font: inherit; }
    .page { max-width: 1380px; margin: 0 auto; }
    .eyebrow { color: var(--orange); font: 700 12px/1.2 var(--vscode-editor-font-family, monospace); letter-spacing: .15em; }
    h1 { margin: 6px 0 5px; font-size: 30px; letter-spacing: -.02em; }
    .subtitle { color: var(--muted); margin-bottom: 18px; }
    .badge { display: inline-flex; padding: 5px 9px; border-radius: 999px; font-size: 10px; letter-spacing: .08em; vertical-align: 5px; }
    .experimental { color: #1b1100; background: var(--warn); }
    .safe { color: #052114; background: var(--good); }
    .warning {
        display: flex; gap: 12px; align-items: flex-start; padding: 13px 15px; margin-bottom: 16px;
        border: 1px solid #6b5424; background: rgba(255,200,87,.08); border-radius: 10px; color: #f4d993;
    }
    .warning strong { color: var(--warn); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 9px; margin-bottom: 16px; }
    .btn {
        border: 1px solid #46505e; background: var(--panel-2); color: var(--text); border-radius: 8px;
        padding: 9px 13px; cursor: pointer; font-weight: 650;
    }
    .btn:hover { border-color: var(--orange); background: #21170f; }
    .btn.primary { background: var(--orange); border-color: var(--orange); color: #17100a; }
    .btn.hardware { border-color: #396d59; color: #baf6d8; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px; margin-bottom: 16px; }
    .card { background: rgba(17,21,27,.94); border: 1px solid var(--line); border-radius: 12px; padding: 13px 15px; min-width: 0; }
    .card-label { color: var(--orange); font-size: 11px; font-weight: 750; letter-spacing: .09em; margin-bottom: 4px; }
    .card-title { font-size: 16px; font-weight: 720; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card-detail { color: var(--muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
    .target-select { width: 100%; margin-top: 7px; padding: 6px 8px; border-radius: 6px; border: 1px solid #404956; background: #0c1015; color: var(--text); }
    .workspace { display: grid; grid-template-columns: minmax(600px, 1.45fr) minmax(320px, .75fr); gap: 16px; }
    .sim-card, .side-card { background: rgba(12,15,20,.96); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 15px; border-bottom: 1px solid var(--line); }
    .section-title { font-size: 13px; font-weight: 750; letter-spacing: .06em; }
    .screen-select { max-width: 260px; padding: 5px 8px; border: 1px solid #414a56; border-radius: 6px; background: #11161d; color: var(--text); }
    .device-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 150px; align-items: center; gap: 22px; padding: 28px; }
    .display-bezel { padding: 16px; border-radius: 24px; background: #ddd; border: 5px solid #222; box-shadow: 0 22px 55px rgba(0,0,0,.5); }
    #screen { display: block; width: 100%; aspect-ratio: 2/1; background: #fe8a2c; image-rendering: pixelated; image-rendering: crisp-edges; border: 4px solid #24201d; border-radius: 8px; outline: none; }
    #screen:focus { box-shadow: 0 0 0 3px var(--orange); }
    .dpad { display: grid; grid-template-columns: 44px 44px 44px; grid-template-rows: 44px 44px 44px 42px; justify-content: center; }
    .key { width: 42px; height: 42px; border-radius: 50%; border: 1px solid #9b5716; color: var(--orange); background: #13110f; cursor: pointer; font-weight: 800; }
    .key:hover, .key.active, .key.holding { background: var(--orange); color: #15100b; }
    .key:disabled { opacity: .45; cursor: wait; background: #13110f; color: #87613d; }
    .key.up { grid-column: 2; grid-row: 1; } .key.left { grid-column: 1; grid-row: 2; }
    .key.ok { grid-column: 2; grid-row: 2; } .key.right { grid-column: 3; grid-row: 2; }
    .key.down { grid-column: 2; grid-row: 3; } .key.back { grid-column: 2; grid-row: 4; border-color: #a83b4b; color: #ff7787; }
    .run-row { display: flex; align-items: center; justify-content: space-between; padding: 0 28px 22px; color: var(--muted); font-size: 12px; }
    .run-state { color: var(--good); font-weight: 700; }
    .side-card { min-height: 100%; }
    .side-section { padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .side-section:last-child { border-bottom: 0; }
    .side-section h3 { margin: 0 0 9px; font-size: 12px; color: var(--orange); letter-spacing: .08em; }
    .metric { display: flex; justify-content: space-between; gap: 12px; margin: 5px 0; }
    .metric span:first-child { color: var(--muted); }
    .metric span:last-child { text-align: right; overflow-wrap: anywhere; }
    .good { color: var(--good); } .bad { color: var(--bad); } .muted { color: var(--muted); }
    .warnings { margin: 0; padding-left: 18px; max-height: 160px; overflow: auto; color: #e8c97f; }
    .warnings li { margin: 5px 0; }
    .log { height: 165px; overflow: auto; padding: 10px; border: 1px solid #2c333e; border-radius: 7px; background: #05070a; color: #bec8d6; font: 12px/1.5 var(--vscode-editor-font-family, Consolas, monospace); white-space: pre-wrap; }
    .source-link { border: 0; padding: 0; background: none; color: #72b7ff; cursor: pointer; text-decoration: underline; }
    .limitations { margin-top: 16px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 10px; background: rgba(17,21,27,.75); color: var(--muted); }
    @media (max-width: 940px) {
        .cards, .workspace { grid-template-columns: 1fr; }
        .device-wrap { grid-template-columns: 1fr; }
        .dpad { margin: 0 auto; }
    }
</style>
</head>
<body>
<div class="page">
    <div class="eyebrow">FLIPPER FAP STUDIO / LOCAL TESTING</div>
    <h1>Flipper Simulator <span class="badge experimental">EXPERIMENTAL</span></h1>
    <div class="subtitle">Boot the selected Target firmware and run the active app with shared display, input, and virtual-storage services.</div>

    <div class="warning">
        <div>⚠</div>
        <div><strong>Firmware-backed simulation.</strong> The selected STM32WB55 firmware is executed by the local ARM engine. Its real ST7567 screen and button GPIO take over this panel after boot, while packaged resources and compatible <code>.fap</code> files are available through the emulated SPI SD card. The app compatibility bridge remains available for supported app logic. Raw internal flash, radio, NFC, IR, BLE, and electrical GPIO remain outside the desktop model.</div>
    </div>

    <div class="toolbar">
        <button class="btn primary" id="btnBuild">▶ Build .fap</button>
        <button class="btn hardware" id="btnRuntime">▶ Boot Target${model.appFolder && model.entryPoint ? ' + App' : ''}</button>
        <button class="btn" id="btnRuntimeStop" disabled>■ Stop Simulator</button>
        <button class="btn" id="btnAudio">Sound: On</button>
        <button class="btn" id="btnStorage">Open Virtual Storage</button>
        <button class="btn" id="btnDisplaySource" disabled>View CFW</button>
        <button class="btn hardware" id="btnHardware">◉ Build + Run on Physical Flipper</button>
        <button class="btn" id="btnFap">Load .fap…</button>
        <button class="btn" id="btnRefresh">↻ Reload Source</button>
        <button class="btn" id="btnShot" ${model.parse.screens.length ? '' : 'disabled'}>▣ Save Screenshot</button>
    </div>

    <div class="cards">
        <div class="card">
            <div class="card-label">ACTIVE APP</div>
            <div class="card-title">${escapeHtml(model.appName)}</div>
            <div class="card-detail">${escapeHtml(model.appFolder || 'Choose an app folder from the sidebar')}</div>
        </div>
        <div class="card">
            <div class="card-label">FIRMWARE PROFILE</div>
            <div class="card-title">${escapeHtml(model.firmware.title)}</div>
            <select class="target-select" id="targetSelect">
                ${model.targetOptions.map(option => `<option value="${escapeAttr(option.id)}" ${option.id === model.targetId ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
            </select>
            <div class="card-detail">${escapeHtml(model.firmware.detail)}</div>
            <div class="card-detail ${model.engine.available ? 'good' : 'bad'}">${escapeHtml(model.engine.available ? 'STM32 engine ready' : model.engine.detail)}</div>
        </div>
        <div class="card">
            <div class="card-label">FAP HEADER CHECK</div>
            <div class="card-title ${model.fap?.valid ? 'good' : ''}">${escapeHtml(model.fap ? model.fap.name : 'Not built yet')}</div>
            <div class="card-detail">${escapeHtml(model.fap ? `${model.fap.format} • ${formatBytes(model.fap.size)} • ${model.fap.detail}` : 'Build the active app or load an existing .fap.')}</div>
        </div>
    </div>

    <div class="workspace">
        <section class="sim-card">
            <div class="section-head">
                <div class="section-title">128 × 64 DISPLAY</div>
                <select class="screen-select" id="screenSelect" ${model.parse.screens.length ? '' : 'disabled'}>
                    ${model.parse.screens.map((screen, index) => `<option value="${index}">${escapeHtml(screen.name)}</option>`).join('')}
                    ${model.parse.screens.length ? '' : '<option>No preview available</option>'}
                </select>
            </div>
            <div class="device-wrap">
                <div class="display-bezel"><canvas id="screen" width="128" height="64" tabindex="0" aria-label="Flipper simulator display"></canvas></div>
                <div class="dpad" aria-label="Simulator controls">
                    <button class="key up" data-key="UP">▲</button>
                    <button class="key left" data-key="LEFT">◀</button>
                    <button class="key ok" data-key="OK">OK</button>
                    <button class="key right" data-key="RIGHT">▶</button>
                    <button class="key down" data-key="DOWN">▼</button>
                    <button class="key back" data-key="BACK">↩</button>
                </div>
            </div>
            <div class="run-row"><span>Keyboard: arrows/WASD • Enter/Space = OK • Esc/Backspace = Back</span><span class="run-state" id="runState">STATIC PREVIEW</span></div>
        </section>

        <aside class="side-card">
            <div class="side-section">
                <h3>PREVIEW COVERAGE</h3>
                <div class="metric"><span>Screens found</span><span>${model.parse.screens.length}</span></div>
                <div class="metric"><span>Canvas calls</span><span>${model.parse.parsedCalls}</span></div>
                <div class="metric"><span>XBM arrays</span><span>${Object.keys(model.parse.bitmaps).length}</span></div>
                <div class="metric"><span>Entry point</span><span>${escapeHtml(model.entryPoint || 'unknown')}</span></div>
                <div class="metric"><span>Source</span><span><button class="source-link" id="openSource">${escapeHtml(model.parse.screens[0]?.sourceFile || 'none')}</button></span></div>
            </div>
            <div class="side-section">
                <h3>APPROXIMATIONS / SKIPPED</h3>
                ${model.parse.warnings.length
                    ? `<ul class="warnings">${model.parse.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
                    : '<div class="good">No parser warnings for the detected screens.</div>'}
            </div>
            <div class="side-section">
                <h3>SIMULATOR LOG</h3>
                <div class="log" id="log">[SIM] Safe source preview loaded\n[FW] ${escapeHtml(model.firmware.title)}\n${model.fap ? `[FAP] ${escapeHtml(model.fap.name)} — ${model.fap.valid ? 'ARM ELF32 header detected' : 'header check failed'}` : '[FAP] No package loaded'}</div>
            </div>
        </aside>
    </div>

    <div class="limitations"><strong>Runtime layout:</strong> the selected firmware image, STM32WB55 SVD, built app, session metadata, and virtual <code>/ext</code> tree are assembled under extension storage. App saves survive restarts. Physical radios and GPIO still require <strong>Build + Run on Physical Flipper</strong>.</div>
</div>

<script nonce="${nonce}">
(function() {
    var vscode = acquireVsCodeApi();
    var model = ${data};
    var FONT = (function() {
        var bin = atob('${FONT_B64}');
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    })();
    var display = document.getElementById('screen');
    var ctx = display.getContext('2d');
    var buf = new Uint8Array(128 * 64);
    var current = 0;
    var running = true;
    var runtimeActive = false;
    var runtimeCommands = [];
    var firmwareFrame = '';
    var firmwareActive = false;
    var firmwareProcessActive = false;
    var preparationActive = false;
    var preparationProgress = 0;
    var preparationText = 'Preparing selected firmware...';
    var displaySource = model.appFolder && model.entryPoint ? 'app' : 'firmware';
    var activeFont = 'FontSecondary';
    var colorMode = 'ColorBlack';
    var budget = 0;
    var budgetWarned = false;
    var logBox = document.getElementById('log');
    var audioEnabled = true;
    var audioContext = null;
    var audioChannels = { app: null, firmware: null };
    var audioDesired = { app: null, firmware: null };
    var audioTimers = { app: null, firmware: null };

    function log(text) {
        logBox.textContent += '\\n' + text;
        logBox.scrollTop = logBox.scrollHeight;
    }
    function unlockAudio() {
        if (!audioEnabled) return;
        var AudioApi = window.AudioContext || window.webkitAudioContext;
        if (!AudioApi) return;
        if (!audioContext) audioContext = new AudioApi();
        if (audioContext.state === 'suspended') audioContext.resume();
        ['app', 'firmware'].forEach(function(source) {
            var desired = audioDesired[source];
            if (desired && desired.playing) applyAudio(source, desired);
        });
    }
    function stopAudioChannel(source) {
        var channel = audioChannels[source];
        audioChannels[source] = null;
        if (!channel || !audioContext) return;
        try {
            channel.gain.gain.cancelScheduledValues(audioContext.currentTime);
            channel.gain.gain.setTargetAtTime(0, audioContext.currentTime, 0.008);
            channel.oscillator.stop(audioContext.currentTime + 0.04);
        } catch (_) {}
    }
    function applyAudio(source, state) {
        if (!audioEnabled || !audioContext || audioContext.state === 'closed') return;
        if (!state.playing) { stopAudioChannel(source); return; }
        var frequency = Math.min(12000, Math.max(40, Number(state.frequency) || 0));
        var volume = Math.min(1, Math.max(0, Number(state.volume) || 0));
        if (!frequency || !volume) { stopAudioChannel(source); return; }
        var channel = audioChannels[source];
        if (!channel) {
            var oscillator = audioContext.createOscillator();
            var gain = audioContext.createGain();
            oscillator.type = 'square';
            gain.gain.value = 0;
            oscillator.connect(gain);
            gain.connect(audioContext.destination);
            oscillator.start();
            channel = audioChannels[source] = { oscillator: oscillator, gain: gain };
        }
        channel.oscillator.frequency.setTargetAtTime(frequency, audioContext.currentTime, 0.005);
        channel.gain.gain.setTargetAtTime(volume * 0.08, audioContext.currentTime, 0.008);
    }
    function setAudio(source, state) {
        if (audioTimers[source]) { clearTimeout(audioTimers[source]); audioTimers[source] = null; }
        audioDesired[source] = state;
        if (!state.playing) { stopAudioChannel(source); return; }
        unlockAudio();
        applyAudio(source, state);
        var duration = Math.min(10000, Math.max(0, Number(state.durationMs) || 0));
        if (duration) {
            audioTimers[source] = setTimeout(function() {
                audioDesired[source] = { playing: false };
                stopAudioChannel(source);
                audioTimers[source] = null;
            }, duration);
        }
    }
    function stopAllAudio() {
        ['app', 'firmware'].forEach(function(source) {
            if (audioTimers[source]) clearTimeout(audioTimers[source]);
            audioTimers[source] = null;
            audioDesired[source] = null;
            stopAudioChannel(source);
        });
    }
    function rawPx(x, y, value) {
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || x >= 128 || y < 0 || y >= 64) return;
        buf[y * 128 + x] = value ? 1 : 0;
    }
    function spend(cost) {
        budget -= cost || 1;
        return budget >= 0;
    }
    function setPx(x, y, value) {
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || x >= 128 || y < 0 || y >= 64) return;
        var index = y * 128 + x;
        if (colorMode === 'ColorWhite') buf[index] = 0;
        else if (colorMode === 'ColorXOR') buf[index] = buf[index] ? 0 : 1;
        else buf[index] = value === 0 ? 0 : 1;
    }
    function box(x, y, w, h) {
        var x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        var x1 = Math.min(128, Math.ceil(x + w)), y1 = Math.min(64, Math.ceil(y + h));
        for (var py = y0; py < y1; py++) for (var px = x0; px < x1; px++) {
            if (!spend()) return;
            setPx(px, py);
        }
    }
    function line(x0, y0, x1, y1) {
        var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
        var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
        while (true) {
            if (!spend()) return;
            setPx(x0, y0);
            if (x0 === x1 && y0 === y1) break;
            var e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }
    function frame(x, y, w, h) {
        line(x, y, x + w - 1, y); line(x, y + h - 1, x + w - 1, y + h - 1);
        line(x, y, x, y + h - 1); line(x + w - 1, y, x + w - 1, y + h - 1);
    }
    function insideRounded(px, py, x, y, w, h, r) {
        if (px < x || py < y || px >= x + w || py >= y + h) return false;
        r = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
        var x1 = x + r, y1 = y + r, x2 = x + w - 1 - r, y2 = y + h - 1 - r;
        var cx = null, cy = null;
        if (px < x1 && py < y1) { cx = x1; cy = y1; }
        else if (px > x2 && py < y1) { cx = x2; cy = y1; }
        else if (px < x1 && py > y2) { cx = x1; cy = y2; }
        else if (px > x2 && py > y2) { cx = x2; cy = y2; }
        if (cx === null) return true;
        var dx = px - cx, dy = py - cy;
        return dx * dx + dy * dy <= r * r;
    }
    function rounded(x, y, w, h, r, fill) {
        var x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        var x1 = Math.min(128, Math.ceil(x + w)), y1 = Math.min(64, Math.ceil(y + h));
        for (var py = y0; py < y1; py++) for (var px = x0; px < x1; px++) {
            if (!spend()) return;
            if (!insideRounded(px, py, x, y, w, h, r)) continue;
            if (fill) setPx(px, py);
            else if (!insideRounded(px - 1, py, x, y, w, h, r) || !insideRounded(px + 1, py, x, y, w, h, r) || !insideRounded(px, py - 1, x, y, w, h, r) || !insideRounded(px, py + 1, x, y, w, h, r)) setPx(px, py);
        }
    }
    function circle(cx, cy, r, fill) {
        if (r < 0) return;
        var x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
        var x1 = Math.min(127, Math.ceil(cx + r)), y1 = Math.min(63, Math.ceil(cy + r));
        for (var py = y0; py <= y1; py++) for (var px = x0; px <= x1; px++) {
            if (!spend()) return;
            var dx = px - cx, dy = py - cy, d = dx * dx + dy * dy;
            if (fill ? d <= r * r : (d <= r * r && d >= (r - 1) * (r - 1) - 1)) setPx(px, py);
        }
    }
    function glyphCols(ch) {
        var code = ch.charCodeAt(0);
        if (code < 32 || code > 126) code = 63;
        var offset = (code - 32) * 5, cols = [];
        for (var i = 0; i < 5; i++) cols.push(FONT[offset + i]);
        return cols;
    }
    function glyphMetrics(ch) {
        if (ch === ' ') return { cols: [0], first: 0, last: 0, advance: 3 };
        var cols = glyphCols(ch), first = 0, last = cols.length - 1;
        while (first < last && cols[first] === 0) first++;
        while (last > first && cols[last] === 0) last--;
        return { cols: cols, first: first, last: last, advance: (last - first + 1) + 1 };
    }
    function drawText(x, baseline, text, fontName, inkOverride) {
        var scale = fontName === 'FontBigNumbers' ? 2 : 1;
        var bold = fontName === 'FontPrimary';
        var top = baseline - 6 * scale;
        var cursor = x;
        for (var n = 0; n < text.length; n++) {
            if (!spend()) return cursor - x;
            var metrics = glyphMetrics(text.charAt(n));
            for (var col = metrics.first; col <= metrics.last; col++) for (var row = 0; row < 7; row++) {
                if (!spend()) return cursor - x;
                if ((metrics.cols[col] >> row) & 1) {
                    for (var sy = 0; sy < scale; sy++) for (var sx = 0; sx < scale; sx++) {
                        var glyphX = cursor + (col - metrics.first) * scale + sx;
                        if (inkOverride === undefined) setPx(glyphX, top + row * scale + sy);
                        else rawPx(glyphX, top + row * scale + sy, inkOverride);
                        if (bold) {
                            if (inkOverride === undefined) setPx(glyphX + 1, top + row * scale + sy);
                            else rawPx(glyphX + 1, top + row * scale + sy, inkOverride);
                        }
                    }
                }
            }
            cursor += (metrics.advance + (bold ? 1 : 0)) * scale;
        }
        return cursor - x;
    }
    function textWidth(text, fontName) {
        var scale = fontName === 'FontBigNumbers' ? 2 : 1;
        var width = 0;
        for (var i = 0; i < text.length; i++) width += glyphMetrics(text.charAt(i)).advance + (fontName === 'FontPrimary' ? 1 : 0);
        return width * scale;
    }
    function drawAlignedText(x, y, text, horizontal, vertical) {
        var scale = activeFont === 'FontBigNumbers' ? 2 : 1;
        var width = textWidth(text, activeFont);
        var height = 7 * scale;
        var drawX = x;
        var baseline = y;
        if (horizontal === 'AlignCenter') drawX = Math.round(x - width / 2);
        else if (horizontal === 'AlignRight') drawX = x - width;
        if (vertical === 'AlignTop') baseline = y + height - 1;
        else if (vertical === 'AlignCenter') baseline = y + Math.floor((height - 1) / 2);
        drawText(drawX, baseline, text, activeFont);
    }
    function button(pos, text) {
        var label = pos === 'left' ? '<' + text : pos === 'right' ? text + '>' : text;
        var width = textWidth(label, 'FontSecondary') + 9;
        var x = pos === 'left' ? 0 : pos === 'right' ? 128 - width : Math.floor((128 - width) / 2);
        var old = colorMode; colorMode = 'ColorBlack'; rounded(x, 53, width, 11, 3, true); colorMode = old;
        drawText(x + 5, 61, label, 'FontSecondary', 0);
    }
    function drawXbm(x, y, w, h, name) {
        var bytes = model.parse.bitmaps[name];
        if (!bytes) { drawIconPlaceholder(x, y, name, w, h); return; }
        drawXbmBytes(x, y, w, h, bytes);
    }
    function drawXbmData(x, y, w, h, hex) {
        var bytes = [];
        for (var i = 0; i + 1 < String(hex).length; i += 2) bytes.push(parseInt(String(hex).slice(i, i + 2), 16) || 0);
        drawXbmBytes(x, y, w, h, bytes);
    }
    function drawXbmBytes(x, y, w, h, bytes) {
        if (w <= 0 || h <= 0) return;
        var stride = Math.ceil(w / 8);
        var py0 = Math.max(0, -y), py1 = Math.min(h, 64 - y);
        var px0 = Math.max(0, -x), px1 = Math.min(w, 128 - x);
        for (var py = py0; py < py1; py++) for (var px = px0; px < px1; px++) {
            if (!spend()) return;
            var byteIndex = py * stride + Math.floor(px / 8);
            if ((bytes[byteIndex] || 0) & (1 << (px % 8))) setPx(x + px, y + py);
        }
    }
    function drawIconPlaceholder(x, y, name, forcedW, forcedH) {
        var m = /_(\\d+)x(\\d+)$/.exec(name || '');
        var w = forcedW || (m ? Number(m[1]) : 10), h = forcedH || (m ? Number(m[2]) : 10);
        w = Math.max(5, Math.min(24, w)); h = Math.max(5, Math.min(24, h));
        frame(x, y, w, h); line(x + 1, y + 1, x + w - 2, y + h - 2); line(x + w - 2, y + 1, x + 1, y + h - 2);
    }
    function execute(command) {
        var a = command.args;
        switch (command.op) {
            case 'clear': buf.fill(0); break;
            case 'setFont': activeFont = a[0]; break;
            case 'setColor': colorMode = a[0]; break;
            case 'invertColor': colorMode = colorMode === 'ColorBlack' ? 'ColorWhite' : 'ColorBlack'; break;
            case 'text': drawText(a[0], a[1], a[2], activeFont); break;
            case 'textAligned': drawAlignedText(a[0], a[1], a[2], a[3], a[4]); break;
            case 'box': box(a[0], a[1], a[2], a[3]); break;
            case 'frame': frame(a[0], a[1], a[2], a[3]); break;
            case 'rbox': rounded(a[0], a[1], a[2], a[3], a[4], true); break;
            case 'rframe': rounded(a[0], a[1], a[2], a[3], a[4], false); break;
            case 'line': line(a[0], a[1], a[2], a[3]); break;
            case 'dot': setPx(a[0], a[1]); break;
            case 'circle': circle(a[0], a[1], a[2], false); break;
            case 'disc': circle(a[0], a[1], a[2], true); break;
            case 'xbm': drawXbm(a[0], a[1], a[2], a[3], a[4]); break;
            case 'xbmData': drawXbmData(a[0], a[1], a[2], a[3], a[4]); break;
            case 'icon': drawIconPlaceholder(a[0], a[1], a[2]); break;
            case 'button': button(a[0], a[1]); break;
        }
    }
    function paint() {
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#FE8A2C'; ctx.fillRect(0, 0, 128, 64);
        ctx.fillStyle = '#000000';
        for (var y = 0; y < 64; y++) for (var x = 0; x < 128; x++) if (buf[y * 128 + x]) ctx.fillRect(x, y, 1, 1);
    }
    function preparationLines(text, maxWidth, maxLines) {
        var words = String(text || 'Preparing firmware...').replace(/\\s+/g, ' ').trim().split(' ');
        var lines = [], currentLine = '';
        var truncated = false;
        for (var i = 0; i < words.length; i++) {
            var candidate = currentLine ? currentLine + ' ' + words[i] : words[i];
            if (textWidth(candidate, 'FontSecondary') <= maxWidth) {
                currentLine = candidate;
                continue;
            }
            if (currentLine) lines.push(currentLine);
            currentLine = words[i];
            if (lines.length >= maxLines) {
                truncated = true;
                break;
            }
        }
        if (currentLine && lines.length < maxLines) lines.push(currentLine);
        if (truncated) {
            var last = lines[maxLines - 1];
            while (last.length && textWidth(last + '...', 'FontSecondary') > maxWidth) {
                last = last.slice(0, -1);
            }
            lines[maxLines - 1] = last + '...';
        }
        return lines;
    }
    function drawPreparation() {
        var lines = preparationLines(preparationText, 120, 3);
        for (var i = 0; i < lines.length; i++) drawText(4, 9 + i * 11, lines[i], 'FontSecondary');
        var percent = Math.max(0, Math.min(100, Math.round(preparationProgress)));
        var label = String(percent) + '%';
        drawText(124 - textWidth(label, 'FontSecondary'), 45, label, 'FontSecondary');
        frame(4, 49, 120, 11);
        var fillWidth = Math.round(116 * percent / 100);
        if (fillWidth > 0) box(6, 51, fillWidth, 7);
    }
    function setPreparation(active, progress, text) {
        preparationActive = Boolean(active);
        if (Number.isFinite(Number(progress))) {
            preparationProgress = Math.max(0, Math.min(100, Number(progress)));
        }
        if (text) preparationText = String(text);
        document.querySelectorAll('[data-key]').forEach(function(buttonEl) {
            buttonEl.disabled = preparationActive;
        });
    }
    function render() {
        buf.fill(0); activeFont = 'FontSecondary'; colorMode = 'ColorBlack';
        budget = 100000;
        var screen = model.parse.screens[current];
        var commands = displaySource === 'app' && runtimeActive ? runtimeCommands : (screen ? screen.commands : []);
        if (preparationActive) {
            drawPreparation();
        } else if (displaySource === 'firmware' && firmwareProcessActive && firmwareActive && firmwareFrame.length === 2048 && running) {
            for (var page = 0; page < 8; page++) for (var x = 0; x < 128; x++) {
                var byteValue = parseInt(firmwareFrame.slice((page * 128 + x) * 2, (page * 128 + x) * 2 + 2), 16) || 0;
                for (var bit = 0; bit < 8; bit++) {
                    buf[(page * 8 + bit) * 128 + x] = (byteValue >> bit) & 1;
                }
            }
        } else if (displaySource === 'app' && runtimeActive && running) {
            for (var i = 0; i < commands.length; i++) {
                if (!spend()) break;
                execute(commands[i]);
            }
        } else if (!firmwareProcessActive && screen && running) {
            for (var i = 0; i < commands.length; i++) {
                if (!spend()) break;
                execute(commands[i]);
            }
        }
        paint();
        if (budget < 0 && !budgetWarned) {
            budgetWarned = true;
            log('[SAFE] Preview render budget reached; remaining drawing work was skipped.');
        }
        var cfwVisible = displaySource === 'firmware' && firmwareProcessActive && firmwareActive;
        var appVisible = displaySource === 'app' && runtimeActive;
        document.getElementById('runState').textContent = preparationActive ?
            'PREPARING CFW ' + Math.round(preparationProgress) + '%' :
            (cfwVisible ? '● CFW FUNCTIONAL' :
            (appVisible ? '● APP FUNCTIONAL' :
            (firmwareProcessActive ? 'BOOTING CFW…' : (running ? 'STATIC PREVIEW' : '■ STOPPED'))));
        document.getElementById('runState').style.color =
            (cfwVisible || appVisible || firmwareProcessActive || running) ? 'var(--good)' : 'var(--bad)';
        var source = document.getElementById('openSource');
        if (source) source.textContent = screen ? screen.sourceFile : 'none';
    }
    function input(key, inputType) {
        inputType = inputType === 'long' ? 'long' : 'short';
        if (preparationActive) {
            log('[INPUT] ' + key + ' ignored — firmware setup is still running');
            return;
        }
        if (displaySource === 'firmware') {
            if (firmwareProcessActive) {
                vscode.postMessage({ type: 'runtimeInput', source: 'firmware', key: key, inputType: inputType });
                log('[INPUT] ' + key + ' → CFW');
                return;
            }
            if (firmwareActive) {
                log('[INPUT] ' + key + ' ignored — CFW is stopped');
                return;
            }
        }
        if (displaySource === 'app' && runtimeActive) {
            vscode.postMessage({ type: 'runtimeInput', source: 'app', key: key, inputType: inputType });
            log('[INPUT] ' + key + ' → app');
            return;
        }
        if (key === 'BACK') {
            running = false; log('[INPUT] BACK — preview stopped'); render(); return;
        }
        if (!running) {
            if (key === 'OK') { running = true; log('[SIM] Preview restarted'); render(); }
            return;
        }
        if ((key === 'LEFT' || key === 'RIGHT') && model.parse.screens.length > 1) {
            var delta = key === 'RIGHT' ? 1 : -1;
            current = (current + delta + model.parse.screens.length) % model.parse.screens.length;
            document.getElementById('screenSelect').value = String(current);
            log('[INPUT] ' + key + ' → ' + model.parse.screens[current].name);
            render(); return;
        }
        log('[INPUT] ' + key + ' (app logic is not executed offline)');
    }
    function screenshot() {
        var out = document.createElement('canvas'); out.width = 512; out.height = 256;
        var o = out.getContext('2d'); o.imageSmoothingEnabled = false;
        o.fillStyle = '#FE8A2C'; o.fillRect(0, 0, 512, 256); o.fillStyle = '#000000';
        for (var y = 0; y < 64; y++) for (var x = 0; x < 128; x++) if (buf[y * 128 + x]) o.fillRect(x * 4, y * 4, 4, 4);
        vscode.postMessage({ type: 'saveScreenshot', dataUrl: out.toDataURL('image/png') });
    }

    document.getElementById('btnBuild').onclick = function() { log('[BUILD] Requested'); vscode.postMessage({ type: 'build' }); };
    document.getElementById('btnRuntime').onclick = function() {
        log('[SIM] Building app and preparing selected firmware…');
        displaySource = 'firmware';
        firmwareActive = false;
        firmwareFrame = '';
        setPreparation(true, 2, 'Preparing selected firmware...');
        updateDisplaySourceButton();
        render();
        document.getElementById('btnRuntime').disabled = true;
        vscode.postMessage({ type: 'runtimeStart' });
    };
    document.getElementById('btnRuntimeStop').onclick = function() { vscode.postMessage({ type: 'runtimeStop' }); };
    document.getElementById('btnAudio').onclick = function() {
        audioEnabled = !audioEnabled;
        this.textContent = audioEnabled ? 'Sound: On' : 'Sound: Off';
        if (audioEnabled) unlockAudio(); else stopAllAudio();
    };
    document.getElementById('btnStorage').onclick = function() { vscode.postMessage({ type: 'runtimeOpenStorage' }); };
    function updateDisplaySourceButton() {
        var button = document.getElementById('btnDisplaySource');
        button.disabled = displaySource === 'firmware' ?
            !runtimeActive : !(firmwareProcessActive && firmwareActive);
        button.textContent = displaySource === 'firmware' ? 'View App' : 'View CFW';
    }
    document.getElementById('btnDisplaySource').onclick = function() {
        displaySource = displaySource === 'firmware' ? 'app' : 'firmware';
        updateDisplaySourceButton();
        render();
    };
    document.getElementById('btnHardware').onclick = function() { log('[HW] Accurate run requested'); vscode.postMessage({ type: 'runHardware' }); };
    document.getElementById('btnFap').onclick = function() { vscode.postMessage({ type: 'chooseFap' }); };
    document.getElementById('btnRefresh').onclick = function() { vscode.postMessage({ type: 'refresh' }); };
    document.getElementById('btnShot').onclick = screenshot;
    document.getElementById('targetSelect').onchange = function(e) { vscode.postMessage({ type: 'selectTarget', target: e.target.value }); };
    document.getElementById('screenSelect').onchange = function(e) { current = Number(e.target.value) || 0; running = true; render(); log('[SIM] Screen → ' + model.parse.screens[current].name); };
    document.getElementById('openSource').onclick = function() { var screen = model.parse.screens[current]; if (screen) vscode.postMessage({ type: 'openSource', sourceFile: screen.sourceFile }); };
    var holdDelayMs = 550;
    document.querySelectorAll('[data-key]').forEach(function(buttonEl) {
        var holdTimer = null;
        var holdSent = false;
        buttonEl.addEventListener('pointerdown', function(event) {
            if (buttonEl.disabled) return;
            if (event && event.preventDefault) event.preventDefault();
            unlockAudio();
            holdSent = false;
            if (buttonEl.classList) buttonEl.classList.add('holding');
            if (buttonEl.setPointerCapture && event && event.pointerId !== undefined) {
                buttonEl.setPointerCapture(event.pointerId);
            }
            holdTimer = setTimeout(function() {
                holdTimer = null;
                holdSent = true;
                input(buttonEl.dataset.key, 'long');
            }, holdDelayMs);
        });
        buttonEl.addEventListener('pointerup', function(event) {
            if (event && event.preventDefault) event.preventDefault();
            if (holdTimer) clearTimeout(holdTimer);
            holdTimer = null;
            if (buttonEl.classList) buttonEl.classList.remove('holding');
            if (!holdSent) input(buttonEl.dataset.key, 'short');
            holdSent = false;
            display.focus();
        });
        buttonEl.addEventListener('pointercancel', function() {
            if (holdTimer) clearTimeout(holdTimer);
            holdTimer = null;
            holdSent = false;
            if (buttonEl.classList) buttonEl.classList.remove('holding');
        });
        buttonEl.addEventListener('contextmenu', function(event) { event.preventDefault(); });
    });
    var keyboardHolds = {};
    function mappedKey(code) {
        var map = { ArrowUp:'UP', KeyW:'UP', ArrowDown:'DOWN', KeyS:'DOWN', ArrowLeft:'LEFT', KeyA:'LEFT', ArrowRight:'RIGHT', KeyD:'RIGHT', Enter:'OK', Space:'OK', Escape:'BACK', Backspace:'BACK' };
        return map[code];
    }
    window.addEventListener('keydown', function(event) {
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'SELECT' || tag === 'BUTTON') return;
        var key = mappedKey(event.code); if (!key) return;
        event.preventDefault();
        if (keyboardHolds[event.code]) return;
        unlockAudio();
        keyboardHolds[event.code] = {
            key: key,
            sent: false,
            timer: setTimeout(function() {
                var state = keyboardHolds[event.code];
                if (!state) return;
                state.sent = true;
                state.timer = null;
                input(state.key, 'long');
            }, holdDelayMs)
        };
    });
    window.addEventListener('keyup', function(event) {
        var state = keyboardHolds[event.code];
        if (!state) return;
        event.preventDefault();
        if (state.timer) clearTimeout(state.timer);
        delete keyboardHolds[event.code];
        if (!state.sent) input(state.key, 'short');
    });
    window.addEventListener('message', function(event) {
        var message = event.data;
        if (message && message.type === 'status') log('[' + String(message.kind || 'status').toUpperCase() + '] ' + message.text);
        if (message && message.type === 'runtimeFrame') {
            runtimeCommands = Array.isArray(message.commands) ? message.commands : [];
            runtimeActive = true; running = true; updateDisplaySourceButton(); render();
        }
        if (message && message.type === 'runtimeLog') {
            log('[' + String(message.tag || 'RUNTIME') + '] ' + String(message.text || ''));
        }
        if (message && message.type === 'runtimeAudio') setAudio('app', message);
        if (message && message.type === 'stm32Audio') setAudio('firmware', message);
        if (message && message.type === 'stm32Log') {
            log('[' + String(message.tag || 'STM32') + '] ' + String(message.text || ''));
        }
        if (message && message.type === 'stm32Frame') {
            if (!firmwareProcessActive) return;
            firmwareFrame = String(message.hex || '');
            firmwareActive = firmwareFrame.length === 2048;
            running = true;
            if (firmwareActive) {
                setPreparation(false, 100);
                document.getElementById('runState').textContent = 'CFW RUNNING';
                updateDisplaySourceButton();
                render();
            }
        }
        if (message && message.type === 'stm32Status') {
            var stmState = String(message.state || '');
            if (message.text) log('[STM32] ' + message.text);
            if (stmState === 'starting') {
                setPreparation(true, message.progress, message.text);
                firmwareProcessActive = true;
                firmwareActive = false;
                firmwareFrame = '';
                document.getElementById('runState').textContent = 'BOOTING CFW…';
                render();
            }
            if (stmState === 'running') {
                firmwareProcessActive = true;
                if (message.progress !== undefined) setPreparation(true, message.progress);
                document.getElementById('btnRuntime').disabled = true;
                document.getElementById('btnRuntimeStop').disabled = false;
                render();
            } else if (stmState === 'stopped' || stmState === 'error' || stmState === 'ready') {
                setPreparation(false, preparationProgress);
                firmwareProcessActive = false;
                firmwareActive = false;
                firmwareFrame = '';
                if (runtimeActive) displaySource = 'app';
                updateDisplaySourceButton();
                document.getElementById('btnRuntimeStop').disabled = !runtimeActive;
                document.getElementById('btnRuntime').disabled = runtimeActive;
                render();
            }
        }
        if (message && message.type === 'runtimeStatus') {
            var state = String(message.state || '');
            if (message.text) log('[RUNTIME] ' + message.text);
            if (state === 'running') {
                runtimeActive = true; running = true;
                updateDisplaySourceButton();
                document.getElementById('btnRuntime').disabled = true;
                document.getElementById('btnRuntimeStop').disabled = false;
                document.getElementById('screenSelect').disabled = true;
            } else if (state === 'building') {
                if (!preparationActive) document.getElementById('runState').textContent = 'BUILDING…';
            } else if (state === 'stopped' || state === 'exited' || state === 'error') {
                setAudio('app', { playing: false });
                if (state === 'error' && !firmwareProcessActive) setPreparation(false, preparationProgress);
                runtimeActive = false;
                displaySource = 'firmware';
                updateDisplaySourceButton();
                document.getElementById('btnRuntime').disabled = firmwareProcessActive;
                document.getElementById('btnRuntimeStop').disabled = !firmwareProcessActive;
                document.getElementById('screenSelect').disabled = model.parse.screens.length === 0;
                render();
            }
        }
    });
    window.addEventListener('beforeunload', stopAllAudio);
    updateDisplaySourceButton();
    render();
    ${autoStart ? "document.getElementById('btnRuntime').click();" : ""}
})();
</script>
</body>
</html>`;
}

function randomNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 24; i++) { value += alphabet[Math.floor(Math.random() * alphabet.length)]; }
    return value;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttr(value: string): string {
    return escapeHtml(value).replace(/`/g, '&#096;');
}

function formatBytes(value: number): string {
    if (value < 1024) { return `${value} B`; }
    if (value < 1024 * 1024) { return `${(value / 1024).toFixed(1)} KB`; }
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// Kept deliberately small: the smoke test uses this to syntax-check the
// generated webview script without starting a VS Code Extension Host.
export const simulatorPanelTestHooks = { html };
