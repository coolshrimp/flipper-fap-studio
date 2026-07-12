import * as vscode from 'vscode';
import { StateManager } from './stateManager';

interface SettingsData {
    askOnBuildOutput: boolean;
    buildOutputDir: string;
    defaultCreateAppDir: string;
    rogueMasterPath: string;
    momentumPath: string;
    unleashedPath: string;
}

export class SettingsPanel {
    static currentPanel: SettingsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    static show(_context: vscode.ExtensionContext, state: StateManager, refresh: () => void) {
        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            SettingsPanel.currentPanel._update(state);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'flipperSettings',
            'Flipper FAP Studio — Settings',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        SettingsPanel.currentPanel = new SettingsPanel(panel, state, refresh);
    }

    private constructor(panel: vscode.WebviewPanel, state: StateManager, refresh: () => void) {
        this._panel = panel;
        this._update(state);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (msg: { command: string; field?: string; settings?: SettingsData }) => {
                const cfg = vscode.workspace.getConfiguration('flipperFapStudio');
                switch (msg.command) {
                    case 'pickFolder': {
                        const result = await vscode.window.showOpenDialog({
                            canSelectFolders: true,
                            canSelectFiles: false,
                            canSelectMany: false,
                            openLabel: 'Select Folder',
                        });
                        if (result?.[0]) {
                            this._panel.webview.postMessage({
                                command: 'folderPicked',
                                field: msg.field,
                                value: result[0].fsPath,
                            });
                        }
                        break;
                    }
                    case 'save': {
                        const s = msg.settings!;
                        await cfg.update('askOnBuildOutput', s.askOnBuildOutput, vscode.ConfigurationTarget.Global);
                        await cfg.update('buildOutputDir', s.buildOutputDir, vscode.ConfigurationTarget.Global);
                        await cfg.update('defaultCreateAppDir', s.defaultCreateAppDir, vscode.ConfigurationTarget.Global);
                        await cfg.update('targets.rogueMasterPath', s.rogueMasterPath, vscode.ConfigurationTarget.Global);
                        await cfg.update('targets.momentumPath', s.momentumPath, vscode.ConfigurationTarget.Global);
                        await cfg.update('targets.unleashedPath', s.unleashedPath, vscode.ConfigurationTarget.Global);
                        refresh();
                        vscode.window.showInformationMessage('Flipper FAP Studio — settings saved.');
                        break;
                    }
                }
            },
            null,
            this._disposables
        );
    }

    private _update(state: StateManager) {
        const cfg = vscode.workspace.getConfiguration('flipperFapStudio');
        const data: SettingsData = {
            askOnBuildOutput: cfg.get<boolean>('askOnBuildOutput') ?? false,
            buildOutputDir: cfg.get<string>('buildOutputDir') ?? '',
            defaultCreateAppDir: cfg.get<string>('defaultCreateAppDir') ?? '',
            rogueMasterPath: state.getTargetPath('rogueMaster'),
            momentumPath: state.getTargetPath('momentum'),
            unleashedPath: state.getTargetPath('unleashed'),
        };
        this._panel.webview.html = getSettingsHtml(data);
    }

    dispose() {
        SettingsPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}

function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getSettingsHtml(s: SettingsData): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flipper FAP Studio — Settings</title>
<style>
  :root {
    --purple:       #8b5cf6;
    --purple-dark:  #7c3aed;
    --purple-light: #a78bfa;
    --purple-dim:   rgba(139,92,246,0.12);
    --purple-border:rgba(139,92,246,0.35);
    --bg:     var(--vscode-editor-background, #13111c);
    --fg:     var(--vscode-editor-foreground, #d4d4d4);
    --inp-bg: var(--vscode-input-background, #1e1b2e);
    --inp-br: var(--vscode-input-border, #3c3553);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px;
    line-height: 1.5;
    padding: 28px 32px 48px;
    max-width: 720px;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
  }
  .header svg { flex-shrink: 0; }
  h1 {
    color: var(--purple-light);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .subtitle { color: #777; font-size: 12px; margin-bottom: 28px; }
  .section {
    background: var(--purple-dim);
    border: 1px solid var(--purple-border);
    border-radius: 10px;
    padding: 20px 22px;
    margin-bottom: 18px;
  }
  .section-title {
    color: var(--purple-light);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 18px;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  label {
    display: block;
    font-size: 12px;
    color: #bbb;
    margin-bottom: 6px;
    font-weight: 500;
  }
  label .muted { color: #666; font-weight: 400; }
  .input-row { display: flex; gap: 8px; }
  input[type="text"] {
    flex: 1;
    background: var(--inp-bg);
    border: 1px solid var(--inp-br);
    color: var(--fg);
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
    outline: none;
    transition: border-color 0.15s;
  }
  input[type="text"]:focus { border-color: var(--purple); }
  input[type="text"]::placeholder { color: #444; }
  .browse-btn {
    background: var(--purple-dim);
    border: 1px solid var(--purple-border);
    color: var(--purple-light);
    padding: 7px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
    transition: background 0.15s, border-color 0.15s;
    font-family: inherit;
    flex-shrink: 0;
  }
  .browse-btn:hover { background: rgba(139,92,246,0.28); border-color: var(--purple); }
  .browse-btn:active { transform: scale(0.97); }
  .toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    cursor: pointer;
  }
  .toggle-wrap { padding-top: 2px; flex-shrink: 0; }
  .toggle {
    position: relative;
    width: 40px;
    height: 22px;
    display: block;
  }
  .toggle input { display: none; }
  .track {
    position: absolute;
    inset: 0;
    background: #2a2a2a;
    border-radius: 11px;
    border: 1px solid #444;
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s;
  }
  .toggle input:checked + .track { background: var(--purple-dark); border-color: var(--purple); }
  .thumb {
    position: absolute;
    width: 16px;
    height: 16px;
    background: #ccc;
    border-radius: 50%;
    top: 2px;
    left: 2px;
    transition: left 0.18s, background 0.18s;
    pointer-events: none;
  }
  .toggle input:checked ~ .thumb { left: 20px; background: #fff; }
  .toggle-text strong { display: block; font-size: 12px; color: #ccc; font-weight: 500; }
  .toggle-text span { font-size: 11px; color: #666; }
  .hint { color: #5a5a6a; font-size: 11px; margin-top: 5px; }
  .save-row { margin-top: 8px; }
  .save-btn {
    background: linear-gradient(135deg, #6d28d9, #8b5cf6);
    border: none;
    color: #fff;
    padding: 10px 26px;
    border-radius: 7px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 2px 12px rgba(139,92,246,0.35);
    transition: opacity 0.15s, transform 0.1s;
    font-family: inherit;
  }
  .save-btn:hover { opacity: 0.9; }
  .save-btn:active { transform: scale(0.97); }
</style>
</head>
<body>

<div class="header">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
    <path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
  </svg>
  <h1>Flipper FAP Studio — Settings</h1>
</div>
<p class="subtitle">Configure build behaviour, output paths, and firmware SDK locations.</p>

<!-- Build Output -->
<div class="section">
  <div class="section-title">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
    </svg>
    Build Output
  </div>

  <div class="field">
    <div class="toggle-row" onclick="document.getElementById('askTgl').click()">
      <div class="toggle-wrap">
        <label class="toggle">
          <input type="checkbox" id="askTgl" ${s.askOnBuildOutput ? 'checked' : ''}>
          <div class="track"></div>
          <div class="thumb"></div>
        </label>
      </div>
      <div class="toggle-text">
        <strong>Ask where to copy .fap after each build</strong>
        <span>A folder picker appears after every successful build so you can choose the destination.</span>
      </div>
    </div>
  </div>

  <div class="field">
    <label for="buildOutputDir">
      Auto-copy .fap to directory
      <span class="muted">(ignored when "ask" is on — leave blank to disable)</span>
    </label>
    <div class="input-row">
      <input type="text" id="buildOutputDir" value="${esc(s.buildOutputDir)}"
             placeholder="e.g. D:\\SD Card\\apps\\Misc">
      <button class="browse-btn" onclick="pick('buildOutputDir')">Browse…</button>
    </div>
    <div class="hint">After a successful build the .fap is automatically copied here.</div>
  </div>
</div>

<!-- New App Defaults -->
<div class="section">
  <div class="section-title">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
    </svg>
    New App Defaults
  </div>

  <div class="field">
    <label for="defaultCreateAppDir">
      Default parent folder for new apps
      <span class="muted">(leave blank to always ask)</span>
    </label>
    <div class="input-row">
      <input type="text" id="defaultCreateAppDir" value="${esc(s.defaultCreateAppDir)}"
             placeholder="e.g. C:\\Projects\\Flipper">
      <button class="browse-btn" onclick="pick('defaultCreateAppDir')">Browse…</button>
    </div>
    <div class="hint">When creating a starter app this folder is offered as the default — you can still override it.</div>
  </div>
</div>

<!-- Firmware SDK Paths -->
<div class="section">
  <div class="section-title">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="3"/>
      <path d="M8 12h8M12 8v8"/>
    </svg>
    Firmware SDK Paths
  </div>
  <p style="color:#5a5a6a;font-size:11px;margin-bottom:14px;">
    Point each entry to a locally-cloned firmware repo that contains the SDK.
    Leave blank to fall back to the OEM uFBT default.
  </p>

  <div class="field">
    <label for="rogueMasterPath">RogueMaster SDK path</label>
    <div class="input-row">
      <input type="text" id="rogueMasterPath" value="${esc(s.rogueMasterPath)}"
             placeholder="C:\\Flipper\\RogueMaster">
      <button class="browse-btn" onclick="pick('rogueMasterPath')">Browse…</button>
    </div>
  </div>

  <div class="field">
    <label for="momentumPath">Momentum SDK path</label>
    <div class="input-row">
      <input type="text" id="momentumPath" value="${esc(s.momentumPath)}"
             placeholder="C:\\Flipper\\Momentum">
      <button class="browse-btn" onclick="pick('momentumPath')">Browse…</button>
    </div>
  </div>

  <div class="field">
    <label for="unleashedPath">Unleashed SDK path</label>
    <div class="input-row">
      <input type="text" id="unleashedPath" value="${esc(s.unleashedPath)}"
             placeholder="C:\\Flipper\\Unleashed">
      <button class="browse-btn" onclick="pick('unleashedPath')">Browse…</button>
    </div>
  </div>
</div>

<div class="save-row">
  <button class="save-btn" onclick="save()">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Save Settings
  </button>
</div>

<script>
const vscode = acquireVsCodeApi();

function pick(field) {
    vscode.postMessage({ command: 'pickFolder', field });
}

function save() {
    vscode.postMessage({
        command: 'save',
        settings: {
            askOnBuildOutput:   document.getElementById('askTgl').checked,
            buildOutputDir:     document.getElementById('buildOutputDir').value.trim(),
            defaultCreateAppDir:document.getElementById('defaultCreateAppDir').value.trim(),
            rogueMasterPath:    document.getElementById('rogueMasterPath').value.trim(),
            momentumPath:       document.getElementById('momentumPath').value.trim(),
            unleashedPath:      document.getElementById('unleashedPath').value.trim(),
        }
    });
}

window.addEventListener('message', e => {
    const { command, field, value } = e.data;
    if (command === 'folderPicked' && field) {
        const el = document.getElementById(field);
        if (el) el.value = value;
    }
});
</script>
</body>
</html>`;
}
