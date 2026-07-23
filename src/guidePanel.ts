import * as vscode from 'vscode';
import { WEBVIEW_THEME } from './webviewTheme';

export function showGuidePanel(): void {
    const panel = vscode.window.createWebviewPanel(
        'flipperGuide',
        'Flipper FAP Studio — Guide',
        vscode.ViewColumn.One,
        { enableScripts: false }
    );
    panel.webview.html = getGuideHtml();
}

function getGuideHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flipper FAP Studio — Guide</title>
<style>
  ${WEBVIEW_THEME}
  :root {
    --purple:       var(--fap-accent);
    --purple-dark:  var(--fap-accent-strong);
    --purple-light: var(--fap-accent);
    --purple-dim:   var(--fap-accent-soft);
    --purple-border:var(--fap-accent-border);
    --bg:  var(--fap-bg);
    --fg:  var(--fap-text);
    --code-bg: rgba(0,0,0,0.3);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--fap-ui-font);
    font-size: 13px;
    line-height: 1.6;
    padding: 28px 36px 60px;
    max-width: 780px;
  }
  .hero {
    text-align: center;
    padding: 32px 0 36px;
    border-bottom: 1px solid var(--purple-border);
    margin-bottom: 36px;
  }
  .hero-icon {
    width: 56px;
    height: 56px;
    background: var(--purple-dim);
    border: 2px solid var(--purple-border);
    border-radius: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 14px;
  }
  .hero h1 {
    font-size: 24px;
    font-weight: 700;
    color: var(--purple-light);
    letter-spacing: -0.02em;
    margin-bottom: 8px;
  }
  .hero p { color: var(--fap-muted); font-size: 13px; }
  .steps { display: flex; flex-direction: column; gap: 16px; }
  .step {
    display: flex;
    gap: 18px;
    background: var(--fap-surface);
    border: 1px solid var(--fap-line);
    border-radius: 10px;
    padding: 18px 20px;
  }
  .step-num {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    background: linear-gradient(135deg, var(--fap-accent-strong), var(--fap-accent));
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    color: #fff;
    margin-top: 2px;
  }
  .step-body h3 {
    color: var(--purple-light);
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .step-body p { color: var(--fap-muted); font-size: 12px; }
  code {
    background: var(--code-bg);
    border: 1px solid var(--fap-accent-border);
    border-radius: 4px;
    padding: 1px 6px;
    font-family: var(--fap-code-font);
    font-size: 11px;
    color: var(--purple-light);
  }
  .tip {
    margin-top: 14px;
    background: var(--fap-accent-soft);
    border-left: 3px solid var(--purple);
    border-radius: 0 6px 6px 0;
    padding: 10px 14px;
    color: var(--fap-muted);
    font-size: 11px;
  }
  .tip strong { color: var(--purple-light); }
  .section-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--fap-muted);
    margin: 32px 0 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--purple-border);
  }
  .cmd-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .cmd-table th {
    text-align: left;
    color: var(--purple-light);
    font-weight: 600;
    padding: 8px 12px;
    border-bottom: 1px solid var(--purple-border);
  }
  .cmd-table td { padding: 8px 12px; color: var(--fap-muted); border-bottom: 1px solid var(--fap-line); }
  .cmd-table tr:last-child td { border-bottom: none; }
  .cmd-table td:first-child { color: var(--fg); }
</style>
</head>
<body>

<div class="hero">
  <div class="hero-icon">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--fap-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
    </svg>
  </div>
  <h1>Flipper FAP Studio</h1>
  <p>Build and deploy Flipper Zero .fap apps from VS Code — no terminal required.</p>
</div>

<div class="section-label">Getting Started</div>
<div class="steps">

  <div class="step">
    <div class="step-num">1</div>
    <div class="step-body">
      <h3>Install uFBT</h3>
      <p>
        Click <strong>Install / Update uFBT</strong> in the sidebar. This runs
        <code>pip install -U ufbt</code> in a terminal. uFBT is the official Flipper build tool
        and is required for all build operations. You only need to do this once (or when updating).
      </p>
      <div class="tip"><strong>Tip:</strong> Make sure Python 3.8+ and pip are on your PATH before running this.</div>
    </div>
  </div>

  <div class="step">
    <div class="step-num">2</div>
    <div class="step-body">
      <h3>Create or open an app</h3>
      <p>
        Click <strong>Create starter app</strong> to scaffold a new Flipper app with
        <code>application.fam</code> and <code>main.c</code> template files ready to go.
        Give it a <code>snake_case</code> name and choose a parent folder — the extension
        creates a subfolder for you.<br><br>
        Already have an app? Open its folder in VS Code — the extension auto-detects it.
        You can also set a <strong>Default parent folder</strong> in Settings so you're not
        asked every time.
      </p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">3</div>
    <div class="step-body">
      <h3>Select a firmware target</h3>
      <p>
        Click <strong>Select firmware target</strong> to choose which SDK to build against.
        The available targets are:<br><br>
        • <strong>OEM / uFBT</strong> — official Flipper firmware (default, no extra setup)<br>
        • <strong>RogueMaster</strong>, <strong>Momentum</strong>, <strong>Unleashed</strong> — custom firmwares
        (set their SDK paths in <strong>Settings</strong> first)<br>
        • <strong>Add custom target…</strong> — any other locally-cloned firmware SDK
      </p>
      <div class="tip"><strong>Tip:</strong> SDK paths for the built-in targets can be changed in the Settings panel via the Browse buttons.</div>
    </div>
  </div>

  <div class="step">
    <div class="step-num">4</div>
    <div class="step-body">
      <h3>Build your app</h3>
      <p>
        Click <strong>Build .fap</strong>. The Output panel shows the full compiler log.
        The compiled <code>.fap</code> binary ends up in the <code>dist/</code> folder inside your app.
        Use <strong>Open dist folder</strong> to jump straight there.<br><br>
        Enable <em>Ask where to copy .fap after each build</em> (Settings) to be prompted for a
        destination — handy for copying straight to an SD card. Or set a fixed <em>Auto-copy directory</em>
        to have it happen silently every time.
      </p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">5</div>
    <div class="step-body">
      <h3>Preview in Flipper Simulator</h3>
      <p>
        Click <strong>Flipper Simulator</strong> for a fast offline static preview of
        <code>canvas_*</code> UI calls and local draw helpers. It watches your source, lets you cycle through detected
        screens, checks a built <code>.fap</code> for the expected ARM ELF32 header, and saves qFlipper-palette screenshots.
        Runtime strings remain visible as marked placeholders; project code is never executed inside VS Code.
      </p>
      <div class="tip"><strong>Scope:</strong> This previews static Canvas output, not the STM32 CPU, full firmware, app logic, or hardware APIs. Use the physical-device button for exact behaviour.</div>
    </div>
  </div>

  <div class="step">
    <div class="step-num">6</div>
    <div class="step-body">
      <h3>Deploy to your Flipper</h3>
      <p>
        Connect your Flipper Zero via USB, then click <strong>Build + Launch on Flipper</strong>.
        This builds the app and immediately sideloads it — the app starts running on the device
        so you can test without manually copying files.
      </p>
      <div class="tip"><strong>Tip:</strong> Use <strong>Clean</strong> if you run into build cache issues or switch firmware targets.</div>
    </div>
  </div>

</div>

<div class="section-label">All Commands</div>
<table class="cmd-table">
  <thead>
    <tr><th>Action</th><th>What it does</th></tr>
  </thead>
  <tbody>
    <tr><td>Install / Update uFBT</td><td>Runs <code>pip install -U ufbt</code> in a terminal</td></tr>
    <tr><td>Build .fap</td><td>Compiles the current app to a .fap binary using uFBT</td></tr>
    <tr><td>Build + Launch on Flipper</td><td>Builds then sideloads to a connected Flipper via USB</td></tr>
    <tr><td>Clean</td><td>Removes build artefacts from the dist/ folder</td></tr>
    <tr><td>Open dist folder</td><td>Opens the dist/ output folder in your file explorer</td></tr>
    <tr><td>Create starter app</td><td>Scaffolds a new app with .fam manifest and main.c template</td></tr>
    <tr><td>Flipper Simulator</td><td>Boots the selected Target firmware, stages the active .fap on virtual SD storage, and runs supported app UI and logic</td></tr>
    <tr><td>Select firmware target</td><td>Switches the active SDK (OEM, custom firmware, or custom path)</td></tr>
    <tr><td>Settings</td><td>Configure output paths, SDK locations, and build behaviour</td></tr>
    <tr><td>Guide</td><td>Opens this page</td></tr>
  </tbody>
</table>

</body>
</html>`;
}
