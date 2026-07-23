const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildFat16Image, mergeFat16Image } = require("../out/fat16Image");

function decodeLfn(entries, shortName) {
    if(entries.length === 0) return undefined;
    const checksum = [...shortName].reduce(
        (sum, byte) => ((((sum & 1) << 7) | (sum >> 1)) + byte) & 0xff,
        0,
    );
    const count = entries[0][0] & 0x1f;
    if((entries[0][0] & 0x40) === 0 || entries.length !== count) return undefined;
    const chunks = [];
    const positions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
    for(let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const sequence = entry[0] & 0x1f;
        if(sequence !== count - index || entry[13] !== checksum) return undefined;
        chunks[sequence - 1] = positions.map(position => entry.readUInt16LE(position));
    }
    const units = chunks.flat();
    const end = units.indexOf(0);
    return String.fromCharCode(...units.slice(0, end >= 0 ? end : units.length).filter(unit => unit !== 0xffff));
}

function readFat16(imagePath) {
    const image = fs.readFileSync(imagePath);
    assert.equal(image.readUInt16LE(11), 512);
    assert.equal(image[510], 0x55);
    assert.equal(image[511], 0xaa);
    assert.equal(image.toString("ascii", 54, 62), "FAT16   ");
    const bytesPerSector = image.readUInt16LE(11);
    const sectorsPerCluster = image[13];
    const reserved = image.readUInt16LE(14);
    const fatCount = image[16];
    const rootEntries = image.readUInt16LE(17);
    const sectorsPerFat = image.readUInt16LE(22);
    const totalSectors = image.readUInt16LE(19) || image.readUInt32LE(32);
    const rootSectors = Math.ceil(rootEntries * 32 / bytesPerSector);
    const rootSector = reserved + fatCount * sectorsPerFat;
    const dataSector = rootSector + rootSectors;
    const fatOffset = reserved * bytesPerSector;
    const fatBytes = sectorsPerFat * bytesPerSector;
    assert.deepEqual(
        image.subarray(fatOffset, fatOffset + fatBytes),
        image.subarray(fatOffset + fatBytes, fatOffset + fatBytes * 2),
    );
    assert.equal(totalSectors * bytesPerSector, image.length);
    assert.equal(totalSectors % 1024, 0);

    function readChain(firstCluster, length) {
        if(firstCluster === 0) return Buffer.alloc(0);
        const parts = [];
        const seen = new Set();
        let cluster = firstCluster;
        while(cluster < 0xfff8) {
            assert.ok(cluster >= 2);
            assert.ok(!seen.has(cluster), "FAT chain loop");
            seen.add(cluster);
            const offset = (dataSector + (cluster - 2) * sectorsPerCluster) * bytesPerSector;
            parts.push(image.subarray(offset, offset + sectorsPerCluster * bytesPerSector));
            cluster = image.readUInt16LE(fatOffset + cluster * 2);
        }
        const result = Buffer.concat(parts);
        return length === undefined ? result : result.subarray(0, length);
    }

    function shortName(entry) {
        const base = entry.toString("ascii", 0, 8).trimEnd();
        const extension = entry.toString("ascii", 8, 11).trimEnd();
        return extension ? `${base}.${extension}` : base;
    }

    function parseDirectory(buffer, directoryCluster = 0) {
        const result = new Map();
        let longEntries = [];
        for(let offset = 0; offset + 32 <= buffer.length; offset += 32) {
            const entry = buffer.subarray(offset, offset + 32);
            if(entry[0] === 0) break;
            if(entry[0] === 0xe5) {
                longEntries = [];
                continue;
            }
            const attributes = entry[11];
            if(attributes === 0x0f) {
                longEntries.push(Buffer.from(entry));
                continue;
            }
            if(attributes & 0x08) {
                longEntries = [];
                continue;
            }
            const rawShort = entry.subarray(0, 11);
            const name = decodeLfn(longEntries, rawShort) || shortName(entry);
            longEntries = [];
            const cluster = entry.readUInt16LE(26);
            const size = entry.readUInt32LE(28);
            if(name === ".") {
                assert.equal(cluster, directoryCluster);
            } else if(name === "..") {
                // Checked structurally by successful traversal.
            } else if(attributes & 0x10) {
                result.set(name, parseDirectory(readChain(cluster), cluster));
            } else {
                result.set(name, Buffer.from(readChain(cluster, size)));
            }
        }
        return result;
    }

    const rootOffset = rootSector * bytesPerSector;
    return {
        image,
        root: parseDirectory(image.subarray(rootOffset, rootOffset + rootEntries * 32)),
        sectorsPerCluster,
    };
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flipper-fat16-test-"));
try {
    const source = path.join(temporaryRoot, "source");
    const apps = path.join(source, "apps", "Tools");
    const data = path.join(source, "apps_data", "postcode reader");
    const empty = path.join(source, "empty folder");
    fs.mkdirSync(apps, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(source, "Manifest"), "Filetype: Flipper Resource Manifest\n");
    const fapBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 255]);
    fs.writeFileSync(path.join(apps, "Xbox Postcode Reader.fap"), fapBytes);
    fs.writeFileSync(path.join(data, "Mömentum 🎮.txt"), Buffer.from("exact UTF-8 payload", "utf8"));
    fs.writeFileSync(path.join(source, "zero.bin"), Buffer.alloc(0));
    fs.writeFileSync(path.join(source, "collision long one.txt"), "one");
    fs.writeFileSync(path.join(source, "collision long two.txt"), "two");

    const firstImage = path.join(temporaryRoot, "first.img");
    const metadata = buildFat16Image(source, firstImage, {
        minimumImageBytes: 8 * 1024 * 1024,
        maximumImageBytes: 32 * 1024 * 1024,
        reserveFreeBytes: 1024 * 1024,
    });
    assert.equal(metadata.imageBytes, 8 * 1024 * 1024);
    assert.equal(metadata.imageBytes % (512 * 1024), 0);
    assert.equal(metadata.fileCount, 6);
    assert.equal(metadata.directoryCount, 5);
    assert.match(metadata.contentFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(metadata.freeBytes >= 1024 * 1024);

    const parsed = readFat16(firstImage);
    assert.deepEqual(parsed.root.get("Manifest"), Buffer.from("Filetype: Flipper Resource Manifest\n"));
    assert.deepEqual(parsed.root.get("zero.bin"), Buffer.alloc(0));
    assert.deepEqual(parsed.root.get("apps").get("Tools").get("Xbox Postcode Reader.fap"), fapBytes);
    assert.deepEqual(
        parsed.root.get("apps_data").get("postcode reader").get("Mömentum 🎮.txt"),
        Buffer.from("exact UTF-8 payload", "utf8"),
    );
    assert.ok(parsed.root.get("empty folder") instanceof Map);
    assert.equal(parsed.root.get("collision long one.txt").toString(), "one");
    assert.equal(parsed.root.get("collision long two.txt").toString(), "two");

    const unchangedMetadata = buildFat16Image(source, firstImage, {
        minimumImageBytes: 8 * 1024 * 1024,
        maximumImageBytes: 32 * 1024 * 1024,
        reserveFreeBytes: 1024 * 1024,
    });
    assert.equal(unchangedMetadata.reusedExisting, true);

    const restored = path.join(temporaryRoot, "restored");
    const mergeMetadata = mergeFat16Image(firstImage, restored);
    assert.equal(mergeMetadata.fileCount, metadata.fileCount);
    assert.equal(mergeMetadata.directoryCount, metadata.directoryCount);
    assert.equal(mergeMetadata.contentFingerprint, metadata.contentFingerprint);
    assert.deepEqual(
        fs.readFileSync(path.join(restored, "apps", "Tools", "Xbox Postcode Reader.fap")),
        fapBytes,
    );

    const secondImage = path.join(temporaryRoot, "second.img");
    const secondMetadata = buildFat16Image(source, secondImage, {
        minimumImageBytes: 8 * 1024 * 1024,
        maximumImageBytes: 32 * 1024 * 1024,
        reserveFreeBytes: 1024 * 1024,
    });
    assert.equal(secondMetadata.contentFingerprint, metadata.contentFingerprint);
    assert.deepEqual(fs.readFileSync(secondImage), fs.readFileSync(firstImage));

    // Model a raw-firmware save: import the image into host storage, stage a
    // changed managed file, and rebuild without losing the save.
    const rawSource = path.join(temporaryRoot, "raw-source");
    fs.cpSync(source, rawSource, { recursive: true });
    fs.mkdirSync(path.join(rawSource, "apps_data", "demo"), { recursive: true });
    const savedBytes = Buffer.from([9, 8, 7, 6, 5]);
    fs.writeFileSync(path.join(rawSource, "apps_data", "demo", "save.bin"), savedBytes);
    const rawImage = path.join(temporaryRoot, "raw.img");
    buildFat16Image(rawSource, rawImage, {
        minimumImageBytes: 8 * 1024 * 1024,
        maximumImageBytes: 32 * 1024 * 1024,
        reserveFreeBytes: 1024 * 1024,
    });
    mergeFat16Image(rawImage, source);
    fs.writeFileSync(path.join(source, "Manifest"), "new managed manifest\n");
    buildFat16Image(source, rawImage, {
        minimumImageBytes: 8 * 1024 * 1024,
        maximumImageBytes: 32 * 1024 * 1024,
        reserveFreeBytes: 1024 * 1024,
    });
    const persisted = readFat16(rawImage).root;
    assert.deepEqual(persisted.get("apps_data").get("demo").get("save.bin"), savedBytes);
    assert.equal(persisted.get("Manifest").toString(), "new managed manifest\n");

    assert.throws(
        () => buildFat16Image(source, path.join(source, "bad.img")),
        /outside the source directory/,
    );

    console.log("FAT16 image tests passed");
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
