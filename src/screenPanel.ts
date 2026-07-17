import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { flipperSerial, InputKey, InputType } from './serial/flipperSerial';

const KEY_MAP: Record<string, InputKey> = {
    up: InputKey.UP, down: InputKey.DOWN, left: InputKey.LEFT,
    right: InputKey.RIGHT, ok: InputKey.OK, back: InputKey.BACK,
};
const TYPE_MAP: Record<string, InputType> = {
    press: InputType.PRESS, release: InputType.RELEASE,
    short: InputType.SHORT, long: InputType.LONG, repeat: InputType.REPEAT,
};

/**
 * Live screen preview panel — qFlipper-style remote display with
 * D-pad / keyboard control, screenshots, and an RPC log strip.
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
    private readonly subs: vscode.Disposable[] = [];

    private constructor(context: vscode.ExtensionContext) {
        this.panel = vscode.window.createWebviewPanel(
            'flipperScreen',
            'Flipper Screen',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'flipper-icon.svg'));
        this.panel.webview.html = html();

        this.subs.push(
            flipperSerial.onScreenFrame(f => this.post({
                type: 'frame', data: f.data.toString('base64'), orientation: f.orientation,
            })),
            flipperSerial.onStatus(s => this.post({ type: 'status', level: s.level, text: s.text })),
            flipperSerial.onDidChangeState(state => this.post({ type: 'state', state })),
        );

        this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.subs);

        this.panel.onDidDispose(() => {
            ScreenPanel.current = null;
            this.subs.forEach(d => d.dispose());
            void flipperSerial.setStreamActive(false);
        }, null, context.subscriptions);
    }

    private post(msg: unknown) {
        void this.panel.webview.postMessage(msg);
    }

    private async onMessage(msg: { type: string; [k: string]: unknown }) {
        switch (msg.type) {
            case 'ready':
                this.post({ type: 'state', state: flipperSerial.getState() });
                void this.connect();
                break;
            case 'reconnect':
                void this.connect();
                break;
            case 'input': {
                const key = KEY_MAP[msg.key as string];
                const type = TYPE_MAP[msg.event as string];
                if (key === undefined || type === undefined) { return; }
                flipperSerial.sendInput(key, type).catch(err =>
                    this.post({ type: 'status', level: 'error', text: `Input failed: ${(err as Error).message}` }));
                break;
            }
            case 'screenshot':
                await this.saveScreenshot(msg.dataUrl as string);
                break;
        }
    }

    private async connect() {
        try {
            await flipperSerial.setStreamActive(true);
        } catch (err) {
            this.post({ type: 'status', level: 'error', text: (err as Error).message });
        }
    }

    private async saveScreenshot(dataUrl: string) {
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
}

function html(): string {
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    :root {
        --orange: #ff8c1a;
        --orange-dim: #a35a12;
        --bg: #100d0a;
        --screen-bg: #ff8b27;
    }
    * { box-sizing: border-box; user-select: none; }
    body {
        margin: 0; padding: 14px;
        background:
            linear-gradient(rgba(255,140,26,.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,140,26,.05) 1px, transparent 1px),
            #100d0a;
        background-size: 22px 22px;
        color: var(--orange);
        font-family: 'Consolas', 'Courier New', monospace;
        display: flex; flex-direction: column; align-items: center; gap: 12px;
        min-height: 100vh;
    }
    #topbar {
        width: 100%; max-width: 760px;
        display: flex; align-items: center; justify-content: space-between;
        font-size: 12px; letter-spacing: 1px;
    }
    #statusDot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #666; margin-right: 6px; }
    #statusDot.on { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
    #statusDot.warn { background: #d29922; box-shadow: 0 0 6px #d29922; }
    #main {
        display: flex; gap: 26px; align-items: center; justify-content: center;
        flex-wrap: wrap;
    }
    #bezel {
        background: var(--screen-bg);
        border: 3px solid var(--orange-dim);
        border-radius: 14px;
        padding: 12px;
        box-shadow: 0 0 24px rgba(255,140,26,.18);
    }
    canvas {
        display: block;
        width: 512px; height: 256px;
        image-rendering: pixelated;
        outline: none;
    }
    @media (max-width: 820px) { canvas { width: 384px; height: 192px; } }
    /* ── controls ── */
    #controls { display: flex; flex-direction: column; align-items: center; gap: 16px; }
    #dpad {
        position: relative; width: 168px; height: 168px;
        border: 3px solid var(--orange-dim); border-radius: 50%;
        display: grid;
        grid-template: repeat(3, 1fr) / repeat(3, 1fr);
        place-items: center;
    }
    .pad {
        background: none; border: none; cursor: pointer;
        color: var(--orange); font-size: 26px; line-height: 1;
        padding: 8px; border-radius: 8px;
    }
    .pad:hover { background: rgba(255,140,26,.12); }
    .pad:active, .pad.active { background: rgba(255,140,26,.3); color: #ffd9ad; }
    #btnOk {
        width: 54px; height: 54px; border-radius: 50%;
        border: 3px solid var(--orange); background: rgba(255,140,26,.15);
        font-size: 11px; letter-spacing: 1px; color: var(--orange); cursor: pointer;
    }
    #btnOk:hover { background: rgba(255,140,26,.3); }
    #btnOk:active, #btnOk.active { background: var(--orange); color: #100d0a; }
    #btnBack {
        align-self: flex-end;
        width: 44px; height: 44px; border-radius: 50%;
        border: 3px solid var(--orange-dim); background: none;
        color: var(--orange); font-size: 20px; cursor: pointer;
    }
    #btnBack:hover { background: rgba(255,140,26,.12); }
    #btnBack:active, #btnBack.active { background: rgba(255,140,26,.3); }
    /* ── bottom bar ── */
    #actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center; }
    .btn {
        background: none; cursor: pointer;
        border: 2px solid var(--orange); border-radius: 6px;
        color: var(--orange); padding: 7px 16px;
        font-family: inherit; font-size: 12px; letter-spacing: 1px;
    }
    .btn:hover { background: rgba(255,140,26,.15); }
    .btn:disabled { opacity: .4; cursor: default; }
    #hint {
        font-size: 10.5px; letter-spacing: .5px; color: var(--orange-dim);
        text-align: center;
    }
    /* ── logs strip ── */
    #logsWrap { width: 100%; max-width: 760px; }
    #logsHeader {
        display: flex; align-items: center; gap: 10px;
        border: 2px solid var(--orange-dim); border-radius: 6px;
        padding: 5px 10px; cursor: pointer; font-size: 12px; letter-spacing: 1px;
    }
    #logsHeader:hover { background: rgba(255,140,26,.08); }
    #statusLine { flex: 1; opacity: .9; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    #logs {
        display: none; margin-top: 6px; max-height: 140px; overflow-y: auto;
        background: #000; border: 1px solid var(--orange-dim); border-radius: 6px;
        padding: 6px 8px; font-size: 11px; line-height: 1.5;
    }
    #logs.open { display: block; }
    .li  { color: #e8e6e3; } .li b { color: var(--orange); font-weight: normal; }
    .lw  { color: #d29922; } .le { color: #f14c4c; }
</style>
</head>
<body tabindex="0">
    <div id="topbar">
        <span>FLIPPER&nbsp;SCREEN</span>
        <span><span id="statusDot"></span><span id="statusText">CONNECTING…</span></span>
    </div>

    <div id="main">
        <div id="bezel"><canvas id="screen" width="128" height="64"></canvas></div>
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

    <div id="actions">
        <button class="btn" id="btnShot">▣ SAVE SCREENSHOT</button>
        <button class="btn" id="btnReconnect" style="display:none">↻ RECONNECT</button>
    </div>
    <div id="hint">W/↑ · A/← · S/↓ · D/→ &nbsp;|&nbsp; SPACE / ENTER = OK &nbsp;|&nbsp; BACKSPACE / ESC = BACK &nbsp;|&nbsp; CTRL+C = COPY SCREENSHOT &nbsp;|&nbsp; HOLD = LONG PRESS</div>

    <div id="logsWrap">
        <div id="logsHeader"><span id="logsArrow">▸</span> LOGS <span id="statusLine">READY.</span></div>
        <div id="logs"></div>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    const BG = '#ff8b27', FG = '#1e1005';
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
                if (bit) { img.data[o] = 0x1e; img.data[o+1] = 0x10; img.data[o+2] = 0x05; }
                else     { img.data[o] = 0xff; img.data[o+1] = 0x8b; img.data[o+2] = 0x27; }
                img.data[o+3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    // initial blank screen
    ctx.fillStyle = BG; ctx.fillRect(0, 0, 128, 64);

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }

    // ── input handling: click = press/short/release, hold = press/long/repeat…/release ──
    const held = {}; // key → { longTimer, repeatTimer, isLong }
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

    function copyScreenshot() {
        renderPng().toBlob(async blob => {
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                logLine('info', 'Screenshot copied to clipboard');
            } catch (err) {
                logLine('warn', 'Clipboard copy blocked — use SAVE SCREENSHOT instead');
            }
        });
    }

    // ── status / logs strip ──
    const logs = document.getElementById('logs');
    const statusLine = document.getElementById('statusLine');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const btnReconnect = document.getElementById('btnReconnect');

    document.getElementById('logsHeader').onclick = () => {
        logs.classList.toggle('open');
        document.getElementById('logsArrow').textContent = logs.classList.contains('open') ? '▾' : '▸';
    };
    btnReconnect.onclick = () => { vscode.postMessage({ type: 'reconnect' }); };

    function logLine(level, text) {
        const div = document.createElement('div');
        div.className = level === 'error' ? 'le' : level === 'warn' ? 'lw' : 'li';
        div.innerHTML = '<b>[' + new Date().toTimeString().slice(0, 8) + ']</b> ' +
            text.replace(/&/g,'&amp;').replace(/</g,'&lt;');
        logs.appendChild(div);
        while (logs.childNodes.length > 300) logs.removeChild(logs.firstChild);
        logs.scrollTop = logs.scrollHeight;
        statusLine.textContent = text.toUpperCase();
    }

    window.addEventListener('message', e => {
        const m = e.data;
        if (m.type === 'frame') {
            lastFrame = m;
            drawFrame(b64ToBytes(m.data), m.orientation);
        } else if (m.type === 'status') {
            logLine(m.level, m.text);
        } else if (m.type === 'state') {
            const s = m.state;
            const streaming = s.mode === 'rpc' && s.wantStream && !s.suspended;
            if (s.suspended) {
                statusDot.className = 'warn';
                statusText.textContent = 'PAUSED — BUILD/LAUNCH';
                btnReconnect.style.display = 'none';
            } else if (streaming) {
                statusDot.className = 'on';
                statusText.textContent = 'LIVE — ' + (s.portPath || '');
                btnReconnect.style.display = 'none';
            } else if (s.mode === 'disconnected') {
                statusDot.className = '';
                statusText.textContent = 'DISCONNECTED';
                btnReconnect.style.display = '';
            } else {
                statusDot.className = 'warn';
                statusText.textContent = s.mode.toUpperCase();
                btnReconnect.style.display = 'none';
            }
        }
    });

    vscode.postMessage({ type: 'ready' });
    document.body.focus();
</script>
</body>
</html>`;
}
