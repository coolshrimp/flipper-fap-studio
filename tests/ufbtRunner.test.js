const assert = require("assert");
const fs = require("fs");

const source = fs.readFileSync(require.resolve("../out/ufbtRunner"), "utf8");
const match = source.match(
    /function completedLaunchBeforeRpcHandoff\(log\) \{[\s\S]*?\n\}/
);
assert.ok(match, "compiled uFBT runner should export its launch-handoff predicate");
const predicate = new Function(`${match[0]}; return completedLaunchBeforeRpcHandoff;`)();

assert.strictEqual(predicate(
    "Closing current app\nLaunching app: /ext/apps/GPIO/test.fap\nUnexpected response: DEVICE: test"
), true);
assert.strictEqual(predicate("Failed to find connected Flipper"), false);
assert.strictEqual(predicate("Launching app: /ext/apps/GPIO/test.fap"), false);
console.log("uFBT launch handoff tests passed");
