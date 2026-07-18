import * as vscode from 'vscode';
import {
    encode, tryDecodeFrame, decodeListResponse, decodeKeyValue, decodeStorageInfo,
    MainContent, MainMessage, StorageFile, COMMAND_STATUS_NAMES,
} from './protobuf';
import type { StatusLine } from './flipperSerial';

/**
 * BLE RPC transport — our own implementation built from the Flipper's public
 * GATT profile (targets/f7/ble_glue/services/serial_service_uuid.inc in the
 * official firmware):
 *
 *   serial service  8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000
 *   RX  (write)     19ed82ae-ed21-4c9d-4145-228e62fe0000   host → device
 *   TX  (indicate)  19ed82ae-ed21-4c9d-4145-228e61fe0000   device → host
 *   flow control    19ed82ae-ed21-4c9d-4145-228e63fe0000   uint32 BE available-buffer bytes
 *
 * The firmware opens its protobuf RPC session automatically when a BLE client
 * connects to the serial profile — no CLI handshake, raw PB.Main frames only.
 * Transport is the MIT-licensed `webbluetooth` package (SimpleBLE, N-API).
 */

const SERIAL_SERVICE = '8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000';
const CHAR_RX = '19ed82ae-ed21-4c9d-4145-228e62fe0000';
const CHAR_TX = '19ed82ae-ed21-4c9d-4145-228e61fe0000';
const CHAR_FLOW = '19ed82ae-ed21-4c9d-4145-228e63fe0000';

/** Firmware caps a serial packet at 486 bytes; stay under one ATT long-write. */
const WRITE_CHUNK = 240;

interface PendingRequest {
    messages: MainMessage[];
    resolve: (msgs: MainMessage[]) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    timeoutMs: number;
}

export class FlipperBle {
    private device: any | null = null;
    private rxChar: any | null = null;
    private buf = Buffer.alloc(0);
    private nextCommandId = 1;
    private pending = new Map<number, PendingRequest>();
    private flowAvailable = 0;
    private flowWaiters: Array<() => void> = [];
    private connecting = false;

    private _onStatus = new vscode.EventEmitter<StatusLine>();
    readonly onStatus = this._onStatus.event;
    private _onDidChangeState = new vscode.EventEmitter<void>();
    readonly onDidChangeState = this._onDidChangeState.event;

    deviceName: string | null = null;

    isConnected(): boolean {
        return this.device?.gatt?.connected === true;
    }

    /** Scan for a device advertising as "Flipper …" and open the RPC link. */
    async connect(): Promise<void> {
        if (this.isConnected() || this.connecting) { return; }
        this.connecting = true;
        try {
            let webbluetooth: any;
            try {
                webbluetooth = require('webbluetooth');
            } catch (err) {
                throw new Error(
                    `Bluetooth library failed to load on this platform (${(err as Error).message}). ` +
                    'USB device tools are unaffected.');
            }
            this.status('info', 'Scanning for a Flipper over Bluetooth…');
            const bt = new webbluetooth.Bluetooth({ scanTime: 8 });
            const device = await bt.requestDevice({
                filters: [{ namePrefix: 'Flipper' }],
                optionalServices: [SERIAL_SERVICE],
            }).catch((err: Error) => {
                throw new Error(
                    `No Flipper found over Bluetooth (${err.message}). ` +
                    'Make sure Bluetooth is ON on the Flipper (Settings → Bluetooth) and it is paired with this PC ' +
                    '(Windows Settings → Bluetooth → Add device — confirm the 6-digit code the Flipper shows).');
            });
            this.deviceName = device.name || 'Flipper';
            this.status('info', `Found ${this.deviceName} — connecting…`);

            device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
            const server = await device.gatt.connect();
            const svc = await server.getPrimaryService(SERIAL_SERVICE).catch(() => {
                throw new Error(
                    'Connected, but the serial service is not accessible. Pair the Flipper with this PC first ' +
                    '(it protects RPC behind an encrypted, bonded link), then try again.');
            });
            const tx = await svc.getCharacteristic(CHAR_TX);
            this.rxChar = await svc.getCharacteristic(CHAR_RX);

            // flow control is optional for the small reads the dashboard does,
            // but honour it when the device exposes it
            try {
                const flow = await svc.getCharacteristic(CHAR_FLOW);
                const v = await flow.readValue();
                this.flowAvailable = v.byteLength >= 4 ? v.getUint32(0, false) : 0;
                await flow.startNotifications();
                flow.addEventListener('characteristicvaluechanged', (ev: any) => {
                    const dv = ev.target.value as DataView;
                    if (dv.byteLength >= 4) {
                        this.flowAvailable = dv.getUint32(0, false);
                        for (const w of this.flowWaiters.splice(0)) { w(); }
                    }
                });
            } catch { this.flowAvailable = Number.MAX_SAFE_INTEGER; }

            await tx.startNotifications();
            tx.addEventListener('characteristicvaluechanged', (ev: any) => {
                const dv = ev.target.value as DataView;
                this.onData(Buffer.from(dv.buffer, dv.byteOffset, dv.byteLength));
            });

            this.device = device;
            this.buf = Buffer.alloc(0);

            // firmware opens the RPC session on connect — verify with a ping
            await this.rpcRequest(id => [encode.ping(id)], 5000).catch(err => {
                throw new Error(`BLE link up but RPC did not answer (${err.message}). ` +
                    'Close the Flipper mobile app if it is connected, then try again.');
            });
            this.status('info', `Bluetooth RPC connected — ${this.deviceName}`);
            this._onDidChangeState.fire();
        } catch (err) {
            this.cleanup();
            throw err;
        } finally {
            this.connecting = false;
        }
    }

    async disconnect(): Promise<void> {
        const name = this.deviceName;
        try { this.device?.gatt?.disconnect(); } catch { /* already gone */ }
        this.cleanup();
        this.status('info', `Bluetooth disconnected${name ? ` — ${name}` : ''}`);
    }

    // ── RPC API (same shapes as FlipperSerial) ────────────────────────────────

    async getDeviceInfo(): Promise<Record<string, string>> {
        const msgs = await this.rpcRequest(id => [encode.systemDeviceInfo(id)], 15000);
        return this.collectKeyValues(msgs, MainContent.SYSTEM_DEVICE_INFO_RESPONSE);
    }

    async getPowerInfo(): Promise<Record<string, string>> {
        const msgs = await this.rpcRequest(id => [encode.systemPowerInfo(id)], 15000);
        return this.collectKeyValues(msgs, MainContent.SYSTEM_POWER_INFO_RESPONSE);
    }

    async getStorageInfo(path: string): Promise<{ totalSpace: number; freeSpace: number }> {
        const msgs = await this.rpcRequest(id => [encode.storageInfo(id, path)], 10000);
        for (const m of msgs) {
            if (m.contentFieldNo === MainContent.STORAGE_INFO_RESPONSE) {
                return decodeStorageInfo(m.contentData);
            }
        }
        throw new Error(`No storage info returned for ${path}`);
    }

    async listDir(path: string): Promise<StorageFile[]> {
        const msgs = await this.rpcRequest(id => [encode.storageList(id, path)], 15000);
        const files: StorageFile[] = [];
        for (const m of msgs) {
            if (m.contentFieldNo === MainContent.STORAGE_LIST_RESPONSE) {
                files.push(...decodeListResponse(m.contentData));
            }
        }
        return files.sort((a, b) =>
            a.type !== b.type ? b.type - a.type : a.name.localeCompare(b.name));
    }

    async writeFile(path: string, data: Buffer): Promise<void> {
        await this.rpcRequest(id => {
            const frames: Buffer[] = [];
            const CHUNK = 512;
            if (data.length === 0) {
                frames.push(encode.storageWrite(id, path, Buffer.alloc(0), false));
            } else {
                for (let off = 0; off < data.length; off += CHUNK) {
                    const chunk = data.subarray(off, off + CHUNK);
                    frames.push(encode.storageWrite(id, path, chunk, off + CHUNK < data.length));
                }
            }
            return frames;
        }, 60000);
    }

    async mkdir(path: string): Promise<void> {
        await this.rpcRequest(id => [encode.storageMkdir(id, path)]);
    }

    dispose() {
        void this.disconnect();
    }

    // ── internals ─────────────────────────────────────────────────────────────

    private collectKeyValues(msgs: MainMessage[], contentFieldNo: number): Record<string, string> {
        const out: Record<string, string> = {};
        for (const m of msgs) {
            if (m.contentFieldNo === contentFieldNo) {
                const { key, value } = decodeKeyValue(m.contentData);
                if (key) { out[key] = value; }
            }
        }
        return out;
    }

    private onDisconnected() {
        if (!this.device) { return; }
        this.status('warn', 'Bluetooth link lost');
        this.cleanup();
    }

    private cleanup() {
        this.device = null;
        this.rxChar = null;
        this.buf = Buffer.alloc(0);
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('Bluetooth link closed'));
        }
        this.pending.clear();
        for (const w of this.flowWaiters.splice(0)) { w(); }
        this._onDidChangeState.fire();
    }

    private onData(chunk: Buffer) {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (true) {
            let frame: ReturnType<typeof tryDecodeFrame>;
            try {
                frame = tryDecodeFrame(this.buf);
            } catch {
                this.buf = Buffer.alloc(0);
                return;
            }
            if (!frame) { return; }
            this.buf = this.buf.subarray(frame.bytesConsumed);
            this.route(frame.msg);
        }
    }

    private route(msg: MainMessage) {
        const pending = this.pending.get(msg.commandId);
        if (!pending) { return; }
        if (msg.commandStatus !== 0) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.commandId);
            pending.reject(new Error(COMMAND_STATUS_NAMES[msg.commandStatus] ?? `status ${msg.commandStatus}`));
            return;
        }
        pending.messages.push(msg);
        if (msg.hasNext) {
            clearTimeout(pending.timer);
            pending.timer = this.makeTimer(msg.commandId, pending.timeoutMs);
        } else {
            clearTimeout(pending.timer);
            this.pending.delete(msg.commandId);
            pending.resolve(pending.messages);
        }
    }

    private makeTimer(id: number, timeoutMs: number): NodeJS.Timeout {
        return setTimeout(() => {
            const p = this.pending.get(id);
            if (p) {
                this.pending.delete(id);
                p.reject(new Error('BLE RPC request timed out'));
            }
        }, timeoutMs);
    }

    private allocId(): number {
        const id = this.nextCommandId;
        this.nextCommandId = this.nextCommandId >= 0x7fffffff ? 1 : this.nextCommandId + 1;
        return id;
    }

    private async waitForFlow(needed: number): Promise<void> {
        if (this.flowAvailable >= needed) { return; }
        await new Promise<void>(resolve => {
            const t = setTimeout(resolve, 3000); // proceed anyway — writes are ACKed at ATT level
            this.flowWaiters.push(() => { clearTimeout(t); resolve(); });
        });
    }

    private async writeRaw(data: Buffer): Promise<void> {
        if (!this.rxChar) { throw new Error('Bluetooth is not connected'); }
        for (let off = 0; off < data.length; off += WRITE_CHUNK) {
            const chunk = data.subarray(off, off + WRITE_CHUNK);
            await this.waitForFlow(chunk.length);
            this.flowAvailable = Math.max(0, this.flowAvailable - chunk.length);
            await this.rxChar.writeValueWithResponse(
                chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
        }
    }

    private rpcRequest(build: (id: number) => Buffer[], timeoutMs = 10000): Promise<MainMessage[]> {
        if (!this.isConnected() && !this.connecting) {
            return Promise.reject(new Error('Bluetooth is not connected'));
        }
        const id = this.allocId();
        const frames = build(id);
        return new Promise<MainMessage[]>((resolve, reject) => {
            this.pending.set(id, {
                messages: [], resolve, reject, timeoutMs,
                timer: this.makeTimer(id, timeoutMs),
            });
            (async () => {
                for (const f of frames) { await this.writeRaw(f); }
            })().catch(err => {
                const p = this.pending.get(id);
                if (p) { clearTimeout(p.timer); this.pending.delete(id); }
                reject(err as Error);
            });
        });
    }

    private status(level: StatusLine['level'], text: string) {
        this._onStatus.fire({ level, text });
    }
}

export const flipperBle = new FlipperBle();
