import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface RunResult {
    ok: boolean;
    log: string;
}

export function completedLaunchBeforeRpcHandoff(log: string): boolean {
    return /Launching app:\s*\/ext\/apps\//i.test(log) &&
        /Unexpected response:\s*\S+/i.test(log);
}

export async function runUfbt(
    appFolder: string,
    args: string[],
    outputChannel: vscode.OutputChannel,
    onSpawn?: (proc: cp.ChildProcess) => void
): Promise<RunResult> {
    return new Promise(resolve => {
        outputChannel.show(true);
        outputChannel.appendLine(`\n▶ ufbt ${args.join(' ')}`);
        outputChannel.appendLine(`  Folder: ${appFolder}\n`);

        let log = '';
        const collect = (d: Buffer) => { log += d.toString(); };

        const proc = cp.spawn('ufbt', args, {
            cwd: appFolder,
            shell: true,
            env: process.env,
        });

        onSpawn?.(proc);

        proc.stdout.on('data', (d: Buffer) => { collect(d); outputChannel.append(d.toString()); });
        proc.stderr.on('data', (d: Buffer) => { collect(d); outputChannel.append(d.toString()); });

        proc.on('close', code => {
            const rpcHandoff = args.includes('launch') && completedLaunchBeforeRpcHandoff(log);
            if (code === 0 || rpcHandoff) {
                if (rpcHandoff) {
                    outputChannel.appendLine(
                        '\nApp launched; its custom serial protocol took over before uFBT closed RPC.'
                    );
                }
                outputChannel.appendLine('\n✓ Done.');
                resolve({ ok: true, log });
            } else {
                outputChannel.appendLine(`\n✗ Exited with code ${code}`);
                resolve({ ok: false, log });
            }
        });

        proc.on('error', err => {
            const msg = `Failed to start ufbt: ${err.message}\nMake sure uFBT is installed: pip install ufbt`;
            outputChannel.appendLine(`\n✗ ${msg}`);
            resolve({ ok: false, log: log + '\n' + msg });
        });
    });
}

export function findSensitiveFiles(folder: string): string[] {
    const found: string[] = [];
    try {
        const entries = fs.readdirSync(folder);
        for (const entry of entries) {
            const lower = entry.toLowerCase();
            if (lower === '.env' || lower.endsWith('.pem') || lower.endsWith('.pfx') ||
                ['config.json', 'settings.json', 'tokens.json', 'credentials.json'].includes(lower)) {
                found.push(path.join(folder, entry));
            }
        }
    } catch { /* ignore */ }
    return found;
}

export async function buildWithTarget(
    appFolder: string,
    targetPath: string,
    outputChannel: vscode.OutputChannel,
    onSpawn?: (proc: cp.ChildProcess) => void
): Promise<RunResult> {
    if (targetPath) {
        const env = { ...process.env, UFBT_SDK_PATH: targetPath };
        return new Promise(resolve => {
            outputChannel.show(true);
            outputChannel.appendLine(`\n▶ ufbt (SDK: ${targetPath})`);
            outputChannel.appendLine(`  Folder: ${appFolder}\n`);

            let log = '';
            const collect = (d: Buffer) => { log += d.toString(); };

            const proc = cp.spawn('ufbt', [], {
                cwd: appFolder,
                shell: true,
                env,
            });

            onSpawn?.(proc);

            proc.stdout.on('data', (d: Buffer) => { collect(d); outputChannel.append(d.toString()); });
            proc.stderr.on('data', (d: Buffer) => { collect(d); outputChannel.append(d.toString()); });

            proc.on('close', code => resolve({ ok: code === 0, log }));

            proc.on('error', err => {
                outputChannel.appendLine(`\n✗ ${err.message}`);
                resolve({ ok: false, log: log + '\n' + err.message });
            });
        });
    }
    return runUfbt(appFolder, [], outputChannel, onSpawn);
}
