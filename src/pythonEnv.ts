/**
 * Private Python virtual environment for uFBT.
 *
 * Flipper FAP Studio only needs Python to install and run uFBT. Instead of
 * relying on `python` / `pip` / `ufbt` being on the system PATH, the extension
 * creates a venv of its own and runs everything from there by absolute path.
 *
 * This module is deliberately free of any `vscode` import so it can be unit
 * tested with plain Node (see tests/pythonEnv.test.js). The VS Code glue lives
 * in pythonConfig.ts and ufbtInstaller.ts.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface PythonEnvOptions {
    /** false = legacy behaviour: use whatever `python` / `pip` / `ufbt` is on PATH. */
    useVenv: boolean;
    /** Absolute folder of the extension-managed virtual environment. */
    venvDir: string;
    /** Optional interpreter used to *create* the venv. Empty = auto-detect. */
    pythonPath: string;
}

export interface PythonInterpreter {
    command: string;
    /** Extra leading args, e.g. ['-3'] for the Windows `py` launcher. */
    args: string[];
    /** "3.12" */
    version: string;
    /** Resolved sys.executable, for display. */
    executable: string;
}

export interface FindPythonResult {
    interpreter?: PythonInterpreter;
    error?: string;
}

export interface UfbtLaunch {
    command: string;
    shell: boolean;
    env: NodeJS.ProcessEnv;
    source: 'venv' | 'path';
}

export interface SetupResult {
    ok: boolean;
    error?: string;
    /** True when the failure is "no usable Python found" so the UI can offer to pick one. */
    needsPython?: boolean;
}

export const MIN_PYTHON: [number, number] = [3, 8];

type Output = (text: string) => void;

// ── Paths ─────────────────────────────────────────────────────────────────────

function pathFor(platform: NodeJS.Platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

export function venvBinDir(venvDir: string, platform: NodeJS.Platform = process.platform): string {
    return pathFor(platform).join(venvDir, platform === 'win32' ? 'Scripts' : 'bin');
}

export function venvPythonPath(venvDir: string, platform: NodeJS.Platform = process.platform): string {
    return pathFor(platform).join(venvBinDir(venvDir, platform), platform === 'win32' ? 'python.exe' : 'python');
}

export function venvUfbtPath(venvDir: string, platform: NodeJS.Platform = process.platform): string {
    return pathFor(platform).join(venvBinDir(venvDir, platform), platform === 'win32' ? 'ufbt.exe' : 'ufbt');
}

/**
 * Environment for running anything from the venv: the same effect as
 * "activating" it, without needing Activate.ps1 (which PowerShell's execution
 * policy often blocks).
 */
export function venvEnvironment(
    venvDir: string,
    base: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    // Windows env keys are case-insensitive but a copied object is not: reuse the existing spelling.
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const sep = platform === 'win32' ? ';' : ':';
    const bin = venvBinDir(venvDir, platform);
    env[pathKey] = env[pathKey] ? `${bin}${sep}${env[pathKey]}` : bin;
    env.VIRTUAL_ENV = venvDir;
    delete env.PYTHONHOME;
    return env;
}

// ── Process helpers ───────────────────────────────────────────────────────────

function runProcess(
    command: string,
    args: string[],
    onOutput: Output,
    env?: NodeJS.ProcessEnv
): Promise<number> {
    return new Promise(resolve => {
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, args, { shell: false, windowsHide: true, env: env ?? process.env });
        } catch (err) {
            onOutput(`\n✗ ${(err as Error).message}\n`);
            resolve(-1);
            return;
        }
        proc.stdout?.on('data', (d: Buffer) => onOutput(d.toString()));
        proc.stderr?.on('data', (d: Buffer) => onOutput(d.toString()));
        proc.on('error', err => {
            onOutput(`\n✗ ${err.message}\n`);
            resolve(-1);
        });
        proc.on('close', code => resolve(code ?? -1));
    });
}

function probeScript(): string {
    return 'import sys; print(sys.executable); print(sys.version_info[0], sys.version_info[1])';
}

/** Runs `<command> [args] -c <probe>` and returns the interpreter if it works and is new enough. */
function probe(command: string, args: string[]): Promise<PythonInterpreter | null> {
    return new Promise(resolve => {
        cp.execFile(
            command,
            [...args, '-c', probeScript()],
            { encoding: 'utf8', timeout: 10000, windowsHide: true },
            (err, stdout) => {
                if (err) { resolve(null); return; }
                const lines = String(stdout).trim().split(/\r?\n/);
                const executable = (lines[0] ?? '').trim();
                const ver = /^(\d+)\s+(\d+)$/.exec((lines[1] ?? '').trim());
                if (!executable || !ver) { resolve(null); return; }
                const major = Number(ver[1]);
                const minor = Number(ver[2]);
                if (major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1])) {
                    resolve(null);
                    return;
                }
                resolve({ command, args, version: `${major}.${minor}`, executable });
            }
        );
    });
}

// ── Finding a Python to create the venv from ──────────────────────────────────

function windowsInstallCandidates(env: NodeJS.ProcessEnv): string[] {
    const roots: string[] = [];
    if (env.LOCALAPPDATA) { roots.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Python')); }
    if (env.ProgramFiles) { roots.push(env.ProgramFiles); }
    if (env['ProgramFiles(x86)']) { roots.push(env['ProgramFiles(x86)']!); }
    roots.push('C:\\');

    const found: Array<{ minor: number; exe: string }> = [];
    for (const root of roots) {
        let names: string[] = [];
        try { names = fs.readdirSync(root); } catch { continue; }
        for (const name of names) {
            const m = /^Python3(\d+)/i.exec(name);
            if (!m) { continue; }
            const exe = path.win32.join(root, name, 'python.exe');
            if (fs.existsSync(exe)) { found.push({ minor: Number(m[1]), exe }); }
        }
    }
    return found.sort((a, b) => b.minor - a.minor).map(f => f.exe);
}

export function candidateInterpreters(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env
): Array<{ command: string; args: string[] }> {
    const list: Array<{ command: string; args: string[] }> = [];
    if (platform === 'win32') {
        // The `py` launcher is installed to C:\Windows by the python.org installer, so it
        // is often reachable even when Python itself was never added to PATH.
        list.push({ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] });
        for (const exe of windowsInstallCandidates(env)) { list.push({ command: exe, args: [] }); }
    } else {
        list.push({ command: 'python3', args: [] }, { command: 'python', args: [] });
    }
    return list;
}

export async function findPython(
    configured: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env
): Promise<FindPythonResult> {
    const wanted = configured.trim();
    if (wanted) {
        const interpreter = await probe(wanted, []);
        return interpreter
            ? { interpreter }
            : {
                error: `The configured Python "${wanted}" could not be run, or is older than Python ` +
                    `${MIN_PYTHON[0]}.${MIN_PYTHON[1]}. Check the "flipperFapStudio.python.path" setting.`,
            };
    }
    for (const c of candidateInterpreters(platform, env)) {
        const interpreter = await probe(c.command, c.args);
        if (interpreter) { return { interpreter }; }
    }
    return {
        error: `No Python ${MIN_PYTHON[0]}.${MIN_PYTHON[1]}+ was found. Install Python from python.org, ` +
            'or point the "flipperFapStudio.python.path" setting at your python executable. ' +
            'It does not need to be on your PATH.',
    };
}

// ── Creating and using the venv ───────────────────────────────────────────────

/** True when the venv's own interpreter exists and actually starts. */
export function venvIsHealthy(venvDir: string, platform: NodeJS.Platform = process.platform): boolean {
    const py = venvPythonPath(venvDir, platform);
    if (!fs.existsSync(py)) { return false; }
    try {
        cp.execFileSync(py, ['-c', 'pass'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Refuses to build into a folder that already holds unrelated files. */
function checkVenvTarget(venvDir: string): string | null {
    if (!fs.existsSync(venvDir)) { return null; }
    if (fs.existsSync(path.join(venvDir, 'pyvenv.cfg'))) { return null; }
    let entries: string[] = [];
    try { entries = fs.readdirSync(venvDir); } catch { return `Cannot read ${venvDir}`; }
    return entries.length === 0
        ? null
        : `${venvDir} already exists and is not a Python virtual environment, so it was left untouched. ` +
          'Choose another folder in "flipperFapStudio.python.venvPath".';
}

export async function createVenv(
    interpreter: PythonInterpreter,
    venvDir: string,
    onOutput: Output,
    platform: NodeJS.Platform = process.platform
): Promise<boolean> {
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });
    const args = [...interpreter.args, '-m', 'venv'];
    // A venv whose base Python was moved or uninstalled cannot start; rebuild it in place.
    if (fs.existsSync(path.join(venvDir, 'pyvenv.cfg'))) { args.push('--clear'); }
    args.push(venvDir);
    const code = await runProcess(interpreter.command, args, onOutput);
    return code === 0 && fs.existsSync(venvPythonPath(venvDir, platform));
}

/** `pip install --upgrade ufbt` inside the venv (covers both first install and update). */
export async function pipInstallUfbt(
    venvDir: string,
    onOutput: Output,
    platform: NodeJS.Platform = process.platform
): Promise<boolean> {
    const code = await runProcess(
        venvPythonPath(venvDir, platform),
        ['-m', 'pip', 'install', '--upgrade', 'ufbt'],
        onOutput,
        venvEnvironment(venvDir, process.env, platform)
    );
    return code === 0 && fs.existsSync(venvUfbtPath(venvDir, platform));
}

/** Create the venv if needed, then install / update uFBT in it. */
export async function setupUfbtVenv(opts: PythonEnvOptions, onOutput: Output): Promise<SetupResult> {
    if (!venvIsHealthy(opts.venvDir)) {
        const blocked = checkVenvTarget(opts.venvDir);
        if (blocked) { return { ok: false, error: blocked }; }

        onOutput('Looking for Python…\n');
        const found = await findPython(opts.pythonPath);
        if (!found.interpreter) { return { ok: false, needsPython: true, error: found.error }; }
        const py = found.interpreter;
        onOutput(`Using Python ${py.version} (${py.executable})\n`);

        onOutput(`\nCreating virtual environment in ${opts.venvDir}\n`);
        if (!(await createVenv(py, opts.venvDir, onOutput))) {
            return {
                ok: false,
                error: 'Could not create the virtual environment. See the output above. ' +
                    'On Debian/Ubuntu you may need: sudo apt install python3-venv',
            };
        }
    }

    onOutput('\nInstalling uFBT…\n');
    if (!(await pipInstallUfbt(opts.venvDir, onOutput))) {
        return { ok: false, error: 'pip could not install uFBT. See the output above (check your internet connection).' };
    }
    return { ok: true };
}

// ── Using it ──────────────────────────────────────────────────────────────────

/**
 * How to start uFBT. Prefers the venv's own ufbt; falls back to whatever is on
 * PATH so anyone who already installed uFBT globally keeps working.
 */
export function resolveUfbt(
    opts: PythonEnvOptions,
    baseEnv: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): UfbtLaunch {
    if (opts.useVenv) {
        const exe = venvUfbtPath(opts.venvDir, platform);
        if (fs.existsSync(exe)) {
            return { command: exe, shell: false, env: venvEnvironment(opts.venvDir, baseEnv, platform), source: 'venv' };
        }
    }
    return { command: 'ufbt', shell: true, env: baseEnv, source: 'path' };
}

/** One log line saying which uFBT is about to run, and why. */
export function describeUfbtLaunch(
    opts: PythonEnvOptions,
    launch: UfbtLaunch,
    platform: NodeJS.Platform = process.platform
): string {
    if (launch.source === 'venv') {
        return `Using uFBT from the private Python environment: ${launch.command}`;
    }
    if (opts.useVenv) {
        return `No uFBT found in the private Python environment (looked for ${venvUfbtPath(opts.venvDir, platform)}); ` +
            'falling back to "ufbt" on your PATH. Run "Install / Update uFBT" to set it up.';
    }
    return 'Using "ufbt" from your system PATH (the private environment is turned off in settings).';
}

export function getInstalledUfbtVersion(
    opts: PythonEnvOptions,
    platform: NodeJS.Platform = process.platform
): string | null {
    const attempts: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    if (opts.useVenv && fs.existsSync(venvPythonPath(opts.venvDir, platform))) {
        attempts.push({
            command: venvPythonPath(opts.venvDir, platform),
            args: ['-m', 'pip', 'show', 'ufbt'],
            env: venvEnvironment(opts.venvDir, process.env, platform),
        });
    }
    attempts.push({ command: 'pip', args: ['show', 'ufbt'] });

    for (const a of attempts) {
        try {
            const out = cp.execFileSync(a.command, a.args, {
                encoding: 'utf8', timeout: 8000, windowsHide: true, env: a.env ?? process.env, stdio: ['ignore', 'pipe', 'ignore'],
            });
            const m = /^Version:\s*(.+)$/m.exec(out);
            if (m) { return m[1].trim(); }
        } catch { /* try next */ }
    }
    return null;
}
