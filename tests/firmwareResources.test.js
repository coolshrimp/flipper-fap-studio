const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
    decodeHeatshrinkStream,
    findFirmwareResourcePackage,
    parseFirmwareResourceArchive,
    stageFirmwareResources,
} = require("../out/firmwareResources");

function tarHeader(name, data, type = "0") {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const value of header) checksum += value;
    const encodedChecksum = checksum.toString(8).padStart(6, "0");
    header.write(encodedChecksum, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

function writeOctal(buffer, offset, length, value) {
    const encoded = value.toString(8).padStart(length - 1, "0");
    buffer.write(encoded, offset, length - 1, "ascii");
    buffer[offset + length - 1] = 0;
}

function makeTar(entries) {
    const chunks = [];
    for (const entry of entries) {
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
        chunks.push(tarHeader(entry.name, data, entry.type || "0"));
        chunks.push(data);
        const padding = (512 - (data.length % 512)) % 512;
        if (padding) chunks.push(Buffer.alloc(padding));
    }
    chunks.push(Buffer.alloc(1024));
    return Buffer.concat(chunks);
}

function literalHeatshrink(data, windowBits = 13, lookaheadBits = 6) {
    const bits = [];
    for (const value of data) {
        bits.push(1);
        for (let bit = 7; bit >= 0; bit--) bits.push((value >> bit) & 1);
    }
    const compressed = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((value, index) => {
        compressed[index >> 3] |= value << (7 - (index & 7));
    });
    return Buffer.concat([
        Buffer.from([0x48, 0x53, 0x44, 0x53, 1, windowBits, lookaheadBits]),
        compressed,
    ]);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flipper-resources-test-"));

(async () => {
    try {
        const updateDirectory = path.join(root, "f7-update-test");
        fs.mkdirSync(updateDirectory, { recursive: true });
        fs.writeFileSync(path.join(root, "full.bin"), Buffer.from([1, 2, 3]));
        fs.writeFileSync(
            path.join(root, "components.json"),
            JSON.stringify({
                components: {
                    "full.bin": "full.bin",
                    "update.dir": "f7-update-test",
                },
            }),
        );
        fs.writeFileSync(
            path.join(updateDirectory, "update.fuf"),
            [
                "Filetype: Flipper firmware upgrade configuration",
                "Version: 2",
                "Info: test-001",
                "Resources: resources.tar.gz",
            ].join("\n"),
        );

        const archivePath = path.join(updateDirectory, "resources.tar.gz");
        const firstTar = makeTar([
            { name: "apps/", type: "5" },
            { name: "apps/Tools/", type: "5" },
            { name: "apps/Tools/base.fap", data: "firmware-copy" },
            { name: "apps_data/old/config.txt", data: "old-config" },
        ]);
        fs.writeFileSync(archivePath, zlib.gzipSync(firstTar));

        const resourcePackage = findFirmwareResourcePackage(root, path.join(root, "full.bin"));
        assert(resourcePackage);
        assert.equal(resourcePackage.archivePath, archivePath);
        assert.equal(resourcePackage.version, "test-001");

        const storageRoot = path.join(root, "storage");
        const unrelated = path.join(storageRoot, "ext", "user", "keep.txt");
        fs.mkdirSync(path.dirname(unrelated), { recursive: true });
        fs.writeFileSync(unrelated, "keep-me");

        const firstProgress = [];
        const first = await stageFirmwareResources(
            resourcePackage,
            storageRoot,
            progress => firstProgress.push(progress),
        );
        assert.equal(first.changed, true);
        assert.equal(first.fileCount, 2);
        assert.equal(firstProgress[0], 0.03);
        assert.equal(firstProgress.at(-1), 1);
        assert.ok(
            firstProgress.every((progress, index) => index === 0 || progress >= firstProgress[index - 1]),
            "resource progress must be monotonic",
        );
        assert.ok(firstProgress.some(progress => progress > 0.3 && progress < 1));
        assert.equal(
            fs.readFileSync(path.join(storageRoot, "ext", "apps", "Tools", "base.fap"), "utf8"),
            "firmware-copy",
        );

        const secondTar = makeTar([
            { name: "apps/Tools/base.fap", data: "updated-copy" },
            { name: "apps/Tools/extra.fap", data: "extra" },
        ]);
        fs.writeFileSync(archivePath, zlib.gzipSync(secondTar));
        const second = await stageFirmwareResources(resourcePackage, storageRoot);
        assert.equal(second.changed, true);
        assert.equal(
            fs.readFileSync(path.join(storageRoot, "ext", "apps", "Tools", "base.fap"), "utf8"),
            "updated-copy",
        );
        assert.equal(fs.existsSync(path.join(storageRoot, "ext", "apps_data", "old", "config.txt")), false);
        assert.equal(fs.readFileSync(unrelated, "utf8"), "keep-me");

        const reused = await stageFirmwareResources(resourcePackage, storageRoot);
        assert.equal(reused.changed, false);
        assert.equal(reused.fileCount, 2);

        const heatshrinkTar = makeTar([{ name: "Manifest", data: "hello" }]);
        const heatshrink = literalHeatshrink(heatshrinkTar);
        assert.deepEqual(decodeHeatshrinkStream(heatshrink), heatshrinkTar);
        const parsedHeatshrink = parseFirmwareResourceArchive(heatshrink, "resources.ths");
        assert.equal(parsedHeatshrink.files[0].relativePath, "Manifest");
        assert.equal(parsedHeatshrink.files[0].data.toString("utf8"), "hello");

        const traversal = makeTar([{ name: "../outside.txt", data: "bad" }]);
        assert.throws(
            () => parseFirmwareResourceArchive(traversal, "resources.tar"),
            /Unsafe firmware resource path/,
        );
        const linked = makeTar([{ name: "linked", type: "2", data: "" }]);
        assert.throws(
            () => parseFirmwareResourceArchive(linked, "resources.tar"),
            /Unsupported firmware resource tar entry type/,
        );

        console.log("firmware resource tests passed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
