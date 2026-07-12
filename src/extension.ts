import * as vscode from 'vscode';
import { MainTreeProvider } from './treeProviders';
import { registerCommands } from './commands';
import { StateManager } from './stateManager';
import { buildState } from './buildState';
import { FirmwareViewProvider } from './firmwareView';

export function activate(context: vscode.ExtensionContext) {
    const state = new StateManager(context);
    const mainProvider = new MainTreeProvider(state);

    vscode.window.registerTreeDataProvider('flipperMain', mainProvider);

    const firmwareView = new FirmwareViewProvider(state);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(FirmwareViewProvider.viewId, firmwareView)
    );

    const refresh = () => { mainProvider.refresh(); firmwareView.refresh(); };

    registerCommands(context, state, refresh);

    // ── Status bar ────────────────────────────────────────────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    statusBar.text = '$(circuit-board) Flipper FAP Studio';
    statusBar.tooltip = 'Flipper FAP Studio — click to open guide';
    statusBar.command = 'flipperFapStudio.openGuide';
    statusBar.show();
    context.subscriptions.push(statusBar);

    const unsub = buildState.onDidChange(() => {
        if (buildState.isBuilding) {
            statusBar.text = '$(sync~spin) Flipper: Building…';
            statusBar.tooltip = 'Building — click to cancel';
            statusBar.command = 'flipperFapStudio.cancelBuild';
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            statusBar.text = '$(circuit-board) Flipper FAP Studio';
            statusBar.tooltip = 'Flipper FAP Studio — click to open guide';
            statusBar.command = 'flipperFapStudio.openGuide';
            statusBar.backgroundColor = undefined;
        }
        refresh();
    });
    context.subscriptions.push(unsub);

    // ── Auto-detect workspace folder if none saved ────────────────────────────
    if (!state.getAppFolder()) {
        const ws = vscode.workspace.workspaceFolders;
        if (ws && ws.length > 0) {
            state.setAppFolder(ws[0].uri.fsPath);
            refresh();
        }
    }
}

export function deactivate() {}
