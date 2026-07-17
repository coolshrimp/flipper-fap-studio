/**
 * Minimal protobuf codec for the Flipper Zero RPC protocol.
 *
 * Implements only the subset of messages this extension uses, with field
 * numbers taken from the vendored definitions in /proto (flipperdevices/
 * flipperzero-protobuf). Messages on the wire are varint-length-delimited
 * PB.Main frames.
 */

// ── PB.Main content field numbers (proto/flipper.proto) ─────────────────────
export const enum MainContent {
    EMPTY = 4,
    STOP_SESSION = 19,
    SYSTEM_PING_REQUEST = 5,
    SYSTEM_PING_RESPONSE = 6,
    STORAGE_INFO_REQUEST = 28,
    STORAGE_INFO_RESPONSE = 29,
    STORAGE_STAT_REQUEST = 24,
    STORAGE_STAT_RESPONSE = 25,
    STORAGE_LIST_REQUEST = 7,
    STORAGE_LIST_RESPONSE = 8,
    STORAGE_READ_REQUEST = 9,
    STORAGE_READ_RESPONSE = 10,
    STORAGE_WRITE_REQUEST = 11,
    STORAGE_DELETE_REQUEST = 12,
    STORAGE_MKDIR_REQUEST = 13,
    STORAGE_RENAME_REQUEST = 30,
    APP_START_REQUEST = 16,
    APP_LOAD_FILE_REQUEST = 48,
    GUI_START_SCREEN_STREAM_REQUEST = 20,
    GUI_STOP_SCREEN_STREAM_REQUEST = 21,
    GUI_SCREEN_FRAME = 22,
    GUI_SEND_INPUT_EVENT_REQUEST = 23,
}

// ── Enums (proto/gui.proto, proto/storage.proto) ─────────────────────────────
export const enum InputKey { UP = 0, DOWN = 1, RIGHT = 2, LEFT = 3, OK = 4, BACK = 5 }
export const enum InputType { PRESS = 0, RELEASE = 1, SHORT = 2, LONG = 3, REPEAT = 4 }
export const enum FileType { FILE = 0, DIR = 1 }

export const COMMAND_STATUS_NAMES: Record<number, string> = {
    0: 'OK', 1: 'ERROR', 2: 'ERROR_DECODE', 3: 'ERROR_NOT_IMPLEMENTED', 4: 'ERROR_BUSY',
    5: 'ERROR_STORAGE_NOT_READY', 6: 'ERROR_STORAGE_EXIST', 7: 'ERROR_STORAGE_NOT_EXIST',
    8: 'ERROR_STORAGE_INVALID_PARAMETER', 9: 'ERROR_STORAGE_DENIED', 10: 'ERROR_STORAGE_INVALID_NAME',
    11: 'ERROR_STORAGE_INTERNAL', 12: 'ERROR_STORAGE_NOT_IMPLEMENTED', 13: 'ERROR_STORAGE_ALREADY_OPEN',
    14: 'ERROR_CONTINUOUS_COMMAND_INTERRUPTED', 15: 'ERROR_INVALID_PARAMETERS',
    16: 'ERROR_APP_CANT_START', 17: 'ERROR_APP_SYSTEM_LOCKED', 18: 'ERROR_STORAGE_DIR_NOT_EMPTY',
    21: 'ERROR_APP_NOT_RUNNING', 22: 'ERROR_APP_CMD_ERROR',
};

// ── Low-level writer ──────────────────────────────────────────────────────────

class Writer {
    private chunks: Buffer[] = [];

    varint(n: number): this {
        const bytes: number[] = [];
        let v = n >>> 0;
        do {
            let b = v & 0x7f;
            v >>>= 7;
            if (v) { b |= 0x80; }
            bytes.push(b);
        } while (v);
        this.chunks.push(Buffer.from(bytes));
        return this;
    }

    /** field with wire type 0 (varint) */
    uint(fieldNo: number, value: number): this {
        if (value === 0) { return this; } // proto3 default — omit
        return this.varint(fieldNo << 3).varint(value);
    }

    /** field with wire type 0, always emitted (for oneof-adjacent semantics) */
    uintAlways(fieldNo: number, value: number): this {
        return this.varint(fieldNo << 3).varint(value);
    }

    bool(fieldNo: number, value: boolean): this {
        return value ? this.uintAlways(fieldNo, 1) : this;
    }

    /** field with wire type 2 (length-delimited) */
    bytes(fieldNo: number, value: Buffer): this {
        this.varint((fieldNo << 3) | 2).varint(value.length);
        this.chunks.push(value);
        return this;
    }

    string(fieldNo: number, value: string): this {
        if (value.length === 0) { return this; }
        return this.bytes(fieldNo, Buffer.from(value, 'utf8'));
    }

    finish(): Buffer {
        return Buffer.concat(this.chunks);
    }
}

// ── Low-level reader ──────────────────────────────────────────────────────────

export interface DecodedField {
    fieldNo: number;
    wireType: number;
    value: number;      // for varint fields
    data: Buffer;       // for length-delimited fields
}

export function readVarint(buf: Buffer, pos: number): { value: number; pos: number } {
    let result = 0;
    let shift = 0;
    while (true) {
        if (pos >= buf.length) { throw new RangeError('varint past end of buffer'); }
        const b = buf[pos++];
        result += (b & 0x7f) * Math.pow(2, shift); // avoid 32-bit overflow for large values
        if ((b & 0x80) === 0) { break; }
        shift += 7;
        if (shift > 63) { throw new Error('varint too long'); }
    }
    return { value: result, pos };
}

/** Parse all fields of an embedded message into a flat list. */
export function readFields(buf: Buffer): DecodedField[] {
    const fields: DecodedField[] = [];
    let pos = 0;
    while (pos < buf.length) {
        const tag = readVarint(buf, pos);
        pos = tag.pos;
        const fieldNo = tag.value >>> 3;
        const wireType = tag.value & 7;
        if (wireType === 0) {
            const v = readVarint(buf, pos);
            pos = v.pos;
            fields.push({ fieldNo, wireType, value: v.value, data: Buffer.alloc(0) });
        } else if (wireType === 2) {
            const len = readVarint(buf, pos);
            pos = len.pos;
            const data = buf.subarray(pos, pos + len.value);
            if (data.length < len.value) { throw new RangeError('length-delimited field past end'); }
            pos += len.value;
            fields.push({ fieldNo, wireType, value: 0, data });
        } else if (wireType === 5) {
            pos += 4;
            fields.push({ fieldNo, wireType, value: buf.readUInt32LE(pos - 4), data: Buffer.alloc(0) });
        } else if (wireType === 1) {
            pos += 8;
            fields.push({ fieldNo, wireType, value: 0, data: buf.subarray(pos - 8, pos) });
        } else {
            throw new Error(`unsupported wire type ${wireType}`);
        }
    }
    return fields;
}

const first = (fields: DecodedField[], no: number) => fields.find(f => f.fieldNo === no);

// ── PB.Main encode ────────────────────────────────────────────────────────────

function mainFrame(commandId: number, hasNext: boolean, contentFieldNo: number, content: Buffer): Buffer {
    const w = new Writer();
    w.uint(1, commandId);          // command_id
    // command_status omitted (OK=0)
    w.bool(3, hasNext);            // has_next
    w.bytes(contentFieldNo, content); // oneof content — always emitted, even when empty
    const body = w.finish();
    return Buffer.concat([new Writer().varint(body.length).finish(), body]);
}

export const encode = {
    ping: (id: number) =>
        mainFrame(id, false, MainContent.SYSTEM_PING_REQUEST, Buffer.alloc(0)),

    stopSession: (id: number) =>
        mainFrame(id, false, MainContent.STOP_SESSION, Buffer.alloc(0)),

    guiStartScreenStream: (id: number) =>
        mainFrame(id, false, MainContent.GUI_START_SCREEN_STREAM_REQUEST, Buffer.alloc(0)),

    guiStopScreenStream: (id: number) =>
        mainFrame(id, false, MainContent.GUI_STOP_SCREEN_STREAM_REQUEST, Buffer.alloc(0)),

    guiSendInputEvent: (id: number, key: InputKey, type: InputType) =>
        mainFrame(id, false, MainContent.GUI_SEND_INPUT_EVENT_REQUEST,
            new Writer().uintAlways(1, key).uintAlways(2, type).finish()),

    storageList: (id: number, path: string) =>
        mainFrame(id, false, MainContent.STORAGE_LIST_REQUEST,
            new Writer().string(1, path).finish()),

    storageRead: (id: number, path: string) =>
        mainFrame(id, false, MainContent.STORAGE_READ_REQUEST,
            new Writer().string(1, path).finish()),

    /** One chunk of a write; send with hasNext=true for all but the final chunk. */
    storageWrite: (id: number, path: string, chunk: Buffer, hasNext: boolean) =>
        mainFrame(id, hasNext, MainContent.STORAGE_WRITE_REQUEST,
            new Writer()
                .string(1, path)
                .bytes(2, new Writer().bytes(4, chunk).finish()) // file { data = 4 }
                .finish()),

    storageDelete: (id: number, path: string, recursive: boolean) =>
        mainFrame(id, false, MainContent.STORAGE_DELETE_REQUEST,
            new Writer().string(1, path).bool(2, recursive).finish()),

    storageMkdir: (id: number, path: string) =>
        mainFrame(id, false, MainContent.STORAGE_MKDIR_REQUEST,
            new Writer().string(1, path).finish()),

    storageRename: (id: number, oldPath: string, newPath: string) =>
        mainFrame(id, false, MainContent.STORAGE_RENAME_REQUEST,
            new Writer().string(1, oldPath).string(2, newPath).finish()),

    appStart: (id: number, name: string, args: string) =>
        mainFrame(id, false, MainContent.APP_START_REQUEST,
            new Writer().string(1, name).string(2, args).finish()),

    appLoadFile: (id: number, path: string) =>
        mainFrame(id, false, MainContent.APP_LOAD_FILE_REQUEST,
            new Writer().string(1, path).finish()),
};

// ── PB.Main decode ────────────────────────────────────────────────────────────

export interface StorageFile {
    type: FileType;
    name: string;
    size: number;
    data: Buffer;
}

export interface MainMessage {
    commandId: number;
    commandStatus: number;
    hasNext: boolean;
    contentFieldNo: number;
    /** raw bytes of the oneof content message */
    contentData: Buffer;
}

/**
 * Try to consume one varint-delimited PB.Main frame from buf.
 * Returns null when the buffer does not yet hold a complete frame.
 */
export function tryDecodeFrame(buf: Buffer): { msg: MainMessage; bytesConsumed: number } | null {
    if (buf.length === 0) { return null; }
    let len: { value: number; pos: number };
    try {
        len = readVarint(buf, 0);
    } catch {
        return null; // incomplete length prefix
    }
    if (buf.length < len.pos + len.value) { return null; }
    const body = buf.subarray(len.pos, len.pos + len.value);
    const fields = readFields(body);

    const msg: MainMessage = {
        commandId: first(fields, 1)?.value ?? 0,
        commandStatus: first(fields, 2)?.value ?? 0,
        hasNext: (first(fields, 3)?.value ?? 0) !== 0,
        contentFieldNo: 0,
        contentData: Buffer.alloc(0),
    };
    // The content oneof is any length-delimited field above 3
    for (const f of fields) {
        if (f.fieldNo > 3 && f.wireType === 2) {
            msg.contentFieldNo = f.fieldNo;
            msg.contentData = f.data;
            break;
        }
    }
    return { msg, bytesConsumed: len.pos + len.value };
}

export function decodeScreenFrame(content: Buffer): { data: Buffer; orientation: number } {
    const fields = readFields(content);
    return {
        data: first(fields, 1)?.data ?? Buffer.alloc(0),
        orientation: first(fields, 2)?.value ?? 0,
    };
}

function decodeFile(content: Buffer): StorageFile {
    const fields = readFields(content);
    return {
        type: (first(fields, 1)?.value ?? 0) as FileType,
        name: first(fields, 2)?.data.toString('utf8') ?? '',
        size: first(fields, 3)?.value ?? 0,
        data: first(fields, 4)?.data ?? Buffer.alloc(0),
    };
}

export function decodeListResponse(content: Buffer): StorageFile[] {
    return readFields(content)
        .filter(f => f.fieldNo === 1 && f.wireType === 2)
        .map(f => decodeFile(f.data));
}

export function decodeReadResponse(content: Buffer): StorageFile | null {
    const f = first(readFields(content), 1);
    return f ? decodeFile(f.data) : null;
}
