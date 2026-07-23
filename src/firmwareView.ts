import * as vscode from 'vscode';
import { WEBVIEW_THEME } from './webviewTheme';
import * as cp from 'child_process';
import * as https from 'https';
import { StateManager } from './stateManager';
import { FW_META, fwWebUrl } from './treeProviders';
import {
    inspectSdkFolder, findAllFirmware, fetchLatestReleaseTag, repoSlugFromUrl, versionMatchesTag,
    FLAVOR_LABELS, FwFlavor, SdkInfo,
} from './sdkCheck';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FwEntry {
    id: string;
    label: string;
    status: string;
    found: boolean;
    dotCls: 'found' | 'missing' | 'update';
    path: string;
    githubUrl: string;
    webUrl?: string;
    webLabel?: string;
}

const EXPECTED_FLAVOR: Record<string, FwFlavor> = {
    momentum: 'momentum',
    unleashed: 'unleashed',
    rogueMaster: 'rogueMaster',
};

interface UfbtVersions {
    installed: string | null;   // null = not installed
    latest: string | null;      // null = couldn't fetch
    checking: boolean;
}

// ── Version checks ────────────────────────────────────────────────────────────

function getInstalledUfbtVersion(): string | null {
    try {
        const out = cp.execSync('pip show ufbt', { encoding: 'utf8', timeout: 6000, windowsHide: true });
        const m = out.match(/^Version:\s*(.+)$/m);
        return m ? m[1].trim() : null;
    } catch {
        return null;
    }
}

function fetchPypiVersion(): Promise<string | null> {
    return new Promise(resolve => {
        const req = https.get(
            {
                hostname: 'pypi.org',
                path: '/pypi/ufbt/json',
                headers: { 'User-Agent': 'flipper-fap-studio-vscode' },
                timeout: 8000,
            },
            res => {
                let data = '';
                res.on('data', (c: string) => { data += c; });
                res.on('end', () => {
                    try { resolve((JSON.parse(data) as { info: { version: string } }).info.version); }
                    catch { resolve(null); }
                });
            }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// ── Entry builder ─────────────────────────────────────────────────────────────

function buildEntries(
    state: StateManager,
    ufbt: UfbtVersions,
    latestTags: Record<string, string | null>
): FwEntry[] {
    return Object.entries(FW_META).map(([id, meta]) => {
        if (id === 'oem') {
            let status: string;
            let dotCls: FwEntry['dotCls'];
            if (ufbt.checking) {
                status = 'Checking…';
                dotCls = 'missing';
            } else if (ufbt.installed === null) {
                status = 'Not installed';
                dotCls = 'missing';
            } else if (ufbt.latest && ufbt.latest !== ufbt.installed) {
                status = `v${ufbt.installed} → v${ufbt.latest} available`;
                dotCls = 'update';
            } else {
                status = `v${ufbt.installed}${ufbt.latest ? ' (up to date)' : ''}`;
                dotCls = 'found';
            }
            return { id, status, found: ufbt.installed !== null, dotCls, path: '', ...meta };
        }

        const p = state.getTargetPath(id);
        const info = inspectSdkFolder(p, EXPECTED_FLAVOR[id]);
        const latest = latestTags[id];
        const verified = info.ok && (!EXPECTED_FLAVOR[id] || info.flavor === EXPECTED_FLAVOR[id]);

        let status: string;
        let dotCls: FwEntry['dotCls'];
        let found = false;

        if (!p) {
            status = 'Not configured';
            dotCls = 'missing';
        } else if (!verified) {
            status = `Not found${latest ? ` — latest ${latest}` : ''}`;
            dotCls = 'missing';
        } else {
            found = true;
            if (latest && info.version && !versionMatchesTag(info.version, latest)) {
                status = `${info.version} → ${latest} available`;
                dotCls = 'update';
            } else {
                status = `${info.version} ✓ verified${latest ? ' · up to date' : ''}`;
                dotCls = 'found';
            }
        }
        return { id, status, found, dotCls, path: p, ...meta, webUrl: fwWebUrl(id, latest) };
    });
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class FirmwareViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'flipperFirmwareStatus';
    private _view?: vscode.WebviewView;
    private _ufbt: UfbtVersions = { installed: null, latest: null, checking: true };
    private _latestTags: Record<string, string | null> = {};

    constructor(private readonly state: StateManager) {
        void this._autoAssignPaths().then(() => {
            this._checkUfbt();
            this._checkLatestReleases();
        });
    }

    resolveWebviewView(view: vscode.WebviewView) {
        this._view = view;
        view.webview.options = { enableScripts: true };
        this._render();

        view.webview.onDidReceiveMessage(async (msg: { command: string; id?: string }) => {
            const meta = msg.id ? FW_META[msg.id] : undefined;
            switch (msg.command) {

                case 'installUfbt': {
                    const term = vscode.window.createTerminal('uFBT Install');
                    term.show();
                    term.sendText('pip install ufbt');
                    setTimeout(() => this._checkUfbt(), 12000);
                    break;
                }

                case 'updateUfbt': {
                    const term = vscode.window.createTerminal('uFBT Update');
                    term.show();
                    // Use python -m pip for reliable upgrades (matches pip's own advice)
                    term.sendText('python -m pip install --upgrade ufbt');
                    setTimeout(() => this._checkUfbt(), 12000);
                    break;
                }

                case 'checkUfbt':
                case 'refreshAll':
                    this._ufbt = { ...this._ufbt, checking: true };
                    this._render();
                    void this._autoAssignPaths().then(() => {
                        this._checkUfbt();
                        this._checkLatestReleases(true);
                    });
                    break;

                case 'openGitHub':
                    if (meta?.githubUrl) { vscode.env.openExternal(vscode.Uri.parse(meta.githubUrl)); }
                    break;

                case 'openWeb': {
                    const url = msg.id ? fwWebUrl(msg.id, this._latestTags[msg.id]) : undefined;
                    if (url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
                    break;
                }

                case 'setPath': {
                    if (!msg.id || msg.id === 'oem') { break; }
                    const result = await vscode.window.showOpenDialog({
                        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
                        openLabel: `Set ${meta?.label} SDK folder`,
                    });
                    if (!result) { break; }
                    const keyMap: Record<string, string> = {
                        rogueMaster: 'targets.rogueMasterPath',
                        momentum:    'targets.momentumPath',
                        unleashed:   'targets.unleashedPath',
                    };
                    const key = keyMap[msg.id];
                    if (key) {
                        await vscode.workspace.getConfiguration('flipperFapStudio')
                            .update(key, result[0].fsPath, vscode.ConfigurationTarget.Global);
                        this._render();
                        vscode.window.showInformationMessage(`${meta?.label} SDK path set.`);
                    }
                    break;
                }
            }
        });
    }

    refresh() { this._render(); }

    private async _checkUfbt() {
        this._ufbt = { installed: null, latest: null, checking: true };
        this._render();

        const [installed, latest] = await Promise.all([
            Promise.resolve(getInstalledUfbtVersion()),
            fetchPypiVersion(),
        ]);

        this._ufbt = { installed, latest, checking: false };
        this._render();
    }

    /**
     * If a configured path turns out to contain a *different* firmware (or a
     * parent folder holding several), point each target at the package that
     * actually matches it — e.g. RogueMaster found while checking Momentum's
     * folder gets assigned to the RogueMaster target automatically.
     */
    private async _autoAssignPaths() {
        const keyMap: Record<string, string> = {
            rogueMaster: 'targets.rogueMasterPath',
            momentum: 'targets.momentumPath',
            unleashed: 'targets.unleashedPath',
        };
        try {
            // gather every firmware package reachable from any configured path
            const candidates: SdkInfo[] = [];
            const seen = new Set<string>();
            for (const id of Object.keys(keyMap)) {
                for (const info of findAllFirmware(this.state.getTargetPath(id))) {
                    if (info.dir && !seen.has(info.dir)) {
                        seen.add(info.dir);
                        candidates.push(info);
                    }
                }
            }

            const cfg = vscode.workspace.getConfiguration('flipperFapStudio');
            const assigned: string[] = [];
            for (const id of Object.keys(keyMap)) {
                const expected = EXPECTED_FLAVOR[id];
                const current = this.state.getTargetPath(id);
                const info = inspectSdkFolder(current, expected);
                if (info.ok && info.flavor === expected) { continue; } // already good
                const match = candidates.find(c => c.flavor === expected && c.dir);
                if (match?.dir && match.dir !== current) {
                    await cfg.update(keyMap[id], match.dir, vscode.ConfigurationTarget.Global);
                    assigned.push(`${FLAVOR_LABELS[expected]} → ${match.version}`);
                }
            }
            if (assigned.length > 0) {
                vscode.window.showInformationMessage(
                    `Firmware detected and assigned automatically: ${assigned.join(', ')}`);
            }
        } catch { /* best effort — never block the panel */ }
    }

    /** Fetch each firmware's latest GitHub release tag for version comparison. */
    private async _checkLatestReleases(force = false) {
        await Promise.all(Object.entries(FW_META)
            .filter(([id]) => id !== 'oem')
            .map(async ([id, meta]) => {
                const slug = repoSlugFromUrl(meta.githubUrl);
                this._latestTags[id] = slug ? await fetchLatestReleaseTag(slug, force) : null;
            }));
        this._render();
    }

    private _render() {
        if (!this._view) { return; }
        const entries = buildEntries(this.state, this._ufbt, this._latestTags);
        this._view.webview.html = getHtml(entries, this._ufbt);
    }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function esc(s: string) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getHtml(entries: FwEntry[], ufbt: UfbtVersions): string {

    const rows = entries.map(e => {
        const isOem = e.id === 'oem';

        const dotCls = e.dotCls;
        const dot = `<span class="dot ${dotCls}"></span>`;
        const statusCls = dotCls === 'found' ? 'status-ok' : dotCls === 'update' ? 'status-update' : 'status-warn';

        // ── OEM action buttons ──
        let oemBtns = '';
        if (isOem && !ufbt.checking) {
            if (ufbt.installed === null) {
                oemBtns = `<button class="btn btn-action" onclick="send('installUfbt')">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/>
                    </svg>Install</button>`;
            } else if (ufbt.latest && ufbt.latest !== ufbt.installed) {
                oemBtns = `<button class="btn btn-action btn-update" onclick="send('updateUfbt')">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                    </svg>Update</button>`;
            }
            oemBtns += `<button class="btn btn-icon" title="Re-check version" onclick="send('checkUfbt')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg></button>`;
        }
        if (isOem && ufbt.checking) {
            oemBtns = `<span class="checking">checking…</span>`;
        }

        // ── Non-OEM action buttons ──
        const btnSetPath = !isOem
            ? `<button class="btn btn-icon" title="Set SDK path" onclick="send('setPath','${e.id}')">
                 <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                   <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                 </svg></button>` : '';

        const btnGH = `<button class="btn btn-icon" title="GitHub Releases" onclick="send('openGitHub','${e.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/>
            </svg></button>`;

        const btnWeb = e.webUrl
            ? `<button class="btn btn-web" title="${esc(e.webLabel ?? '')}" onclick="send('openWeb','${e.id}')">
                 <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                   <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                   <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                 </svg>${esc(e.webLabel ?? '')}</button>`
            : '';

        const pathHint = !isOem && e.path
            ? `<div class="path">${esc(e.path)}</div>` : '';

        const actions = isOem ? `${oemBtns}${btnGH}${btnWeb}` : `${btnSetPath}${btnGH}${btnWeb}`;

        return `
        <div class="fw-row">
          <div class="fw-left">
            ${dot}
            <div class="fw-info">
              <span class="fw-name">${esc(e.label)}</span>
              <span class="${statusCls}">${esc(e.status)}</span>
              ${pathHint}
            </div>
          </div>
          <div class="fw-actions">${actions}</div>
        </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  ${WEBVIEW_THEME}
  :root {
    --purple:       var(--fap-accent);
    --purple-light: var(--fap-accent);
    --purple-dim:   var(--fap-accent-soft);
    --purple-border:var(--fap-accent-border);
    --green:  var(--fap-good);
    --yellow: var(--fap-warn);
    --orange: var(--fap-accent-strong);
    --bg: var(--fap-bg);
    --fg: var(--fap-text);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--fap-ui-font);
    font-size: 11px;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 12px 8px;
    border-bottom: 1px solid var(--purple-border);
    background: linear-gradient(135deg, rgba(255,140,26,0.16), rgba(255,140,26,0.05));
  }
  .header-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--purple-light);
    flex: 1;
  }

  .fw-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 8px 7px 12px;
    border-bottom: 1px solid var(--fap-line);
    transition: background 0.12s;
  }
  .fw-row:last-child { border-bottom: none; }
  .fw-row:hover { background: var(--purple-dim); }

  .fw-left { display: flex; align-items: flex-start; gap: 8px; min-width: 0; flex: 1; }

  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    flex-shrink: 0; margin-top: 3px;
  }
  .dot.found   { background: var(--green);  box-shadow: 0 0 5px rgba(74,222,128,0.5); }
  .dot.missing { background: var(--yellow); box-shadow: 0 0 5px rgba(251,191,36,0.4); }
  .dot.update  { background: var(--orange); box-shadow: 0 0 5px rgba(251,146,60,0.5);
                 animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse {
    0%,100% { opacity:1; } 50% { opacity:0.45; }
  }

  .fw-info { min-width: 0; }
  .fw-name {
    display: block; font-size: 11.5px; font-weight: 600; color: var(--fg);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .status-ok     { display:block; font-size:10px; color: var(--green); }
  .status-warn   { display:block; font-size:10px; color: var(--yellow); }
  .status-update { display:block; font-size:10px; color: var(--orange); font-weight:600; }
  .path {
    font-size: 9.5px; color: #555; margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 155px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .checking { font-size: 10px; color: #555; font-style: italic; padding: 3px 6px; }

  .fw-actions { display: flex; gap: 3px; flex-shrink: 0; align-items: center; }

  .btn {
    background: transparent; border: 1px solid transparent; color: #666; cursor: pointer;
    border-radius: 4px; padding: 3px 5px;
    display: flex; align-items: center; gap: 4px;
    font-family: inherit; font-size: 10px;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
    white-space: nowrap;
  }
  .btn:hover { background: var(--purple-dim); border-color: var(--purple-border); color: var(--purple-light); }

  .btn-action {
    border-color: var(--purple-border); color: var(--purple-light);
    padding: 3px 8px; font-weight: 600;
  }
  .btn-action:hover { background: var(--fap-accent-hover); }

  .btn-update {
    border-color: rgba(251,146,60,0.5); color: var(--orange);
  }
  .btn-update:hover { background: rgba(251,146,60,0.12); border-color: var(--orange); color: var(--orange); }

  .btn-web {
    border-color: var(--purple-border); color: var(--purple-light); padding: 3px 7px;
  }
  .btn-web:hover { background: var(--fap-accent-hover); }
</style>
</head>
<body>
<div class="header">
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fap-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="20" height="20" rx="3"/><path d="M8 12h8M12 8v8"/>
  </svg>
  <span class="header-title">Firmware SDKs</span>
  <button class="btn btn-icon" title="Re-check all firmwares (local versions + latest releases)" onclick="send('refreshAll')">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg></button>
</div>
${rows}
<script>
const vscode = acquireVsCodeApi();
function send(command, id) { vscode.postMessage({ command, id }); }
</script>
</body>
</html>`;
}
