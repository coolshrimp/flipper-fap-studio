import * as vscode from 'vscode';
import { flipperSerial, SerialState } from './serial/flipperSerial';

const MAX_BUFFER = 400_000; // chars retained for view restore

/**
 * "Serial Log" side-panel view — live device log over the Flipper CLI
 * (`log` command), with start/stop/clear controls.
 */
export class SerialLogViewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'flipperSerialLog';

    private view: vscode.WebviewView | null = null;
    private buffer = '';

    constructor(private readonly context: vscode.ExtensionContext) {
        context.subscriptions.push(
            flipperSerial.onLogData(text => {
                this.buffer = (this.buffer + text).slice(-MAX_BUFFER);
                this.post({ type: 'log', text });
            }),
            flipperSerial.onDidChangeState(state => this.post({ type: 'state', state })),
            flipperSerial.onStatus(s => this.post({ type: 'status', level: s.level, text: s.text })),
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html();

        view.webview.onDidReceiveMessage(async msg => {
            try {
                switch (msg.type) {
                    case 'ready':
                        this.post({ type: 'restore', text: this.buffer });
                        this.post({ type: 'state', state: flipperSerial.getState() });
                        break;
                    case 'start': await flipperSerial.startLog(); break;
                    case 'stop':  await flipperSerial.stopLog(); break;
                    case 'clear': this.buffer = ''; break;
                    case 'disconnect': await flipperSerial.disconnect(); break;
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Flipper serial: ${(err as Error).message}`);
                this.post({ type: 'state', state: flipperSerial.getState() });
            }
        });

        view.onDidDispose(() => { this.view = null; });
    }

    private post(msg: unknown) {
        this.view?.webview.postMessage(msg);
    }

    private html(): string {
        return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    :root { color-scheme: dark light; }
    body {
        padding: 0; margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    }
    #toolbar {
        display: flex; gap: 4px; align-items: center;
        padding: 4px 6px; flex: 0 0 auto;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    }
    button {
        border: none; cursor: pointer; border-radius: 3px;
        padding: 3px 10px; font-size: 11px; font-family: inherit;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover { opacity: .85; }
    button:disabled { opacity: .4; cursor: default; }
    #dot { width: 8px; height: 8px; border-radius: 50%; background: #808080; flex: 0 0 auto; }
    #dot.on  { background: #3fb950; box-shadow: 0 0 4px #3fb950; }
    #dot.paused { background: #d29922; box-shadow: 0 0 4px #d29922; }
    #statusText { font-size: 11px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    #banner {
        display: none; padding: 3px 8px; font-size: 11px; flex: 0 0 auto;
        background: var(--vscode-inputValidation-warningBackground, #5c4a00);
        border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    }
    #log {
        flex: 1; overflow-y: auto; padding: 4px 6px; margin: 0;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px; line-height: 1.45;
        white-space: pre-wrap; word-break: break-all;
    }
    .a30{color:#666}.a31{color:#f14c4c}.a32{color:#3fb950}.a33{color:#d29922}
    .a34{color:#58a6ff}.a35{color:#bc8cff}.a36{color:#39c5cf}.a37{color:#c9d1d9}
    .a90{color:#8b949e}.a91{color:#ff7b72}.a92{color:#56d364}.a93{color:#e3b341}
    .a94{color:#79c0ff}.a95{color:#d2a8ff}.a96{color:#56d4dd}.a97{color:#f0f6fc}
    .b1{font-weight:bold}
    .rpc { display: block; }
    .rpc b { color: #ff8c1a; font-weight: normal; }
    .rpc.info  { color: #bdb4a8; }
    .rpc.warn  { color: #d29922; }
    .rpc.error { color: #f14c4c; }
    #empty { opacity: .55; padding: 12px 10px; font-size: 12px; }
</style>
</head>
<body>
    <div id="toolbar">
        <div id="dot"></div>
        <span id="statusText">Disconnected</span>
        <button id="btnStart" class="primary" title="Connect and stream device logs">▶ Start</button>
        <button id="btnStop" title="Stop log streaming" disabled>■ Stop</button>
        <button id="btnClear" title="Clear the log window">Clear</button>
    </div>
    <div id="banner"></div>
    <div id="log"><div id="empty">Click <b>▶ Start</b> to connect to your Flipper and stream device logs.<br><br>Logs pause automatically while a build pushes a .fap to the device, and resume afterwards.</div></div>
<script>
    const vscode = acquireVsCodeApi();
    const log = document.getElementById('log');
    const empty = document.getElementById('empty');
    const dot = document.getElementById('dot');
    const statusText = document.getElementById('statusText');
    const banner = document.getElementById('banner');
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    let autoScroll = true;
    let pendingSpanClass = null; // ANSI state carries across chunks

    log.addEventListener('scroll', () => {
        autoScroll = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    });

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

    function append(text) {
        if (empty.parentNode) empty.remove();
        const span = document.createElement('span');
        span.innerHTML = ansiToHtml(text);
        log.appendChild(span);
        // trim DOM if huge
        while (log.childNodes.length > 4000) log.removeChild(log.firstChild);
        if (autoScroll) log.scrollTop = log.scrollHeight;
    }

    // qFlipper-style connection/RPC event lines, interleaved with the device log
    function appendRpc(level, text) {
        if (empty.parentNode) empty.remove();
        const div = document.createElement('div');
        div.className = 'rpc ' + level;
        div.innerHTML = '<b>[RPC]</b> ' + esc(text);
        log.appendChild(div);
        while (log.childNodes.length > 4000) log.removeChild(log.firstChild);
        if (autoScroll) log.scrollTop = log.scrollHeight;
    }

    function setState(s) {
        const logging = s.mode === 'logging';
        const connected = s.mode !== 'disconnected';
        btnStart.disabled = logging || s.suspended;
        btnStop.disabled = !s.wantLog && !logging;
        dot.className = logging ? 'on' : (s.suspended || (s.wantLog && s.mode === 'rpc')) ? 'paused' : '';
        if (s.suspended) {
            statusText.textContent = 'Paused — build/launch is using the port';
            banner.style.display = 'block';
            banner.textContent = '⏸ Serial paused while the .fap is pushed to the Flipper — resumes automatically.';
        } else if (logging) {
            statusText.textContent = 'Streaming device log — ' + (s.portPath || '');
            banner.style.display = 'none';
        } else if (s.wantLog && s.mode === 'rpc') {
            statusText.textContent = 'Log paused (RPC active) — ' + (s.portPath || '');
            banner.style.display = 'block';
            banner.textContent = '⏸ Log paused while screen preview / file browser uses the RPC session — resumes when idle.';
        } else if (connected) {
            statusText.textContent = 'Connected — ' + (s.portPath || '') + (s.mode === 'rpc' ? ' (RPC)' : '');
            banner.style.display = 'none';
        } else {
            statusText.textContent = 'Disconnected';
            banner.style.display = 'none';
        }
    }

    btnStart.onclick = () => vscode.postMessage({ type: 'start' });
    btnStop.onclick  = () => vscode.postMessage({ type: 'stop' });
    document.getElementById('btnClear').onclick = () => {
        log.innerHTML = '';
        pendingSpanClass = null;
        vscode.postMessage({ type: 'clear' });
    };

    window.addEventListener('message', e => {
        const m = e.data;
        if (m.type === 'log') append(m.text);
        else if (m.type === 'restore') { if (m.text) { log.innerHTML=''; append(m.text); } }
        else if (m.type === 'state') setState(m.state);
        else if (m.type === 'status') appendRpc(m.level, m.text);
    });

    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
