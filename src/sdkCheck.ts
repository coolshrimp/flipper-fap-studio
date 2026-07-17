import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

/**
 * Firmware SDK folder verification.
 *
 * A valid target folder is an extracted firmware update package — it contains
 * an `update.fuf` manifest ("Flipper firmware upgrade configuration") whose
 * `Info:` line carries the firmware version string, e.g. `mntm-012` or
 * `unlshd-081`. Release archives usually nest it one level down
 * (flipper-z-f7-update-mntm-012/f7-update-mntm-012/update.fuf), so we search
 * a couple of levels deep.
 */

export type FwFlavor = 'momentum' | 'unleashed' | 'rogueMaster' | 'official' | 'unknown';

export interface SdkInfo {
    /** update.fuf found and parsed */
    ok: boolean;
    /** version string from the manifest's Info line, e.g. "mntm-012" */
    version?: string;
    flavor?: FwFlavor;
    /** directory that actually contains update.fuf */
    dir?: string;
    /** human-readable reason when not ok */
    problem?: string;
}

export const FLAVOR_LABELS: Record<FwFlavor, string> = {
    momentum: 'Momentum',
    unleashed: 'Unleashed',
    rogueMaster: 'RogueMaster',
    official: 'Official',
    unknown: 'Unknown firmware',
};

export function detectFlavor(version: string): FwFlavor {
    const v = version.toLowerCase();
    if (v.includes('mntm')) { return 'momentum'; }
    if (v.includes('unlshd')) { return 'unleashed'; }
    if (/^rm/.test(v)) { return 'rogueMaster'; }
    if (/^\d+\.\d+/.test(v)) { return 'official'; }
    return 'unknown';
}

function readManifest(dir: string): SdkInfo | null {
    const fuf = path.join(dir, 'update.fuf');
    try {
        if (!fs.existsSync(fuf)) { return null; }
        const text = fs.readFileSync(fuf, 'utf8');
        if (!/Filetype:\s*Flipper firmware upgrade configuration/i.test(text)) { return null; }
        const version = /^Info:\s*(.+)$/m.exec(text)?.[1]?.trim();
        if (!version) { return { ok: true, version: 'unknown', flavor: 'unknown', dir }; }
        return { ok: true, version, flavor: detectFlavor(version), dir };
    } catch {
        return null;
    }
}

const MAX_DEPTH = 4;
const MAX_DIRS = 400;

/**
 * Collect every firmware update manifest in root or up to MAX_DEPTH levels
 * below it (extracted releases often nest a folder in a folder).
 */
export function findAllFirmware(root: string): SdkInfo[] {
    const found: SdkInfo[] = [];
    try {
        if (!root || !fs.existsSync(root)) { return found; }
        let visited = 0;
        const walk = (dir: string, depth: number) => {
            if (visited++ > MAX_DIRS || found.length >= 25) { return; }
            const manifest = readManifest(dir);
            if (manifest) { found.push(manifest); return; } // don't descend into a package
            if (depth >= MAX_DEPTH) { return; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (!entry.isDirectory()) { continue; }
                if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
                walk(path.join(dir, entry.name), depth + 1);
            }
        };
        walk(root, 0);
    } catch { /* partial results are fine */ }
    return found;
}

/**
 * Find the firmware in a folder. When several firmwares live under one parent
 * folder, `expectedFlavor` picks the matching one.
 */
export function inspectSdkFolder(root: string, expectedFlavor?: FwFlavor): SdkInfo {
    try {
        if (!root) { return { ok: false, problem: 'Not configured' }; }
        if (!fs.existsSync(root)) { return { ok: false, problem: 'Path not found' }; }

        const found = findAllFirmware(root);
        if (found.length === 0) {
            return { ok: false, problem: 'No firmware found in folder (missing update.fuf)' };
        }
        if (expectedFlavor) {
            const match = found.find(f => f.flavor === expectedFlavor);
            if (match) { return match; }
        }
        return found[0];
    } catch (err) {
        return { ok: false, problem: (err as Error).message };
    }
}

// ── Latest-release lookup (GitHub) ───────────────────────────────────────────

const releaseCache = new Map<string, { tag: string | null; at: number }>();
const CACHE_TTL = 30 * 60 * 1000;

/** repoSlug like "Next-Flip/Momentum-Firmware"; resolves null on any failure. */
export function fetchLatestReleaseTag(repoSlug: string, force = false): Promise<string | null> {
    const cached = releaseCache.get(repoSlug);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
        return Promise.resolve(cached.tag);
    }
    return new Promise(resolve => {
        const done = (tag: string | null) => {
            releaseCache.set(repoSlug, { tag, at: Date.now() });
            resolve(tag);
        };
        const req = https.get(
            {
                hostname: 'api.github.com',
                path: `/repos/${repoSlug}/releases/latest`,
                headers: {
                    'User-Agent': 'flipper-fap-studio-vscode',
                    'Accept': 'application/vnd.github+json',
                },
                timeout: 8000,
            },
            res => {
                let data = '';
                res.on('data', (c: string) => { data += c; });
                res.on('end', () => {
                    try { done((JSON.parse(data) as { tag_name?: string }).tag_name ?? null); }
                    catch { done(null); }
                });
            }
        );
        req.on('error', () => done(null));
        req.on('timeout', () => { req.destroy(); done(null); });
    });
}

/** Extract "owner/repo" from a GitHub URL like https://github.com/owner/repo/releases/latest */
export function repoSlugFromUrl(url: string): string | null {
    const m = /github\.com\/([^/]+\/[^/]+)/.exec(url);
    return m ? m[1] : null;
}

/**
 * Loose match between a local manifest version ("mntm-012") and a release tag
 * ("mntm-012" / "RM0713-2232-3be1368f"): case-insensitive containment either
 * way, or a shared commit-hash token (RogueMaster's manifest says
 * "rm-420-3be1368f" while its tag is "RM0713-2232-3be1368f").
 */
export function versionMatchesTag(version: string, tag: string): boolean {
    const v = version.toLowerCase().trim();
    const t = tag.toLowerCase().trim();
    if (v === t || t.includes(v) || v.includes(t)) { return true; }
    const hashTokens = (s: string) => s.split(/[^0-9a-z]+/).filter(x => /^[0-9a-f]{7,}$/.test(x));
    const tagHashes = new Set(hashTokens(t));
    return hashTokens(v).some(h => tagHashes.has(h));
}
