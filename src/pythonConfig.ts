import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { PythonEnvOptions } from './pythonEnv';

let storageRoot = '';

/** Call once from activate() so the venv lives in the extension's own storage folder. */
export function initPythonConfig(context: vscode.ExtensionContext): void {
    storageRoot = context.globalStorageUri.fsPath;
}

export function getPythonEnvOptions(): PythonEnvOptions {
    const cfg = vscode.workspace.getConfiguration('flipperFapStudio');
    const customVenv = (cfg.get<string>('python.venvPath') ?? '').trim();
    const defaultRoot = storageRoot || path.join(os.homedir(), '.flipper-fap-studio');
    return {
        useVenv: cfg.get<boolean>('python.useVenv', true),
        venvDir: customVenv || path.join(defaultRoot, 'venv'),
        pythonPath: (cfg.get<string>('python.path') ?? '').trim(),
    };
}
