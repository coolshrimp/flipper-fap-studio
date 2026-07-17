import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import {
    encode, tryDecodeFrame, decodeScreenFrame, decodeListResponse, decodeReadResponse,
    MainContent, MainMessage, StorageFile, InputKey, InputType,
    COMMAND_STATUS_NAMES,
} from './protobuf';

export { InputKey, InputType, StorageFile };
export { FileType } from './protobuf';

const FLIPPER_VID = '0483';
const FLIPPER_PID = '5740';
const CLI_PROMPT = '>: ';
const WRITE_CHUNK = 512;

export type SerialMode = 'disconnected' | 'cli' | 'logging' | 'rpc';

export interface SerialState {
    mode: SerialMode;
    portPath: string | null;
    /** user asked for device log streaming */
    wantLog: boolean;
    /** screen preview panel is open */
    wantStream: boolean;
    /** port handed over to an external process (build / launch) */
    suspended: boolean;
}

export interface StatusLine {
    level: 'info' | 'warn' | 'error';
    text: string;
}

export interface PortInfo {
    path: string;
    description: string;
    isFlipper: boolean;
}

interface PendingRequest {
    messages: MainMessage[];
    resolve: (msgs: MainMessage[]) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    timeoutMs: number;
}

export class FlipperSerial {
    // ── desired-state flags ───────────────────────────────────────────────────
    private wantLog = false;
    private wantStream = false;
    private rpcHold = 0;
    private suspendCount = 0;
    private userConnected = false;

    // ── live state ────────────────────────────────────────────────────────────
    private port: SerialPort | null = null;
    private mode: SerialMode = 'disconnected';
    private streaming = false;
    private portPath: string | null = null;

    // ── wire buffers ──────────────────────────────────────────────────────────
    private textBuf = '';
    private rpcBuf = Buffer.alloc(0);
    private textWaiters: Array<{ needle: string; resolve: () => void; timer: NodeJS.Timeout }> = [];

    // ── rpc dispatch ──────────────────────────────────────────────────────────
    private nextCommandId = 1;
    private pending = new Map<number, PendingRequest>();

    // ── reconcile queue ───────────────────────────────────────────────────────
    private opChain: Promise<void> = Promise.resolve();
    private holdReleaseTimer: NodeJS.Timeout | null = null;

    // ── events ────────────────────────────────────────────────────────────────
    private _onDidChangeState = new vscode.EventEmitter<SerialState>();
    readonly onDidChangeState = this._onDidChangeState.event;

    private _onLogData = new vscode.EventEmitter<string>();
    /** raw CLI / device-log text as it arrives */
    readonly onLogData = this._onLogData.event;

    private _onScreenFrame = new vscode.EventEmitter<{ data: Buffer; orientation: number }>();
    readonly onScreenFrame = this._onScreenFrame.event;

    private _onStatus = new vscode.EventEmitter<StatusLine>();
    /** human-readable connection / RPC event log (previewer LOGS strip) */
    readonly onStatus = this._onStatus.event;

    // ══════════════════════════════════════════════════════════════════════════
    // Public API
    // ══════════════════════════════════════════════════════════════════════════

    getState(): SerialState {
        return {
            mode: this.mode,
            portPath: this.portPath,
            wantLog: this.wantLog,
            wantStream: this.wantStream,
            suspended: this.suspendCount > 0,
        };
    }

    async listPorts(): Promise<PortInfo[]> {
        const ports = await SerialPort.list();
        return ports.map(p => ({
            path: p.path,
            description: [p.manufacturer, p.serialNumber].filter(Boolean).join(' — ') || 'Unknown device',
            isFlipper:
                (p.vendorId ?? '').toLowerCase() === FLIPPER_VID &&
                (p.productId ?? '').toLowerCase() === FLIPPER_PID,
        }));
    }

    /** Explicitly connect (auto-detects the Flipper port unless one is given). */
    async connect(portPath?: string): Promise<void> {
        if (portPath) { this.portPath = portPath; }
        this.userConnected = true;
        await this.reconcile();
    }

    async disconnect(): Promise<void> {
        this.userConnected = false;
        this.wantLog = false;
        this.wantStream = false;
        await this.reconcile();
    }

    async startLog(): Promise<void> {
        this.wantLog = true;
        this.userConnected = true;
        await this.reconcile();
    }

    async stopLog(): Promise<void> {
        this.wantLog = false;
        await this.reconcile();
    }

    /** Screen preview panel opened / closed. */
    async setStreamActive(active: boolean): Promise<void> {
        this.wantStream = active;
        if (active) { this.userConnected = true; }
        await this.reconcile();
    }

    /**
     * Release the COM port for an external process (ufbt launch etc.).
     * Restores the previous mode when the returned disposable is disposed.
     */
    async suspendForExternal(reason: string): Promise<{ resume: () => Promise<void> }> {
        this.suspendCount++;
        if (this.suspendCount === 1 && this.mode !== 'disconnected') {
            this.status('info', `Serial paused — ${reason}`);
        }
        await this.reconcile();
        // give Windows a moment to fully release the COM handle
        await delay(300);
        let resumed = false;
        return {
            resume: async () => {
                if (resumed) { return; }
                resumed = true;
                this.suspendCount = Math.max(0, this.suspendCount - 1);
                if (this.suspendCount === 0) {
                    // the external tool may also need a beat to let go of the port
                    await delay(500);
                    this.status('info', 'Resuming serial…');
                    await this.reconcile();
                }
            },
        };
    }

    // ── Storage / input API (each call temporarily enters RPC mode) ───────────

    async listDir(path: string): Promise<StorageFile[]> {
        return this.withRpc(async () => {
            const msgs = await this.rpcRequest(id => [encode.storageList(id, path)]);
            const files: StorageFile[] = [];
            for (const m of msgs) {
                if (m.contentFieldNo === MainContent.STORAGE_LIST_RESPONSE) {
                    files.push(...decodeListResponse(m.contentData));
                }
            }
            return files.sort((a, b) =>
                a.type !== b.type ? b.type - a.type : a.name.localeCompare(b.name));
        });
    }

    async readFile(path: string): Promise<Buffer> {
        return this.withRpc(async () => {
            const msgs = await this.rpcRequest(id => [encode.storageRead(id, path)], 30000);
            const chunks: Buffer[] = [];
            for (const m of msgs) {
                if (m.contentFieldNo === MainContent.STORAGE_READ_RESPONSE) {
                    const f = decodeReadResponse(m.contentData);
                    if (f) { chunks.push(f.data); }
                }
            }
            return Buffer.concat(chunks);
        });
    }

    async writeFile(path: string, data: Buffer): Promise<void> {
        await this.withRpc(async () => {
            await this.rpcRequest(id => {
                const frames: Buffer[] = [];
                if (data.length === 0) {
                    frames.push(encode.storageWrite(id, path, Buffer.alloc(0), false));
                } else {
                    for (let off = 0; off < data.length; off += WRITE_CHUNK) {
                        const chunk = data.subarray(off, off + WRITE_CHUNK);
                        frames.push(encode.storageWrite(id, path, chunk, off + WRITE_CHUNK < data.length));
                    }
                }
                return frames;
            }, 30000);
        });
    }

    async deletePath(path: string, recursive: boolean): Promise<void> {
        await this.withRpc(() => this.rpcRequest(id => [encode.storageDelete(id, path, recursive)]));
    }

    async mkdir(path: string): Promise<void> {
        await this.withRpc(() => this.rpcRequest(id => [encode.storageMkdir(id, path)]));
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        await this.withRpc(() => this.rpcRequest(id => [encode.storageRename(id, oldPath, newPath)]));
    }

    /** Send a button event to the device (screen preview control). */
    async sendInput(key: InputKey, type: InputType): Promise<void> {
        await this.withRpc(() => this.rpcRequest(id => [encode.guiSendInputEvent(id, key, type)]));
    }

    dispose() {
        this.forceClose();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Reconciler — serialized transitions toward the desired mode
    // ══════════════════════════════════════════════════════════════════════════

    private desiredMode(): SerialMode {
        if (this.suspendCount > 0) { return 'disconnected'; }
        if (!this.userConnected && !this.wantLog && !this.wantStream && this.rpcHold === 0) {
            return 'disconnected';
        }
        if (this.wantStream || this.rpcHold > 0 || this.holdReleaseTimer !== null) { return 'rpc'; }
        if (this.wantLog) { return 'logging'; }
        return 'cli';
    }

    private reconcile(): Promise<void> {
        const run = this.opChain.then(() => this.reconcileLoop()).catch(err => {
            this.status('error', `Serial error: ${(err as Error).message}`);
            this.forceClose();
        });
        this.opChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async reconcileLoop(): Promise<void> {
        for (let i = 0; i < 8; i++) {
            const desired = this.desiredMode();
            if (desired === this.mode && (this.mode !== 'rpc' || this.streaming === this.wantStream)) {
                this.fireState();
                return;
            }
            await this.stepToward(desired);
        }
        this.fireState();
    }

    private async stepToward(desired: SerialMode): Promise<void> {
        // one transition per call; the loop re-evaluates after each step
        if (desired === 'disconnected') {
            await this.teardown();
            return;
        }
        switch (this.mode) {
            case 'disconnected':
                await this.openPort();
                break;
            case 'cli':
                if (desired === 'logging') { await this.enterLog(); }
                else if (desired === 'rpc') { await this.enterRpc(); }
                break;
            case 'logging':
                await this.exitLog();
                break;
            case 'rpc':
                if (desired === 'rpc') {
                    // only the streaming sub-state differs
                    if (this.wantStream && !this.streaming) { await this.startStream(); }
                    else if (!this.wantStream && this.streaming) { await this.stopStream(); }
                } else {
                    await this.exitRpc();
                }
                break;
        }
    }

    // ── transitions ───────────────────────────────────────────────────────────

    private async resolvePortPath(): Promise<string> {
        const configured = vscode.workspace.getConfiguration('flipperFapStudio').get<string>('serialPort');
        if (configured) { return configured; }
        if (this.portPath) {
            const still = (await this.listPorts()).some(p => p.path === this.portPath);
            if (still) { return this.portPath; }
            this.portPath = null;
        }
        const flippers = (await this.listPorts()).filter(p => p.isFlipper);
        if (flippers.length === 0) {
            throw new Error('No Flipper Zero found on any COM port. Is it connected via USB (and not held by qFlipper / lab.flipper.net)?');
        }
        return flippers[0].path;
    }

    private async openPort(): Promise<void> {
        const path = await this.resolvePortPath();
        this.status('info', `Opening ${path}…`);
        const port = new SerialPort({ path, baudRate: 230400, autoOpen: false });
        await new Promise<void>((resolve, reject) => {
            port.open(err => err
                ? reject(new Error(`Could not open ${path}: ${err.message} (close qFlipper or other serial monitors)`))
                : resolve());
        });
        this.port = port;
        this.portPath = path;
        this.textBuf = '';
        this.rpcBuf = Buffer.alloc(0);

        port.on('data', (d: Buffer) => this.onData(d));
        port.on('close', () => this.onPortClosed());
        port.on('error', (err: Error) => this.status('error', `Port error: ${err.message}`));

        await new Promise<void>((resolve, reject) => {
            port.set({ dtr: true, rts: true }, err => err ? reject(err) : resolve());
        });

        this.mode = 'cli';
        // nudge the CLI and wait for a prompt so we start from a known state
        await delay(100);
        this.write(Buffer.from('\r'));
        try {
            await this.waitForText(CLI_PROMPT, 3000);
        } catch {
            // Some firmwares need a Ctrl+C first (e.g. if a previous log session leaked)
            this.write(Buffer.from('\x03'));
            await this.waitForText(CLI_PROMPT, 3000);
        }
        this.status('info', `Connected to Flipper on ${path}`);
        this.fireState();
    }

    private async teardown(): Promise<void> {
        if (!this.port) { this.mode = 'disconnected'; return; }
        try {
            if (this.mode === 'rpc') {
                if (this.streaming) { await this.stopStream().catch(() => undefined); }
                // politely end the RPC session so the firmware returns to CLI
                this.write(encode.stopSession(this.allocId()));
                await delay(150);
            } else if (this.mode === 'logging') {
                this.write(Buffer.from('\x03'));
                await delay(100);
            }
        } catch { /* closing anyway */ }
        this.forceClose();
        this.status('info', 'Serial port closed');
    }

    private async enterLog(): Promise<void> {
        this.write(Buffer.from('log\r'));
        this.mode = 'logging';
        this.status('info', 'Device log started (Ctrl+C on device CLI stops it)');
        this.fireState();
    }

    private async exitLog(): Promise<void> {
        this.write(Buffer.from('\x03'));
        try { await this.waitForText(CLI_PROMPT, 2000); } catch { /* tolerate */ }
        this.mode = 'cli';
        this.status('info', 'Device log stopped');
        this.fireState();
    }

    private async enterRpc(): Promise<void> {
        this.textBuf = '';
        this.rpcBuf = Buffer.alloc(0);
        this.status('info', 'Starting RPC session…');
        this.write(Buffer.from('start_rpc_session\r'));
        await this.waitForText('start_rpc_session', 3000);
        // everything after the echoed command's newline is protobuf
        this.mode = 'rpc';
        this.textBuf = '';
        this.status('info', 'RPC session started');
        this.fireState();
    }

    private async exitRpc(): Promise<void> {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('RPC session closed'));
        }
        this.pending.clear();
        this.write(encode.stopSession(this.allocId()));
        await delay(200);
        this.mode = 'cli';
        this.rpcBuf = Buffer.alloc(0);
        this.write(Buffer.from('\r'));
        try { await this.waitForText(CLI_PROMPT, 2000); } catch { /* tolerate */ }
        this.status('info', 'RPC session ended');
        this.fireState();
    }

    private async startStream(): Promise<void> {
        await this.rpcRequest(id => [encode.guiStartScreenStream(id)]);
        this.streaming = true;
        this.status('info', 'Screen streaming started');
        this.fireState();
    }

    private async stopStream(): Promise<void> {
        this.streaming = false;
        try {
            await this.rpcRequest(id => [encode.guiStopScreenStream(id)], 2000);
        } catch { /* device may already be gone */ }
        this.status('info', 'Screen streaming stopped');
        this.fireState();
    }

    private forceClose() {
        const port = this.port;
        this.port = null;
        this.mode = 'disconnected';
        this.streaming = false;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('Serial port closed'));
        }
        this.pending.clear();
        for (const w of this.textWaiters.splice(0)) { clearTimeout(w.timer); }
        if (port) {
            port.removeAllListeners();
            try { if (port.isOpen) { port.close(() => undefined); } } catch { /* ignore */ }
        }
        this.fireState();
    }

    private onPortClosed() {
        if (!this.port) { return; } // intentional close
        this.status('warn', 'Serial port closed unexpectedly (device unplugged?)');
        // stop trying to auto-restore — the user can reconnect explicitly
        this.userConnected = false;
        this.wantLog = false;
        this.forceClose();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Wire handling
    // ══════════════════════════════════════════════════════════════════════════

    private write(data: Buffer) {
        if (!this.port || !this.port.isOpen) { throw new Error('Serial port is not open'); }
        this.port.write(data);
    }

    private onData(data: Buffer) {
        if (this.mode === 'rpc') {
            this.rpcBuf = Buffer.concat([this.rpcBuf, data]);
            this.drainRpcFrames();
            return;
        }
        const text = data.toString('utf8');
        this.textBuf = (this.textBuf + text).slice(-8192);
        this._onLogData.fire(text);
        for (const w of this.textWaiters.splice(0)) {
            if (this.textBuf.includes(w.needle)) {
                clearTimeout(w.timer);
                w.resolve();
            } else {
                this.textWaiters.push(w);
            }
        }
    }

    private waitForText(needle: string, timeoutMs: number): Promise<void> {
        if (this.textBuf.includes(needle)) { return Promise.resolve(); }
        return new Promise<void>((resolve, reject) => {
            const waiter = {
                needle,
                resolve,
                timer: setTimeout(() => {
                    this.textWaiters = this.textWaiters.filter(w => w !== waiter);
                    reject(new Error(`Timed out waiting for "${needle.trim() || needle}" from device`));
                }, timeoutMs),
            };
            this.textWaiters.push(waiter);
        });
    }

    private drainRpcFrames() {
        while (true) {
            let frame: ReturnType<typeof tryDecodeFrame>;
            try {
                frame = tryDecodeFrame(this.rpcBuf);
            } catch (err) {
                this.status('error', `Protocol desync: ${(err as Error).message}`);
                this.rpcBuf = Buffer.alloc(0);
                return;
            }
            if (!frame) { return; }
            this.rpcBuf = this.rpcBuf.subarray(frame.bytesConsumed);
            this.routeMessage(frame.msg);
        }
    }

    private routeMessage(msg: MainMessage) {
        if (msg.contentFieldNo === MainContent.GUI_SCREEN_FRAME) {
            this._onScreenFrame.fire(decodeScreenFrame(msg.contentData));
            return;
        }
        const pending = this.pending.get(msg.commandId);
        if (!pending) { return; }
        if (msg.commandStatus !== 0) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.commandId);
            const name = COMMAND_STATUS_NAMES[msg.commandStatus] ?? `status ${msg.commandStatus}`;
            pending.reject(new Error(name));
            return;
        }
        pending.messages.push(msg);
        if (msg.hasNext) {
            // streaming response — refresh the inactivity timeout
            clearTimeout(pending.timer);
            pending.timer = this.makePendingTimer(msg.commandId, pending.timeoutMs);
        } else {
            clearTimeout(pending.timer);
            this.pending.delete(msg.commandId);
            pending.resolve(pending.messages);
        }
    }

    private makePendingTimer(id: number, timeoutMs: number): NodeJS.Timeout {
        return setTimeout(() => {
            const p = this.pending.get(id);
            if (p) {
                this.pending.delete(id);
                p.reject(new Error('RPC request timed out'));
            }
        }, timeoutMs);
    }

    private allocId(): number {
        const id = this.nextCommandId;
        this.nextCommandId = this.nextCommandId >= 0x7fffffff ? 1 : this.nextCommandId + 1;
        return id;
    }

    /** Send one request (possibly multi-frame) and await its full response. */
    private rpcRequest(build: (id: number) => Buffer[], timeoutMs = 6000): Promise<MainMessage[]> {
        if (this.mode !== 'rpc') { return Promise.reject(new Error('Not in RPC mode')); }
        const id = this.allocId();
        const frames = build(id);
        return new Promise<MainMessage[]>((resolve, reject) => {
            this.pending.set(id, {
                messages: [], resolve, reject, timeoutMs,
                timer: this.makePendingTimer(id, timeoutMs),
            });
            try {
                for (const f of frames) { this.write(f); }
            } catch (err) {
                const p = this.pending.get(id);
                if (p) { clearTimeout(p.timer); this.pending.delete(id); }
                reject(err as Error);
            }
        });
    }

    /**
     * Run fn with the port in RPC mode, then (after a short grace period)
     * fall back to whatever mode is otherwise desired — e.g. resume the
     * device log after a burst of file-browser operations.
     */
    private async withRpc<T>(fn: () => Promise<T>): Promise<T> {
        this.userConnected = true;
        this.rpcHold++;
        if (this.holdReleaseTimer) { clearTimeout(this.holdReleaseTimer); this.holdReleaseTimer = null; }
        try {
            await this.reconcile();
            if (this.mode !== 'rpc') {
                throw new Error(this.suspendCount > 0
                    ? 'Serial is paused while a build/launch is using the port'
                    : 'Could not enter RPC mode');
            }
            return await fn();
        } finally {
            this.rpcHold = Math.max(0, this.rpcHold - 1);
            if (this.rpcHold === 0) {
                // linger in RPC mode briefly so bursts of operations don't
                // bounce the port between RPC and log mode
                this.holdReleaseTimer = setTimeout(() => {
                    this.holdReleaseTimer = null;
                    void this.reconcile();
                }, 700);
            }
        }
    }

    private status(level: StatusLine['level'], text: string) {
        this._onStatus.fire({ level, text });
    }

    private fireState() {
        this._onDidChangeState.fire(this.getState());
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/** Singleton shared by all views and commands. */
export const flipperSerial = new FlipperSerial();
