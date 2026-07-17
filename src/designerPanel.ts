import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './stateManager';

const STATE_KEY = 'uiDesigner.design';

/**
 * Flipper UI Designer — lopaka.app-style visual editor for the 128×64 screen.
 * Multiple screens, drag-and-drop elements/icons, live 1-bit preview, and
 * C code generation (screen snippet or a complete buildable app).
 */
export class DesignerPanel {
    private static current: DesignerPanel | null = null;

    static show(context: vscode.ExtensionContext, state: StateManager, refresh: () => void) {
        if (DesignerPanel.current) {
            DesignerPanel.current.panel.reveal();
            return;
        }
        DesignerPanel.current = new DesignerPanel(context, state, refresh);
    }

    private readonly panel: vscode.WebviewPanel;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly state: StateManager,
        private readonly refresh: () => void
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'flipperUiDesigner',
            'Flipper UI Designer',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'flipper-icon.svg'));
        this.panel.webview.html = html();

        this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, context.subscriptions);
        this.panel.onDidDispose(() => { DesignerPanel.current = null; }, null, context.subscriptions);
    }

    private async onMessage(msg: { type: string; [k: string]: unknown }) {
        switch (msg.type) {
            case 'ready': {
                const saved = this.context.globalState.get<string>(STATE_KEY);
                if (saved) { void this.panel.webview.postMessage({ type: 'loadDesign', json: saved }); }
                break;
            }
            case 'saveState':
                void this.context.globalState.update(STATE_KEY, msg.json as string);
                break;
            case 'copy':
                await vscode.env.clipboard.writeText(msg.text as string);
                vscode.window.setStatusBarMessage(`Copied ${msg.what ?? 'code'} to clipboard`, 4000);
                break;
            case 'insert': {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('Open a code file and place the cursor where the draw code should go, then click Insert again.');
                    return;
                }
                await editor.edit(edit => edit.insert(editor.selection.active, msg.text as string));
                vscode.window.showTextDocument(editor.document, editor.viewColumn);
                break;
            }
            case 'createApp':
                await this.createApp(msg.appId as string, msg.famText as string, msg.mainC as string);
                break;
            case 'exportJson': {
                const defaultDir = this.state.getAppFolder() ||
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(path.join(defaultDir, `${msg.appId ?? 'flipper_ui'}_design.json`)),
                    filters: { 'UI design': ['json'] },
                    title: 'Export UI design',
                });
                if (uri) {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.json as string, 'utf8'));
                    vscode.window.showInformationMessage(`Design exported: ${path.basename(uri.fsPath)}`);
                }
                break;
            }
            case 'importJson': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'UI design': ['json'] },
                    title: 'Import UI design',
                });
                if (!picked) { return; }
                try {
                    const raw = fs.readFileSync(picked[0].fsPath, 'utf8');
                    JSON.parse(raw); // validate
                    void this.panel.webview.postMessage({ type: 'loadDesign', json: raw });
                } catch (err) {
                    vscode.window.showErrorMessage(`Could not import design: ${(err as Error).message}`);
                }
                break;
            }
        }
    }

    private async createApp(appId: string, famText: string, mainC: string) {
        const defaultDir = this.state.getDefaultCreateAppDir();
        let parentDir: string | undefined;
        if (defaultDir) {
            const USE = `Use default: ${defaultDir}`;
            const pick = await vscode.window.showQuickPick([USE, 'Browse for different location…'], {
                title: 'Where should the app be created?',
            });
            if (!pick) { return; }
            if (pick === USE) { parentDir = defaultDir; }
        }
        if (!parentDir) {
            const result = await vscode.window.showOpenDialog({
                canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
                openLabel: 'Create app inside this folder',
            });
            if (!result) { return; }
            parentDir = result[0].fsPath;
        }

        const appDir = path.join(parentDir, appId);
        if (fs.existsSync(appDir)) {
            vscode.window.showWarningMessage(`Folder already exists: ${appDir} — pick a different app name (top-left field in the designer).`);
            return;
        }
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(path.join(appDir, 'application.fam'), famText);
        fs.writeFileSync(path.join(appDir, 'main.c'), mainC);

        this.state.setAppFolder(appDir);
        vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
            0,
            { uri: vscode.Uri.file(appDir), name: appId }
        );
        this.refresh();
        const action = await vscode.window.showInformationMessage(
            `Created ${appId} at ${appDir} — it is now the active app.`, 'Open main.c');
        if (action) {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(appDir, 'main.c')));
        }
    }
}

// 5×7 GLCD font (classic Adafruit-GFX glcdfont, BSD licence) — chars 32..126,
// 5 column-bytes per char, bit 0 = top row. Used only for the on-canvas preview.
const FONT_B64 =
    'AAAAAAAAAF8AAAAHAAcAFH8UfxQkKn8qEiMTCGRiNklWIFAACAcDAAAcIkEAAEEiHAAqHH8cKggIPggIAIBwMAAICAgICAAAYGAAIBAIBAI+UUlFPgBCf0AAcklJSUYhQUlNMxgUEn8QJ0VFRTk8SklJMUEhEQkHNklJSTZGSUkpHgAAFAAAAEA0AAAACBQiQRQUFBQUAEEiFAgCAVkJBj5BXVlOfBIREnx/SUlJNj5BQUEif0FBQT5/SUlJQX8JCQkBPkFBUXN/CAgIfwBBf0EAIEBBPwF/CBQiQX9AQEBAfwIcAn9/BAgQfz5BQUE+fwkJCQY+QVEhXn8JGSlGJklJSTIDAX8BAz9AQEA/HyBAIB8/QDhAP2MUCBRjAwR4BANhWUlNQwB/QUFBAgQIECAAQUFBfwQCAQIEQEBAQEAAAwcIACBUVHhAfyhERDg4REREKDhERCh/OFRUVBgACH4JAhikpJx4fwgEBHgARH1AACBAQD0AfxAoRAAAQX9AAHwEeAR4fAgEBHg4REREOPwYJCQYGCQkGPx8CAQECEhUVFQkBAQ/RCQ8QEAgfBwgQCAcPEAwQDxEKBAoREyQkJB8RGRUTEQACDZBAAAAdwAAAEE2CAACAQIEAg==';

function html(): string {
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    :root {
        --orange: #ff8c1a;
        --orange-dim: #a35a12;
        --bg: #100d0a;
        --panel: #191410;
        --sel: #58a6ff;
    }
    * { box-sizing: border-box; }
    body {
        margin: 0; padding: 10px;
        background:
            linear-gradient(rgba(255,140,26,.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,140,26,.04) 1px, transparent 1px),
            var(--bg);
        background-size: 22px 22px;
        color: var(--orange);
        font-family: 'Consolas', 'Courier New', monospace;
        font-size: 12px;
        user-select: none;
    }
    input, select, textarea, button { font-family: inherit; }
    input[type=text], input[type=number], select, textarea {
        background: #000; color: var(--orange);
        border: 1px solid var(--orange-dim); border-radius: 4px;
        padding: 3px 6px; font-size: 11px;
    }
    input[type=number] { width: 52px; }
    button {
        background: none; border: 2px solid var(--orange); border-radius: 6px;
        color: var(--orange); padding: 4px 10px; cursor: pointer;
        font-size: 11px; letter-spacing: .5px;
    }
    button:hover { background: rgba(255,140,26,.15); }
    button.small { border-width: 1px; padding: 2px 7px; font-size: 10px; border-color: var(--orange-dim); }
    button.active { background: var(--orange); color: #100d0a; }
    .panel {
        background: var(--panel);
        border: 2px solid var(--orange-dim); border-radius: 8px;
        padding: 8px;
    }
    .panel h3 {
        margin: 0 0 6px; font-size: 10px; letter-spacing: 1px;
        color: var(--orange-dim); text-transform: uppercase;
    }
    #toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
    #toolbar .title { letter-spacing: 1px; font-size: 13px; }
    #screenTabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .tab {
        border: 1px solid var(--orange-dim); border-radius: 5px 5px 0 0;
        padding: 3px 10px; cursor: pointer; font-size: 11px;
    }
    .tab.cur { background: var(--orange); color: #100d0a; }
    #layout { display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
    #palette { width: 168px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 10px; }
    .palBtns { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
    .palBtns button { border-width: 1px; border-color: var(--orange-dim); padding: 4px 2px; font-size: 10px; }
    #iconGrid { display: grid; grid-template-columns: repeat(4, 34px); gap: 4px; }
    .iconCell {
        width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
        border: 1px solid var(--orange-dim); border-radius: 4px; cursor: grab;
        background: #000;
    }
    .iconCell:hover { border-color: var(--orange); }
    .iconCell canvas { image-rendering: pixelated; }
    #centerCol { display: flex; flex-direction: column; gap: 8px; align-items: center; flex: 0 0 auto; }
    #screenWrap {
        background: #ff8b27; padding: 10px; border-radius: 10px;
        border: 3px solid var(--orange-dim);
        box-shadow: 0 0 24px rgba(255,140,26,.15);
    }
    #screen { display: block; image-rendering: pixelated; cursor: crosshair; }
    #coords { font-size: 10px; color: var(--orange-dim); min-height: 14px; }
    #rightCol { width: 250px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 10px; }
    #layerList { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; }
    .layer {
        display: flex; align-items: center; gap: 6px;
        padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;
        border: 1px solid transparent;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .layer.sel { border-color: var(--sel); color: #cde6ff; }
    .layer:hover { background: rgba(255,140,26,.1); }
    #props { display: flex; flex-direction: column; gap: 5px; }
    .prow { display: flex; align-items: center; gap: 6px; }
    .prow label { width: 52px; font-size: 10px; color: var(--orange-dim); }
    .prow input[type=text] { flex: 1; min-width: 0; }
    #bottombar { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    #hint { font-size: 10px; color: var(--orange-dim); margin-top: 6px; line-height: 1.6; }
    #xbmBox { display: none; }
    #xbmBox.open { display: block; }
    #xbmBox textarea { width: 100%; height: 64px; font-size: 10px; }
    .rowBtns { display: flex; gap: 4px; flex-wrap: wrap; }
    #codePanel { margin-top: 10px; max-width: 980px; }
    #codeArea {
        width: 100%; height: 190px; resize: vertical;
        background: #000; color: #e8e6e3;
        font-size: 11px; line-height: 1.5; white-space: pre; overflow: auto;
        user-select: text;
    }
    #codeStatus { font-size: 9px; color: var(--orange-dim); text-transform: none; letter-spacing: 0; }
</style>
</head>
<body>
    <div id="toolbar">
        <span class="title">FLIPPER&nbsp;UI&nbsp;DESIGNER</span>
        <label style="font-size:10px;color:var(--orange-dim)">APP</label>
        <input type="text" id="appName" value="my_ui_app" size="16" title="App id (snake_case) — used for application.fam and folder name">
        <div id="screenTabs"></div>
        <button class="small" id="btnAddScreen" title="Add a new screen">+ SCREEN</button>
        <span style="flex:1"></span>
        <label style="font-size:10px;color:var(--orange-dim)">ZOOM</label>
        <select id="zoom"><option>4</option><option selected>5</option><option>6</option><option>7</option></select>
        <button class="small" id="btnGrid" title="Toggle pixel grid">GRID</button>
        <button class="small" id="btnUndo" title="Undo (Ctrl+Z)">↶</button>
        <button class="small" id="btnRedo" title="Redo (Ctrl+Y)">↷</button>
    </div>

    <div id="layout">
        <div id="palette">
            <div class="panel">
                <h3>Elements</h3>
                <div class="palBtns">
                    <button data-add="text">TEXT</button>
                    <button data-add="box">BOX</button>
                    <button data-add="frame">FRAME</button>
                    <button data-add="rbox">RBOX</button>
                    <button data-add="rframe">RFRAME</button>
                    <button data-add="line">LINE</button>
                    <button data-add="circle">CIRCLE</button>
                    <button data-add="disc">DISC</button>
                    <button data-add="dot">DOT</button>
                    <button data-add="button" title="Standard Flipper soft-button (elements_button_left/center/right)">BUTTON</button>
                </div>
            </div>
            <div class="panel">
                <h3>Templates — adds a screen</h3>
                <div class="palBtns">
                    <button data-tpl="dialog">DIALOG</button>
                    <button data-tpl="menu">MENU</button>
                    <button data-tpl="splash">SPLASH</button>
                    <button data-tpl="buttons">BUTTONS</button>
                    <button data-tpl="hud">HUD</button>
                </div>
            </div>
            <div class="panel">
                <h3>Icons — drag onto screen</h3>
                <div id="iconGrid"></div>
                <button class="small" id="btnXbm" style="margin-top:6px">+ PASTE XBM…</button>
                <div id="xbmBox">
                    <div class="prow"><label>name</label><input type="text" id="xbmName" value="my_icon"></div>
                    <div class="prow"><label>w × h</label><input type="number" id="xbmW" value="8"> <input type="number" id="xbmH" value="8"></div>
                    <textarea id="xbmData" placeholder="0x18, 0x3C, 0x7E, ... (XBM bytes, row-major, LSB first)"></textarea>
                    <button class="small" id="btnXbmAdd">ADD ICON</button>
                </div>
            </div>
        </div>

        <div id="centerCol">
            <div id="screenWrap"><canvas id="screen" width="128" height="64"></canvas></div>
            <div id="coords"></div>
        </div>

        <div id="rightCol">
            <div class="panel">
                <h3>Screen</h3>
                <div class="prow"><label>name</label><input type="text" id="screenName"></div>
                <div class="rowBtns" style="margin-top:5px">
                    <button class="small" id="btnDupScreen" title="Duplicate this screen">DUP</button>
                    <button class="small" id="btnDelScreen" title="Delete this screen">DELETE</button>
                    <button class="small" id="btnScreenLeft" title="Move screen earlier">◀</button>
                    <button class="small" id="btnScreenRight" title="Move screen later">▶</button>
                </div>
            </div>
            <div class="panel">
                <h3>Layers</h3>
                <div id="layerList"></div>
                <div class="rowBtns" style="margin-top:5px">
                    <button class="small" id="btnElUp" title="Bring forward">▲</button>
                    <button class="small" id="btnElDown" title="Send back">▼</button>
                    <button class="small" id="btnElDup" title="Duplicate (Ctrl+D)">DUP</button>
                    <button class="small" id="btnElDel" title="Delete (Del)">DEL</button>
                </div>
            </div>
            <div class="panel">
                <h3>Properties</h3>
                <div id="props"><i style="color:var(--orange-dim);font-size:10px">Nothing selected — click an element on the screen.</i></div>
            </div>
        </div>
    </div>

    <div id="bottombar">
        <button id="btnCopyScreen" title="Copy this screen's draw code (canvas_* calls)">▣ COPY SCREEN CODE</button>
        <button id="btnInsert" title="Insert this screen's draw code at the cursor in the active editor">⇥ INSERT AT CURSOR</button>
        <button id="btnCopyApp" title="Copy a complete main.c with all screens">▣ COPY FULL APP</button>
        <button id="btnCreateApp" title="Create a ready-to-build app folder (application.fam + main.c) from this design">🗀 CREATE APP…</button>
        <button class="small" id="btnExport" title="Save this design as JSON">EXPORT</button>
        <button class="small" id="btnImport" title="Load a design JSON">IMPORT</button>
    </div>
    <div id="hint">Drag elements to move · arrows nudge (Shift = 5px) · Del removes · Ctrl+Z/Y undo/redo · Ctrl+D duplicate · Text preview is approximate — device fonts differ slightly. Generated app: ◀/▶ switch screens, Back exits.</div>

    <div class="panel" id="codePanel">
        <h3>Code — current screen, edits sync both ways &nbsp;<span id="codeStatus"></span></h3>
        <textarea id="codeArea" spellcheck="false"></textarea>
    </div>

<script>
(function() {
    var vscode = acquireVsCodeApi();
    var NL = String.fromCharCode(10);
    var Q = String.fromCharCode(34);

    // ── 5x7 font ──────────────────────────────────────────────────────────────
    var FONT = (function() {
        var bin = atob('${FONT_B64}');
        var a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return a;
    })();

    // ── built-in icons (rows of '1'/'0', row-major) ───────────────────────────
    var BUILTIN_ICONS = {
        arrow_up:    ['00011000','00111100','01111110','11111111','00011000','00011000','00011000','00011000'],
        arrow_down:  ['00011000','00011000','00011000','00011000','11111111','01111110','00111100','00011000'],
        arrow_left:  ['00010000','00110000','01110000','11111111','11111111','01110000','00110000','00010000'],
        arrow_right: ['00001000','00001100','00001110','11111111','11111111','00001110','00001100','00001000'],
        ok_disc:     ['00111100','01111110','11111111','11111111','11111111','11111111','01111110','00111100'],
        back:        ['00000000','00001000','00001100','11111110','11111111','00001101','00001001','00000000'],
        check:       ['00000000','10000000','11000000','01100001','00110011','00011110','00001100','00000000'],
        cross:       ['00000000','01100110','00111100','00011000','00111100','01100110','00000000','00000000'],
        heart:       ['01100110','11111111','11111111','11111111','01111110','00111100','00011000','00000000'],
        star:        ['00011000','00011000','01111110','11111111','00111100','00111100','01100110','01000010'],
        bell:        ['00011000','00111100','00111100','01111110','01111110','11111111','00000000','00011000'],
        gear:        ['00100100','01111110','11011011','01100110','01100110','11011011','01111110','00100100'],
        lock:        ['00111100','01000010','01000010','11111111','11111111','11100111','11100111','11111111'],
        bluetooth:   ['00011000','00010100','01010010','00110100','00011000','00110100','01010010','00010100'],
        battery:     ['111111111100','100000000110','101101101110','101101101111','101101101111','101101101110','100000000110','111111111100'],
        wifi:        ['001111111100','010000000010','100111111001','001000000100','000011110000','000100001000','000001100000','000001100000'],
        signal:      ['000000000011','000000000011','000000011011','000000011011','000011011011','000011011011','011011011011','011011011011'],
        sd_card:     ['00111110','01111110','01011010','01011010','01111110','01011010','01100110','01111110'],
    };
    var icons = {}; // name → {w,h,rows:[bool[]]}
    function addIconDef(name, rows) {
        var h = rows.length, w = rows[0].length;
        var grid = [];
        for (var y = 0; y < h; y++) {
            var r = [];
            for (var x = 0; x < w; x++) r.push(rows[y].charAt(x) === '1');
            grid.push(r);
        }
        icons[name] = { w: w, h: h, rows: grid };
    }
    for (var k in BUILTIN_ICONS) addIconDef(k, BUILTIN_ICONS[k]);

    // ── model ─────────────────────────────────────────────────────────────────
    var design = { appName: 'my_ui_app', screens: [{ name: 'main', elements: [] }] };
    var cur = 0;          // current screen index
    var sel = -1;         // selected element index
    var zoom = 5;
    var showGrid = false;
    var undoStack = [], redoStack = [];
    var nextId = 1;

    function screen() { return design.screens[cur]; }
    function selEl() { return sel >= 0 ? screen().elements[sel] : null; }

    function pushUndo() {
        undoStack.push(JSON.stringify(design));
        if (undoStack.length > 60) undoStack.shift();
        redoStack = [];
    }
    function undo() {
        if (!undoStack.length) return;
        redoStack.push(JSON.stringify(design));
        design = JSON.parse(undoStack.pop());
        clampSel(); renderAll(); save();
    }
    function redo() {
        if (!redoStack.length) return;
        undoStack.push(JSON.stringify(design));
        design = JSON.parse(redoStack.pop());
        clampSel(); renderAll(); save();
    }
    function clampSel() {
        if (cur >= design.screens.length) cur = design.screens.length - 1;
        if (sel >= screen().elements.length) sel = -1;
    }

    var saveTimer = null;
    function save() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(function() {
            vscode.postMessage({ type: 'saveState', json: JSON.stringify(design) });
        }, 600);
    }

    // ── 1-bit framebuffer rendering ───────────────────────────────────────────
    var buf = new Uint8Array(128 * 64);
    function setPx(x, y, v) {
        x = Math.round(x); y = Math.round(y);
        if (x >= 0 && x < 128 && y >= 0 && y < 64) buf[y * 128 + x] = v === undefined ? 1 : v;
    }
    function drawBoxPx(x, y, w, h) {
        for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) setPx(x + i, y + j);
    }
    function inRB(px, py, x, y, w, h, r) {
        if (px < x || py < y || px >= x + w || py >= y + h) return false;
        var cx = -1, cy = -1;
        if (px < x + r && py < y + r) { cx = x + r - 1; cy = y + r - 1; }
        else if (px >= x + w - r && py < y + r) { cx = x + w - r; cy = y + r - 1; }
        else if (px < x + r && py >= y + h - r) { cx = x + r - 1; cy = y + h - r; }
        else if (px >= x + w - r && py >= y + h - r) { cx = x + w - r; cy = y + h - r; }
        if (cx < 0) return true;
        var dx = px - cx, dy = py - cy;
        return dx * dx + dy * dy <= r * r + 1;
    }
    function drawRBox(x, y, w, h, r, fill) {
        r = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
        for (var py = y; py < y + h; py++) for (var px = x; px < x + w; px++) {
            if (!inRB(px, py, x, y, w, h, r)) continue;
            if (fill) { setPx(px, py); continue; }
            if (!inRB(px - 1, py, x, y, w, h, r) || !inRB(px + 1, py, x, y, w, h, r) ||
                !inRB(px, py - 1, x, y, w, h, r) || !inRB(px, py + 1, x, y, w, h, r)) setPx(px, py);
        }
    }
    function drawLinePx(x0, y0, x1, y1) {
        var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
        var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
        while (true) {
            setPx(x0, y0);
            if (x0 === x1 && y0 === y1) break;
            var e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }
    function drawCirclePx(cx, cy, r, fill) {
        for (var y = -r; y <= r; y++) for (var x = -r; x <= r; x++) {
            var d = x * x + y * y;
            if (fill ? d <= r * r : (d <= r * r && d >= (r - 1) * (r - 1) - 1)) setPx(cx + x, cy + y);
        }
    }
    function glyphCols(ch) {
        var c = ch.charCodeAt(0);
        if (c < 32 || c > 126) c = 63; // '?'
        var o = (c - 32) * 5, cols = [];
        for (var i = 0; i < 5; i++) cols.push(FONT[o + i]);
        return cols;
    }
    function drawTextPx(x, yBase, text, font, ink) {
        var scale = font === 'FontBigNumbers' ? 2 : 1;
        var bold = font === 'FontPrimary';
        var top = yBase - 6 * scale;
        var px = x;
        var v = ink === undefined ? 1 : ink;
        for (var n = 0; n < text.length; n++) {
            var cols = glyphCols(text.charAt(n));
            for (var i = 0; i < 5; i++) {
                for (var j = 0; j < 7; j++) {
                    if ((cols[i] >> j) & 1) {
                        for (var sy = 0; sy < scale; sy++) for (var sx = 0; sx < scale; sx++) {
                            setPx(px + i * scale + sx, top + j * scale + sy, v);
                            if (bold) setPx(px + i * scale + sx + 1, top + j * scale + sy, v);
                        }
                    }
                }
            }
            px += (5 * scale) + (bold ? 2 : 1) * scale;
        }
        return px - x;
    }

    // ── Flipper soft-buttons (elements_button_left/center/right) ─────────────
    function btnDisplay(el) {
        if (el.pos === 'left') return '<' + el.text;
        if (el.pos === 'right') return el.text + '>';
        return el.text;
    }
    function buttonMetrics(el) {
        var w = textWidth(btnDisplay(el), 'FontSecondary') + 9;
        var x = el.pos === 'left' ? 0 : el.pos === 'right' ? 128 - w : Math.floor((128 - w) / 2);
        return { x: x, y: 53, w: w, h: 11 };
    }
    function drawButtonPx(el) {
        var m = buttonMetrics(el);
        drawRBox(m.x, m.y, m.w, m.h, 2, true);
        drawTextPx(m.x + 5, 61, btnDisplay(el), 'FontSecondary', 0);
    }
    function textWidth(text, font) {
        var scale = font === 'FontBigNumbers' ? 2 : 1;
        var adv = (5 * scale) + (font === 'FontPrimary' ? 2 : 1) * scale;
        return text.length * adv;
    }
    function drawIconPx(x, y, name) {
        var ic = icons[name];
        if (!ic) return;
        for (var j = 0; j < ic.h; j++) for (var i = 0; i < ic.w; i++)
            if (ic.rows[j][i]) setPx(x + i, y + j);
    }

    function renderElement(el) {
        if (el.type === 'text') drawTextPx(el.x, el.y, el.text, el.font);
        else if (el.type === 'box') drawBoxPx(el.x, el.y, el.w, el.h);
        else if (el.type === 'frame') { drawLinePx(el.x, el.y, el.x + el.w - 1, el.y); drawLinePx(el.x, el.y + el.h - 1, el.x + el.w - 1, el.y + el.h - 1); drawLinePx(el.x, el.y, el.x, el.y + el.h - 1); drawLinePx(el.x + el.w - 1, el.y, el.x + el.w - 1, el.y + el.h - 1); }
        else if (el.type === 'rbox') drawRBox(el.x, el.y, el.w, el.h, el.r, true);
        else if (el.type === 'rframe') drawRBox(el.x, el.y, el.w, el.h, el.r, false);
        else if (el.type === 'line') drawLinePx(el.x, el.y, el.x2, el.y2);
        else if (el.type === 'circle') drawCirclePx(el.x, el.y, el.r, false);
        else if (el.type === 'disc') drawCirclePx(el.x, el.y, el.r, true);
        else if (el.type === 'dot') setPx(el.x, el.y);
        else if (el.type === 'icon') drawIconPx(el.x, el.y, el.icon);
        else if (el.type === 'button') drawButtonPx(el);
    }

    function elBounds(el) {
        if (el.type === 'text') { var w = textWidth(el.text, el.font); var hh = el.font === 'FontBigNumbers' ? 14 : 8; return { x: el.x, y: el.y - hh + 1, w: Math.max(w, 3), h: hh }; }
        if (el.type === 'line') { return { x: Math.min(el.x, el.x2) - 1, y: Math.min(el.y, el.y2) - 1, w: Math.abs(el.x2 - el.x) + 3, h: Math.abs(el.y2 - el.y) + 3 }; }
        if (el.type === 'circle' || el.type === 'disc') { return { x: el.x - el.r, y: el.y - el.r, w: el.r * 2 + 1, h: el.r * 2 + 1 }; }
        if (el.type === 'dot') { return { x: el.x - 1, y: el.y - 1, w: 3, h: 3 }; }
        if (el.type === 'icon') { var ic = icons[el.icon] || { w: 8, h: 8 }; return { x: el.x, y: el.y, w: ic.w, h: ic.h }; }
        if (el.type === 'button') { return buttonMetrics(el); }
        return { x: el.x, y: el.y, w: el.w, h: el.h };
    }

    var canvas = document.getElementById('screen');
    var ctx = canvas.getContext('2d');

    function renderCanvas() {
        canvas.width = 128 * zoom;
        canvas.height = 64 * zoom;
        buf.fill(0);
        var els = screen().elements;
        for (var i = 0; i < els.length; i++) renderElement(els[i]);
        ctx.fillStyle = '#ff8b27';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#1e1005';
        for (var y = 0; y < 64; y++) for (var x = 0; x < 128; x++)
            if (buf[y * 128 + x]) ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
        if (showGrid && zoom >= 5) {
            ctx.strokeStyle = 'rgba(0,0,0,.12)';
            ctx.lineWidth = 1;
            for (var gx = 0; gx <= 128; gx++) { ctx.beginPath(); ctx.moveTo(gx * zoom + .5, 0); ctx.lineTo(gx * zoom + .5, canvas.height); ctx.stroke(); }
            for (var gy = 0; gy <= 64; gy++) { ctx.beginPath(); ctx.moveTo(0, gy * zoom + .5); ctx.lineTo(canvas.width, gy * zoom + .5); ctx.stroke(); }
        }
        var e = selEl();
        if (e) {
            var b = elBounds(e);
            ctx.strokeStyle = '#58a6ff';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(b.x * zoom - 2, b.y * zoom - 2, b.w * zoom + 4, b.h * zoom + 4);
            ctx.setLineDash([]);
        }
    }

    // ── UI rendering ──────────────────────────────────────────────────────────
    function renderTabs() {
        var tabs = document.getElementById('screenTabs');
        tabs.innerHTML = '';
        design.screens.forEach(function(s, i) {
            var t = document.createElement('div');
            t.className = 'tab' + (i === cur ? ' cur' : '');
            t.textContent = s.name;
            t.onclick = function() { cur = i; sel = -1; renderAll(); };
            tabs.appendChild(t);
        });
        document.getElementById('screenName').value = screen().name;
    }
    function renderLayers() {
        var list = document.getElementById('layerList');
        list.innerHTML = '';
        var els = screen().elements;
        for (var i = els.length - 1; i >= 0; i--) {
            (function(i) {
                var el = els[i];
                var d = document.createElement('div');
                d.className = 'layer' + (i === sel ? ' sel' : '');
                var label = el.type;
                if (el.type === 'text') label += ' ' + Q + el.text + Q;
                if (el.type === 'icon') label += ' ' + el.icon;
                if (el.type === 'button') label += ' ' + el.pos + ' ' + Q + el.text + Q;
                d.textContent = (i + 1) + '. ' + label;
                d.onclick = function() { sel = i; renderAll(); };
                list.appendChild(d);
            })(i);
        }
    }
    function prow(labelText, inputEl) {
        var d = document.createElement('div');
        d.className = 'prow';
        var l = document.createElement('label');
        l.textContent = labelText;
        d.appendChild(l);
        d.appendChild(inputEl);
        return d;
    }
    function numInput(val, cb) {
        var i = document.createElement('input');
        i.type = 'number'; i.value = val;
        i.addEventListener('change', function() { pushUndo(); cb(parseInt(i.value, 10) || 0); renderAll(); save(); });
        return i;
    }
    function renderProps() {
        var box = document.getElementById('props');
        box.innerHTML = '';
        var el = selEl();
        if (!el) {
            box.innerHTML = '<i style="color:var(--orange-dim);font-size:10px">Nothing selected — click an element on the screen.</i>';
            return;
        }
        var title = document.createElement('div');
        title.style.cssText = 'font-size:11px;margin-bottom:3px';
        title.textContent = 'TYPE: ' + el.type.toUpperCase();
        box.appendChild(title);
        if (el.type === 'text') {
            var t = document.createElement('input');
            t.type = 'text'; t.value = el.text;
            t.addEventListener('change', function() { pushUndo(); el.text = t.value; renderAll(); save(); });
            box.appendChild(prow('text', t));
            var f = document.createElement('select');
            ['FontPrimary', 'FontSecondary', 'FontBigNumbers'].forEach(function(fn) {
                var o = document.createElement('option');
                o.value = fn; o.textContent = fn; if (el.font === fn) o.selected = true;
                f.appendChild(o);
            });
            f.addEventListener('change', function() { pushUndo(); el.font = f.value; renderAll(); save(); });
            box.appendChild(prow('font', f));
            box.appendChild(prow('x', numInput(el.x, function(v) { el.x = v; })));
            box.appendChild(prow('y (base)', numInput(el.y, function(v) { el.y = v; })));
        } else if (el.type === 'line') {
            box.appendChild(prow('x1', numInput(el.x, function(v) { el.x = v; })));
            box.appendChild(prow('y1', numInput(el.y, function(v) { el.y = v; })));
            box.appendChild(prow('x2', numInput(el.x2, function(v) { el.x2 = v; })));
            box.appendChild(prow('y2', numInput(el.y2, function(v) { el.y2 = v; })));
        } else if (el.type === 'circle' || el.type === 'disc') {
            box.appendChild(prow('cx', numInput(el.x, function(v) { el.x = v; })));
            box.appendChild(prow('cy', numInput(el.y, function(v) { el.y = v; })));
            box.appendChild(prow('r', numInput(el.r, function(v) { el.r = Math.max(1, v); })));
        } else if (el.type === 'dot') {
            box.appendChild(prow('x', numInput(el.x, function(v) { el.x = v; })));
            box.appendChild(prow('y', numInput(el.y, function(v) { el.y = v; })));
        } else if (el.type === 'button') {
            var bt = document.createElement('input');
            bt.type = 'text'; bt.value = el.text;
            bt.addEventListener('change', function() { pushUndo(); el.text = bt.value; renderAll(); save(); });
            box.appendChild(prow('label', bt));
            var bp = document.createElement('select');
            ['left', 'center', 'right'].forEach(function(pos) {
                var o = document.createElement('option');
                o.value = pos; o.textContent = pos; if (el.pos === pos) o.selected = true;
                bp.appendChild(o);
            });
            bp.addEventListener('change', function() { pushUndo(); el.pos = bp.value; renderAll(); save(); });
            box.appendChild(prow('position', bp));
            var note = document.createElement('div');
            note.style.cssText = 'font-size:9px;color:var(--orange-dim)';
            note.textContent = 'Standard bottom bar button — position is fixed by the firmware.';
            box.appendChild(note);
        } else if (el.type === 'icon') {
            var lab = document.createElement('div');
            lab.style.cssText = 'font-size:10px;color:var(--orange-dim)';
            var ic = icons[el.icon] || { w: '?', h: '?' };
            lab.textContent = el.icon + ' (' + ic.w + 'x' + ic.h + ')';
            box.appendChild(lab);
            box.appendChild(prow('x', numInput(el.x, function(v) { el.x = v; })));
            box.appendChild(prow('y', numInput(el.y, function(v) { el.y = v; })));
        } else {
            box.appendChild(prow('x', numInput(el.x, function(v) { el.x = v; })));
            box.appendChild(prow('y', numInput(el.y, function(v) { el.y = v; })));
            box.appendChild(prow('w', numInput(el.w, function(v) { el.w = Math.max(1, v); })));
            box.appendChild(prow('h', numInput(el.h, function(v) { el.h = Math.max(1, v); })));
            if (el.type === 'rbox' || el.type === 'rframe') {
                box.appendChild(prow('radius', numInput(el.r, function(v) { el.r = Math.max(0, v); })));
            }
        }
    }
    function renderAll() {
        renderTabs(); renderCanvas(); renderLayers(); renderProps();
        renderCode();
    }

    // ── icon palette ──────────────────────────────────────────────────────────
    function renderIconGrid() {
        var grid = document.getElementById('iconGrid');
        grid.innerHTML = '';
        Object.keys(icons).forEach(function(name) {
            var ic = icons[name];
            var cell = document.createElement('div');
            cell.className = 'iconCell';
            cell.title = name + ' (' + ic.w + 'x' + ic.h + ') — drag onto the screen';
            cell.draggable = true;
            var c = document.createElement('canvas');
            c.width = ic.w; c.height = ic.h;
            var scale = Math.max(1, Math.floor(26 / Math.max(ic.w, ic.h)));
            c.style.width = (ic.w * scale) + 'px';
            c.style.height = (ic.h * scale) + 'px';
            var g = c.getContext('2d');
            g.fillStyle = '#ff8c1a';
            for (var y = 0; y < ic.h; y++) for (var x = 0; x < ic.w; x++)
                if (ic.rows[y][x]) g.fillRect(x, y, 1, 1);
            cell.appendChild(c);
            cell.addEventListener('dragstart', function(e) {
                e.dataTransfer.setData('text/plain', 'icon:' + name);
            });
            cell.addEventListener('click', function() { addElement('icon', { icon: name }); });
            grid.appendChild(cell);
        });
    }

    // ── element creation ──────────────────────────────────────────────────────
    function addElement(type, extra, atX, atY) {
        pushUndo();
        var x = atX === undefined ? 40 : atX;
        var y = atY === undefined ? 24 : atY;
        var el = { id: nextId++, type: type, x: x, y: y };
        if (type === 'text') { el.text = 'Text'; el.font = 'FontSecondary'; el.y = Math.max(8, y); }
        else if (type === 'box' || type === 'frame') { el.w = 30; el.h = 14; }
        else if (type === 'rbox' || type === 'rframe') { el.w = 34; el.h = 14; el.r = 3; }
        else if (type === 'line') { el.x2 = x + 24; el.y2 = y; }
        else if (type === 'circle' || type === 'disc') { el.r = 7; }
        else if (type === 'icon') { el.icon = extra.icon; }
        else if (type === 'button') { el.pos = 'center'; el.text = 'OK'; }
        screen().elements.push(el);
        sel = screen().elements.length - 1;
        renderAll(); save();
    }
    document.querySelectorAll('[data-add]').forEach(function(b) {
        b.addEventListener('click', function() { addElement(b.dataset.add, {}); });
    });

    // ── starter templates (each adds a new screen) ────────────────────────────
    var TEMPLATES = {
        dialog: { name: 'dialog', elements: [
            { type: 'rframe', x: 4, y: 4, w: 120, h: 44, r: 4 },
            { type: 'text', x: 42, y: 18, text: 'Title', font: 'FontPrimary' },
            { type: 'text', x: 26, y: 32, text: 'Are you sure?', font: 'FontSecondary' },
            { type: 'button', x: 0, y: 0, pos: 'left', text: 'No' },
            { type: 'button', x: 0, y: 0, pos: 'right', text: 'Yes' },
        ] },
        menu: { name: 'menu', elements: [
            { type: 'text', x: 4, y: 11, text: 'Menu', font: 'FontPrimary' },
            { type: 'line', x: 0, y: 14, x2: 127, y2: 14 },
            { type: 'rframe', x: 2, y: 19, w: 124, h: 13, r: 2 },
            { type: 'text', x: 8, y: 28, text: 'First item', font: 'FontSecondary' },
            { type: 'text', x: 8, y: 41, text: 'Second item', font: 'FontSecondary' },
            { type: 'text', x: 8, y: 54, text: 'Third item', font: 'FontSecondary' },
        ] },
        splash: { name: 'splash', elements: [
            { type: 'icon', x: 60, y: 6, icon: 'star' },
            { type: 'text', x: 43, y: 32, text: 'My App', font: 'FontPrimary' },
            { type: 'text', x: 52, y: 44, text: 'v1.0', font: 'FontSecondary' },
            { type: 'button', x: 0, y: 0, pos: 'center', text: 'Start' },
        ] },
        buttons: { name: 'buttons', elements: [
            { type: 'text', x: 34, y: 30, text: 'Content here', font: 'FontSecondary' },
            { type: 'button', x: 0, y: 0, pos: 'left', text: 'Back' },
            { type: 'button', x: 0, y: 0, pos: 'center', text: 'OK' },
            { type: 'button', x: 0, y: 0, pos: 'right', text: 'Next' },
        ] },
        hud: { name: 'hud', elements: [
            { type: 'icon', x: 2, y: 1, icon: 'signal' },
            { type: 'icon', x: 114, y: 1, icon: 'battery' },
            { type: 'text', x: 40, y: 9, text: 'MY DEVICE', font: 'FontSecondary' },
            { type: 'line', x: 0, y: 12, x2: 127, y2: 12 },
            { type: 'rframe', x: 14, y: 20, w: 100, h: 28, r: 3 },
            { type: 'text', x: 34, y: 37, text: 'Status: OK', font: 'FontSecondary' },
        ] },
    };
    document.querySelectorAll('[data-tpl]').forEach(function(b) {
        b.addEventListener('click', function() {
            var tpl = TEMPLATES[b.dataset.tpl];
            if (!tpl) return;
            pushUndo();
            var copy = JSON.parse(JSON.stringify(tpl));
            var base = copy.name;
            var n = 1;
            while (design.screens.some(function(s) { return s.name === copy.name; })) { copy.name = base + '_' + (++n); }
            copy.elements.forEach(function(el) { el.id = nextId++; if (el.x === undefined) el.x = 0; if (el.y === undefined) el.y = 0; });
            design.screens.push(copy);
            cur = design.screens.length - 1;
            sel = -1;
            renderAll(); save();
        });
    });

    // ── canvas interactions ───────────────────────────────────────────────────
    var drag = null;
    function evPx(e) {
        var r = canvas.getBoundingClientRect();
        return {
            x: Math.floor((e.clientX - r.left) / zoom),
            y: Math.floor((e.clientY - r.top) / zoom),
        };
    }
    canvas.addEventListener('mousedown', function(e) {
        var p = evPx(e);
        var els = screen().elements;
        var hit = -1;
        for (var i = els.length - 1; i >= 0; i--) {
            var b = elBounds(els[i]);
            if (p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h) { hit = i; break; }
        }
        sel = hit;
        if (hit >= 0) {
            var el = els[hit];
            pushUndo();
            drag = { dx: p.x - el.x, dy: p.y - el.y, lx: el.type === 'line' ? el.x2 - el.x : 0, ly: el.type === 'line' ? el.y2 - el.y : 0, moved: false };
        }
        renderAll();
    });
    canvas.addEventListener('mousemove', function(e) {
        var p = evPx(e);
        document.getElementById('coords').textContent = p.x + ', ' + p.y;
        if (!drag) return;
        var el = selEl();
        if (!el) return;
        el.x = p.x - drag.dx;
        el.y = p.y - drag.dy;
        if (el.type === 'line') { el.x2 = el.x + drag.lx; el.y2 = el.y + drag.ly; }
        drag.moved = true;
        renderCanvas(); renderProps();
    });
    window.addEventListener('mouseup', function() {
        if (drag) {
            if (!drag.moved) undoStack.pop(); // click without move — drop the snapshot
            drag = null;
            renderCode();
            save();
        }
    });
    canvas.addEventListener('dragover', function(e) { e.preventDefault(); });
    canvas.addEventListener('drop', function(e) {
        e.preventDefault();
        var data = e.dataTransfer.getData('text/plain');
        if (data && data.indexOf('icon:') === 0) {
            var p = evPx(e);
            addElement('icon', { icon: data.slice(5) }, p.x, p.y);
        }
    });

    window.addEventListener('keydown', function(e) {
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
        if (e.ctrlKey && (e.code === 'KeyY' || (e.shiftKey && e.code === 'KeyZ'))) { e.preventDefault(); redo(); return; }
        if (e.ctrlKey && e.code === 'KeyD') { e.preventDefault(); dupSelected(); return; }
        var el = selEl();
        if (!el) return;
        var step = e.shiftKey ? 5 : 1;
        var moved = true;
        if (e.code === 'ArrowUp') { el.y -= step; if (el.type === 'line') el.y2 -= step; }
        else if (e.code === 'ArrowDown') { el.y += step; if (el.type === 'line') el.y2 += step; }
        else if (e.code === 'ArrowLeft') { el.x -= step; if (el.type === 'line') el.x2 -= step; }
        else if (e.code === 'ArrowRight') { el.x += step; if (el.type === 'line') el.x2 += step; }
        else if (e.code === 'Delete' || e.code === 'Backspace') { delSelected(); return; }
        else moved = false;
        if (moved) { e.preventDefault(); renderCanvas(); renderProps(); renderCode(); save(); }
    });

    function dupSelected() {
        var el = selEl();
        if (!el) return;
        pushUndo();
        var copy = JSON.parse(JSON.stringify(el));
        copy.id = nextId++;
        copy.x += 4; copy.y += 4;
        if (copy.type === 'line') { copy.x2 += 4; copy.y2 += 4; }
        screen().elements.push(copy);
        sel = screen().elements.length - 1;
        renderAll(); save();
    }
    function delSelected() {
        if (sel < 0) return;
        pushUndo();
        screen().elements.splice(sel, 1);
        sel = -1;
        renderAll(); save();
    }
    document.getElementById('btnElDel').onclick = delSelected;
    document.getElementById('btnElDup').onclick = dupSelected;
    document.getElementById('btnElUp').onclick = function() {
        if (sel < 0 || sel >= screen().elements.length - 1) return;
        pushUndo();
        var els = screen().elements;
        var t = els[sel]; els[sel] = els[sel + 1]; els[sel + 1] = t;
        sel++; renderAll(); save();
    };
    document.getElementById('btnElDown').onclick = function() {
        if (sel <= 0) return;
        pushUndo();
        var els = screen().elements;
        var t = els[sel]; els[sel] = els[sel - 1]; els[sel - 1] = t;
        sel--; renderAll(); save();
    };

    // ── screens ───────────────────────────────────────────────────────────────
    document.getElementById('btnAddScreen').onclick = function() {
        pushUndo();
        design.screens.push({ name: 'screen_' + (design.screens.length + 1), elements: [] });
        cur = design.screens.length - 1;
        sel = -1;
        renderAll(); save();
    };
    document.getElementById('btnDelScreen').onclick = function() {
        if (design.screens.length <= 1) return;
        pushUndo();
        design.screens.splice(cur, 1);
        cur = Math.max(0, cur - 1);
        sel = -1;
        renderAll(); save();
    };
    document.getElementById('btnDupScreen').onclick = function() {
        pushUndo();
        var copy = JSON.parse(JSON.stringify(screen()));
        copy.name = screen().name + '_copy';
        design.screens.splice(cur + 1, 0, copy);
        cur++;
        renderAll(); save();
    };
    document.getElementById('btnScreenLeft').onclick = function() {
        if (cur <= 0) return;
        pushUndo();
        var s = design.screens[cur]; design.screens[cur] = design.screens[cur - 1]; design.screens[cur - 1] = s;
        cur--; renderAll(); save();
    };
    document.getElementById('btnScreenRight').onclick = function() {
        if (cur >= design.screens.length - 1) return;
        pushUndo();
        var s = design.screens[cur]; design.screens[cur] = design.screens[cur + 1]; design.screens[cur + 1] = s;
        cur++; renderAll(); save();
    };
    document.getElementById('screenName').addEventListener('change', function() {
        pushUndo();
        screen().name = cIdent(this.value) || screen().name;
        renderAll(); save();
    });
    document.getElementById('appName').addEventListener('change', function() {
        design.appName = cIdent(this.value) || design.appName;
        this.value = design.appName;
        save();
    });

    // ── custom XBM icons ──────────────────────────────────────────────────────
    document.getElementById('btnXbm').onclick = function() {
        document.getElementById('xbmBox').classList.toggle('open');
    };
    document.getElementById('btnXbmAdd').onclick = function() {
        var name = cIdent(document.getElementById('xbmName').value) || 'my_icon';
        var w = parseInt(document.getElementById('xbmW').value, 10) || 8;
        var h = parseInt(document.getElementById('xbmH').value, 10) || 8;
        var m = document.getElementById('xbmData').value.match(/0x[0-9A-Fa-f]{1,2}/g);
        if (!m) return;
        var bytes = m.map(function(s) { return parseInt(s, 16); });
        var bpr = Math.ceil(w / 8);
        var rows = [];
        for (var y = 0; y < h; y++) {
            var row = '';
            for (var x = 0; x < w; x++) {
                var b = bytes[y * bpr + (x >> 3)] || 0;
                row += ((b >> (x & 7)) & 1) ? '1' : '0';
            }
            rows.push(row);
        }
        addIconDef(name, rows);
        renderIconGrid();
        document.getElementById('xbmBox').classList.remove('open');
        save();
    };

    // ── toolbar ───────────────────────────────────────────────────────────────
    document.getElementById('zoom').addEventListener('change', function() {
        zoom = parseInt(this.value, 10);
        renderCanvas();
    });
    document.getElementById('btnGrid').onclick = function() {
        showGrid = !showGrid;
        this.classList.toggle('active', showGrid);
        renderCanvas();
    };
    document.getElementById('btnUndo').onclick = undo;
    document.getElementById('btnRedo').onclick = redo;

    // ── code generation ───────────────────────────────────────────────────────
    function cIdent(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, '_$1');
    }
    function pascal(s) {
        return cIdent(s).split('_').map(function(p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join('');
    }
    function escC(s) {
        var out = '';
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i), c = s.charCodeAt(i);
            if (ch === Q) out += String.fromCharCode(92) + Q;
            else if (c === 92) out += String.fromCharCode(92, 92);
            else if (c >= 32 && c < 127) out += ch;
        }
        return out;
    }
    function usedIcons(screens) {
        var names = {};
        screens.forEach(function(s) {
            s.elements.forEach(function(el) { if (el.type === 'icon' && icons[el.icon]) names[el.icon] = true; });
        });
        return Object.keys(names);
    }
    function iconArray(name) {
        var ic = icons[name];
        var bpr = Math.ceil(ic.w / 8);
        var bytes = [];
        for (var y = 0; y < ic.h; y++) {
            for (var bx = 0; bx < bpr; bx++) {
                var b = 0;
                for (var bit = 0; bit < 8; bit++) {
                    var x = bx * 8 + bit;
                    if (x < ic.w && ic.rows[y][x]) b |= (1 << bit);
                }
                bytes.push('0x' + (b < 16 ? '0' : '') + b.toString(16).toUpperCase());
            }
        }
        return 'static const uint8_t img_' + cIdent(name) + '[] = {' + bytes.join(', ') + '}; // ' + ic.w + 'x' + ic.h;
    }
    function screenCode(s, indent) {
        var lines = [];
        var font = null;
        s.elements.forEach(function(el) {
            if (el.type === 'text') {
                if (el.font !== font) { lines.push(indent + 'canvas_set_font(canvas, ' + el.font + ');'); font = el.font; }
                lines.push(indent + 'canvas_draw_str(canvas, ' + el.x + ', ' + el.y + ', ' + Q + escC(el.text) + Q + ');');
            }
            else if (el.type === 'box') lines.push(indent + 'canvas_draw_box(canvas, ' + el.x + ', ' + el.y + ', ' + el.w + ', ' + el.h + ');');
            else if (el.type === 'frame') lines.push(indent + 'canvas_draw_frame(canvas, ' + el.x + ', ' + el.y + ', ' + el.w + ', ' + el.h + ');');
            else if (el.type === 'rbox') lines.push(indent + 'canvas_draw_rbox(canvas, ' + el.x + ', ' + el.y + ', ' + el.w + ', ' + el.h + ', ' + el.r + ');');
            else if (el.type === 'rframe') lines.push(indent + 'canvas_draw_rframe(canvas, ' + el.x + ', ' + el.y + ', ' + el.w + ', ' + el.h + ', ' + el.r + ');');
            else if (el.type === 'line') lines.push(indent + 'canvas_draw_line(canvas, ' + el.x + ', ' + el.y + ', ' + el.x2 + ', ' + el.y2 + ');');
            else if (el.type === 'circle') lines.push(indent + 'canvas_draw_circle(canvas, ' + el.x + ', ' + el.y + ', ' + el.r + ');');
            else if (el.type === 'disc') lines.push(indent + 'canvas_draw_disc(canvas, ' + el.x + ', ' + el.y + ', ' + el.r + ');');
            else if (el.type === 'dot') lines.push(indent + 'canvas_draw_dot(canvas, ' + el.x + ', ' + el.y + ');');
            else if (el.type === 'icon' && icons[el.icon]) {
                var ic = icons[el.icon];
                lines.push(indent + 'canvas_draw_xbm(canvas, ' + el.x + ', ' + el.y + ', ' + ic.w + ', ' + ic.h + ', img_' + cIdent(el.icon) + ');');
            }
            else if (el.type === 'button') {
                lines.push(indent + 'elements_button_' + el.pos + '(canvas, ' + Q + escC(el.text) + Q + ');');
            }
        });
        return lines;
    }
    function usesButtons(screens) {
        return screens.some(function(s) {
            return s.elements.some(function(el) { return el.type === 'button'; });
        });
    }
    function snippetForScreen() {
        var s = screen();
        var parts = [];
        var iconNames = usedIcons([s]);
        if (iconNames.length) {
            parts.push('// Icon bitmaps (XBM, row-major LSB-first) — place at file scope:');
            iconNames.forEach(function(n) { parts.push(iconArray(n)); });
            parts.push('');
        }
        if (usesButtons([s])) {
            parts.push('// Soft-buttons need: #include <gui/elements.h>');
        }
        parts.push('// Screen: ' + s.name + ' (drawn inside your draw callback)');
        parts.push('canvas_clear(canvas);');
        parts = parts.concat(screenCode(s, ''));
        return parts.join(NL) + NL;
    }
    function fullApp() {
        var appId = design.appName;
        var screens = design.screens;
        var lines = [];
        lines.push('#include <furi.h>');
        lines.push('#include <gui/gui.h>');
        lines.push('#include <gui/view_port.h>');
        if (usesButtons(screens)) { lines.push('#include <gui/elements.h>'); }
        lines.push('');
        lines.push('// Generated by Flipper FAP Studio UI Designer');
        var iconNames = usedIcons(screens);
        if (iconNames.length) {
            lines.push('');
            iconNames.forEach(function(n) { lines.push(iconArray(n)); });
        }
        lines.push('');
        lines.push('typedef enum {');
        screens.forEach(function(s) { lines.push('    Screen' + pascal(s.name) + ','); });
        lines.push('    ScreenCount,');
        lines.push('} ' + pascal(appId) + 'Screen;');
        lines.push('');
        lines.push('typedef struct {');
        lines.push('    FuriMessageQueue* queue;');
        lines.push('    ' + pascal(appId) + 'Screen screen;');
        lines.push('} ' + pascal(appId) + 'App;');
        lines.push('');
        lines.push('static void draw_callback(Canvas* canvas, void* ctx) {');
        lines.push('    ' + pascal(appId) + 'App* app = ctx;');
        lines.push('    canvas_clear(canvas);');
        lines.push('    switch(app->screen) {');
        screens.forEach(function(s) {
            lines.push('    case Screen' + pascal(s.name) + ':');
            lines = lines.concat(screenCode(s, '        '));
            lines.push('        break;');
        });
        lines.push('    default:');
        lines.push('        break;');
        lines.push('    }');
        lines.push('}');
        lines.push('');
        lines.push('static void input_callback(InputEvent* event, void* ctx) {');
        lines.push('    ' + pascal(appId) + 'App* app = ctx;');
        lines.push('    furi_message_queue_put(app->queue, event, FuriWaitForever);');
        lines.push('}');
        lines.push('');
        lines.push('int32_t app_main(void* p) {');
        lines.push('    UNUSED(p);');
        lines.push('');
        lines.push('    ' + pascal(appId) + 'App app = {');
        lines.push('        .queue = furi_message_queue_alloc(8, sizeof(InputEvent)),');
        lines.push('        .screen = Screen' + pascal(screens[0].name) + ',');
        lines.push('    };');
        lines.push('');
        lines.push('    ViewPort* vp = view_port_alloc();');
        lines.push('    view_port_draw_callback_set(vp, draw_callback, &app);');
        lines.push('    view_port_input_callback_set(vp, input_callback, &app);');
        lines.push('');
        lines.push('    Gui* gui = furi_record_open(RECORD_GUI);');
        lines.push('    gui_add_view_port(gui, vp, GuiLayerFullscreen);');
        lines.push('');
        lines.push('    InputEvent event;');
        lines.push('    bool running = true;');
        lines.push('    while(running && furi_message_queue_get(app.queue, &event, FuriWaitForever) == FuriStatusOk) {');
        lines.push('        if(event.type != InputTypeShort) continue;');
        lines.push('        if(event.key == InputKeyBack) {');
        lines.push('            running = false;');
        lines.push('        } else if(event.key == InputKeyRight) {');
        lines.push('            app.screen = (' + pascal(appId) + 'Screen)((app.screen + 1) % ScreenCount);');
        lines.push('            view_port_update(vp);');
        lines.push('        } else if(event.key == InputKeyLeft) {');
        lines.push('            app.screen = (' + pascal(appId) + 'Screen)((app.screen + ScreenCount - 1) % ScreenCount);');
        lines.push('            view_port_update(vp);');
        lines.push('        }');
        lines.push('    }');
        lines.push('');
        lines.push('    gui_remove_view_port(gui, vp);');
        lines.push('    view_port_free(vp);');
        lines.push('    furi_record_close(RECORD_GUI);');
        lines.push('    furi_message_queue_free(app.queue);');
        lines.push('    return 0;');
        lines.push('}');
        return lines.join(NL) + NL;
    }
    function famText() {
        var appId = design.appName;
        var display = appId.split('_').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
        var lines = [];
        lines.push('App(');
        lines.push('    appid=' + Q + appId + Q + ',');
        lines.push('    name=' + Q + display + Q + ',');
        lines.push('    apptype=FlipperAppType.EXTERNAL,');
        lines.push('    entry_point=' + Q + 'app_main' + Q + ',');
        lines.push('    requires=[' + Q + 'gui' + Q + '],');
        lines.push('    stack_size=2048,');
        lines.push('    fap_version=(1, 0),');
        lines.push('    fap_category=' + Q + 'Misc' + Q + ',');
        lines.push(')');
        return lines.join(NL) + NL;
    }

    document.getElementById('btnCopyScreen').onclick = function() {
        vscode.postMessage({ type: 'copy', text: snippetForScreen(), what: 'screen draw code' });
    };
    document.getElementById('btnInsert').onclick = function() {
        vscode.postMessage({ type: 'insert', text: snippetForScreen() });
    };
    document.getElementById('btnCopyApp').onclick = function() {
        vscode.postMessage({ type: 'copy', text: fullApp(), what: 'full app main.c' });
    };
    document.getElementById('btnCreateApp').onclick = function() {
        vscode.postMessage({ type: 'createApp', appId: design.appName, famText: famText(), mainC: fullApp() });
    };
    document.getElementById('btnExport').onclick = function() {
        vscode.postMessage({ type: 'exportJson', json: JSON.stringify(design, null, 2), appId: design.appName });
    };
    document.getElementById('btnImport').onclick = function() {
        vscode.postMessage({ type: 'importJson' });
    };

    // ── code panel: generated code ⇄ elements (two-way sync) ─────────────────
    var codeArea = document.getElementById('codeArea');
    var codeStatus = document.getElementById('codeStatus');
    var codeEditing = false;
    var codeTimer = null;

    function renderCode() {
        if (codeEditing) return;
        var parts = ['// Screen: ' + screen().name + ' — edit this code and the canvas follows'];
        parts.push('canvas_clear(canvas);');
        parts = parts.concat(screenCode(screen(), ''));
        codeArea.value = parts.join(NL);
        codeStatus.textContent = '';
    }

    codeArea.addEventListener('focus', function() { codeEditing = true; });
    codeArea.addEventListener('blur', function() {
        codeEditing = false;
        if (codeTimer) { clearTimeout(codeTimer); codeTimer = null; applyCode(); }
        renderCode();
    });
    codeArea.addEventListener('input', function() {
        if (codeTimer) clearTimeout(codeTimer);
        codeTimer = setTimeout(function() { codeTimer = null; applyCode(); }, 600);
    });

    var reStr = /^canvas_draw_str\\s*\\(\\s*canvas\\s*,\\s*(-?[0-9]+)\\s*,\\s*(-?[0-9]+)\\s*,\\s*"(.*)"\\s*\\)$/;
    var reBtn = /^elements_button_(left|center|right)\\s*\\(\\s*canvas\\s*,\\s*"(.*)"\\s*\\)$/;
    function unesc(s) { return s.replace(/\\\\(.)/g, '$1'); }
    function stripLine(t) { return t.trim().replace(/[;]+$/, '').trim(); }
    function numArgs(t, name, count) {
        if (t.indexOf(name) !== 0) return null;
        var after = t.charAt(name.length);
        if (after !== '(' && after !== ' ') return null;
        var o = t.indexOf('('), c = t.lastIndexOf(')');
        if (o < 0 || c < o) return null;
        var parts = t.slice(o + 1, c).split(',').map(function(s) { return s.trim(); });
        if (parts[0] !== 'canvas' || parts.length !== count) return null;
        return parts;
    }

    function applyCode() {
        var lines = codeArea.value.split(NL);
        var els = [];
        var font = 'FontSecondary';
        var ignored = 0;
        for (var li = 0; li < lines.length; li++) {
            var t = stripLine(lines[li]);
            if (!t || t.indexOf('//') === 0 || t.indexOf('canvas_clear') === 0) continue;
            var m = t.match(reStr);
            if (m) { els.push({ id: nextId++, type: 'text', x: +m[1], y: +m[2], text: unesc(m[3]), font: font }); continue; }
            m = t.match(reBtn);
            if (m) { els.push({ id: nextId++, type: 'button', x: 0, y: 0, pos: m[1], text: unesc(m[2]) }); continue; }
            if (t.indexOf('canvas_set_font') === 0) {
                if (t.indexOf('FontPrimary') >= 0) font = 'FontPrimary';
                else if (t.indexOf('FontBigNumbers') >= 0) font = 'FontBigNumbers';
                else font = 'FontSecondary';
                continue;
            }
            var a;
            if ((a = numArgs(t, 'canvas_draw_box', 5)))    { els.push({ id: nextId++, type: 'box',    x: +a[1], y: +a[2], w: +a[3], h: +a[4] }); continue; }
            if ((a = numArgs(t, 'canvas_draw_frame', 5)))  { els.push({ id: nextId++, type: 'frame',  x: +a[1], y: +a[2], w: +a[3], h: +a[4] }); continue; }
            if ((a = numArgs(t, 'canvas_draw_rbox', 6)))   { els.push({ id: nextId++, type: 'rbox',   x: +a[1], y: +a[2], w: +a[3], h: +a[4], r: +a[5] }); continue; }
            if ((a = numArgs(t, 'canvas_draw_rframe', 6))) { els.push({ id: nextId++, type: 'rframe', x: +a[1], y: +a[2], w: +a[3], h: +a[4], r: +a[5] }); continue; }
            if ((a = numArgs(t, 'canvas_draw_line', 5)))   { els.push({ id: nextId++, type: 'line',   x: +a[1], y: +a[2], x2: +a[3], y2: +a[4] }); continue; }
            if ((a = numArgs(t, 'canvas_draw_circle', 4))) { els.push({ id: nextId++, type: 'circle', x: +a[1], y: +a[2], r: +a[3] }); continue; }
            if ((a = numArgs(t, 'canvas_draw_disc', 4)))   { els.push({ id: nextId++, type: 'disc',   x: +a[1], y: +a[2], r: +a[3] }); continue; }
            if ((a = numArgs(t, 'canvas_draw_dot', 3)))    { els.push({ id: nextId++, type: 'dot',    x: +a[1], y: +a[2] }); continue; }
            if ((a = numArgs(t, 'canvas_draw_xbm', 6))) {
                var nm = a[5].replace(/^img_/, '');
                if (icons[nm]) { els.push({ id: nextId++, type: 'icon', x: +a[1], y: +a[2], icon: nm }); continue; }
            }
            ignored++;
        }
        pushUndo();
        screen().elements = els;
        if (sel >= els.length) sel = -1;
        renderCanvas(); renderLayers(); renderProps();
        codeStatus.textContent = '✓ synced ' + els.length + ' element(s)' +
            (ignored ? ' · ' + ignored + ' line(s) not recognized (kept out of the design)' : '');
        save();
    }

    // ── load / init ───────────────────────────────────────────────────────────
    window.addEventListener('message', function(e) {
        var m = e.data;
        if (m.type === 'loadDesign') {
            try {
                var d = JSON.parse(m.json);
                if (d && d.screens && d.screens.length) {
                    design = d;
                    cur = 0; sel = -1;
                    var maxId = 0;
                    design.screens.forEach(function(s) { s.elements.forEach(function(el) { if (el.id > maxId) maxId = el.id; }); });
                    nextId = maxId + 1;
                    document.getElementById('appName').value = design.appName || 'my_ui_app';
                    renderAll();
                }
            } catch (err) { /* keep current design */ }
        }
    });

    renderIconGrid();
    renderAll();
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
