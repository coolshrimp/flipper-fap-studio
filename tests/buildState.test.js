const assert = require("assert");
const {BuildState} = require("../out/buildState");

const state = new BuildState();
assert.strictEqual(state.reserve(), true, "first workflow should reserve the build slot");
assert.strictEqual(state.reserve(), false, "overlapping workflow must be rejected");
const started = state.elapsedSeconds;
state.begin({kill() {}});
assert.ok(state.elapsedSeconds >= started, "attaching a process must preserve workflow timing");
state.end();
assert.strictEqual(state.isBuilding, false);
assert.strictEqual(state.reserve(), true, "slot should reopen after completion");
state.cancel();
assert.strictEqual(state.isBuilding, false, "a reservation without a child can be cancelled");
console.log("build state tests passed");
