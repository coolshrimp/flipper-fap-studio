import * as vscode from 'vscode';
import { MainTreeProvider, RecentProjectsProvider } from './treeProviders';
import { registerCommands } from './commands';
import { StateManager } from './stateManager';
import { buildState } from './buildState';
import { FirmwareViewProvider } from './firmwareView';
import { SerialLogViewProvider } from './serialLogView';
import { FlipperFsProvider, registerFsCommands } from './flipperFsView';
import { ScreenPanel, ScreenViewProvider } from './screenPanel';
import { flipperSerial } from './serial/flipperSerial';

export function activate(context: vscode.ExtensionContext) {
    const state = new StateManager(context);
    const mainProvider = new MainTreeProvider(state);

    vscode.window.registerTreeDataProvider('flipperMain', mainProvider);

    const recentProvider = new RecentProjectsProvider(state);
    vscode.window.registerTreeDataProvider('flipperRecentProjects', recentProvider);

    const firmwareView = new FirmwareViewProvider(state);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(FirmwareViewProvider.viewId, firmwareView)
    );

    // ── Device features (serial log, screen preview, file browser) ────────────
    context.subscriptions.push(flipperSerial);

    const serialLogView = new SerialLogViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SerialLogViewProvider.viewId, serialLogView, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    const fsProvider = new FlipperFsProvider();
    vscode.window.registerTreeDataProvider('flipperDeviceFiles', fsProvider);
    registerFsCommands(context, fsProvider);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ScreenViewProvider.viewId, new ScreenViewProvider(), {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('flipperFapStudio.screen.open', () =>
            vscode.commands.executeCommand('flipperScreen.focus')),
        vscode.commands.registerCommand('flipperFapStudio.screen.openTab', () => ScreenPanel.show(context)),
        vscode.commands.registerCommand('flipperFapStudio.serial.startLog', () =>
            flipperSerial.startLog().catch(err => vscode.window.showErrorMessage(`Flipper serial: ${err.message}`))),
        vscode.commands.registerCommand('flipperFapStudio.serial.stopLog', () => flipperSerial.stopLog()),
        vscode.commands.registerCommand('flipperFapStudio.serial.disconnect', () => flipperSerial.disconnect()),
    );

    const refresh = () => { mainProvider.refresh(); recentProvider.refresh(); firmwareView.refresh(); };

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
