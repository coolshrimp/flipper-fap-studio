const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const panels = [
    'designerPanel.ts',
    'simulatorPanel.ts',
    'dashboardPanel.ts',
    'screenPanel.ts',
    'guidePanel.ts',
    'firmwareView.ts',
    'settingsPanel.ts',
];

for (const file of panels) {
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert(source.includes('WEBVIEW_THEME'), `${file} must consume the shared webview theme`);
    assert(!/#(?:8b5cf6|7c3aed|a78bfa|6d28d9)/i.test(source), `${file} retains a legacy purple color`);
}

const theme = fs.readFileSync(path.join(root, 'src', 'webviewTheme.ts'), 'utf8');
for (const token of ['--fap-accent', '--fap-bg', '--fap-surface', '--fap-text', '--fap-good', '--fap-warn', '--fap-danger']) {
    assert(theme.includes(token), `shared theme is missing ${token}`);
}

console.log('shared webview theme tests passed');
