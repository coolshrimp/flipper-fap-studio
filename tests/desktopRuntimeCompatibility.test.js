const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const repo = path.resolve(__dirname, "..");
const fixture = path.join(__dirname, "fixtures", "runtime_compat");
const build = path.join(repo, ".runtime-test", "runtime-compat-test");
const { generateDesktopAssetHeaders, decodePbmAsset, decodePngAsset } = require("../out/desktopAssets");

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const name = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
}

function makeOneBitPng() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 1;
    header[9] = 0;
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 0xaa]))),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function findCompiler() {
    const candidates = [
        process.env.FLIPPER_GCC,
        path.join(os.homedir(), ".pico-sdk", "mingw64", "bin", "gcc.exe"),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    const found = childProcess.spawnSync(process.platform === "win32" ? "where.exe" : "which", ["gcc"], {
        encoding: "utf8",
    });
    return found.status === 0 ? found.stdout.split(/\r?\n/).find(Boolean) : undefined;
}

function waitFor(output, pattern, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
            if (pattern.test(output.text)) return resolve();
            if (Date.now() - started > timeout) {
                return reject(new Error(`Timed out waiting for ${pattern}.\nRuntime output:\n${output.text}`));
            }
            setTimeout(poll, 20);
        };
        poll();
    });
}

async function main() {
    const pbm = decodePbmAsset(fs.readFileSync(path.join(fixture, "images", "test_8x8.pbm")));
    assert.deepStrictEqual([pbm.width, pbm.height, pbm.bytes.length], [8, 8, 8]);
    assert.strictEqual(pbm.bytes[0], 0x81, "PBM pixels should be packed in Flipper XBM order");
    const png = decodePngAsset(makeOneBitPng());
    assert.deepStrictEqual([png.width, png.height, png.bytes.length], [8, 1, 1]);
    assert.strictEqual(png.bytes[0], 0xaa, "1-bit PNG pixels should be packed in Flipper XBM order");

    const gcc = findCompiler();
    if (!gcc) {
        console.log("desktopRuntimeCompatibility tests skipped (GCC not found)");
        return;
    }

    fs.rmSync(build, { recursive: true, force: true });
    fs.mkdirSync(build, { recursive: true });
    const source = path.join(fixture, "runtime_compat.c");
    const generated = await generateDesktopAssetHeaders(fixture, build, [source]);
    assert.strictEqual(generated.headerCount, 1);
    assert.deepStrictEqual(generated.warnings, []);
    const generatedHeader = fs.readFileSync(path.join(build, "runtime_compat_icons.h"), "utf8");
    assert.match(generatedHeader, /I_test_8x8 = \{8,8,1,/);

    const config = path.join(build, "runtime_config.h");
    fs.writeFileSync(
        config,
        '#define FLIPPER_RUNTIME_ENTRY runtime_compat_main\n#define FLIPPER_RUNTIME_APP_ID "runtime_compat"\n',
    );
    const executable = path.join(build, "runtime_compat.exe");
    const runtime = path.join(repo, "runtime");
    const args = [
        "-std=gnu11",
        "-O0",
        "-g",
        "-Wall",
        "-Werror=implicit-function-declaration",
        "-include",
        config,
        `-I${path.join(runtime, "include")}`,
        `-I${build}`,
        `-I${fixture}`,
        source,
        path.join(runtime, "host_runtime.c"),
        path.join(runtime, "host_events.c"),
        path.join(runtime, "host_gui.c"),
        path.join(runtime, "host_main.c"),
        "-lm",
        "-o",
        executable,
    ];
    const compile = childProcess.spawnSync(gcc, args, { cwd: fixture, encoding: "utf8", timeout: 120000 });
    assert.strictEqual(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);

    const runtimeOutput = { text: "" };
    const processHandle = childProcess.spawn(executable, [], {
        cwd: fixture,
        windowsHide: true,
        env: { ...process.env, FLIPPER_RUNTIME_STORAGE: path.join(build, "storage") },
    });
    processHandle.stdout.setEncoding("utf8");
    processHandle.stderr.setEncoding("utf8");
    processHandle.stdout.on("data", chunk => (runtimeOutput.text += chunk));
    processHandle.stderr.on("data", chunk => (runtimeOutput.text += chunk));
    const exitPromise = new Promise(resolve => processHandle.once("exit", resolve));

    try {
        await waitFor(runtimeOutput, /Runtime APIs/);
        processHandle.stdin.write("INPUT down short\n");
        processHandle.stdin.write("INPUT ok short\n");
        await waitFor(runtimeOutput, /Speed/);
        processHandle.stdin.write("INPUT right short\n");
        await waitFor(runtimeOutput, /Fast/);
        processHandle.stdin.write("INPUT ok short\n");
        await waitFor(runtimeOutput, /Runtime OK/);
        assert.match(runtimeOutput.text, /"op":"xbmData"/, "generated icon should render as an XBM command");
        assert.match(
            runtimeOutput.text,
            /"type":"audio","playing":true,"frequency":440\.000,"volume":0\.2500/,
            "speaker start should be forwarded as structured audio",
        );
        assert.match(
            runtimeOutput.text,
            /"type":"audio","playing":false,"frequency":0\.000,"volume":0\.0000/,
            "speaker stop should be forwarded",
        );
        assert.match(runtimeOutput.text, /"durationMs":120/, "success notification should emit a short tone");
        assert.match(runtimeOutput.text, /"durationMs":180/, "error notification should emit a short tone");
        processHandle.stdin.write("INPUT ok short\n");
        await waitFor(runtimeOutput, /"state":"exited"/);
        const exitCode = await exitPromise;
        assert.strictEqual(exitCode, 0, runtimeOutput.text);
    } finally {
        if (processHandle.exitCode === null) processHandle.kill();
    }

    console.log("desktopRuntimeCompatibility tests passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
