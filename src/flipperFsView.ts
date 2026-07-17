import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { flipperSerial, FileType, StorageFile } from './serial/flipperSerial';
import { StateManager } from './stateManager';

const ORANGE = new vscode.ThemeColor('charts.orange');
const GREEN = new vscode.ThemeColor('testing.iconPassed');

function posixJoin(dir: string, name: string): string {
    return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function humanSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where the active app's .fap lands on the device, derived from application.fam. */
export interface CurrentAppTarget {
    /** e.g. /ext/apps/Misc */
    categoryDir: string;
    /** e.g. /ext/apps/Misc/my_app.fap */
    fapPath: string;
    appId: string;
}

export class FlipperFsItem extends vscode.TreeItem {
    constructor(
        public readonly devicePath: string,
        public readonly isDir: boolean,
        file?: StorageFile
    ) {
        super(path.posix.basename(devicePath) || devicePath,
            isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = devicePath; // stable identity so reveal() can find nodes
        this.contextValue = isDir ? 'flipperDir' : 'flipperFile';
        this.tooltip = devicePath;
        if (isDir) {
            this.iconPath = new vscode.ThemeIcon('folder', ORANGE);
        } else {
            this.iconPath = new vscode.ThemeIcon('file');
            this.description = file ? humanSize(file.size) : undefined;
            this.command = {
                command: 'flipperFapStudio.files.open',
                title: 'Open file',
                arguments: [this],
            };
        }
    }
}

class RootItem extends FlipperFsItem {
    constructor(devicePath: string, label: string, icon: string) {
        super(devicePath, true);
        this.label = label;
        this.description = devicePath;
        this.iconPath = new vscode.ThemeIcon(icon, ORANGE);
        this.collapsibleState = devicePath === '/ext'
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
    }
}

class MessageItem extends vscode.TreeItem {
    constructor(label: string, tooltip: string, command?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('info');
        this.tooltip = tooltip;
        if (command) { this.command = { command, title: label }; }
    }
}

export class FlipperFsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly state: StateManager) {}

    refresh() { this._onDidChangeTreeData.fire(); }

    getTreeItem(el: vscode.TreeItem) { return el; }

    /** Parse the active app's application.fam to find its .fap location on device. */
    getCurrentAppTarget(): CurrentAppTarget | null {
        const folder = this.state.getAppFolder();
        if (!folder) { return null; }
        try {
            const fam = fs.readFileSync(path.join(folder, 'application.fam'), 'utf8');
            const appId = /appid\s*=\s*["']([^"']+)["']/.exec(fam)?.[1];
            if (!appId) { return null; }
            const category = /fap_category\s*=\s*["']([^"']+)["']/.exec(fam)?.[1] ?? '';
            const categoryDir = category ? `/ext/apps/${category}` : '/ext/apps';
            return { categoryDir, fapPath: `${categoryDir}/${appId}.fap`, appId };
        } catch {
            return null;
        }
    }

    getParent(el: vscode.TreeItem): vscode.TreeItem | undefined {
        if (!(el instanceof FlipperFsItem)) { return undefined; }
        const parent = path.posix.dirname(el.devicePath);
        if (parent === '/' || parent === el.devicePath) { return undefined; }
        return new FlipperFsItem(parent, true);
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            return [
                new RootItem('/ext', 'SD Card', 'device-mobile'),
                new RootItem('/int', 'Internal Flash', 'circuit-board'),
            ];
        }
        if (!(element instanceof FlipperFsItem) || !element.isDir) { return []; }
        try {
            const files = await flipperSerial.listDir(element.devicePath);
            const target = this.getCurrentAppTarget();
            return files.map(f => {
                const item = new FlipperFsItem(
                    posixJoin(element.devicePath, f.name),
                    f.type === FileType.DIR,
                    f
                );
                // highlight the active app's category folder and built .fap
                if (target && item.devicePath === target.categoryDir && item.isDir) {
                    item.iconPath = new vscode.ThemeIcon('folder-active', GREEN);
                    item.description = '← current app';
                    item.tooltip = `${item.devicePath} — contains the current app (${target.appId})`;
                } else if (target && item.devicePath === target.fapPath) {
                    item.iconPath = new vscode.ThemeIcon('star-full', GREEN);
                    item.description = `${humanSize(f.size)} ● current app`;
                    item.tooltip = `${item.devicePath} — built from the current app folder`;
                }
                return item;
            });
        } catch (err) {
            return [new MessageItem(
                `⚠ ${(err as Error).message}`,
                'Connect your Flipper via USB (and close qFlipper), then click Refresh.',
                'flipperFapStudio.files.refresh'
            )];
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

export function registerFsCommands(
    context: vscode.ExtensionContext,
    provider: FlipperFsProvider,
    treeView: vscode.TreeView<vscode.TreeItem>
) {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    const withProgress = <T>(title: string, task: (progress: vscode.Progress<{ message?: string }>) => Promise<T>) =>
        vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: false },
            task
        );

    const showError = (prefix: string, err: unknown) =>
        vscode.window.showErrorMessage(`${prefix}: ${(err as Error).message}`);

    reg('flipperFapStudio.files.refresh', () => provider.refresh());

    // Reveal the current app's .fap (or its category folder) on the device
    reg('flipperFapStudio.files.revealApp', async () => {
        const target = provider.getCurrentAppTarget();
        if (!target) {
            vscode.window.showWarningMessage('No current app with an application.fam — set an app folder first.');
            return;
        }
        const candidates: Array<[string, boolean]> = [
            [target.fapPath, false],
            [target.categoryDir, true],
            ['/ext/apps', true],
        ];
        for (const [devicePath, isDir] of candidates) {
            try {
                await treeView.reveal(new FlipperFsItem(devicePath, isDir), { select: true, expand: true });
                if (devicePath !== target.fapPath) {
                    vscode.window.setStatusBarMessage(
                        `${target.appId}.fap is not on the device yet — run Build + Launch once to install it.`, 6000);
                }
                return;
            } catch { /* try the next candidate */ }
        }
        vscode.window.showWarningMessage('Could not browse the device — is the Flipper connected (and qFlipper closed)?');
    });

    // Open file: download to temp and open in the editor (read-only copy)
    reg('flipperFapStudio.files.open', async (item: unknown) => {
        const node = item as FlipperFsItem;
        if (!node?.devicePath) { return; }
        try {
            const data = await withProgress(`Reading ${node.devicePath} from Flipper…`,
                () => flipperSerial.readFile(node.devicePath));
            const tempDir = path.join(os.tmpdir(), 'flipper-fap-studio');
            fs.mkdirSync(tempDir, { recursive: true });
            const tempFile = path.join(tempDir, path.posix.basename(node.devicePath));
            fs.writeFileSync(tempFile, data);
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(tempFile));
            vscode.window.setStatusBarMessage('Opened a downloaded copy — edits are not written back to the Flipper.', 6000);
        } catch (err) { showError('Could not read file', err); }
    });

    reg('flipperFapStudio.files.download', async (item: unknown) => {
        const node = item as FlipperFsItem;
        if (!node?.devicePath) { return; }
        const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(defaultDir, path.posix.basename(node.devicePath))),
            title: `Download ${node.devicePath}`,
        });
        if (!uri) { return; }
        try {
            const data = await withProgress(`Downloading ${node.devicePath}…`,
                () => flipperSerial.readFile(node.devicePath));
            await vscode.workspace.fs.writeFile(uri, data);
            vscode.window.showInformationMessage(`Downloaded to ${uri.fsPath}`);
        } catch (err) { showError('Download failed', err); }
    });

    reg('flipperFapStudio.files.upload', async (item: unknown) => {
        const node = item as FlipperFsItem | undefined;
        const destDir = node?.isDir ? node.devicePath : '/ext';
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: `Upload to ${destDir}`,
            title: `Upload file(s) to ${destDir} on Flipper`,
        });
        if (!picked || picked.length === 0) { return; }
        try {
            await withProgress(`Uploading to ${destDir} on Flipper`, async progress => {
                let done = 0;
                for (const uri of picked) {
                    const name = path.basename(uri.fsPath);
                    progress.report({ message: `${++done}/${picked.length} — ${name}` });
                    const data = fs.readFileSync(uri.fsPath);
                    await flipperSerial.writeFile(posixJoin(destDir, name), data);
                }
            });
            provider.refresh();
            vscode.window.showInformationMessage(`Uploaded ${picked.length} file(s) to ${destDir}`);
        } catch (err) { showError('Upload failed', err); }
    });

    // Bulk upload: mirror an entire local folder (recursively) onto the device
    reg('flipperFapStudio.files.uploadFolder', async (item: unknown) => {
        const node = item as FlipperFsItem | undefined;
        const destDir = node?.isDir ? node.devicePath : '/ext';
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: `Upload folder to ${destDir}`,
            title: `Upload a folder (recursively) to ${destDir} on Flipper`,
        });
        if (!picked || picked.length === 0) { return; }
        const localRoot = picked[0].fsPath;

        // collect the tree up front so progress can show real counts
        const dirs: string[] = [];
        const files: Array<{ local: string; remote: string }> = [];
        const rootRemote = posixJoin(destDir, path.basename(localRoot));
        const walk = (localDir: string, remoteDir: string) => {
            dirs.push(remoteDir);
            for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
                const localChild = path.join(localDir, entry.name);
                const remoteChild = posixJoin(remoteDir, entry.name);
                if (entry.isDirectory()) { walk(localChild, remoteChild); }
                else if (entry.isFile()) { files.push({ local: localChild, remote: remoteChild }); }
            }
        };
        try {
            walk(localRoot, rootRemote);
        } catch (err) {
            showError('Could not read local folder', err);
            return;
        }

        try {
            await withProgress(`Uploading ${files.length} file(s) to ${rootRemote}`, async progress => {
                for (const dir of dirs) {
                    try {
                        await flipperSerial.mkdir(dir);
                    } catch (err) {
                        if (!(err as Error).message.includes('EXIST')) { throw err; }
                    }
                }
                let done = 0;
                for (const f of files) {
                    progress.report({ message: `${++done}/${files.length} — ${path.posix.basename(f.remote)}` });
                    await flipperSerial.writeFile(f.remote, fs.readFileSync(f.local));
                }
            });
            provider.refresh();
            vscode.window.showInformationMessage(`Uploaded ${files.length} file(s) to ${rootRemote}`);
        } catch (err) { showError('Folder upload failed', err); }
    });

    reg('flipperFapStudio.files.mkdir', async (item: unknown) => {
        const node = item as FlipperFsItem | undefined;
        const parent = node?.isDir ? node.devicePath : '/ext';
        const name = await vscode.window.showInputBox({
            prompt: `New folder inside ${parent}`,
            placeHolder: 'folder_name',
            validateInput: v => /^[^/\\:*?"<>|]+$/.test(v) ? undefined : 'Invalid folder name',
        });
        if (!name) { return; }
        try {
            await flipperSerial.mkdir(posixJoin(parent, name));
            provider.refresh();
        } catch (err) { showError('Could not create folder', err); }
    });

    reg('flipperFapStudio.files.rename', async (item: unknown) => {
        const node = item as FlipperFsItem;
        if (!node?.devicePath) { return; }
        const oldName = path.posix.basename(node.devicePath);
        const name = await vscode.window.showInputBox({
            prompt: `Rename ${node.devicePath}`,
            value: oldName,
            validateInput: v => /^[^/\\:*?"<>|]+$/.test(v) ? undefined : 'Invalid name',
        });
        if (!name || name === oldName) { return; }
        try {
            const parent = path.posix.dirname(node.devicePath);
            await flipperSerial.rename(node.devicePath, posixJoin(parent, name));
            provider.refresh();
        } catch (err) { showError('Rename failed', err); }
    });

    reg('flipperFapStudio.files.delete', async (item: unknown) => {
        const node = item as FlipperFsItem;
        if (!node?.devicePath) { return; }
        const what = node.isDir ? 'folder (and everything in it)' : 'file';
        const confirm = await vscode.window.showWarningMessage(
            `Delete this ${what} from the Flipper?\n\n${node.devicePath}`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }
        try {
            await withProgress(`Deleting ${node.devicePath}…`,
                () => flipperSerial.deletePath(node.devicePath, node.isDir));
            provider.refresh();
        } catch (err) { showError('Delete failed', err); }
    });

    reg('flipperFapStudio.files.copyPath', async (item: unknown) => {
        const node = item as FlipperFsItem;
        if (!node?.devicePath) { return; }
        await vscode.env.clipboard.writeText(node.devicePath);
        vscode.window.setStatusBarMessage(`Copied: ${node.devicePath}`, 3000);
    });
}
