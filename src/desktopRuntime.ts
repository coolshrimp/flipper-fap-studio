import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { generateDesktopAssetHeaders } from "./desktopAssets";
import { prepareRuntimeWorkspace } from "./runtimeWorkspace";

export interface DesktopRuntimeManifest {
    appId: string;
    entryPoint: string;
}

export type DesktopRuntimeEvent =
    | { type: "runtimeStatus"; state: string; text?: string }
    | { type: "runtimeFrame"; commands: unknown[] }
    | { type: "runtimeAudio"; playing: boolean; frequency: number; volume: number; durationMs?: number }
    | { type: "runtimeLog"; text: string; level?: string; tag?: string };

export class DesktopRuntime {
    private process: childProcess.ChildProcessWithoutNullStreams | undefined;
    private stoppingProcess: childProcess.ChildProcessWithoutNullStreams | undefined;
    private stdoutBuffer = "";
    private storageRoot: string | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly emit: (event: DesktopRuntimeEvent) => void,
    ) {}

    public get running(): boolean {
        return Boolean(this.process);
    }

    public async start(appFolder: string, manifest: DesktopRuntimeManifest, sharedStorageRoot?: string): Promise<void> {
        const previousProcess = this.process || this.stoppingProcess;
        this.stop();
        if (previousProcess) {
            await waitForProcessExit(previousProcess);
            if (this.stoppingProcess === previousProcess) this.stoppingProcess = undefined;
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error("Functional simulation requires a trusted workspace because it compiles and runs the app source.");
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(manifest.entryPoint)) {
            throw new Error(`Invalid application entry point: ${manifest.entryPoint}`);
        }

        const compiler = await this.findCompiler();
        if (!compiler) {
            throw new Error(
                "No desktop GCC compiler was found. Set flipperFapStudio.desktopRuntime.compilerPath to gcc.exe (the Pico SDK MinGW compiler is supported).",
            );
        }

        const appSources = this.collectSources(appFolder);
        if (!appSources.length) {
            throw new Error("No C sources were found in the active app folder.");
        }
        const hardwareSources = appSources.filter(source => {
            const text = fs.readFileSync(source, "utf8");
            return /#include\s*[<"][^>"]*(?:stm32|furi_hal_bus|furi_hal_interrupt|furi_hal_spi)/i.test(text);
        });
        const entryPattern = new RegExp(`\\b${manifest.entryPoint}\\s*\\(`);
        const desktopSources = appSources.filter(source =>
            !hardwareSources.includes(source) ||
            entryPattern.test(fs.readFileSync(source, "utf8"))
        );
        const omittedHardwareSources = hardwareSources.filter(source => !desktopSources.includes(source));

        const safeId = (manifest.appId || "flipper_app").replace(/[^A-Za-z0-9_.-]/g, "_");
        const buildRoot = path.join(this.context.globalStorageUri.fsPath, "desktop-runtime", safeId);
        this.storageRoot = sharedStorageRoot || path.join(buildRoot, "storage");
        // A firmware-backed session supplies storage outside buildRoot. The
        // compiler workspace still needs to exist for runtime_config.h,
        // generated asset headers, and the host executable.
        await prepareRuntimeWorkspace(buildRoot, this.storageRoot);

        const runtimeRoot = path.join(this.context.extensionUri.fsPath, "runtime");
        const executable = path.join(buildRoot, `${safeId}-runtime.exe`);
        const generatedConfig = path.join(buildRoot, "runtime_config.h");
        await fs.promises.writeFile(
            generatedConfig,
            `#define FLIPPER_RUNTIME_ENTRY ${manifest.entryPoint}\n#define FLIPPER_RUNTIME_APP_ID ${JSON.stringify(safeId)}\n`,
            "utf8",
        );
        const assetResult = await generateDesktopAssetHeaders(appFolder, buildRoot, desktopSources);
        for (const warning of assetResult.warnings) {
            this.emit({ type: "runtimeLog", tag: "ASSET", level: "warn", text: warning });
        }
        const generatedAssets = assetResult.headerCount;
        const args = [
            "-std=gnu11",
            "-O0",
            "-g",
            "-Wall",
            "-Wno-unused-function",
            "-Wno-unused-variable",
            "-Wno-format",
            "-include",
            generatedConfig,
            `-I${path.join(runtimeRoot, "include")}`,
            `-I${buildRoot}`,
            `-I${appFolder}`,
            ...desktopSources,
            path.join(runtimeRoot, "host_runtime.c"),
            path.join(runtimeRoot, "host_events.c"),
            path.join(runtimeRoot, "host_gui.c"),
            ...(omittedHardwareSources.length ? [path.join(runtimeRoot, "host_audio_backend.c")] : []),
            path.join(runtimeRoot, "host_main.c"),
            "-lm",
            "-o",
            executable,
        ];

        this.emit({
            type: "runtimeStatus",
            state: "building",
            text: `Compiling ${desktopSources.length} source files${hardwareSources.length ? `; stubbing ${hardwareSources.length} hardware backend` : ""}${generatedAssets ? `; generated ${generatedAssets} asset header${generatedAssets === 1 ? "" : "s"}` : ""}…`,
        });
        const build = await this.runCompiler(compiler, args, appFolder);
        if (build.output.trim()) {
            this.emit({ type: "runtimeLog", text: build.output.trim(), tag: "BUILD" });
        }
        if (build.code !== 0) {
            this.emit({ type: "runtimeStatus", state: "error", text: "Desktop runtime build failed." });
            throw new Error(`Desktop runtime build failed (exit ${build.code}). See the simulator log.`);
        }

        this.stdoutBuffer = "";
        const runtimeProcess = childProcess.spawn(executable, [], {
            cwd: appFolder,
            shell: false,
            windowsHide: true,
            env: { ...process.env, FLIPPER_RUNTIME_STORAGE: this.storageRoot },
        });
        this.process = runtimeProcess;
        runtimeProcess.stdout.setEncoding("utf8");
        runtimeProcess.stderr.setEncoding("utf8");
        runtimeProcess.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
        runtimeProcess.stderr.on("data", (chunk: string) => {
            this.emit({ type: "runtimeLog", text: chunk.trimEnd(), level: "error", tag: "RUNTIME" });
        });
        runtimeProcess.once("error", error => {
            this.emit({ type: "runtimeAudio", playing: false, frequency: 0, volume: 0 });
            this.emit({ type: "runtimeStatus", state: "error", text: error.message });
            if (this.process === runtimeProcess) this.process = undefined;
        });
        runtimeProcess.once("exit", code => {
            if (this.process === runtimeProcess) {
                this.process = undefined;
                this.emit({ type: "runtimeAudio", playing: false, frequency: 0, volume: 0 });
                this.emit({ type: "runtimeStatus", state: "stopped", text: `Runtime exited (${code ?? "unknown"}).` });
            }
        });
    }

    public sendInput(key: string, inputType = "short"): void {
        if (!this.process || !this.process.stdin.writable) return;
        const safeKey = key.toLowerCase().replace(/[^a-z]/g, "");
        const safeType = inputType.toLowerCase().replace(/[^a-z]/g, "");
        if (safeKey && safeType) this.process.stdin.write(`INPUT ${safeKey} ${safeType}\n`);
    }

    public stop(): void {
        const active = this.process;
        this.process = undefined;
        if (active) {
            this.stoppingProcess = active;
            active.once("exit", () => {
                if (this.stoppingProcess === active) this.stoppingProcess = undefined;
            });
            active.stdin.end();
            active.kill();
            this.emit({ type: "runtimeAudio", playing: false, frequency: 0, volume: 0 });
            this.emit({ type: "runtimeStatus", state: "stopped", text: "Functional runtime stopped." });
        }
    }

    public async openStorage(): Promise<void> {
        if (!this.storageRoot) {
            const fallback = path.join(this.context.globalStorageUri.fsPath, "desktop-runtime");
            await fs.promises.mkdir(fallback, { recursive: true });
            this.storageRoot = fallback;
        }
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(this.storageRoot));
    }

    private collectSources(root: string): string[] {
        const result: string[] = [];
        const ignored = new Set([".git", ".ufbt", ".vscode", "build", "dist", "tests", "node_modules"]);
        const visit = (folder: string): void => {
            if (result.length > 250) throw new Error("The app has too many C sources for desktop simulation.");
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    if (!ignored.has(entry.name) && !entry.name.startsWith(".")) visit(path.join(folder, entry.name));
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".c")) {
                    result.push(path.join(folder, entry.name));
                }
            }
        };
        visit(root);
        return result;
    }

    private async findCompiler(): Promise<string | undefined> {
        const configured = vscode.workspace
            .getConfiguration("flipperFapStudio")
            .get<string>("desktopRuntime.compilerPath", "")
            .trim();
        const candidates = [
            configured,
            process.env.FLIPPER_GCC || "",
            path.join(os.homedir(), ".pico-sdk", "mingw64", "bin", "gcc.exe"),
        ].filter(Boolean);
        for (const candidate of candidates) {
            try {
                await fs.promises.access(candidate, fs.constants.X_OK);
                return candidate;
            } catch {
                // Try the next explicit compiler location.
            }
        }
        return this.findOnPath();
    }

    private findOnPath(): Promise<string | undefined> {
        return new Promise(resolve => {
            const finder = process.platform === "win32" ? "where.exe" : "which";
            const processHandle = childProcess.spawn(finder, ["gcc"], { shell: false, windowsHide: true });
            let output = "";
            processHandle.stdout.on("data", chunk => (output += chunk.toString()));
            processHandle.once("error", () => resolve(undefined));
            processHandle.once("exit", code => {
                const first = output.split(/\r?\n/).map(line => line.trim()).find(Boolean);
                resolve(code === 0 ? first : undefined);
            });
        });
    }

    private runCompiler(
        compiler: string,
        args: string[],
        cwd: string,
    ): Promise<{ code: number | null; output: string }> {
        return new Promise((resolve, reject) => {
            const processHandle = childProcess.spawn(compiler, args, { cwd, shell: false, windowsHide: true });
            let output = "";
            processHandle.stdout.on("data", chunk => (output += chunk.toString()));
            processHandle.stderr.on("data", chunk => (output += chunk.toString()));
            processHandle.once("error", reject);
            processHandle.once("exit", code => resolve({ code, output }));
        });
    }

    private consumeStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        if (this.stdoutBuffer.length > 2_000_000) {
            this.stdoutBuffer = "";
            this.emit({ type: "runtimeLog", level: "error", text: "Runtime output exceeded the safety limit." });
            return;
        }
        let newline = this.stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (line) this.consumeLine(line);
            newline = this.stdoutBuffer.indexOf("\n");
        }
    }

    private consumeLine(line: string): void {
        try {
            const message = JSON.parse(line) as {
                type?: string;
                state?: string;
                commands?: unknown[];
                text?: string;
                level?: string;
                tag?: string;
                playing?: boolean;
                frequency?: number;
                volume?: number;
                durationMs?: number;
            };
            if (message.type === "frame" && Array.isArray(message.commands)) {
                this.emit({ type: "runtimeFrame", commands: message.commands });
            } else if (message.type === "audio") {
                this.emit({
                    type: "runtimeAudio",
                    playing: message.playing === true,
                    frequency: clampFinite(message.frequency, 0, 20_000),
                    volume: clampFinite(message.volume, 0, 1),
                    durationMs: message.durationMs === undefined
                        ? undefined
                        : clampFinite(message.durationMs, 0, 10_000),
                });
            } else if (message.type === "status") {
                this.emit({ type: "runtimeStatus", state: message.state || "running", text: message.text });
            } else if (message.type === "log") {
                this.emit({ type: "runtimeLog", text: message.text || "", level: message.level, tag: message.tag });
            }
        } catch {
            this.emit({ type: "runtimeLog", text: line, tag: "APP" });
        }
    }
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
            () => finish(new Error("The previous desktop runtime did not stop within 5 seconds.")),
            timeoutMs,
        );
        process.once("exit", onExit);
    });
}

function clampFinite(value: number | undefined, minimum: number, maximum: number): number {
    return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Number(value))) : minimum;
}
