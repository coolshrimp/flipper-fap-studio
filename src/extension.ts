import * as vscode from 'vscode';
import { MainTreeProvider, RecentProjectsProvider } from './treeProviders';
import { registerCommands } from './commands';
import { StateManager } from './stateManager';
import { buildState } from './buildState';
import { FirmwareViewProvider } from './firmwareView';
import { FlipperFsProvider, registerFsCommands } from './flipperFsView';
import { ScreenPanel, ScreenViewProvider, initScreenLogBuffer } from './screenPanel';
import { DesignerPanel } from './designerPanel';
import { DashboardPanel } from './dashboardPanel';
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

    // ── Device features (screen preview w/ log, file browser) ─────────────────
    context.subscriptions.push(flipperSerial);
    initScreenLogBuffer(context);

    const fsProvider = new FlipperFsProvider(state);
    const fsTreeView = vscode.window.createTreeView('flipperDeviceFiles', {
        treeDataProvider: fsProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(fsTreeView);
    registerFsCommands(context, fsProvider, fsTreeView);

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

    context.subscriptions.push(
        vscode.commands.registerCommand('flipperFapStudio.designer.open', () =>
            DesignerPanel.show(context, state, refresh))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('flipperFapStudio.dashboard.open', () =>
            DashboardPanel.show(context, state))
    );

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

    // ── One-time reveal of the Live Screen panel ──────────────────────────────
    // VS Code persists each sidebar container's layout, so a view added in an
    // update can end up appended at the bottom (collapsed) or hidden instead of
    // its declared position above Serial Log — surface it once so it isn't missed.
    const revealKey = 'liveScreenRevealed';
    if (!context.globalState.get(revealKey)) {
        void context.globalState.update(revealKey, true);
        vscode.window.showInformationMessage(
            'New: Live Screen is now a panel in the Flipper sidebar. If it appears in the wrong spot, drag its header above Serial Log — or run "View: Reset View Locations" for the default order.',
            'Reveal Live Screen'
        ).then(action => {
            if (action) { void vscode.commands.executeCommand('flipperScreen.focus'); }
        });
    }
}

export function deactivate() {}
