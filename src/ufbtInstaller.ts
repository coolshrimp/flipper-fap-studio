import * as vscode from 'vscode';
import { getInstalledUfbtVersion, setupUfbtVenv } from './pythonEnv';
import { getPythonEnvOptions } from './pythonConfig';

/**
 * Install or update uFBT.
 *
 * Default: build a private virtual environment (using any Python the extension
 * can find, PATH or not) and install uFBT into it. Resolves true once uFBT is
 * ready. With `flipperFapStudio.python.useVenv` off it falls back to the old
 * behaviour of typing pip commands into a terminal (resolves true without
 * knowing the outcome).
 */
export async function installOrUpdateUfbt(out: vscode.OutputChannel): Promise<boolean> {
    const first = getPythonEnvOptions();

    if (!first.useVenv) {
        const alreadyInstalled = getInstalledUfbtVersion(first) !== null;
        const terminal = vscode.window.createTerminal(alreadyInstalled ? 'uFBT Update' : 'uFBT Install');
        terminal.show();
        terminal.sendText(alreadyInstalled ? 'python -m pip install --upgrade ufbt' : 'pip install ufbt');
        return true;
    }

    out.show(true);
    out.appendLine('\n▶ Install / Update uFBT (private Python virtual environment)');

    for (let attempt = 0; attempt < 2; attempt++) {
        const opts = getPythonEnvOptions();
        out.appendLine(`  Environment: ${opts.venvDir}\n`);

        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Flipper FAP Studio: setting up uFBT…' },
            () => setupUfbtVenv(opts, text => out.append(text))
        );

        if (result.ok) {
            out.appendLine('\n✓ uFBT is ready.');
            void vscode.window.showInformationMessage(
                'uFBT is installed in its own Python environment. Python does not need to be on your PATH.'
            );
            return true;
        }

        out.appendLine(`\n✗ ${result.error}`);

        if (result.needsPython && attempt === 0) {
            const choice = await vscode.window.showErrorMessage(
                result.error ?? 'No Python found.', 'Choose Python…', 'Download Python'
            );
            if (choice === 'Download Python') {
                void vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
                return false;
            }
            if (choice === 'Choose Python…') {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    title: 'Select your Python executable (python.exe)',
                    openLabel: 'Use this Python',
                    filters: process.platform === 'win32' ? { Python: ['exe'] } : undefined,
                });
                if (!picked || picked.length === 0) { return false; }
                await vscode.workspace.getConfiguration('flipperFapStudio')
                    .update('python.path', picked[0].fsPath, vscode.ConfigurationTarget.Global);
                continue;
            }
            return false;
        }

        const action = await vscode.window.showErrorMessage(`uFBT setup failed: ${result.error}`, 'Show Output');
        if (action === 'Show Output') { out.show(true); }
        return false;
    }
    return false;
}
