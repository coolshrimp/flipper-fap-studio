import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { flipperSerial, InputKey, InputType } from './serial/flipperSerial';
import { WEBVIEW_GRID_BACKGROUND, WEBVIEW_THEME } from './webviewTheme';

const KEY_MAP: Record<string, InputKey> = {
    up: InputKey.UP, down: InputKey.DOWN, left: InputKey.LEFT,
    right: InputKey.RIGHT, ok: InputKey.OK, back: InputKey.BACK,
};
const TYPE_MAP: Record<string, InputType> = {
    press: InputType.PRESS, release: InputType.RELEASE,
    short: InputType.SHORT, long: InputType.LONG, repeat: InputType.REPEAT,
};

// ── shared log buffer so panels restore their content when reopened ──────────

interface LogEntry { kind: 'serial' | 'rpc'; level?: string; text: string; ts: number }

const logBuffer: LogEntry[] = [];
let bufferInitialized = false;

function pushLog(entry: LogEntry) {
    logBuffer.push(entry);
    while (logBuffer.length > 1500) { logBuffer.shift(); }
}

/** Call once on activation — records serial + RPC events for panel restore. */
export function initScreenLogBuffer(context: vscode.ExtensionContext) {
    if (bufferInitialized) { return; }
    bufferInitialized = true;
    context.subscriptions.push(
        flipperSerial.onLogData(text => pushLog({ kind: 'serial', text, ts: Date.now() })),
        flipperSerial.onStatus(s => pushLog({ kind: 'rpc', level: s.level, text: s.text, ts: Date.now() })),
    );
}

/**
 * Wire a webview (sidebar view or editor tab) to the shared serial manager:
 * frames/status/state/device-log in, input/screenshot/log-control/reboot out.
 */
function attachScreen(webview: vscode.Webview, consumerId: string): vscode.Disposable[] {
    const post = (msg: unknown) => void webview.postMessage(msg);

    const subs: vscode.Disposable[] = [
        flipperSerial.onScreenFrame(f => post({
            type: 'frame', data: f.data.toString('base64'), orientation: f.orientation,
        })),
        flipperSerial.onStatus(s => post({ type: 'status', level: s.level, text: s.text, ts: Date.now() })),
        flipperSerial.onLogData(text => post({ type: 'serial', text })),
        flipperSerial.onDidChangeState(state => post({ type: 'state', state })),
    ];

    const connect = async () => {
        try {
            await flipperSerial.setStreamConsumer(consumerId, true);
        } catch (err) {
            post({ type: 'status', level: 'error', text: (err as Error).message, ts: Date.now() });
        }
    };

    subs.push(webview.onDidReceiveMessage(async (msg: { type: string; [k: string]: unknown }) => {
        const reportError = (err: unknown) =>
            post({ type: 'status', level: 'error', text: (err as Error).message, ts: Date.now() });
        switch (msg.type) {
            case 'ready':
                post({ type: 'restoreLog', entries: logBuffer });
                post({ type: 'state', state: flipperSerial.getState() });
                void connect();
                break;
            case 'reconnect':
                void connect();
                break;
            case 'input': {
                const key = KEY_MAP[msg.key as string];
                const type = TYPE_MAP[msg.event as string];
                if (key === undefined || type === undefined) { return; }
                flipperSerial.sendInput(key, type).catch(reportError);
                break;
            }
            case 'startLog': flipperSerial.startLog().catch(reportError); break;
            case 'stopLog':  flipperSerial.stopLog().catch(reportError); break;
            case 'clearLog': logBuffer.length = 0; break;
            case 'reboot':   flipperSerial.rebootDevice().catch(reportError); break;
            case 'openTab':
                void vscode.commands.executeCommand('flipperFapStudio.screen.openTab');
                break;
            case 'screenshot':
                await saveScreenshot(msg.dataUrl as string);
                break;
        }
    }));

    return subs;
}

async function saveScreenshot(dataUrl: string) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(defaultDir, `flipper_${stamp}.png`)),
        filters: { 'PNG image': ['png'] },
        title: 'Save Flipper screenshot',
    });
    if (!uri) { return; }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(base64, 'base64'));
    const action = await vscode.window.showInformationMessage(`Screenshot saved: ${path.basename(uri.fsPath)}`, 'Open');
    if (action === 'Open') { await vscode.commands.executeCommand('vscode.open', uri); }
}

/**
 * "Live Screen" sidebar view — screen mirror, controls, and the combined
 * device/RPC log in one panel. Streams only while the view is visible.
 */
export class ScreenViewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'flipperScreen';

    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        view.webview.html = html(true);
        const subs = attachScreen(view.webview, 'sidebar');

        view.onDidChangeVisibility(() => {
            void flipperSerial.setStreamConsumer('sidebar', view.visible);
        });
        view.onDidDispose(() => {
            subs.forEach(d => d.dispose());
            void flipperSerial.setStreamConsumer('sidebar', false);
        });
    }
}

/**
 * Editor-tab variant ("pop out") — same UI at full size.
 */
export class ScreenPanel {
    private static current: ScreenPanel | null = null;

    static show(context: vscode.ExtensionContext) {
        if (ScreenPanel.current) {
            ScreenPanel.current.panel.reveal();
            return;
        }
        ScreenPanel.current = new ScreenPanel(context);
    }

    private readonly panel: vscode.WebviewPanel;

    private constructor(context: vscode.ExtensionContext) {
        this.panel = vscode.window.createWebviewPanel(
            'flipperScreenTab',
            'Flipper Screen',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'flipper-icon.svg'));
        this.panel.webview.html = html(false);

        const subs = attachScreen(this.panel.webview, 'tab');

        this.panel.onDidDispose(() => {
            ScreenPanel.current = null;
            subs.forEach(d => d.dispose());
            void flipperSerial.setStreamConsumer('tab', false);
        }, null, context.subscriptions);
    }
}

function html(compact: boolean): string {
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    ${WEBVIEW_THEME}
    :root {
        --orange: var(--fap-accent);
        --orange-dim: var(--fap-accent-border);
        --screen-bg: var(--fap-screen);
    }
    * { box-sizing: border-box; user-select: none; }
    body {
        margin: 0; padding: ${compact ? '8px' : '14px'};
        background: ${WEBVIEW_GRID_BACKGROUND};
        background-size: 36px 36px, 36px 36px, auto, auto;
        color: var(--fap-text);
        font-family: var(--fap-ui-font);
        display: flex; flex-direction: column; align-items: center; gap: ${compact ? '8px' : '12px'};
        min-height: ${compact ? 'auto' : '100vh'};
    }
    #topbar {
        width: 100%; max-width: 980px;
        display: flex; align-items: center; justify-content: space-between;
        font-size: ${compact ? '10px' : '12px'}; letter-spacing: 1px;
    }
    #statusDot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #666; margin-right: 6px; }
    #statusDot.on { background: var(--fap-good); box-shadow: 0 0 6px var(--fap-good); }
    #statusDot.warn { background: var(--fap-warn); box-shadow: 0 0 6px var(--fap-warn); }
    #statusDot.err { background: var(--fap-danger); box-shadow: 0 0 6px var(--fap-danger); }
    #main {
        width: 100%;
        display: flex; gap: ${compact ? '14px' : '26px'};
        align-items: center; justify-content: center; flex-wrap: wrap;
    }
    #screenCol {
        flex: 0 1 538px; min-width: 220px;
        display: flex; flex-direction: column; align-items: center; gap: ${compact ? '8px' : '12px'};
    }
    #bezel {
        width: 100%;
        background: var(--screen-bg);
        border: 3px solid var(--orange-dim);
        border-radius: 14px;
        padding: ${compact ? '8px' : '12px'};
        box-shadow: 0 0 24px rgba(255,140,26,.18);
    }
    canvas {
        display: block;
        width: 100%; height: auto;
        image-rendering: pixelated;
        outline: none;
    }
    /* ── action buttons (above the controls) ── */
    #actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
    .btn {
        background: none; cursor: pointer;
        border: 1px solid var(--fap-line); border-radius: 7px;
        background: var(--fap-surface-raised); color: var(--fap-text); padding: ${compact ? '5px 10px' : '7px 14px'};
        font-family: inherit; font-size: ${compact ? '10px' : '12px'}; letter-spacing: 1px;
    }
    .btn:hover { background: var(--fap-accent-soft); border-color: var(--orange); }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn.danger { border-color: var(--fap-danger); color: var(--fap-danger); }
    .btn.danger:hover { background: rgba(241,76,76,.15); }
    .btn.danger.confirm { background: var(--fap-danger); color: var(--fap-bg); }
    /* ── controls: back button sits right of the D-pad, bottoms aligned ── */
    #controls { display: flex; flex-direction: row; align-items: flex-end; gap: ${compact ? '10px' : '16px'}; }
    #dpad {
        position: relative;
        width: ${compact ? '128px' : '168px'}; height: ${compact ? '128px' : '168px'};
        border: 3px solid var(--orange-dim); border-radius: 50%;
        display: grid;
        grid-template: repeat(3, 1fr) / repeat(3, 1fr);
        place-items: center;
    }
    .pad {
        background: none; border: none; cursor: pointer;
        color: var(--orange); font-size: ${compact ? '19px' : '26px'}; line-height: 1;
        padding: ${compact ? '5px' : '8px'}; border-radius: 8px;
    }
    .pad:hover { background: rgba(255,140,26,.12); }
    .pad:active, .pad.active { background: rgba(255,140,26,.3); color: var(--fap-text); }
    #btnOk {
        width: ${compact ? '42px' : '54px'}; height: ${compact ? '42px' : '54px'}; border-radius: 50%;
        border: 3px solid var(--orange); background: rgba(255,140,26,.15);
        font-size: ${compact ? '10px' : '11px'}; letter-spacing: 1px; color: var(--orange); cursor: pointer;
    }
    #btnOk:hover { background: rgba(255,140,26,.3); }
    #btnOk:active, #btnOk.active { background: var(--orange); color: var(--fap-bg); }
    #btnBack {
        width: ${compact ? '36px' : '44px'}; height: ${compact ? '36px' : '44px'}; border-radius: 50%;
        border: 3px solid var(--orange-dim); background: none;
        color: var(--orange); font-size: ${compact ? '16px' : '20px'}; cursor: pointer;
    }
    #btnBack:hover { background: rgba(255,140,26,.12); }
    #btnBack:active, #btnBack.active { background: rgba(255,140,26,.3); }
    #hint {
        font-size: ${compact ? '9px' : '10.5px'}; letter-spacing: .5px; color: var(--orange-dim);
        text-align: center; line-height: 1.6;
    }
    /* ── combined log (device serial + RPC events) ── */
    #logsWrap { width: 100%; max-width: 980px; }
    #logsHeader {
        display: flex; align-items: center; gap: 8px;
        border: 2px solid var(--orange-dim); border-radius: 6px;
        padding: 3px 8px; font-size: ${compact ? '10px' : '12px'}; letter-spacing: 1px;
    }
    #logsToggle { cursor: pointer; display: flex; align-items: center; gap: 6px; }
    #logsToggle:hover { color: var(--fap-text); }
    #statusLine { flex: 1; opacity: .9; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
    .logbtn {
        background: none; cursor: pointer;
        border: 1px solid var(--orange-dim); border-radius: 4px;
        color: var(--orange); padding: 2px 7px;
        font-family: inherit; font-size: ${compact ? '9px' : '10px'}; letter-spacing: 1px;
    }
    .logbtn:hover { background: rgba(255,140,26,.15); }
    .logbtn:disabled { opacity: .35; cursor: default; }
    #logs {
        display: none; margin-top: 6px;
        height: ${compact ? '220px' : '260px'}; overflow-y: auto;
        background: #000; border: 1px solid var(--orange-dim); border-radius: 6px;
        padding: 6px 8px; font-size: ${compact ? '10px' : '11px'}; line-height: 1.5;
        white-space: pre-wrap; word-break: break-all;
        font-family: 'Consolas', monospace;
    }
    #logs.open { display: block; }
    .rpc { display: block; }
    .rpc b { color: var(--orange); font-weight: normal; }
    .rpc.info  { color: #bdb4a8; }
    .rpc.warn  { color: #d29922; }
    .rpc.error { color: #f14c4c; }
    .serial { color: #e8e6e3; }
    .a30{color:#666}.a31{color:#f14c4c}.a32{color:#3fb950}.a33{color:#d29922}
    .a34{color:#58a6ff}.a35{color:#bc8cff}.a36{color:#39c5cf}.a37{color:#c9d1d9}
    .a90{color:#8b949e}.a91{color:#ff7b72}.a92{color:#56d364}.a93{color:#e3b341}
    .a94{color:#79c0ff}.a95{color:#d2a8ff}.a96{color:#56d4dd}.a97{color:#f0f6fc}
    .b1{font-weight:bold}
</style>
</head>
<body tabindex="0">
    <div id="topbar">
        <span>FLIPPER&nbsp;SCREEN</span>
        <span><span id="statusDot"></span><span id="statusText">CONNECTING…</span></span>
    </div>

    <div id="main">
        <div id="screenCol">
            <div id="bezel"><canvas id="screen" width="128" height="64"></canvas></div>
            <div id="actions">
                <button class="btn" id="btnShot" title="Save a 4× PNG of the current screen">▣ ${compact ? 'SCREENSHOT' : 'SAVE SCREENSHOT'}</button>
                ${compact ? '<button class="btn" id="btnPop" title="Open the screen preview in a full-size editor tab">⧉ POP OUT</button>' : ''}
                <button class="btn danger" id="btnReset" title="Reboot the Flipper over RPC (same as the LEFT+BACK combo) — recovers a frozen app">⟳ RESET</button>
                <button class="btn" id="btnReconnect" style="display:none">↻ RECONNECT</button>
            </div>
        </div>
        <div id="controls">
            <div id="dpad">
                <span></span><button class="pad" data-key="up" title="Up (W / ↑)">▲</button><span></span>
                <button class="pad" data-key="left" title="Left (A / ←)">◀</button>
                <button id="btnOk" data-key="ok" title="OK (Space / Enter)">OK</button>
                <button class="pad" data-key="right" title="Right (D / →)">▶</button>
                <span></span><button class="pad" data-key="down" title="Down (S / ↓)">▼</button><span></span>
            </div>
            <button id="btnBack" data-key="back" title="Back (Backspace / Esc)">↩</button>
        </div>
    </div>

    <div id="hint">W/↑ · A/← · S/↓ · D/→ &nbsp;|&nbsp; SPACE/ENTER = OK &nbsp;|&nbsp; BKSP/ESC = BACK<br>CTRL+C = COPY SCREENSHOT &nbsp;|&nbsp; HOLD = LONG PRESS &nbsp;<i>(click the preview first)</i></div>

    <div id="logsWrap">
        <div id="logsHeader">
            <span id="logsToggle"><span id="logsArrow">▾</span> LOGS</span>
            <span id="statusLine">READY.</span>
            <button class="logbtn" id="btnLogStart" title="Stream the device debug log (pauses the screen while running)">▶ LOG</button>
            <button class="logbtn" id="btnLogStop" title="Stop the device log (screen resumes)" disabled>■</button>
            <button class="logbtn" id="btnLogClear" title="Clear the log window">CLEAR</button>
        </div>
        <div id="logs" class="open"></div>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    let lastFrame = null;

    // ── frame rendering (SSD1306-style pages: bit b of byte i → x=i%128, y=(i>>7)*8+b) ──
    function drawFrame(bytes, orientation) {
        const img = ctx.createImageData(128, 64);
        for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 128; x++) {
                const bit = (bytes[(y >> 3) * 128 + x] >> (y & 7)) & 1;
                let dx = x, dy = y;
                if (orientation === 1) { dx = 127 - x; dy = 63 - y; } // 180° flip
                const o = (dy * 128 + dx) * 4;
                // #000000 on #FE8A2C — must match qFlipper's export palette exactly:
                // the App Catalog rejects screenshots that aren't verbatim qFlipper output
                if (bit) { img.data[o] = 0x00; img.data[o+1] = 0x00; img.data[o+2] = 0x00; }
                else     { img.data[o] = 0xfe; img.data[o+1] = 0x8a; img.data[o+2] = 0x2c; }
                img.data[o+3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    ctx.fillStyle = '#fe8a2c'; ctx.fillRect(0, 0, 128, 64);

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }

    // ── input handling: click = press/short/release, hold = press/long/repeat…/release ──
    const held = {};
    function send(key, event) { vscode.postMessage({ type: 'input', key, event }); }

    function pressKey(key) {
        if (held[key]) return;
        const h = { isLong: false, longTimer: null, repeatTimer: null };
        held[key] = h;
        setPadActive(key, true);
        send(key, 'press');
        h.longTimer = setTimeout(() => {
            h.isLong = true;
            send(key, 'long');
            h.repeatTimer = setInterval(() => send(key, 'repeat'), 150);
        }, 350);
    }
    function releaseKey(key) {
        const h = held[key];
        if (!h) return;
        delete held[key];
        setPadActive(key, false);
        clearTimeout(h.longTimer);
        clearInterval(h.repeatTimer);
        if (!h.isLong) send(key, 'short');
        send(key, 'release');
    }
    function setPadActive(key, on) {
        document.querySelectorAll('[data-key="' + key + '"]').forEach(el =>
            el.classList.toggle('active', on));
    }

    document.querySelectorAll('[data-key]').forEach(el => {
        const key = el.dataset.key;
        el.addEventListener('mousedown', e => { e.preventDefault(); pressKey(key); });
        el.addEventListener('mouseup',   () => releaseKey(key));
        el.addEventListener('mouseleave',() => releaseKey(key));
    });

    const KEYMAP = {
        ArrowUp: 'up', KeyW: 'up',
        ArrowDown: 'down', KeyS: 'down',
        ArrowLeft: 'left', KeyA: 'left',
        ArrowRight: 'right', KeyD: 'right',
        Enter: 'ok', Space: 'ok', NumpadEnter: 'ok',
        Backspace: 'back', Escape: 'back', Delete: 'back',
    };
    window.addEventListener('keydown', e => {
        if (e.ctrlKey && e.code === 'KeyC') { e.preventDefault(); copyScreenshot(); return; }
        const key = KEYMAP[e.code];
        if (!key) return;
        e.preventDefault();
        if (!e.repeat) pressKey(key);
    });
    window.addEventListener('keyup', e => {
        const key = KEYMAP[e.code];
        if (!key) return;
        e.preventDefault();
        releaseKey(key);
    });
    window.addEventListener('blur', () => Object.keys(held).forEach(releaseKey));

    // ── screenshots ──
    function renderPng() {
        const big = document.createElement('canvas');
        big.width = 512; big.height = 256;
        const bctx = big.getContext('2d');
        bctx.imageSmoothingEnabled = false;
        bctx.drawImage(canvas, 0, 0, 512, 256);
        return big;
    }
    document.getElementById('btnShot').onclick = () =>
        vscode.postMessage({ type: 'screenshot', dataUrl: renderPng().toDataURL('image/png') });

    const btnPop = document.getElementById('btnPop');
    if (btnPop) btnPop.onclick = () => vscode.postMessage({ type: 'openTab' });

    function copyScreenshot() {
        renderPng().toBlob(async blob => {
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                appendRpc('info', 'Screenshot copied to clipboard', Date.now());
            } catch (err) {
                appendRpc('warn', 'Clipboard copy blocked — use SAVE SCREENSHOT instead', Date.now());
            }
        });
    }

    // ── RESET (two-click confirm) ──
    const btnReset = document.getElementById('btnReset');
    let resetArmed = null;
    btnReset.onclick = () => {
        if (resetArmed) {
            clearTimeout(resetArmed);
            resetArmed = null;
            btnReset.classList.remove('confirm');
            btnReset.textContent = '⟳ RESET';
            vscode.postMessage({ type: 'reboot' });
        } else {
            btnReset.classList.add('confirm');
            btnReset.textContent = '⟳ SURE?';
            resetArmed = setTimeout(() => {
                resetArmed = null;
                btnReset.classList.remove('confirm');
                btnReset.textContent = '⟳ RESET';
            }, 3000);
        }
    };

    // ── combined log: device serial output + [RPC] events ──
    const logs = document.getElementById('logs');
    const statusLine = document.getElementById('statusLine');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const btnReconnect = document.getElementById('btnReconnect');
    const btnLogStart = document.getElementById('btnLogStart');
    const btnLogStop = document.getElementById('btnLogStop');
    let autoScroll = true;
    let pendingSpanClass = null;
    let portBlocked = false;

    logs.addEventListener('scroll', () => {
        autoScroll = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 8;
    });

    const toggleLogs = () => {
        logs.classList.toggle('open');
        document.getElementById('logsArrow').textContent = logs.classList.contains('open') ? '▾' : '▸';
    };
    document.getElementById('logsToggle').onclick = toggleLogs;
    statusLine.onclick = toggleLogs;

    btnLogStart.onclick = () => vscode.postMessage({ type: 'startLog' });
    btnLogStop.onclick  = () => vscode.postMessage({ type: 'stopLog' });
    document.getElementById('btnLogClear').onclick = () => {
        logs.innerHTML = '';
        pendingSpanClass = null;
        vscode.postMessage({ type: 'clearLog' });
    };
    btnReconnect.onclick = () => { vscode.postMessage({ type: 'reconnect' }); };

    function esc(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // Minimal ANSI SGR → span renderer (Flipper logs are colorized)
    function ansiToHtml(text) {
        let html = '';
        let cls = pendingSpanClass;
        const parts = text.split(/\\x1b\\[([0-9;]*)m/g);
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 0) {
                if (!parts[i]) continue;
                html += cls ? '<span class="' + cls + '">' + esc(parts[i]) + '</span>' : esc(parts[i]);
            } else {
                const codes = parts[i].split(';').filter(Boolean).map(Number);
                if (codes.length === 0 || codes.includes(0)) { cls = null; }
                for (const c of codes) {
                    if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { cls = 'a' + c; }
                    else if (c === 1) { cls = (cls ? cls + ' ' : '') + 'b1'; }
                }
            }
        }
        pendingSpanClass = cls;
        return html;
    }

    function trimAndScroll() {
        while (logs.childNodes.length > 4000) logs.removeChild(logs.firstChild);
        if (autoScroll) logs.scrollTop = logs.scrollHeight;
    }

    function appendSerial(text) {
        const span = document.createElement('span');
        span.className = 'serial';
        span.innerHTML = ansiToHtml(text);
        logs.appendChild(span);
        trimAndScroll();
    }

    function appendRpc(level, text, ts) {
        const div = document.createElement('div');
        div.className = 'rpc ' + (level || 'info');
        const time = new Date(ts || Date.now()).toTimeString().slice(0, 8);
        div.innerHTML = '<b>[' + time + ']</b> ' + esc(text);
        logs.appendChild(div);
        trimAndScroll();
        statusLine.textContent = text.toUpperCase();
        if (level === 'error' && /not accessible/i.test(text)) {
            portBlocked = true;
            statusDot.className = 'err';
            statusText.textContent = 'COM BLOCKED';
            btnReconnect.style.display = '';
        }
    }

    function setState(s) {
        const streaming = s.mode === 'rpc' && s.wantStream && !s.suspended;
        btnLogStart.disabled = s.wantLog || s.suspended;
        btnLogStop.disabled = !s.wantLog;
        if (s.mode !== 'disconnected') portBlocked = false;
        if (s.suspended) {
            statusDot.className = 'warn';
            statusText.textContent = 'PAUSED — BUILD/LAUNCH';
            btnReconnect.style.display = 'none';
        } else if (s.mode === 'logging') {
            statusDot.className = 'on';
            statusText.textContent = 'LOG — ' + (s.portPath || '') + (s.wantStream ? ' · SCREEN PAUSED' : '');
            btnReconnect.style.display = 'none';
        } else if (streaming) {
            statusDot.className = 'on';
            statusText.textContent = 'LIVE — ' + (s.portPath || '');
            btnReconnect.style.display = 'none';
        } else if (s.mode === 'disconnected') {
            if (portBlocked) {
                statusDot.className = 'err';
                statusText.textContent = 'COM BLOCKED';
            } else {
                statusDot.className = '';
                statusText.textContent = 'DISCONNECTED';
            }
            btnReconnect.style.display = '';
        } else {
            statusDot.className = 'warn';
            statusText.textContent = s.mode.toUpperCase();
            btnReconnect.style.display = 'none';
        }
    }

    window.addEventListener('message', e => {
        const m = e.data;
        if (m.type === 'frame') {
            lastFrame = m;
            drawFrame(b64ToBytes(m.data), m.orientation);
        } else if (m.type === 'serial') {
            appendSerial(m.text);
        } else if (m.type === 'status') {
            appendRpc(m.level, m.text, m.ts);
        } else if (m.type === 'restoreLog') {
            logs.innerHTML = '';
            pendingSpanClass = null;
            for (const en of m.entries) {
                if (en.kind === 'serial') appendSerial(en.text);
                else appendRpc(en.level, en.text, en.ts);
            }
        } else if (m.type === 'state') {
            setState(m.state);
        }
    });

    vscode.postMessage({ type: 'ready' });
    document.body.focus();
</script>
</body>
</html>`;
}
