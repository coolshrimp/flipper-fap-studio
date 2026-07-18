import * as vscode from 'vscode';
import * as path from 'path';
import { flipperSerial, FileType } from './serial/flipperSerial';

/**
 * "Device Dashboard" editor tab — device / firmware / battery / storage stats
 * and library counts, fetched over the extension's own USB serial RPC layer.
 * Everything is read-only and loads in one burst, so it never holds the port.
 */
export class DashboardPanel {
    private static current: DashboardPanel | null = null;

    static show(context: vscode.ExtensionContext) {
        if (DashboardPanel.current) {
            DashboardPanel.current.panel.reveal();
            return;
        }
        DashboardPanel.current = new DashboardPanel(context);
    }

    private readonly panel: vscode.WebviewPanel;
    private generation = 0;
    private disposed = false;

    private constructor(context: vscode.ExtensionContext) {
        this.panel = vscode.window.createWebviewPanel(
            'flipperDashboard',
            'Flipper Dashboard',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'flipper-icon.svg'));
        this.panel.webview.html = html();

        const subs: vscode.Disposable[] = [
            this.panel.webview.onDidReceiveMessage((msg: { type: string }) => {
                if (msg.type === 'ready' || msg.type === 'refresh') { void this.load(); }
            }),
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
            const entries = await flipperSerial.listDir(p);
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
}

function html(): string {
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

    <div id="grid">
        <div class="card">
            <h2>⚡ DEVICE</h2>
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
            <h2>▤ SD CARD (/ext)</h2>
            <div class="big" id="extPct">—<small>% used</small></div>
            <div class="bar" id="extBar"><i></i></div>
            <div class="kv" id="extRows"></div>
        </div>
        <div class="card">
            <h2>▦ INTERNAL (/int)</h2>
            <div class="big" id="intPct">—<small>% used</small></div>
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
            $(prefix + 'Pct').innerHTML = '—<small>% used</small>';
            kvRows($(prefix + 'Rows'), [['STATUS', 'not available']]);
            return;
        }
        const used = info.totalSpace - info.freeSpace;
        const pct = Math.round(used / info.totalSpace * 100);
        $(prefix + 'Pct').innerHTML = pct + '<small>% used</small>';
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
        }
    });

    $('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
