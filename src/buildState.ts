import * as cp from 'child_process';

type Listener = () => void;

export class BuildState {
    private _building = false;
    private _proc: cp.ChildProcess | null = null;
    private _startTime = 0;
    private _listeners: Listener[] = [];

    get isBuilding(): boolean { return this._building; }

    get elapsedSeconds(): number {
        return this._building ? (Date.now() - this._startTime) / 1000 : 0;
    }

    reserve(): boolean {
        if (this._building) { return false; }
        this._building = true;
        this._proc = null;
        this._startTime = Date.now();
        this._fire();
        return true;
    }

    onDidChange(cb: Listener): { dispose(): void } {
        this._listeners.push(cb);
        return { dispose: () => { this._listeners = this._listeners.filter(l => l !== cb); } };
    }

    begin(proc: cp.ChildProcess) {
        const wasBuilding = this._building;
        this._building = true;
        this._proc = proc;
        if (!wasBuilding) { this._startTime = Date.now(); }
        this._fire();
    }

    end(): number {
        const elapsed = parseFloat(((Date.now() - this._startTime) / 1000).toFixed(1));
        this._building = false;
        this._proc = null;
        this._fire();
        return elapsed;
    }

    cancel() {
        if (this._building) {
            // ufbt is spawned via a shell, so kill the whole process tree on Windows —
            // proc.kill() would only terminate the shell and leave the build running
            if (this._proc && process.platform === 'win32' && this._proc.pid) {
                cp.exec(`taskkill /pid ${this._proc.pid} /T /F`);
            } else if (this._proc) {
                this._proc.kill('SIGTERM');
            }
            this.end();
        }
    }

    private _fire() { this._listeners.forEach(l => l()); }
}

export const buildState = new BuildState();
