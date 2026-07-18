import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { flipperSerial, FileType } from './serial/flipperSerial';
import { flipperBle } from './serial/flipperBle';
import { StateManager } from './stateManager';

/**
 * "Device Dashboard" editor tab — device / firmware / battery / storage stats
 * and library counts, fetched over USB serial RPC or (when connected) the BLE
 * RPC link. Everything loads in one burst, so it never holds the transport.
 */
export class DashboardPanel {
    private static current: DashboardPanel | null = null;

    static show(context: vscode.ExtensionContext, state: StateManager) {
        if (DashboardPanel.current) {
            DashboardPanel.current.panel.reveal();
            return;
        }
        DashboardPanel.current = new DashboardPanel(context, state);
    }

    private readonly panel: vscode.WebviewPanel;
    private generation = 0;
    private disposed = false;

    private constructor(context: vscode.ExtensionContext, private readonly state: StateManager) {
        this.panel = vscode.window.createWebviewPanel(
            'flipperDashboard',
            'Flipper Dashboard',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'flipper-icon.svg'));

        // device render — a custom media/flipper-device.png wins over the bundled art
        const png = path.join(context.extensionPath, 'media', 'flipper-device.png');
        const img = fs.existsSync(png) ? png : path.join(context.extensionPath, 'media', 'flipperzero.webp');
        const imgSrc = this.panel.webview.asWebviewUri(vscode.Uri.file(img)).toString();
        this.panel.webview.html = html(imgSrc);

        const subs: vscode.Disposable[] = [
            this.panel.webview.onDidReceiveMessage((msg: { type: string }) => {
                switch (msg.type) {
                    case 'ready':
                    case 'refresh':
                        void this.load();
                        break;
                    case 'openFiles':
                        void vscode.commands.executeCommand('flipperDeviceFiles.focus');
                        break;
                    case 'installFap':
                        void this.installFap();
                        break;
                    case 'bluetooth':
                        void this.toggleBluetooth();
                        break;
                }
            }),
            flipperBle.onStatus(s => {
                if (s.level === 'error' || s.level === 'warn') {
                    void vscode.window.showWarningMessage(`Bluetooth: ${s.text}`);
                }
            }),
            flipperBle.onDidChangeState(() => this.postBleState()),
        ];

        this.panel.onDidDispose(() => {
            DashboardPanel.current = null;
            this.disposed = true;
            this.generation++;
            subs.forEach(d => d.dispose());
        }, null, context.subscriptions);
    }

    private post(msg: unknown) {
        if (!this.disposed) { void this.panel.webview.postMessage(msg); }
    }

    /** Whichever transport is live — BLE when connected, USB serial otherwise. */
    private get link(): {
        getDeviceInfo(): Promise<Record<string, string>>;
        getPowerInfo(): Promise<Record<string, string>>;
        getStorageInfo(p: string): Promise<{ totalSpace: number; freeSpace: number }>;
        listDir(p: string): Promise<Array<{ type: number; name: string }>>;
        writeFile(p: string, d: Buffer): Promise<void>;
        mkdir(p: string): Promise<void>;
    } {
        return flipperBle.isConnected() ? flipperBle : flipperSerial;
    }

    private postBleState() {
        this.post({
            type: 'ble',
            connected: flipperBle.isConnected(),
            name: flipperBle.deviceName,
        });
    }

    private async toggleBluetooth(): Promise<void> {
        this.post({ type: 'bleBusy', busy: true });
        try {
            if (flipperBle.isConnected()) {
                await flipperBle.disconnect();
            } else {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Bluetooth: scanning for a Flipper… (pair it in Windows first — confirm the 6-digit code on its screen)' },
                    () => flipperBle.connect());
                void vscode.window.showInformationMessage(`Bluetooth connected — ${flipperBle.deviceName}. Dashboard now reads over BLE.`);
                void this.load();
            }
        } catch (err) {
            void vscode.window.showErrorMessage(`Bluetooth: ${(err as Error).message}`);
        } finally {
            this.post({ type: 'bleBusy', busy: false });
            this.postBleState();
        }
    }

    private async load(): Promise<void> {
        const gen = ++this.generation;
        const live = () => gen === this.generation;
        this.post({ type: 'loading' });

        // ── device + power info ───────────────────────────────────────────────
        let device: Record<string, string>;
        try {
            device = await flipperSerial.getDeviceInfo();
        } catch (err) {
            if (live()) { this.post({ type: 'error', text: (err as Error).message }); }
            return;
        }
        if (!live()) { return; }
        this.post({ type: 'device', info: device });

        try {
            const power = await flipperSerial.getPowerInfo();
            if (!live()) { return; }
            this.post({ type: 'power', info: power });
        } catch {
            if (live()) { this.post({ type: 'power', info: {} }); }
        }

        // ── storage ───────────────────────────────────────────────────────────
        const ext = await flipperSerial.getStorageInfo('/ext').catch(() => null);
        if (!live()) { return; }
        const int_ = await flipperSerial.getStorageInfo('/int').catch(() => null);
        if (!live()) { return; }
        this.post({ type: 'storage', ext, int: int_ });

        // ── library counts (incremental — big libraries take a few seconds) ──
        const libs: Array<{ id: string; path: string }> = [
            { id: 'subghz', path: '/ext/subghz' },
            { id: 'infrared', path: '/ext/infrared' },
            { id: 'nfc', path: '/ext/nfc' },
            { id: 'rfid', path: '/ext/lfrfid' },
            { id: 'badusb', path: '/ext/badusb' },
            { id: 'apps', path: '/ext/apps' },
        ];
        for (const lib of libs) {
            if (!live()) { return; }
            try {
                const count = await this.countFiles(lib.path, live);
                if (live()) { this.post({ type: 'lib', id: lib.id, count }); }
            } catch {
                if (live()) { this.post({ type: 'lib', id: lib.id, count: null }); }
            }
        }
        if (live()) { this.post({ type: 'done' }); }
    }

    /** Recursive file count with depth/traversal caps so huge SD cards stay snappy. */
    private async countFiles(root: string, live: () => boolean): Promise<number> {
        const MAX_DIRS = 300;
        const MAX_DEPTH = 4;
        let count = 0;
        let dirsVisited = 0;
        const queue: Array<{ p: string; depth: number }> = [{ p: root, depth: 0 }];
        while (queue.length > 0) {
            if (!live()) { throw new Error('cancelled'); }
            const { p, depth } = queue.shift()!;
            if (++dirsVisited > MAX_DIRS) { break; }
            const entries = await this.link.listDir(p);
            for (const e of entries) {
                if (e.type === FileType.DIR) {
                    if (depth < MAX_DEPTH && !e.name.startsWith('.')) {
                        queue.push({ p: `${p}/${e.name}`, depth: depth + 1 });
                    }
                } else {
                    count++;
                }
            }
        }
        return count;
    }

    /** Pick a .fap (defaulting to the app's dist/), pick a category, upload to /ext/apps/… */
    private async installFap(): Promise<void> {
        const finish = () => this.post({ type: 'installBusy', busy: false });
        this.post({ type: 'installBusy', busy: true });
        try {
            // defaults from the active app (used for picker location + suggested category)
            const folder = this.state.getAppFolder();
            let appId = '';
            let famCategory = '';
            if (folder) {
                try {
                    const fam = fs.readFileSync(path.join(folder, 'application.fam'), 'utf8');
                    appId = /appid\s*=\s*["']([^"']+)["']/.exec(fam)?.[1] ?? '';
                    famCategory = /fap_category\s*=\s*["']([^"']+)["']/.exec(fam)?.[1] ?? '';
                } catch { /* no active app — picker still works */ }
            }

            // 1) which .fap?
            const distDir = folder ? path.join(folder, 'dist') : undefined;
            const defaultDir = distDir && fs.existsSync(distDir) ? distDir : folder;
            const picked = await vscode.window.showOpenDialog({
                title: 'Select the .fap to install on the Flipper',
                openLabel: 'Install this .fap',
                canSelectMany: false,
                filters: { 'Flipper application': ['fap'] },
                defaultUri: defaultDir ? vscode.Uri.file(defaultDir) : undefined,
            });
            if (!picked || picked.length === 0) { return; }
            const local = picked[0].fsPath;
            const fapName = path.basename(local);

            // 2) which folder on the device? offer existing /ext/apps categories
            const isCurrentApp = appId !== '' && fapName.toLowerCase() === `${appId.toLowerCase()}.fap`;
            const suggested = isCurrentApp ? famCategory : '';
            const deviceCats = (await this.link.listDir('/ext/apps').catch(() => []))
                .filter(e => e.type === FileType.DIR && !e.name.startsWith('.'))
                .map(e => e.name);
            const seen = new Set<string>();
            const items: vscode.QuickPickItem[] = [];
            if (suggested) {
                items.push({ label: suggested, description: 'from application.fam — recommended' });
                seen.add(suggested);
            }
            for (const c of deviceCats.sort((a, b) => a.localeCompare(b))) {
                if (!seen.has(c)) { items.push({ label: c, description: 'existing folder on device' }); seen.add(c); }
            }
            items.push({ label: '$(root-folder) /ext/apps (no category)', description: 'install at the apps root' });
            items.push({ label: '$(edit) Other…', description: 'type a new category folder name' });
            const choice = await vscode.window.showQuickPick(items, {
                title: `Install ${fapName} — choose the category folder under /ext/apps`,
                placeHolder: 'Where on the SD card should it go?',
            });
            if (!choice) { return; }
            let category: string;
            if (choice.label.includes('/ext/apps (no category)')) {
                category = '';
            } else if (choice.label.includes('Other…')) {
                const typed = await vscode.window.showInputBox({
                    title: 'New category folder under /ext/apps',
                    prompt: 'Folder name, e.g. Tools or GPIO',
                    validateInput: v => /^[^\\/:*?"<>|]*$/.test(v.trim()) ? undefined : 'Just a folder name — no slashes',
                });
                if (typed === undefined) { return; }
                category = typed.trim();
            } else {
                category = choice.label;
            }

            const categoryDir = category ? `/ext/apps/${category}` : '/ext/apps';
            const devPath = `${categoryDir}/${fapName}`;
            const link = this.link;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Installing ${fapName} → ${categoryDir}…` },
                async () => {
                    const data = fs.readFileSync(local);
                    // mkdir is idempotent-ish — EXIST errors are fine
                    await link.mkdir('/ext/apps').catch(() => undefined);
                    if (category) { await link.mkdir(categoryDir).catch(() => undefined); }
                    await link.writeFile(devPath, data);
                });
            void vscode.window.showInformationMessage(`Installed ${path.basename(local)} to ${categoryDir} — find it under Apps on the Flipper.`);
            void vscode.commands.executeCommand('flipperFapStudio.files.refresh');
        } catch (err) {
            void vscode.window.showErrorMessage(`Install failed: ${(err as Error).message}`);
        } finally {
            finish();
        }
    }
}

function html(imgSrc: string): string {
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    :root { --orange: #ff8c1a; --orange-dim: #a35a12; --fg-soft: #bdb4a8; }
    * { box-sizing: border-box; }
    body {
        margin: 0; padding: 16px;
        background:
            linear-gradient(rgba(255,140,26,.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,140,26,.05) 1px, transparent 1px),
            #100d0a;
        background-size: 22px 22px;
        color: var(--orange);
        font-family: 'Consolas', 'Courier New', monospace;
        display: flex; flex-direction: column; align-items: center; gap: 12px;
    }
    #wrap { width: 100%; max-width: 980px; display: flex; flex-direction: column; gap: 12px; }
    #topbar { display: flex; align-items: center; justify-content: space-between; font-size: 12px; letter-spacing: 1px; }
    #statusDot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #666; margin-right: 6px; }
    #statusDot.on { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
    #statusDot.err { background: #f14c4c; box-shadow: 0 0 6px #f14c4c; }
    .btn {
        background: none; cursor: pointer;
        border: 2px solid var(--orange); border-radius: 6px;
        color: var(--orange); padding: 5px 12px;
        font-family: inherit; font-size: 11px; letter-spacing: 1px;
    }
    .btn:hover { background: rgba(255,140,26,.15); }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn.on { background: rgba(63,185,80,.15); border-color: #3fb950; color: #3fb950; }
    #errorBox {
        display: none; border: 2px solid #f14c4c; border-radius: 8px;
        color: #f14c4c; padding: 10px 14px; font-size: 12px; line-height: 1.5;
        white-space: pre-wrap; word-break: break-word;
    }
    #grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .card {
        border: 2px solid var(--orange-dim); border-radius: 10px;
        background: rgba(0,0,0,.45); padding: 12px 14px;
        display: flex; flex-direction: column; gap: 8px; min-height: 120px;
    }
    .card h2 {
        margin: 0; font-size: 11px; letter-spacing: 2px; font-weight: normal;
        color: var(--orange); border-bottom: 1px solid rgba(255,140,26,.25); padding-bottom: 6px;
    }
    .big { font-size: 30px; line-height: 1; color: #ffd9ad; }
    .big small { font-size: 14px; color: var(--orange); }
    .bar { height: 8px; border: 1px solid var(--orange-dim); border-radius: 4px; overflow: hidden; background: #000; }
    .bar > i { display: block; height: 100%; background: var(--orange); width: 0%; transition: width .4s; }
    .bar.low > i { background: #f14c4c; }
    .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; font-size: 11.5px; }
    .kv b { font-weight: normal; color: var(--fg-soft); letter-spacing: .5px; }
    .kv span { color: #ffd9ad; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #devImg {
        width: 100%; max-width: 240px; align-self: center;
        filter: drop-shadow(0 0 10px rgba(255,140,26,.25));
    }
    #actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .stHead {
        display: flex; justify-content: space-between; align-items: baseline;
        font-size: 11px; letter-spacing: 1.5px; color: var(--fg-soft); margin-top: 4px;
    }
    .stHead span { color: #ffd9ad; font-size: 14px; }
    #libs { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
    .lib {
        border: 2px solid var(--orange-dim); border-radius: 10px; background: rgba(0,0,0,.45);
        padding: 10px 12px; display: flex; flex-direction: column; gap: 4px;
    }
    .lib b { font-size: 10px; letter-spacing: 1.5px; color: var(--fg-soft); font-weight: normal; }
    .lib span { font-size: 22px; color: #ffd9ad; }
    .lib span.pending { color: var(--orange-dim); font-size: 13px; }
    details { font-size: 11px; }
    summary { cursor: pointer; letter-spacing: 1px; color: var(--orange-dim); }
    summary:hover { color: var(--orange); }
    #allInfo { margin-top: 6px; max-height: 260px; overflow-y: auto; }
    .dim { color: var(--fg-soft); font-size: 10.5px; letter-spacing: .5px; }
</style>
</head>
<body>
<div id="wrap">
    <div id="topbar">
        <span>FLIPPER&nbsp;DASHBOARD</span>
        <span>
            <span id="statusDot"></span><span id="statusText">CONNECTING…</span>
            &nbsp;<button class="btn" id="btnRefresh">↻ REFRESH</button>
        </span>
    </div>

    <div id="errorBox"></div>

    <div id="actions">
        <button class="btn" id="btnFiles" title="Open the on-device file browser in the sidebar">⬚ FILE MANAGER</button>
        <button class="btn" id="btnInstall" title="Copy the built .fap from dist/ to /ext/apps/<Category>/ on the SD card">⬇ INSTALL .FAP → SD</button>
        <button class="btn" id="btnBle" title="Connect to the Flipper over Bluetooth LE. Pair it with this PC first (Windows Settings → Bluetooth) — there is no default PIN, the Flipper shows a one-time 6-digit code on its screen to confirm. While connected, the dashboard reads over BLE instead of USB.">ᗬ BLUETOOTH: OFF</button>
    </div>

    <div id="grid">
        <div class="card">
            <h2>⚡ DEVICE</h2>
            <img id="devImg" src="${imgSrc}" alt="Flipper Zero">
            <div class="big" id="devName">—</div>
            <div class="kv" id="devRows"></div>
            <details><summary>ALL DEVICE INFO</summary><div class="kv" id="allInfo"></div></details>
        </div>
        <div class="card">
            <h2>▮ BATTERY</h2>
            <div class="big" id="battPct">—<small>%</small></div>
            <div class="bar" id="battBar"><i></i></div>
            <div class="kv" id="battRows"></div>
        </div>
        <div class="card">
            <h2>▤ STORAGE</h2>
            <div class="stHead"><span style="color:var(--fg-soft);font-size:11px">SD CARD (/ext)</span><span id="extPct">—</span></div>
            <div class="bar" id="extBar"><i></i></div>
            <div class="kv" id="extRows"></div>
            <div class="stHead"><span style="color:var(--fg-soft);font-size:11px">INTERNAL (/int)</span><span id="intPct">—</span></div>
            <div class="bar" id="intBar"><i></i></div>
            <div class="kv" id="intRows"></div>
        </div>
    </div>

    <div id="libs">
        <div class="lib"><b>SUB-GHZ</b><span id="lib-subghz" class="pending">…</span></div>
        <div class="lib"><b>INFRARED</b><span id="lib-infrared" class="pending">…</span></div>
        <div class="lib"><b>NFC</b><span id="lib-nfc" class="pending">…</span></div>
        <div class="lib"><b>RFID</b><span id="lib-rfid" class="pending">…</span></div>
        <div class="lib"><b>BADUSB</b><span id="lib-badusb" class="pending">…</span></div>
        <div class="lib"><b>APPS</b><span id="lib-apps" class="pending">…</span></div>
    </div>
    <div class="dim">Library counts scan the SD card recursively (capped) — large libraries update as they finish.</div>
</div>

<script>
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);

    // device/power keys vary between firmwares ("hardware_name" vs "hardware.name")
    function norm(info) {
        const out = {};
        for (const k of Object.keys(info)) { out[k.toLowerCase().replace(/\\./g, '_')] = info[k]; }
        return out;
    }
    const pick = (n, ...keys) => { for (const k of keys) { if (n[k] !== undefined && n[k] !== '') { return n[k]; } } return null; };

    function kvRows(el, rows) {
        el.innerHTML = '';
        for (const [k, v] of rows) {
            if (v === null || v === undefined) { continue; }
            const b = document.createElement('b'); b.textContent = k;
            const s = document.createElement('span'); s.textContent = v;
            el.appendChild(b); el.appendChild(s);
        }
    }

    function fmtBytes(n) {
        if (n >= 1073741824) { return (n / 1073741824).toFixed(2) + ' GB'; }
        if (n >= 1048576)    { return (n / 1048576).toFixed(1) + ' MB'; }
        if (n >= 1024)       { return (n / 1024).toFixed(1) + ' KB'; }
        return n + ' B';
    }

    function setStatus(cls, text) {
        $('statusDot').className = cls;
        $('statusText').textContent = text;
    }

    function storageCard(prefix, info) {
        if (!info || !info.totalSpace) {
            $(prefix + 'Pct').textContent = 'not available';
            $(prefix + 'Rows').innerHTML = '';
            return;
        }
        const used = info.totalSpace - info.freeSpace;
        const pct = Math.round(used / info.totalSpace * 100);
        $(prefix + 'Pct').textContent = pct + '% used';
        const bar = $(prefix + 'Bar');
        bar.classList.toggle('low', pct >= 90);
        bar.firstElementChild.style.width = pct + '%';
        kvRows($(prefix + 'Rows'), [
            ['USED', fmtBytes(used)],
            ['FREE', fmtBytes(info.freeSpace)],
            ['TOTAL', fmtBytes(info.totalSpace)],
        ]);
    }

    window.addEventListener('message', e => {
        const m = e.data;
        switch (m.type) {
            case 'loading':
                setStatus('', 'LOADING…');
                $('errorBox').style.display = 'none';
                $('btnRefresh').disabled = true;
                for (const s of document.querySelectorAll('#libs span')) { s.className = 'pending'; s.textContent = '…'; }
                break;
            case 'error':
                setStatus('err', 'NOT CONNECTED');
                $('errorBox').style.display = 'block';
                $('errorBox').textContent = m.text;
                $('btnRefresh').disabled = false;
                break;
            case 'device': {
                setStatus('on', 'CONNECTED');
                const n = norm(m.info);
                $('devName').textContent = pick(n, 'hardware_name', 'devicename_name') || 'Flipper';
                const fw = pick(n, 'firmware_version') || '?';
                const branch = pick(n, 'firmware_branch', 'firmware_branch_name');
                const fork = pick(n, 'firmware_origin_fork');
                kvRows($('devRows'), [
                    ['FIRMWARE', fw + (branch ? ' (' + branch + ')' : '')],
                    ['FORK', fork],
                    ['MODEL', pick(n, 'hardware_model')],
                    ['HW VER', pick(n, 'hardware_ver')],
                    ['UID', pick(n, 'hardware_uid')],
                    ['RADIO', pick(n, 'radio_stack_major') !== null
                        ? (pick(n, 'radio_stack_major') + '.' + (pick(n, 'radio_stack_minor') || '0')) : null],
                ]);
                kvRows($('allInfo'), Object.keys(m.info).sort().map(k => [k, m.info[k]]));
                break;
            }
            case 'power': {
                const n = norm(m.info);
                const pct = pick(n, 'charge_level');
                $('battPct').innerHTML = (pct !== null ? pct : '—') + '<small>%</small>';
                const bar = $('battBar');
                bar.classList.toggle('low', pct !== null && Number(pct) <= 15);
                bar.firstElementChild.style.width = (pct !== null ? pct : 0) + '%';
                const volts = pick(n, 'battery_voltage');
                const amps = pick(n, 'battery_current');
                const temp = pick(n, 'battery_temp', 'battery_gauge_temp', 'battery_temperature');
                const health = pick(n, 'battery_health');
                kvRows($('battRows'), [
                    ['VOLTAGE', volts !== null ? Number(volts).toFixed(3) + ' V' : null],
                    ['CURRENT', amps !== null ? Math.round(Number(amps) * 1000) + ' mA' : null],
                    ['TEMP', temp !== null ? Number(temp).toFixed(1) + ' °C' : null],
                    ['HEALTH', health !== null ? health + ' %' : null],
                    ['STATE', pick(n, 'charge_state')],
                ]);
                break;
            }
            case 'storage':
                storageCard('ext', m.ext);
                storageCard('int', m.int);
                break;
            case 'lib': {
                const el = $('lib-' + m.id);
                if (el) {
                    el.className = m.count === null ? 'pending' : '';
                    el.textContent = m.count === null ? '—' : String(m.count);
                }
                break;
            }
            case 'done':
                $('btnRefresh').disabled = false;
                break;
            case 'installBusy':
                $('btnInstall').disabled = m.busy;
                $('btnInstall').textContent = m.busy ? '⧖ INSTALLING…' : '⬇ INSTALL .FAP → SD';
                break;
            case 'bleBusy':
                $('btnBle').disabled = m.busy;
                if (m.busy) { $('btnBle').textContent = '⧖ BLUETOOTH…'; }
                break;
            case 'ble':
                $('btnBle').textContent = m.connected
                    ? 'ᗬ BLUETOOTH: ' + (m.name || 'ON') + ' ✕'
                    : 'ᗬ BLUETOOTH: OFF';
                $('btnBle').classList.toggle('on', m.connected);
                break;
        }
    });

    $('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    $('btnFiles').addEventListener('click', () => vscode.postMessage({ type: 'openFiles' }));
    $('btnInstall').addEventListener('click', () => vscode.postMessage({ type: 'installFap' }));
    $('btnBle').addEventListener('click', () => vscode.postMessage({ type: 'bluetooth' }));
    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
