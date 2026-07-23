import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CustomTarget {
    name: string;
    path: string;
}

export interface RecentProject {
    path: string;
    lastOpened: number;
}

const MAX_RECENT_PROJECTS = 10;

export class StateManager {
    constructor(private readonly context: vscode.ExtensionContext) {}

    // ── App folder ────────────────────────────────────────────────────────────

    getAppFolder(): string {
        return (
            this.context.globalState.get<string>('appFolder') ||
            vscode.workspace.getConfiguration('flipperFapStudio').get<string>('defaultAppFolder') ||
            ''
        );
    }

    setAppFolder(p: string) {
        this.context.globalState.update('appFolder', p);
        vscode.workspace.getConfiguration('flipperFapStudio')
            .update('defaultAppFolder', p, vscode.ConfigurationTarget.Global);
        this.touchRecentProject(p);
    }

    // ── Recent projects ───────────────────────────────────────────────────────

    getRecentProjects(): RecentProject[] {
        return this.context.globalState.get<RecentProject[]>('recentProjects') || [];
    }

    /** Record activity on a folder — only valid Flipper apps (with application.fam) are tracked. */
    touchRecentProject(p: string) {
        if (!p) { return; }
        try {
            if (!fs.existsSync(path.join(p, 'application.fam'))) { return; }
        } catch { return; }
        const list = this.getRecentProjects()
            .filter(r => r.path.toLowerCase() !== p.toLowerCase());
        list.unshift({ path: p, lastOpened: Date.now() });
        this.context.globalState.update('recentProjects', list.slice(0, MAX_RECENT_PROJECTS));
    }

    removeRecentProject(p: string) {
        this.context.globalState.update(
            'recentProjects',
            this.getRecentProjects().filter(r => r.path !== p)
        );
    }

    // ── Active firmware target ────────────────────────────────────────────────

    getActiveTarget(): string {
        return (
            this.context.globalState.get<string>('activeTarget') ||
            vscode.workspace.getConfiguration('flipperFapStudio').get<string>('defaultTarget') ||
            'oem'
        );
    }

    async setActiveTarget(target: string): Promise<void> {
        await Promise.all([
            this.context.globalState.update('activeTarget', target),
            vscode.workspace.getConfiguration('flipperFapStudio')
                .update('defaultTarget', target, vscode.ConfigurationTarget.Global),
        ]);
    }

    // ── Target paths ──────────────────────────────────────────────────────────

    getTargetPath(target: string): string {
        const cfg = vscode.workspace.getConfiguration('flipperFapStudio');
        switch (target) {
            case 'rogueMaster': return cfg.get<string>('targets.rogueMasterPath') || 'C:\\Flipper\\RogueMaster';
            case 'momentum':    return cfg.get<string>('targets.momentumPath')    || 'C:\\Flipper\\Momentum';
            case 'unleashed':   return cfg.get<string>('targets.unleashedPath')   || 'C:\\Flipper\\Unleashed';
            case 'oem':         return '';
            default: {
                const customs = this.getCustomTargets();
                return customs.find(c => c.name === target)?.path || '';
            }
        }
    }

    getTargetDisplayName(target: string): string {
        switch (target) {
            case 'oem':         return 'OEM / uFBT (official)';
            case 'rogueMaster': return `RogueMaster  ${this.getTargetPath('rogueMaster')}`;
            case 'momentum':    return `Momentum  ${this.getTargetPath('momentum')}`;
            case 'unleashed':   return `Unleashed  ${this.getTargetPath('unleashed')}`;
            default:            return `${target}  ${this.getTargetPath(target)}`;
        }
    }

    getCustomTargets(): CustomTarget[] {
        return vscode.workspace.getConfiguration('flipperFapStudio')
            .get<CustomTarget[]>('targets.custom') || [];
    }

    addCustomTarget(name: string, p: string) {
        const cfg = vscode.workspace.getConfiguration('flipperFapStudio');
        const targets = cfg.get<CustomTarget[]>('targets.custom') || [];
        targets.push({ name, path: p });
        cfg.update('targets.custom', targets, vscode.ConfigurationTarget.Global);
    }

    buildTargetChoices(): Array<{ label: string; id: string }> {
        const builtins = [
            { label: '$(pass) OEM / uFBT  (official SDK)',      id: 'oem' },
            { label: `$(circuit-board) RogueMaster  ${this.getTargetPath('rogueMaster')}`, id: 'rogueMaster' },
            { label: `$(circuit-board) Momentum  ${this.getTargetPath('momentum')}`,       id: 'momentum' },
            { label: `$(circuit-board) Unleashed  ${this.getTargetPath('unleashed')}`,     id: 'unleashed' },
        ];
        const customs = this.getCustomTargets().map(c => ({
            label: `$(circuit-board) ${c.name}  ${c.path}`,
            id: c.name,
        }));
        return [
            ...builtins,
            ...customs,
            { label: '$(add) Add custom target...', id: '__add__' },
        ];
    }

    // ── Build output settings ─────────────────────────────────────────────────

    getAskOnBuildOutput(): boolean {
        return vscode.workspace.getConfiguration('flipperFapStudio')
            .get<boolean>('askOnBuildOutput') ?? false;
    }

    getBuildOutputDir(): string {
        return vscode.workspace.getConfiguration('flipperFapStudio')
            .get<string>('buildOutputDir') ?? '';
    }

    // ── Create-app defaults ───────────────────────────────────────────────────

    getDefaultCreateAppDir(): string {
        return vscode.workspace.getConfiguration('flipperFapStudio')
            .get<string>('defaultCreateAppDir') ?? '';
    }
}
