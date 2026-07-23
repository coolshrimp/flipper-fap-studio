const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    reconcileStorageVolumes,
    storageVolumesShareFilesystem,
} = require("../out/storageVolumes");

const ext = { totalSpace: 128_000_000_000, freeSpace: 120_000_000_000 };
const duplicateInt = { totalSpace: 128_000_000_000, freeSpace: 120_000_000_000 };
assert.strictEqual(storageVolumesShareFilesystem(ext, duplicateInt), true);
assert.deepStrictEqual(
    reconcileStorageVolumes(ext, duplicateInt, { bytes: 4096, complete: true }).int,
    {
        ...duplicateInt,
        sharedWithExt: true,
        contentBytes: 4096,
        contentComplete: true,
    },
);

const realInt = { totalSpace: 1_048_576, freeSpace: 524_288 };
assert.strictEqual(storageVolumesShareFilesystem(ext, realInt), false);
assert.deepStrictEqual(reconcileStorageVolumes(ext, realInt).int, realInt);
assert.strictEqual(storageVolumesShareFilesystem(ext, null), false);

const dashboardSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboardPanel.ts"), "utf8");
assert.match(dashboardSource, /info\.sharedWithExt/);
assert.match(dashboardSource, /shares SD/);
assert.match(dashboardSource, /virtual directory/);

console.log("storage volume tests passed");
