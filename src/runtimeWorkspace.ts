import * as fs from "fs";
import * as path from "path";

const LEGACY_MIGRATION_VERSION = 1;
const MAX_LEGACY_ENTRIES = 50_000;
const MAX_LEGACY_DEPTH = 64;

export interface LegacyStorageMigration {
    alreadyComplete: boolean;
    sources: string[];
    filesCopied: number;
    directoriesCreated: number;
    entriesSkipped: number;
}

export async function prepareRuntimeWorkspace(
    buildRoot: string,
    storageRoot: string,
): Promise<void> {
    await Promise.all([
        fs.promises.mkdir(buildRoot, { recursive: true }),
        fs.promises.mkdir(storageRoot, { recursive: true }),
    ]);
}

/**
 * Older simulator releases stored one virtual filesystem under
 * `<target>/<app>/storage`. New firmware sessions use one target-wide card.
 * Overlay every legacy `/ext` and bridge `/int` tree without overwriting files
 * already present in the new location, then leave the old trees untouched.
 */
export async function migrateLegacyRuntimeStorage(
    targetRuntimeRoot: string,
    storageRoot: string,
): Promise<LegacyStorageMigration> {
    const targetRoot = path.resolve(targetRuntimeRoot);
    const destinationRoot = path.resolve(storageRoot);
    const markerPath = path.join(destinationRoot, ".legacy-storage-migration.json");
    await fs.promises.mkdir(destinationRoot, { recursive: true });
    if (await isMigrationComplete(markerPath)) {
        return {
            alreadyComplete: true,
            sources: [],
            filesCopied: 0,
            directoriesCreated: 0,
            entriesSkipped: 0,
        };
    }

    const result: LegacyStorageMigration = {
        alreadyComplete: false,
        sources: [],
        filesCopied: 0,
        directoriesCreated: 0,
        entriesSkipped: 0,
    };
    const budget = { entries: 0 };
    const children = await fs.promises.readdir(targetRoot, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!child.isDirectory() || ["apps", "storage"].includes(child.name)) continue;
        const legacyStorage = path.join(targetRoot, child.name, "storage");
        const legacyStat = await lstatOrUndefined(legacyStorage);
        if (!legacyStat?.isDirectory() || legacyStat.isSymbolicLink()) continue;
        for (const volume of ["ext", "int"]) {
            const source = path.join(legacyStorage, volume);
            const sourceStat = await lstatOrUndefined(source);
            if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) continue;
            result.sources.push(source);
            await overlayLegacyDirectory(
                source,
                path.join(destinationRoot, volume),
                0,
                budget,
                result,
            );
        }
    }

    await fs.promises.writeFile(
        markerPath,
        `${JSON.stringify({
            version: LEGACY_MIGRATION_VERSION,
            migratedAt: new Date().toISOString(),
            sources: result.sources,
            filesCopied: result.filesCopied,
            directoriesCreated: result.directoriesCreated,
            entriesSkipped: result.entriesSkipped,
        }, null, 2)}\n`,
        "utf8",
    );
    return result;
}

async function overlayLegacyDirectory(
    source: string,
    destination: string,
    depth: number,
    budget: { entries: number },
    result: LegacyStorageMigration,
): Promise<void> {
    if (depth > MAX_LEGACY_DEPTH) {
        throw new Error(`Legacy virtual storage exceeds ${MAX_LEGACY_DEPTH} directory levels.`);
    }
    const destinationStat = await lstatOrUndefined(destination);
    if (!destinationStat) {
        await fs.promises.mkdir(destination, { recursive: true });
        result.directoriesCreated += 1;
    } else if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        result.entriesSkipped += 1;
        return;
    }

    const entries = await fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        budget.entries += 1;
        if (budget.entries > MAX_LEGACY_ENTRIES) {
            throw new Error(`Legacy virtual storage contains more than ${MAX_LEGACY_ENTRIES} entries.`);
        }
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        const sourceStat = await fs.promises.lstat(sourcePath);
        if (sourceStat.isSymbolicLink()) {
            result.entriesSkipped += 1;
        } else if (sourceStat.isDirectory()) {
            await overlayLegacyDirectory(
                sourcePath,
                destinationPath,
                depth + 1,
                budget,
                result,
            );
        } else if (sourceStat.isFile()) {
            try {
                await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
                result.filesCopied += 1;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") result.entriesSkipped += 1;
                else throw error;
            }
        } else {
            result.entriesSkipped += 1;
        }
    }
}

async function isMigrationComplete(markerPath: string): Promise<boolean> {
    try {
        const marker = JSON.parse(await fs.promises.readFile(markerPath, "utf8")) as { version?: unknown };
        return marker.version === LEGACY_MIGRATION_VERSION;
    } catch {
        return false;
    }
}

async function lstatOrUndefined(filePath: string): Promise<fs.Stats | undefined> {
    try {
        return await fs.promises.lstat(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}
