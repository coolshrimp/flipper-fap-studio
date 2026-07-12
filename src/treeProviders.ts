import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './stateManager';
import { buildState } from './buildState';

const PURPLE  = new vscode.ThemeColor('charts.purple');
const GREEN   = new vscode.ThemeColor('testing.iconPassed');
const YELLOW  = new vscode.ThemeColor('list.warningForeground');

// ── Small helpers ─────────────────────────────────────────────────────────────

function md(text: string): vscode.MarkdownString {
    const m = new vscode.MarkdownString(text, true);
    m.isTrusted = true;
    return m;
}

// ── Tree item classes ─────────────────────────────────────────────────────────

class ButtonItem extends vscode.TreeItem {
    constructor(
        label: string,
        command: string,
        icon: vscode.ThemeIcon,
        tooltip: string | vscode.MarkdownString,
        args?: unknown[]
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command = { command, title: label, arguments: args };
        this.iconPath = icon;
        this.tooltip = tooltip;
    }
}

class InfoItem extends vscode.TreeItem {
    constructor(
        label: string,
        detail: string,
        icon: vscode.ThemeIcon,
        tooltip: string | vscode.MarkdownString,
        command?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = detail;
        this.iconPath = icon;
        this.tooltip = tooltip;
        if (command) {
            this.command = { command, title: label };
        }
    }
}

class SeparatorItem extends vscode.TreeItem {
    constructor() {
        super('', vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'separator';
        this.description = '──────────────────────';
    }
}

export class FirmwareSection extends vscode.TreeItem {
    constructor() {
        super('Firmware SDKs', vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('circuit-board', PURPLE);
        this.contextValue = 'firmwareSection';
        this.tooltip = md('**Firmware SDK Status**\n\nShows which firmware SDKs are configured and reachable on disk.\n\nUse the inline buttons to set paths, open GitHub releases, or visit official update pages.');
    }
}

export class FirmwareStatusItem extends vscode.TreeItem {
    constructor(
        public readonly fwId: string,
        label: string,
        status: string,
        found: boolean,
        tooltip: vscode.MarkdownString
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = status;
        this.iconPath = found
            ? new vscode.ThemeIcon('pass-filled', GREEN)
            : new vscode.ThemeIcon('warning', YELLOW);
        this.contextValue = `fw-${fwId}`;
        this.tooltip = tooltip;
    }
}

// ── Firmware metadata ─────────────────────────────────────────────────────────

export const FW_META: Record<string, {
    label: string;
    githubUrl: string;
    webUrl?: string;
    webLabel?: string;
}> = {
    oem: {
        label: 'OEM / uFBT',
        githubUrl: 'https://github.com/flipperdevices/flipperzero-firmware/releases/latest',
        webUrl: 'https://lab.flipper.net/',
        webLabel: 'Flipper Lab',
    },
    rogueMaster: {
        label: 'RogueMaster',
        githubUrl: 'https://github.com/RogueMaster/flipperzero-firmware-wPlugins/releases/latest',
    },
    momentum: {
        label: 'Momentum',
        githubUrl: 'https://github.com/Next-Flip/Momentum-Firmware/releases/latest',
        webUrl: 'https://momentum-fw.dev/update',
        webLabel: 'Momentum Update',
    },
    unleashed: {
        label: 'Unleashed',
        githubUrl: 'https://github.com/DarkFlippers/unleashed-firmware/releases/latest',
    },
};

// ── Status helpers ────────────────────────────────────────────────────────────

function getFirmwareStatusItem(fwId: string, state: StateManager): FirmwareStatusItem {
    const meta = FW_META[fwId];

    if (fwId === 'oem') {
        return new FirmwareStatusItem(
            fwId,
            meta.label,
            'Active via uFBT',
            true,
            md([
                '**OEM / uFBT (official SDK)**',
                '',
                'The OEM target uses uFBT bundled SDK — no local path needed.',
                'uFBT downloads and manages the SDK automatically.',
                '',
                '$(link-external) **[Flipper Lab](https://lab.flipper.net/)** — manage your device & install apps online',
                '$(cloud-download) **[GitHub Releases](https://github.com/flipperdevices/flipperzero-firmware/releases/latest)**',
            ].join('\n'))
        );
    }

    const sdkPath = state.getTargetPath(fwId);
    const exists = sdkPath ? fs.existsSync(sdkPath) : false;

    let status: string;
    let bodyLines: string[];

    if (!sdkPath) {
        status = 'Not configured';
        bodyLines = [
            `**${meta.label}**`,
            '',
            '⚠ No SDK path configured.',
            'Click the folder icon or open **Settings** to set the path.',
        ];
    } else if (!exists) {
        status = 'Path not found';
        bodyLines = [
            `**${meta.label}**`,
            '',
            `⚠ Configured path does not exist on disk:`,
            `\`${sdkPath}\``,
            '',
            'Check the path in **Settings** or clone the firmware repo there.',
        ];
    } else {
        status = 'SDK found';
        bodyLines = [
            `**${meta.label}** — SDK found`,
            '',
            `\`${sdkPath}\``,
        ];
    }

    if (meta.webUrl) {
        bodyLines.push('', `$(link-external) **[${meta.webLabel}](${meta.webUrl})**`);
    }
    bodyLines.push(`$(cloud-download) **[GitHub Releases](${meta.githubUrl})**`);

    return new FirmwareStatusItem(fwId, meta.label, status, exists, md(bodyLines.join('\n')));
}

// ── Main tree provider ────────────────────────────────────────────────────────

export class MainTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private state: StateManager) {}

    refresh() { this._onDidChangeTreeData.fire(); }

    getTreeItem(el: vscode.TreeItem) { return el; }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (element instanceof FirmwareSection) {
            return (['oem', 'rogueMaster', 'momentum', 'unleashed'] as const)
                .map(id => getFirmwareStatusItem(id, this.state));
        }
        if (element) { return []; }
        return this._getRootItems();
    }

    private _getBuildItems(): vscode.TreeItem[] {
        if (buildState.isBuilding) {
            return [
                new ButtonItem(
                    'Building…',
                    'flipperFapStudio.cancelBuild',
                    new vscode.ThemeIcon('sync~spin', PURPLE),
                    md('**Build in progress**\n\nClick to cancel the running build.'),
                ),
                new ButtonItem(
                    'Cancel Build',
                    'flipperFapStudio.cancelBuild',
                    new vscode.ThemeIcon('stop-circle', new vscode.ThemeColor('list.warningForeground')),
                    md('**Cancel Build**\n\nStops the current build immediately.'),
                ),
            ];
        }
        return [
            new ButtonItem(
                'Build .fap',
                'flipperFapStudio.build',
                new vscode.ThemeIcon('play', PURPLE),
                md('**Build .fap**\n\nCompile the current app against the active firmware target.\n\nOutput appears in the _Flipper FAP Studio_ output panel.')
            ),
            new ButtonItem(
                'Build + Launch on Flipper',
                'flipperFapStudio.buildAndLaunch',
                new vscode.ThemeIcon('run-all', PURPLE),
                md('**Build + Launch on Flipper**\n\nBuilds the app then sideloads it to a connected Flipper Zero via USB so you can test immediately.')
            ),
            new ButtonItem(
                'Clean',
                'flipperFapStudio.clean',
                new vscode.ThemeIcon('trash'),
                md('**Clean**\n\nRemoves all build artefacts from the `dist/` folder.\n\nUseful after switching firmware targets or fixing cache issues.')
            ),
            new ButtonItem(
                'Open Working Directory',
                'flipperFapStudio.openDist',
                new vscode.ThemeIcon('go-to-file'),
                md('**Open Working Directory**\n\nOpens the app\'s `dist/` output folder in your system file explorer.')
            ),
        ];
    }

    private _getRootItems(): vscode.TreeItem[] {
        const folder = this.state.getAppFolder();
        const folderLabel = folder ? path.basename(folder) : 'None — click to set';
        const target = this.state.getActiveTarget();
        const targetLabel = this.state.getTargetDisplayName(target);

        return [
            new InfoItem(
                'App',
                folderLabel,
                new vscode.ThemeIcon('folder', PURPLE),
                md(`**Current app folder**\n\n\`${folder || 'Not set'}\`\n\n_Click to browse for an app folder._`),
                'flipperFapStudio.pickAppFolder'
            ),
            new InfoItem(
                'Target',
                targetLabel,
                new vscode.ThemeIcon('circuit-board', PURPLE),
                md(`**Active firmware target**\n\n\`${targetLabel}\`\n\n_Click to change target._`),
                'flipperFapStudio.selectTarget'
            ),

            new SeparatorItem(),

            ...this._getBuildItems(),

            new SeparatorItem(),

            new ButtonItem(
                'Create starter app',
                'flipperFapStudio.createStarterApp',
                new vscode.ThemeIcon('new-folder', PURPLE),
                md('**Create starter app**\n\nScaffold a new Flipper app with `application.fam` and a `main.c` template.\n\nYou\'ll be prompted for a name and a parent folder (or use the default set in Settings).')
            ),
            new ButtonItem(
                'Select firmware target',
                'flipperFapStudio.selectTarget',
                new vscode.ThemeIcon('circuit-board', PURPLE),
                md('**Select firmware target**\n\nChoose which SDK to build against:\n- OEM / uFBT (official)\n- RogueMaster, Momentum, Unleashed\n- Any custom SDK path\n\n_Set SDK paths in **Settings**._')
            ),

            new SeparatorItem(),

            new ButtonItem(
                'Guide',
                'flipperFapStudio.openGuide',
                new vscode.ThemeIcon('book', PURPLE),
                md('**Guide**\n\nOpen the step-by-step usage guide — getting started, build workflow, and all available actions.')
            ),
            new ButtonItem(
                'Settings',
                'flipperFapStudio.openSettings',
                new vscode.ThemeIcon('settings-gear', PURPLE),
                md('**Settings**\n\nConfigure:\n- Build output directory\n- Ask-on-build prompt\n- Default new-app folder\n- Firmware SDK paths (RogueMaster, Momentum, Unleashed)')
            ),

        ];
    }
}
