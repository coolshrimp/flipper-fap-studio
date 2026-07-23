const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    migrateLegacyRuntimeStorage,
    prepareRuntimeWorkspace,
} = require("../out/runtimeWorkspace");

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flipper-runtime-workspace-"));
    const buildRoot = path.join(root, "desktop-runtime", "sample_app");
    const targetRoot = path.join(root, "stm32-runtime", "target");
    const sharedStorage = path.join(targetRoot, "storage");
    try {
        await prepareRuntimeWorkspace(buildRoot, sharedStorage);
        assert.ok(fs.statSync(buildRoot).isDirectory(), "desktop compiler workspace should exist");
        assert.ok(fs.statSync(sharedStorage).isDirectory(), "shared STM32 storage should exist");
        fs.writeFileSync(path.join(buildRoot, "runtime_config.h"), "#define TEST 1\n");
        assert.ok(fs.existsSync(path.join(buildRoot, "runtime_config.h")));

        const firstLegacy = path.join(targetRoot, "sample_app", "storage");
        const secondLegacy = path.join(targetRoot, "other_app", "storage");
        fs.mkdirSync(path.join(firstLegacy, "ext", "apps_data", "sample_app"), {recursive: true});
        fs.mkdirSync(path.join(secondLegacy, "int"), {recursive: true});
        fs.writeFileSync(path.join(firstLegacy, "ext", "apps_data", "sample_app", "save.bin"), "legacy-save");
        fs.writeFileSync(path.join(secondLegacy, "int", "settings.bin"), "legacy-settings");
        fs.mkdirSync(path.join(sharedStorage, "ext", "apps_data", "sample_app"), {recursive: true});
        fs.writeFileSync(path.join(sharedStorage, "ext", "apps_data", "sample_app", "save.bin"), "new-save");

        const migration = await migrateLegacyRuntimeStorage(targetRoot, sharedStorage);
        assert.equal(migration.alreadyComplete, false);
        assert.equal(migration.sources.length, 2);
        assert.equal(migration.filesCopied, 1);
        assert.equal(migration.entriesSkipped, 1);
        assert.equal(
            fs.readFileSync(path.join(sharedStorage, "ext", "apps_data", "sample_app", "save.bin"), "utf8"),
            "new-save",
            "legacy migration must not overwrite target-wide storage",
        );
        assert.equal(fs.readFileSync(path.join(sharedStorage, "int", "settings.bin"), "utf8"), "legacy-settings");

        const repeated = await migrateLegacyRuntimeStorage(targetRoot, sharedStorage);
        assert.equal(repeated.alreadyComplete, true);
        assert.equal(repeated.filesCopied, 0);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
    console.log("runtime workspace tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
