const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const engine = process.env.FLIPPER_STM32_ENGINE;
const target = process.env.FLIPPER_STM32_TARGET;
const fap = process.env.FLIPPER_STM32_FAP;
const maxInstructions = Number(process.env.FLIPPER_STM32_MAX || 2_000_000);

if (!engine || !target || !fap) {
    console.log("stm32 integration test skipped (set FLIPPER_STM32_ENGINE, FLIPPER_STM32_TARGET, and FLIPPER_STM32_FAP)");
    process.exit(0);
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === "vscode") {
        return {
            workspace: {
                isTrusted: true,
                getConfiguration: () => ({
                    get: (key, fallback) => {
                        if (key === "stm32Runtime.executablePath") return engine;
                        if (key === "stm32Runtime.maxInstructions") return maxInstructions;
                        return fallback;
                    },
                }),
            },
            commands: { executeCommand: async () => undefined },
            Uri: { file: fsPath => ({ fsPath }) },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { Stm32Runtime } = require("../out/stm32Runtime");
const globalStorage = fs.mkdtempSync(path.join(os.tmpdir(), "flipper-stm32-integration-"));
const events = [];
let terminalResolve;
const terminal = new Promise(resolve => { terminalResolve = resolve; });
const runtime = new Stm32Runtime(
    {
        globalStorageUri: { fsPath: globalStorage },
        extensionUri: { fsPath: path.resolve(__dirname, "..") },
    },
    event => {
        events.push(event);
        if (event.type === "stm32Status" && ["ready", "stopped", "error"].includes(event.state)) {
            terminalResolve(event);
        }
    },
);

(async () => {
    try {
        await runtime.start({
            targetId: "integration",
            targetPath: target,
            appId: path.basename(fap, ".fap"),
            category: "Misc",
            fapPath: fap,
        });
        const result = await Promise.race([
            terminal,
            new Promise((_, reject) => setTimeout(() => reject(new Error("STM32 integration timeout")), 30_000)),
        ]);
        assert.notEqual(result.state, "error", result.text);
        assert(events.some(event => event.type === "stm32Status" && event.state === "running"));
        const preparationProgress = events
            .filter(event => event.type === "stm32Status" && event.state === "starting")
            .map(event => event.progress)
            .filter(progress => Number.isFinite(progress));
        assert.ok(preparationProgress.length >= 5, "firmware preparation should report progress milestones");
        assert.ok(
            preparationProgress.every(
                (progress, index) => index === 0 || progress >= preparationProgress[index - 1],
            ),
            "firmware preparation progress must be monotonic",
        );
        assert.equal(preparationProgress.at(-1), 96);
        assert(events.some(
            event => event.type === "stm32Status" && event.state === "running" && event.progress === 100,
        ));
        if (maxInstructions >= 20_000_000) {
            assert(events.some(event => event.type === "stm32Frame" && event.hex.length === 2048));
        }
        assert(fs.existsSync(path.join(globalStorage, "stm32-runtime", "integration")));
        assert(fs.existsSync(path.join(runtime.storagePath, "ext", "apps", "Misc", path.basename(fap))));
        console.log(`stm32 integration test passed: ${result.text}`);
    } finally {
        runtime.stop(false);
        fs.rmSync(globalStorage, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
