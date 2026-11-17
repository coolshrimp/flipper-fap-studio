const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const py = require("../out/pythonEnv");

// ── Pure helpers ─────────────────────────────────────────────────────────────

assert.strictEqual(py.venvBinDir("C:\\v", "win32"), "C:\\v\\Scripts");
assert.strictEqual(py.venvPythonPath("C:\\v", "win32"), "C:\\v\\Scripts\\python.exe");
assert.strictEqual(py.venvUfbtPath("C:\\v", "win32"), "C:\\v\\Scripts\\ufbt.exe");
assert.strictEqual(py.venvBinDir("/v", "linux"), "/v/bin");
assert.strictEqual(py.venvPythonPath("/v", "linux"), "/v/bin/python");
assert.strictEqual(py.venvUfbtPath("/v", "darwin"), "/v/bin/ufbt");

{
    // Windows env keys are case-insensitive: the existing "Path" spelling must be reused,
    // not duplicated as "PATH" (which would shadow it with the wrong value).
    const env = py.venvEnvironment("C:\\v", { Path: "C:\\Windows", PYTHONHOME: "C:\\x" }, "win32");
    assert.strictEqual(env.Path, "C:\\v\\Scripts;C:\\Windows");
    assert.strictEqual(env.PATH, undefined);
    assert.strictEqual(env.VIRTUAL_ENV, "C:\\v");
    assert.strictEqual(env.PYTHONHOME, undefined);

    const posix = py.venvEnvironment("/v", { PATH: "/usr/bin" }, "linux");
    assert.strictEqual(posix.PATH, "/v/bin:/usr/bin");
    assert.strictEqual(py.venvEnvironment("/v", {}, "linux").PATH, "/v/bin");
}

assert.deepStrictEqual(py.candidateInterpreters("win32", {})[0], { command: "py", args: ["-3"] });
assert.strictEqual(py.candidateInterpreters("linux", {})[0].command, "python3");

// ── resolveUfbt ──────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fap-studio-pyenv-"));

async function main() {
    const venvDir = path.join(root, "venv");
    const opts = { useVenv: true, venvDir, pythonPath: "" };

    {
        const none = py.resolveUfbt(opts, { PATH: "/usr/bin" });
        assert.strictEqual(none.source, "path", "no venv yet: fall back to a global ufbt");
        assert.strictEqual(none.command, "ufbt");
        assert.strictEqual(none.shell, true);
    }

    // ── find a real interpreter (skip the rest if this machine has none) ──────
    assert.ok((await py.findPython("/definitely/not/python")).error.includes("flipperFapStudio.python.path"),
        "an invalid configured interpreter is reported, not silently replaced");
    const found = await py.findPython("");
    if (!found.interpreter) {
        console.log("python env tests passed (no Python on this machine; venv steps skipped)");
        return;
    }
    assert.ok(/^3\.\d+$/.test(found.interpreter.version));
    const configured = await py.findPython(found.interpreter.executable);
    assert.ok(configured.interpreter, "an explicit interpreter path works without being on PATH");

    // ── refuses to build into an unrelated, non-empty folder ──────────────────
    {
        const stray = path.join(root, "stray");
        fs.mkdirSync(stray);
        fs.writeFileSync(path.join(stray, "precious.txt"), "keep me");
        const r = await py.setupUfbtVenv({ useVenv: true, venvDir: stray, pythonPath: "" }, () => {});
        assert.strictEqual(r.ok, false);
        assert.ok(/not a Python virtual environment/.test(r.error));
        assert.strictEqual(fs.readFileSync(path.join(stray, "precious.txt"), "utf8"), "keep me");
    }

    // ── a local stand-in "ufbt" wheel so the install step needs no network ────
    const wheelDir = path.join(root, "wheels");
    fs.mkdirSync(wheelDir);
    const makeWheel = [
        "import sys, zipfile",
        "d = 'ufbt-0.0.1.dist-info'",
        "files = {",
        "  'ufbt/__init__.py': \"def main():\\n    print('fake-ufbt 0.0.1')\\n\",",
        "  d + '/METADATA': 'Metadata-Version: 2.1\\nName: ufbt\\nVersion: 0.0.1\\n',",
        "  d + '/WHEEL': 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',",
        "  d + '/entry_points.txt': '[console_scripts]\\nufbt = ufbt:main\\n',",
        "}",
        "files[d + '/RECORD'] = ''.join(p + ',,\\n' for p in files) + d + '/RECORD,,\\n'",
        "z = zipfile.ZipFile(sys.argv[1] + '/ufbt-0.0.1-py3-none-any.whl', 'w')",
        "[z.writestr(p, c) for p, c in files.items()]",
        "z.close()",
    ].join("\n");
    const pyi = found.interpreter;
    cp.execFileSync(pyi.command, [...pyi.args, "-c", makeWheel, wheelDir]);

    process.env.PIP_NO_INDEX = "1";
    process.env.PIP_FIND_LINKS = wheelDir;
    process.env.PIP_DISABLE_PIP_VERSION_CHECK = "1";

    // ── full setup: create venv + install uFBT ────────────────────────────────
    const log = [];
    const result = await py.setupUfbtVenv(opts, t => log.push(t));
    assert.strictEqual(result.ok, true, `setup should succeed:\n${log.join("")}${result.error || ""}`);
    assert.ok(py.venvIsHealthy(venvDir));
    assert.ok(fs.existsSync(py.venvUfbtPath(venvDir)), "venv should contain a ufbt launcher");

    // ── the launcher resolveUfbt hands out really runs, with no PATH help ─────
    const launch = py.resolveUfbt(opts, { PATH: "" });
    assert.strictEqual(launch.source, "venv");
    assert.strictEqual(launch.shell, false);
    assert.strictEqual(launch.command, py.venvUfbtPath(venvDir));
    const printed = cp.execFileSync(launch.command, ["--version"], { env: launch.env, encoding: "utf8" });
    assert.ok(printed.includes("fake-ufbt 0.0.1"));

    // ── version lookup reads the venv ─────────────────────────────────────────
    assert.strictEqual(py.getInstalledUfbtVersion(opts), "0.0.1");

    // ── opting out ignores the venv ───────────────────────────────────────────
    assert.strictEqual(py.resolveUfbt({ ...opts, useVenv: false }, {}).source, "path");

    // ── re-running (update) on a healthy venv reuses it ───────────────────────
    const cfgBefore = fs.statSync(path.join(venvDir, "pyvenv.cfg")).mtimeMs;
    const again = await py.setupUfbtVenv(opts, () => {});
    assert.strictEqual(again.ok, true);
    assert.strictEqual(fs.statSync(path.join(venvDir, "pyvenv.cfg")).mtimeMs, cfgBefore,
        "update must not recreate a working venv");

    // ── a broken venv (interpreter removed) is detected and rebuilt ───────────
    fs.rmSync(py.venvPythonPath(venvDir), { force: true });
    assert.strictEqual(py.venvIsHealthy(venvDir), false);
    const repaired = await py.setupUfbtVenv(opts, () => {});
    assert.strictEqual(repaired.ok, true, repaired.error);
    assert.ok(py.venvIsHealthy(venvDir));

    console.log("python env tests passed");
}

main()
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => fs.rmSync(root, { recursive: true, force: true }));
