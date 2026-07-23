const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === "vscode") return {};
    return originalLoad.call(this, request, parent, isMain);
};

const { stm32RuntimeTestHooks } = require("../out/stm32Runtime");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "flipper-stm32-test-"));

try {
    const target = Buffer.alloc(274);
    target.write("Target", 0, "ascii");
    target.writeUInt32LE(1, 270);
    const payload = Buffer.from([0x00, 0x30, 0x03, 0x20, 0x55, 0x1c, 0x01, 0x08]);
    const element = Buffer.alloc(8);
    element.writeUInt32LE(0x08000000, 0);
    element.writeUInt32LE(payload.length, 4);
    const prefix = Buffer.alloc(11);
    prefix.write("DfuSe", 0, "ascii");
    prefix[5] = 1;
    prefix.writeUInt32LE(target.length + element.length + payload.length, 6);
    prefix[10] = 1;
    const dfu = path.join(root, "firmware.dfu");
    fs.writeFileSync(dfu, Buffer.concat([prefix, target, element, payload]));

    const extracted = stm32RuntimeTestHooks.extractDfuSe(dfu);
    assert.equal(extracted.baseAddress, 0x08000000);
    assert.deepEqual(extracted.data, payload);

    const scripts = path.join(root, "scripts", "debug");
    fs.mkdirSync(scripts, { recursive: true });
    const svd = path.join(scripts, "STM32WB55_CM4.svd");
    fs.writeFileSync(svd, "<device/>");
    assert.equal(stm32RuntimeTestHooks.findStm32Svd(root), svd);
    assert.equal(stm32RuntimeTestHooks.findFirmwareImage(root).kind, "dfu");

    assert.deepEqual(
        stm32RuntimeTestHooks.parseStm32Audio("INFO FLIPPER_AUDIO START frequency=440.250 volume=0.5000"),
        { type: "stm32Audio", playing: true, frequency: 440.25, volume: 0.5 },
    );
    assert.deepEqual(
        stm32RuntimeTestHooks.parseStm32Audio("INFO FLIPPER_AUDIO STOP"),
        { type: "stm32Audio", playing: false, frequency: 0, volume: 0 },
    );

    const profile = stm32RuntimeTestHooks.createFlipperProfile();
    assert.match(profile, /FLASH_ALIAS/);
    assert.match(profile, /FACTORY_OTP/);
    assert.match(profile, /STM32WB55_CM4\.svd/);
    assert.match(profile, /sd_card:/);
    assert.match(profile, /peripheral: SPI2/);
    assert.match(profile, /file: "sd-card\.img"/);
    assert.match(profile, /chip_select: PC12/);
    assert.match(profile, /card_detect: PC10/);

    const image = path.join(root, "sd-card.img");
    const syncState = path.join(root, "sd-card.sync.json");
    fs.writeFileSync(image, Buffer.alloc(512));
    stm32RuntimeTestHooks.markSdImageSynchronized(image, syncState);
    assert.equal(stm32RuntimeTestHooks.isSdImageSynchronized(image, syncState), true);
    fs.appendFileSync(image, Buffer.alloc(512));
    assert.equal(stm32RuntimeTestHooks.isSdImageSynchronized(image, syncState), false);
    console.log("stm32 runtime tests passed");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
