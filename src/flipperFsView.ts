import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { flipperSerial, FileType, StorageFile } from './serial/flipperSerial';

const ORANGE = new vscode.ThemeColor('charts.orange');

function posixJoin(dir: string, name: string): string {
    return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function humanSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class FlipperFsItem extends vscode.TreeItem {
    constructor(
        public readonly devicePath: string,
        public readonly isDir: boolean,
        file?: StorageFile
    ) {
        super(path.posix.basename(devicePath) || devicePath,
            isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
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

    refresh() { this._onDidChangeTreeData.fire(); }

    getTreeItem(el: vscode.TreeItem) { return el; }

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
            return files.map(f => new FlipperFsItem(
                posixJoin(element.devicePath, f.name),
                f.type === FileType.DIR,
                f
            ));
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
    provider: FlipperFsProvider
) {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    const withProgress = <T>(title: string, task: () => Promise<T>) =>
        vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: false },
            task
        );

    const showError = (prefix: string, err: unknown) =>
        vscode.window.showErrorMessage(`${prefix}: ${(err as Error).message}`);

    reg('flipperFapStudio.files.refresh', () => provider.refresh());

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
            await withProgress(`Uploading ${picked.length} file(s) to ${destDir}…`, async () => {
                for (const uri of picked) {
                    const data = fs.readFileSync(uri.fsPath);
                    await flipperSerial.writeFile(posixJoin(destDir, path.basename(uri.fsPath)), data);
                }
            });
            provider.refresh();
            vscode.window.showInformationMessage(`Uploaded ${picked.length} file(s) to ${destDir}`);
        } catch (err) { showError('Upload failed', err); }
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
