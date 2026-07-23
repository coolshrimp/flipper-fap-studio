import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
    findFirmwareResourcePackage,
    stageFirmwareResources,
} from "./firmwareResources";
import {
    buildFat16Image,
    Fat16MergeMetadata,
    mergeFat16Image,
} from "./fat16Image";
import { migrateLegacyRuntimeStorage } from "./runtimeWorkspace";

export type Stm32RuntimeEvent =
    | { type: "stm32Status"; state: string; text?: string; progress?: number }
    | { type: "stm32Frame"; hex: string }
    | { type: "stm32Audio"; playing: boolean; frequency: number; volume: number }
    | { type: "stm32Log"; text: string; level?: string; tag?: string };

export interface Stm32RuntimeLaunch {
    targetId: string;
    targetPath: string;
    appId: string;
    category: string;
    fapPath?: string;
}

export interface Stm32RuntimeAvailability {
    available: boolean;
    executable: string;
    detail: string;
}

export interface FirmwareImage {
    sourcePath: string;
    kind: "bin" | "dfu";
    data: Buffer;
    baseAddress: number;
}

const MAX_SCAN_DIRS = 800;
const MAX_SCAN_DEPTH = 8;
const MAX_LOG_LINE = 8_192;

export class Stm32Runtime {
    private process: childProcess.ChildProcessWithoutNullStreams | undefined;
    private stoppingProcess: childProcess.ChildProcessWithoutNullStreams | undefined;
    private stdoutBuffer = "";
    private stderrBuffer = "";
    private storageRoot = "";
    private clock = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly emit: (event: Stm32RuntimeEvent) => void,
    ) {}

    public get running(): boolean {
        return Boolean(this.process);
    }

    public get storagePath(): string {
        return this.storageRoot;
    }

    public inspectAvailability(): Stm32RuntimeAvailability {
        const executable = this.findExecutable();
        if (executable) {
            return {
                available: true,
                executable,
                detail: "STM32WB55 firmware engine found. Selected firmware can be booted locally.",
            };
        }
        return {
            available: false,
            executable: "",
            detail: "Set flipperFapStudio.stm32Runtime.executablePath to the patched stm32-emulator executable.",
        };
    }

    public async start(launch: Stm32RuntimeLaunch): Promise<void> {
        this.emit({ type: "stm32Audio", playing: false, frequency: 0, volume: 0 });
        const previousProcess = this.process || this.stoppingProcess;
        this.stop(false);
        if (previousProcess) {
            await waitForProcessExit(previousProcess);
            if (this.stoppingProcess === previousProcess) this.stoppingProcess = undefined;
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error("STM32 firmware simulation requires a trusted workspace.");
        }
        const executable = this.findExecutable();
        if (!executable) {
            throw new Error(
                "STM32 emulator engine was not found. Set flipperFapStudio.stm32Runtime.executablePath in Settings.",
            );
        }
        if (launch.fapPath && !fs.existsSync(launch.fapPath)) {
            throw new Error("Build the active app before starting firmware simulation.");
        }

        const targetRoot = resolveTargetRoot(launch.targetId, launch.targetPath);
        const firmware = findFirmwareImage(targetRoot);
        if (!firmware) {
            throw new Error(`No full.bin, firmware.bin, or firmware.dfu was found in the selected target: ${targetRoot}`);
        }
        const svdPath = findStm32Svd(targetRoot) || findStm32Svd(path.join(os.homedir(), ".ufbt", "current"));
        if (!svdPath) {
            throw new Error("STM32WB55_CM4.svd was not found in the selected target or managed uFBT SDK.");
        }

        const safeTarget = safeName(launch.targetId || "target");
        const safeApp = safeName(launch.appId || (launch.fapPath ? path.basename(launch.fapPath, ".fap") : "firmware"));
        const targetRuntimeRoot = path.join(this.context.globalStorageUri.fsPath, "stm32-runtime", safeTarget);
        const workRoot = path.join(targetRuntimeRoot, "apps", safeApp);
        const profileRoot = path.join(workRoot, "profile");
        this.storageRoot = path.join(targetRuntimeRoot, "storage");
        const extRoot = path.join(this.storageRoot, "ext");
        const sdImagePath = path.join(this.storageRoot, "sd-card.img");
        const sdSyncPath = path.join(this.storageRoot, "sd-card.sync.json");
        const appFolder = path.join(this.storageRoot, "ext", "apps", safeName(launch.category || "Misc"));
        await Promise.all([
            fs.promises.mkdir(profileRoot, { recursive: true }),
            fs.promises.mkdir(appFolder, { recursive: true }),
        ]);
        const legacyMigration = await migrateLegacyRuntimeStorage(targetRuntimeRoot, this.storageRoot);

        const image = firmware.kind === "dfu" ? extractDfuSe(firmware.sourcePath) : firmware;
        if (image.baseAddress !== 0x08000000) {
            throw new Error(`Firmware image starts at 0x${image.baseAddress.toString(16)}, expected 0x08000000.`);
        }
        if (image.data.length > 0x00100000) {
            throw new Error(`Firmware image is too large for STM32WB55 flash (${image.data.length} bytes).`);
        }

        const binPath = path.join(profileRoot, "full.bin");
        const stagedSvd = path.join(profileRoot, "STM32WB55_CM4.svd");
        const stagedFap = launch.fapPath ? path.join(appFolder, `${safeApp}.fap`) : "";
        const resourcePackage = findFirmwareResourcePackage(targetRoot, image.sourcePath);
        this.emit({
            type: "stm32Status",
            state: "starting",
            progress: 8,
            text: resourcePackage
                ? `Preparing ${path.basename(resourcePackage.archivePath)} for the virtual SD...`
                : "Preparing firmware runtime...",
        });
        await Promise.all([
            fs.promises.writeFile(binPath, image.data),
            fs.promises.copyFile(svdPath, stagedSvd),
        ]);
        this.emit({ type: "stm32Status", state: "starting", progress: 20 });
        let imageMerge: Fat16MergeMetadata | undefined;
        const imageAlreadySynchronized =
            fs.existsSync(sdImagePath) && isSdImageSynchronized(sdImagePath, sdSyncPath);
        if (fs.existsSync(sdImagePath) && !imageAlreadySynchronized) {
            try {
                imageMerge = mergeFat16Image(sdImagePath, extRoot);
            } catch (error) {
                throw new Error(
                    `The existing virtual SD image could not be read, so it was left unchanged to protect firmware saves. ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        this.emit({ type: "stm32Status", state: "starting", progress: 25 });
        const resourceStage = await stageFirmwareResources(
            resourcePackage,
            this.storageRoot,
            progress => this.emit({
                type: "stm32Status",
                state: "starting",
                progress: 28 + Math.round(progress * 48),
            }),
        );
        // A selected development app deliberately wins over the copy shipped in
        // the firmware archive.
        if (launch.fapPath) await fs.promises.copyFile(launch.fapPath, stagedFap);
        this.emit({
            type: "stm32Status",
            state: "starting",
            progress: 80,
            text: "Building the virtual SD image...",
        });
        const sdImage = buildFat16Image(extRoot, sdImagePath);
        markSdImageSynchronized(sdImagePath, sdSyncPath);
        const metadata = {
            targetId: launch.targetId,
            targetPath: targetRoot,
            firmwareSource: image.sourcePath,
            firmwareBytes: image.data.length,
            fapSource: launch.fapPath || "",
            stagedFap,
            storageRoot: this.storageRoot,
            virtualSdRoot: extRoot,
            sdImage,
            previousSdImport: imageMerge,
            previousSdAlreadySynchronized: imageAlreadySynchronized,
            legacyStorageMigration: legacyMigration,
            firmwareResources: resourceStage,
            createdAt: new Date().toISOString(),
        };
        await fs.promises.writeFile(
            path.join(workRoot, "session.json"),
            JSON.stringify(metadata, null, 2),
            "utf8",
        );
        const profileImagePath = path.relative(profileRoot, sdImagePath).replace(/\\/g, "/");
        await fs.promises.writeFile(
            path.join(profileRoot, "config.yaml"),
            createFlipperProfile(profileImagePath),
            "utf8",
        );

        this.clock = 0;
        this.stdoutBuffer = "";
        this.stderrBuffer = "";
        this.emit({
            type: "stm32Status",
            state: "starting",
            progress: 96,
            text: `Starting ${path.basename(image.sourcePath)}${stagedFap ? ` with ${path.basename(stagedFap)}` : ""}; ${
                resourceStage.found
                    ? `${resourceStage.changed ? "staged" : "reused"} ${resourceStage.fileCount.toLocaleString()} firmware SD files`
                    : "no firmware SD resource archive was declared"
            }...`,
        });
        const maxInstructions = vscode.workspace
            .getConfiguration("flipperFapStudio")
            .get<number>("stm32Runtime.maxInstructions", 0);
        const args = [
            "config.yaml",
            "--color",
            "never",
            ...(maxInstructions > 0 ? ["--max-instructions", String(Math.floor(maxInstructions))] : []),
        ];
        const runtimeProcess = childProcess.spawn(executable, args, {
            cwd: profileRoot,
            shell: false,
            windowsHide: true,
            env: {
                ...process.env,
                FLIPPER_RUNTIME_STORAGE: this.storageRoot,
                FLIPPER_RUNTIME_FAP: stagedFap,
            },
        });
        this.process = runtimeProcess;
        runtimeProcess.stdout.setEncoding("utf8");
        runtimeProcess.stderr.setEncoding("utf8");
        runtimeProcess.stdout.on("data", chunk => this.consume(chunk, false));
        runtimeProcess.stderr.on("data", chunk => this.consume(chunk, true));
        runtimeProcess.once("error", error => {
            if (this.process === runtimeProcess) this.process = undefined;
            this.emit({ type: "stm32Audio", playing: false, frequency: 0, volume: 0 });
            this.emit({ type: "stm32Status", state: "error", text: error.message });
        });
        runtimeProcess.once("exit", code => {
            if (this.process !== runtimeProcess) return;
            this.process = undefined;
            this.emit({ type: "stm32Audio", playing: false, frequency: 0, volume: 0 });
            const completed = code === 0 && maxInstructions > 0;
            this.emit({
                type: "stm32Status",
                state: completed ? "ready" : (code === 0 ? "stopped" : "error"),
                text: completed
                    ? `Firmware probe completed at ${this.clock.toLocaleString()} ARM instructions.`
                    : `STM32 firmware engine exited (${code ?? "unknown"}).`,
            });
        });
        this.emit({
            type: "stm32Status",
            state: "running",
            progress: 100,
            text: `Firmware engine running | virtual SD: ${extRoot} | ${formatBytes(sdImage.imageBytes)} FAT16${
                resourceStage.found ? ` | ${resourceStage.fileCount.toLocaleString()} firmware resource files` : ""
            }`,
        });
    }

    public stop(emit = true): void {
        const active = this.process;
        this.process = undefined;
        if (active) {
            this.emit({ type: "stm32Audio", playing: false, frequency: 0, volume: 0 });
            this.stoppingProcess = active;
            active.once("exit", () => {
                if (this.stoppingProcess === active) this.stoppingProcess = undefined;
            });
            active.stdin.end();
            active.kill();
            if (emit) this.emit({ type: "stm32Status", state: "stopped", text: "STM32 firmware engine stopped." });
        }
    }

    public sendInput(key: string, inputType: string): void {
        const active = this.process;
        const normalized = key.toUpperCase();
        if (!active || !["UP", "DOWN", "LEFT", "RIGHT", "OK", "BACK"].includes(normalized)) return;
        active.stdin.write(`BUTTON ${normalized} PRESS\n`);
        const delay = inputType === "long" ? 700 : 90;
        setTimeout(() => {
            if (this.process === active && !active.stdin.destroyed) {
                active.stdin.write(`BUTTON ${normalized} RELEASE\n`);
            }
        }, delay);
    }

    public async openStorage(): Promise<void> {
        const root = this.storageRoot || path.join(this.context.globalStorageUri.fsPath, "stm32-runtime");
        await fs.promises.mkdir(root, { recursive: true });
        if (this.process) {
            await vscode.window.showInformationMessage(
                "Stop the simulator before opening virtual SD storage so firmware saves can be synchronized safely.",
            );
            return;
        }
        if (this.stoppingProcess) {
            const stopping = this.stoppingProcess;
            await waitForProcessExit(stopping);
            if (this.stoppingProcess === stopping) this.stoppingProcess = undefined;
        }
        let revealRoot = root;
        if (this.storageRoot) {
            const imagePath = path.join(root, "sd-card.img");
            const syncPath = path.join(root, "sd-card.sync.json");
            const extRoot = path.join(root, "ext");
            await fs.promises.mkdir(extRoot, { recursive: true });
            if (fs.existsSync(imagePath)) {
                try {
                    mergeFat16Image(imagePath, extRoot);
                    markSdImageSynchronized(imagePath, syncPath);
                } catch (error) {
                    this.emit({
                        type: "stm32Log",
                        level: "warn",
                        tag: "SD",
                        text: `Could not synchronize the virtual SD image before opening storage: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    });
                }
            }
            revealRoot = extRoot;
        }
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(revealRoot));
    }

    private findExecutable(): string {
        const configured = vscode.workspace
            .getConfiguration("flipperFapStudio")
            .get<string>("stm32Runtime.executablePath", "")
            .trim();
        const names = process.platform === "win32" ? ["stm32-emulator.exe"] : ["stm32-emulator"];
        const candidates = [
            configured,
            ...names.map(name => path.join(this.context.extensionUri.fsPath, "runtime", "stm32", name)),
            ...names.map(name => path.join(this.context.extensionUri.fsPath, ".runtime-test", "stm32-emulator", "target", "release", name)),
        ].filter(Boolean);
        return candidates.find(candidate => {
            try { return fs.statSync(candidate).isFile(); } catch { return false; }
        }) || "";
    }

    private consume(chunk: string, stderr: boolean): void {
        const key = stderr ? "stderrBuffer" : "stdoutBuffer";
        this[key] += chunk;
        if (this[key].length > 1_000_000) this[key] = this[key].slice(-250_000);
        let newline = this[key].indexOf("\n");
        while (newline >= 0) {
            const line = this[key].slice(0, newline).trim();
            this[key] = this[key].slice(newline + 1);
            if (line) this.consumeLine(line.slice(0, MAX_LOG_LINE), stderr);
            newline = this[key].indexOf("\n");
        }
    }

    private consumeLine(line: string, stderr: boolean): void {
        const frame = /FLIPPER_FRAME ([0-9a-fA-F]{2048})/.exec(line);
        if (frame) {
            this.emit({ type: "stm32Frame", hex: frame[1] });
            return;
        }
        const audio = parseStm32Audio(line);
        if (audio) {
            this.emit(audio);
            return;
        }
        const clock = /\[clk=(\d+)/.exec(line)?.[1];
        if (clock) this.clock = Number(clock);
        // env_logger writes every level to stderr, so stderr alone is not a
        // severity signal. Forwarding all firmware INFO output can starve
        // display frames and input acknowledgements in the webview.
        const important =
            /(?:\bERROR\b|\bWARN\b|Startup complete|Starting emulation|Reached target|Stop address|Loading file|panicked)/i.test(line);
        if (important) {
            this.emit({
                type: "stm32Log",
                text: line,
                level: /ERROR|panic/i.test(line) ? "error" : (/WARN/i.test(line) ? "warn" : undefined),
                tag: "STM32",
            });
        }
    }
}

function parseStm32Audio(line: string): Extract<Stm32RuntimeEvent, { type: "stm32Audio" }> | undefined {
    if (/FLIPPER_AUDIO STOP/.test(line)) {
        return { type: "stm32Audio", playing: false, frequency: 0, volume: 0 };
    }
    const start = /FLIPPER_AUDIO START frequency=([\d.]+) volume=([\d.]+)/.exec(line);
    if (!start) return undefined;
    return {
        type: "stm32Audio",
        playing: true,
        frequency: clampFinite(Number(start[1]), 0, 20_000),
        volume: clampFinite(Number(start[2]), 0, 1),
    };
}

function clampFinite(value: number, minimum: number, maximum: number): number {
    return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}

export function resolveTargetRoot(targetId: string, configuredPath: string): string {
    if (targetId === "oem") return path.join(os.homedir(), ".ufbt", "current");
    return configuredPath;
}

export function findFirmwareImage(root: string): FirmwareImage | undefined {
    const preferred = boundedFind(root, file => {
        const name = path.basename(file).toLowerCase();
        return name === "full.bin" || name === "firmware.bin" || name === "firmware.dfu";
    }).sort((a, b) => firmwareRank(a) - firmwareRank(b));
    const sourcePath = preferred[0];
    if (!sourcePath) return undefined;
    if (sourcePath.toLowerCase().endsWith(".dfu")) return extractDfuSe(sourcePath);
    return { sourcePath, kind: "bin", data: fs.readFileSync(sourcePath), baseAddress: 0x08000000 };
}

export function findStm32Svd(root: string): string {
    return boundedFind(root, file => /^stm32wb55.*\.svd$/i.test(path.basename(file)))[0] || "";
}

export function extractDfuSe(filePath: string): FirmwareImage {
    const source = fs.readFileSync(filePath);
    if (source.length < 11 || source.toString("ascii", 0, 5) !== "DfuSe") {
        throw new Error(`${path.basename(filePath)} is not a DfuSe firmware container.`);
    }
    const targets = source[10];
    let cursor = 11;
    const elements: Array<{ address: number; data: Buffer }> = [];
    for (let target = 0; target < targets; target++) {
        if (cursor + 274 > source.length || source.toString("ascii", cursor, cursor + 6) !== "Target") {
            throw new Error(`Invalid DfuSe target header in ${path.basename(filePath)}.`);
        }
        const elementCount = source.readUInt32LE(cursor + 270);
        cursor += 274;
        for (let element = 0; element < elementCount; element++) {
            if (cursor + 8 > source.length) throw new Error("Truncated DfuSe element header.");
            const address = source.readUInt32LE(cursor);
            const size = source.readUInt32LE(cursor + 4);
            cursor += 8;
            if (size > 0x01000000 || cursor + size > source.length) throw new Error("Invalid DfuSe element size.");
            elements.push({ address, data: source.subarray(cursor, cursor + size) });
            cursor += size;
        }
    }
    if (!elements.length) throw new Error(`${path.basename(filePath)} contains no firmware elements.`);
    const baseAddress = Math.min(...elements.map(element => element.address));
    const endAddress = Math.max(...elements.map(element => element.address + element.data.length));
    if (endAddress - baseAddress > 0x01000000) throw new Error("DfuSe firmware address range is too large.");
    const data = Buffer.alloc(endAddress - baseAddress, 0xff);
    for (const element of elements) element.data.copy(data, element.address - baseAddress);
    return { sourcePath: filePath, kind: "dfu", data, baseAddress };
}

function firmwareRank(filePath: string): number {
    const name = path.basename(filePath).toLowerCase();
    if (name === "full.bin") return 0;
    if (name === "firmware.bin") return 1;
    return 2;
}

function boundedFind(root: string, accept: (file: string) => boolean): string[] {
    if (!root) return [];
    try { if (!fs.statSync(root).isDirectory()) return []; } catch { return []; }
    const found: string[] = [];
    let dirs = 0;
    const visit = (folder: string, depth: number): void => {
        if (dirs++ >= MAX_SCAN_DIRS || depth > MAX_SCAN_DEPTH || found.length >= 24) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (found.length >= 24) return;
            const full = path.join(folder, entry.name);
            if (entry.isFile() && accept(full)) found.push(full);
            else if (
                entry.isDirectory() &&
                !entry.name.startsWith(".") &&
                !["node_modules", ".git", "dist"].includes(entry.name)
            ) visit(full, depth + 1);
        }
    };
    visit(root, 0);
    return found;
}

function safeName(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "") || "item";
}

function createFlipperProfile(sdImagePath = "sd-card.img"): string {
    return `cpu:
  svd: STM32WB55_CM4.svd
  vector_table: 0x08000000

regions:
  - name: FLASH_ALIAS
    start: 0x00000000
    load: full.bin
    size: 0x00100000
  - name: FLASH
    start: 0x08000000
    load: full.bin
    size: 0x00100000
  - name: SRAM1
    start: 0x20000000
    size: 0x00030000
  - name: SRAM2
    start: 0x20030000
    size: 0x00010000
  - name: SRAM2_ALIAS
    start: 0x10000000
    size: 0x00010000
  - name: FACTORY_OTP
    start: 0x1fff7000
    size: 0x00001000

peripherals: {}
devices:
  usart_probe:
    - peripheral: USART1
  sd_card:
    - peripheral: SPI2
      file: ${JSON.stringify(sdImagePath)}
      chip_select: PC12
      card_detect: PC10
  st7567:
    - peripheral: SPI2
      data_command: PB1
      chip_select: PC11
framebuffers: []
`;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
}

interface SdImageSyncState {
    version: 1;
    imageBytes: number;
    imageModifiedMs: number;
}

function isSdImageSynchronized(imagePath: string, statePath: string): boolean {
    try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<SdImageSyncState>;
        const image = fs.statSync(imagePath);
        return state.version === 1 &&
            state.imageBytes === image.size &&
            state.imageModifiedMs === image.mtimeMs;
    } catch {
        return false;
    }
}

function markSdImageSynchronized(imagePath: string, statePath: string): void {
    const image = fs.statSync(imagePath);
    const state: SdImageSyncState = {
        version: 1,
        imageBytes: image.size,
        imageModifiedMs: image.mtimeMs,
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function waitForProcessExit(
    process: childProcess.ChildProcessWithoutNullStreams,
    timeoutMs = 5_000,
): Promise<void> {
    if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            process.removeListener("exit", onExit);
            if (error) reject(error);
            else resolve();
        };
        const onExit = (): void => finish();
        const timer = setTimeout(
            () => finish(new Error("The previous STM32 firmware engine did not stop within 5 seconds.")),
            timeoutMs,
        );
        process.once("exit", onExit);
    });
}

export const stm32RuntimeTestHooks = {
    extractDfuSe,
    findFirmwareImage,
    findStm32Svd,
    resolveTargetRoot,
    createFlipperProfile,
    isSdImageSynchronized,
    markSdImageSynchronized,
    parseStm32Audio,
};
