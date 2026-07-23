import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

const MAX_DISCOVERY_DIRS = 800;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_RESOURCE_FILES = 32_768;
const MAX_RESOURCE_PATH = 512;
const MANIFEST_NAME = ".firmware-resources.json";

export interface FirmwareResourcePackage {
    updateManifestPath: string;
    archivePath: string;
    version: string;
}

export interface FirmwareResourceStageResult {
    found: boolean;
    archivePath: string;
    updateManifestPath: string;
    version: string;
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    changed: boolean;
}

export type FirmwareResourceProgressCallback = (progress: number) => void;

interface ResourceFile {
    relativePath: string;
    data: Buffer;
}

interface ParsedArchive {
    files: ResourceFile[];
    directories: string[];
    totalBytes: number;
}

interface ManagedResourceManifest {
    schemaVersion: 1;
    archiveSha256: string;
    archivePath: string;
    updateManifestPath: string;
    version: string;
    files: string[];
    directories: string[];
    totalBytes: number;
    stagedAt: string;
}

interface ComponentsFile {
    sourcePath: string;
    updateDirectory: string;
    firmwarePaths: string[];
}

/**
 * Resolve the resource archive that belongs to the selected firmware image.
 *
 * SDKs place the bootable full.bin at their root and the update package in the
 * `components.json` `update.dir`. Extracted release packages instead keep
 * firmware.dfu, update.fuf, and resources together. Both layouts are handled,
 * but an archive is only trusted when its name comes from update.fuf's
 * `Resources:` field.
 */
export function findFirmwareResourcePackage(
    targetRoot: string,
    firmwareSourcePath: string,
): FirmwareResourcePackage | undefined {
    const root = existingDirectory(targetRoot);
    if (!root) return undefined;
    const firmwarePath = safeRealPath(firmwareSourcePath);

    const components = boundedFind(root, file => path.basename(file).toLowerCase() === "components.json")
        .map(readComponentsFile)
        .filter((value): value is ComponentsFile => Boolean(value))
        .filter(component => {
            const componentRoot = path.dirname(component.sourcePath);
            return component.firmwarePaths.includes(firmwarePath) || isInside(componentRoot, firmwarePath);
        })
        .sort((a, b) => componentRank(a, firmwarePath) - componentRank(b, firmwarePath));
    for (const component of components) {
        const resolved = readResourcePackage(path.join(component.updateDirectory, "update.fuf"));
        if (resolved) return resolved;
    }

    const manifests = boundedFind(root, file => path.basename(file).toLowerCase() === "update.fuf")
        .sort((a, b) => manifestRank(a, firmwarePath) - manifestRank(b, firmwarePath));
    for (const manifestPath of manifests) {
        const resolved = readResourcePackage(manifestPath);
        if (resolved) return resolved;
    }
    return undefined;
}

/**
 * Expand a firmware's resource tree into the persistent target storage.
 * Files not listed in our managed manifest are never removed. On a firmware
 * update, only stale files from the previous managed resource set are pruned.
 */
export async function stageFirmwareResources(
    resourcePackage: FirmwareResourcePackage | undefined,
    storageRoot: string,
    onProgress?: FirmwareResourceProgressCallback,
): Promise<FirmwareResourceStageResult> {
    const empty: FirmwareResourceStageResult = {
        found: false,
        archivePath: "",
        updateManifestPath: "",
        version: "",
        fileCount: 0,
        directoryCount: 0,
        totalBytes: 0,
        changed: false,
    };
    if (!resourcePackage) return empty;
    const reportProgress = (progress: number): void => {
        onProgress?.(Math.max(0, Math.min(1, progress)));
    };

    reportProgress(0.03);
    const archiveStat = await fs.promises.stat(resourcePackage.archivePath);
    if (!archiveStat.isFile()) {
        throw new Error(`Firmware resources are not a file: ${resourcePackage.archivePath}`);
    }
    if (archiveStat.size > MAX_ARCHIVE_BYTES) {
        throw new Error(
            `Firmware resource archive is too large (${archiveStat.size} bytes; limit ${MAX_ARCHIVE_BYTES}).`,
        );
    }

    const archive = await fs.promises.readFile(resourcePackage.archivePath);
    reportProgress(0.1);
    const archiveSha256 = crypto.createHash("sha256").update(archive).digest("hex");
    await ensureSafeDirectory(storageRoot, "");
    const extRoot = path.join(storageRoot, "ext");
    await ensureSafeDirectory(storageRoot, "ext");
    const managedManifestPath = path.join(storageRoot, MANIFEST_NAME);
    const previous = await readManagedManifest(managedManifestPath);

    if (previous?.archiveSha256 === archiveSha256) {
        reportProgress(1);
        return {
            found: true,
            archivePath: resourcePackage.archivePath,
            updateManifestPath: resourcePackage.updateManifestPath,
            version: resourcePackage.version,
            fileCount: previous.files.length,
            directoryCount: previous.directories.length,
            totalBytes: previous.totalBytes,
            changed: false,
        };
    }

    reportProgress(0.18);
    const parsed = parseFirmwareResourceArchive(archive, resourcePackage.archivePath);
    reportProgress(0.28);
    const nextFiles = new Set(parsed.files.map(file => file.relativePath));
    const nextDirectories = new Set(parsed.directories);

    if (previous) {
        const staleFiles = previous.files.filter(relativePath => !nextFiles.has(relativePath));
        for (const relativePath of staleFiles) {
            await removeManagedFile(extRoot, relativePath);
        }
        const staleDirectories = previous.directories
            .filter(relativePath => !nextDirectories.has(relativePath))
            .sort((a, b) => pathDepth(b) - pathDepth(a));
        for (const relativePath of staleDirectories) {
            await removeManagedDirectoryIfEmpty(extRoot, relativePath);
        }
    }

    for (const relativePath of parsed.directories.sort((a, b) => pathDepth(a) - pathDepth(b))) {
        await ensureSafeDirectory(extRoot, relativePath);
    }
    reportProgress(0.34);
    const progressInterval = Math.max(1, Math.ceil(parsed.files.length / 40));
    for (let index = 0; index < parsed.files.length; index++) {
        const file = parsed.files[index];
        const parent = path.posix.dirname(file.relativePath);
        if (parent !== ".") await ensureSafeDirectory(extRoot, parent);
        const destination = resolveInside(extRoot, file.relativePath);
        const existing = await lstatIfPresent(destination);
        if (existing?.isSymbolicLink()) {
            throw new Error(`Refusing to replace a linked virtual SD file: ${file.relativePath}`);
        }
        if (existing?.isDirectory()) {
            throw new Error(`Firmware resource file collides with a virtual SD directory: ${file.relativePath}`);
        }
        await fs.promises.writeFile(destination, file.data);
        if ((index + 1) % progressInterval === 0 || index + 1 === parsed.files.length) {
            reportProgress(0.34 + (0.62 * (index + 1)) / Math.max(1, parsed.files.length));
        }
    }

    const managed: ManagedResourceManifest = {
        schemaVersion: 1,
        archiveSha256,
        archivePath: resourcePackage.archivePath,
        updateManifestPath: resourcePackage.updateManifestPath,
        version: resourcePackage.version,
        files: parsed.files.map(file => file.relativePath).sort(),
        directories: parsed.directories.slice().sort(),
        totalBytes: parsed.totalBytes,
        stagedAt: new Date().toISOString(),
    };
    await fs.promises.writeFile(managedManifestPath, JSON.stringify(managed, null, 2), "utf8");
    reportProgress(1);
    return {
        found: true,
        archivePath: resourcePackage.archivePath,
        updateManifestPath: resourcePackage.updateManifestPath,
        version: resourcePackage.version,
        fileCount: managed.files.length,
        directoryCount: managed.directories.length,
        totalBytes: managed.totalBytes,
        changed: true,
    };
}

export function parseFirmwareResourceArchive(archive: Buffer, sourceName: string): ParsedArchive {
    let tar: Buffer;
    const lowerName = sourceName.toLowerCase();
    if (archive.length >= 4 && archive.subarray(0, 4).toString("ascii") === "HSDS") {
        tar = decodeHeatshrinkStream(archive);
    } else if (
        lowerName.endsWith(".gz") ||
        (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b)
    ) {
        tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
    } else {
        if (archive.length > MAX_EXPANDED_BYTES) throw new Error("Firmware resource tar exceeds the safety limit.");
        tar = archive;
    }
    return parseTar(tar);
}

export function decodeHeatshrinkStream(source: Buffer): Buffer {
    if (source.length < 7 || source.subarray(0, 4).toString("ascii") !== "HSDS") {
        throw new Error("Invalid Heatshrink resource stream header.");
    }
    if (source[4] !== 1) throw new Error(`Unsupported Heatshrink resource stream version ${source[4]}.`);
    const windowBits = source[5];
    const lookaheadBits = source[6];
    if (windowBits < 4 || windowBits > 15 || lookaheadBits < 3 || lookaheadBits >= windowBits) {
        throw new Error(
            `Invalid Heatshrink parameters (window ${windowBits}, lookahead ${lookaheadBits}).`,
        );
    }

    const compressed = source.subarray(7);
    let bitOffset = 0;
    let output = Buffer.allocUnsafe(Math.min(
        MAX_EXPANDED_BYTES,
        Math.max(4096, compressed.length * 4),
    ));
    let outputLength = 0;

    const readBits = (count: number): number | undefined => {
        if (bitOffset + count > compressed.length * 8) return undefined;
        let value = 0;
        for (let index = 0; index < count; index++) {
            const absolute = bitOffset++;
            value = (value << 1) | ((compressed[absolute >> 3] >> (7 - (absolute & 7))) & 1);
        }
        return value;
    };
    const reserve = (count: number): void => {
        if (outputLength + count > MAX_EXPANDED_BYTES) {
            throw new Error(`Expanded firmware resources exceed ${MAX_EXPANDED_BYTES} bytes.`);
        }
        if (outputLength + count <= output.length) return;
        let nextLength = output.length;
        while (nextLength < outputLength + count) {
            nextLength = Math.min(MAX_EXPANDED_BYTES, nextLength * 2);
        }
        const next = Buffer.allocUnsafe(nextLength);
        output.copy(next, 0, 0, outputLength);
        output = next;
    };

    while (bitOffset < compressed.length * 8) {
        const tag = readBits(1);
        if (tag === undefined) break;
        if (tag === 1) {
            const literal = readBits(8);
            if (literal === undefined) break;
            reserve(1);
            output[outputLength++] = literal;
            continue;
        }

        const encodedDistance = readBits(windowBits);
        const encodedLength = readBits(lookaheadBits);
        if (encodedDistance === undefined || encodedLength === undefined) break;
        const distance = encodedDistance + 1;
        const length = encodedLength + 1;
        reserve(length);
        for (let index = 0; index < length; index++) {
            // Heatshrink's decoder uses a zero-initialized circular window, so
            // early references may legally point before the first output byte.
            const sourceIndex = outputLength - distance;
            output[outputLength] = sourceIndex < 0 ? 0 : output[sourceIndex];
            outputLength++;
        }
    }
    return output.subarray(0, outputLength);
}

function parseTar(tar: Buffer): ParsedArchive {
    const files: ResourceFile[] = [];
    const explicitDirectories = new Set<string>();
    const filePaths = new Set<string>();
    let cursor = 0;
    let totalBytes = 0;

    while (cursor + 512 <= tar.length) {
        const header = tar.subarray(cursor, cursor + 512);
        if (isZeroBlock(header)) break;
        validateTarChecksum(header);

        const baseName = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        const rawName = prefix ? `${prefix}/${baseName}` : baseName;
        const relativePath = normalizeResourcePath(rawName);
        const size = readTarSize(header);
        const type = header[156];
        const dataStart = cursor + 512;
        const paddedSize = Math.ceil(size / 512) * 512;
        if (dataStart + paddedSize > tar.length) throw new Error("Truncated firmware resource tar entry.");

        if (type === 0 || type === 0x30) {
            if (!relativePath) throw new Error("Firmware resource tar contains an unnamed file.");
            if (size > MAX_EXPANDED_BYTES || totalBytes + size > MAX_EXPANDED_BYTES) {
                throw new Error(`Expanded firmware resources exceed ${MAX_EXPANDED_BYTES} bytes.`);
            }
            if (files.length >= MAX_RESOURCE_FILES) {
                throw new Error(`Firmware resources contain more than ${MAX_RESOURCE_FILES} files.`);
            }
            if (filePaths.has(relativePath) || explicitDirectories.has(relativePath)) {
                throw new Error(`Duplicate firmware resource path: ${relativePath}`);
            }
            filePaths.add(relativePath);
            files.push({
                relativePath,
                data: Buffer.from(tar.subarray(dataStart, dataStart + size)),
            });
            totalBytes += size;
        } else if (type === 0x35) {
            if (relativePath) {
                if (filePaths.has(relativePath)) throw new Error(`Conflicting firmware resource path: ${relativePath}`);
                explicitDirectories.add(relativePath);
            }
        } else {
            const kind = type ? String.fromCharCode(type) : "unknown";
            throw new Error(`Unsupported firmware resource tar entry type '${kind}' at ${rawName || "<root>"}.`);
        }
        cursor = dataStart + paddedSize;
    }

    const directories = new Set(explicitDirectories);
    for (const file of files) {
        let parent = path.posix.dirname(file.relativePath);
        while (parent !== ".") {
            if (filePaths.has(parent)) {
                throw new Error(`Firmware resource path traverses a file: ${file.relativePath}`);
            }
            directories.add(parent);
            parent = path.posix.dirname(parent);
        }
    }
    return { files, directories: [...directories], totalBytes };
}

function readComponentsFile(sourcePath: string): ComponentsFile | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as {
            components?: Record<string, unknown>;
        };
        const components = parsed.components;
        const updateDir = components?.["update.dir"];
        if (typeof updateDir !== "string" || !updateDir.trim()) return undefined;
        const base = path.dirname(sourcePath);
        const updateDirectory = resolveInside(base, normalizeLocalRelativePath(updateDir));
        if (!fs.statSync(updateDirectory).isDirectory()) return undefined;
        const firmwarePaths: string[] = [];
        for (const key of ["full.bin", "firmware.bin", "firmware.dfu"]) {
            const value = components?.[key];
            if (typeof value !== "string" || !value.trim()) continue;
            try {
                firmwarePaths.push(safeRealPath(resolveInside(base, normalizeLocalRelativePath(value))));
            } catch {
                // Invalid optional component paths do not invalidate update.dir.
            }
        }
        return { sourcePath, updateDirectory, firmwarePaths };
    } catch {
        return undefined;
    }
}

function readResourcePackage(updateManifestPath: string): FirmwareResourcePackage | undefined {
    try {
        const text = fs.readFileSync(updateManifestPath, "utf8");
        if (!/Filetype:\s*Flipper firmware upgrade configuration/i.test(text)) return undefined;
        const resourceName = /^Resources:\s*(.+?)\s*$/mi.exec(text)?.[1]?.trim();
        if (!resourceName) return undefined;
        const version = /^Info:\s*(.+?)\s*$/mi.exec(text)?.[1]?.trim() || "unknown";
        const manifestDirectory = path.dirname(updateManifestPath);
        const archivePath = resolveInside(
            manifestDirectory,
            normalizeLocalRelativePath(resourceName),
        );
        if (!fs.statSync(archivePath).isFile()) return undefined;
        return {
            updateManifestPath,
            archivePath,
            version,
        };
    } catch {
        return undefined;
    }
}

function componentRank(component: ComponentsFile, firmwarePath: string): number {
    if (firmwarePath && component.firmwarePaths.includes(firmwarePath)) return 0;
    const componentRoot = path.dirname(component.sourcePath);
    if (firmwarePath && isInside(componentRoot, firmwarePath)) return 10;
    return 100 + pathDistance(componentRoot, firmwarePath);
}

function manifestRank(manifestPath: string, firmwarePath: string): number {
    const manifestDirectory = path.dirname(manifestPath);
    if (firmwarePath && path.dirname(firmwarePath) === manifestDirectory) return 0;
    return pathDistance(manifestDirectory, firmwarePath);
}

function pathDistance(left: string, right: string): number {
    if (!right) return Number.MAX_SAFE_INTEGER;
    const leftParts = path.resolve(left).split(path.sep);
    const rightParts = path.resolve(right).split(path.sep);
    let common = 0;
    while (
        common < leftParts.length &&
        common < rightParts.length &&
        leftParts[common].toLowerCase() === rightParts[common].toLowerCase()
    ) common++;
    return (leftParts.length - common) + (rightParts.length - common);
}

function boundedFind(root: string, accept: (file: string) => boolean): string[] {
    const found: string[] = [];
    let directories = 0;
    const visit = (folder: string, depth: number): void => {
        if (directories++ >= MAX_DISCOVERY_DIRS || depth > MAX_DISCOVERY_DEPTH || found.length >= 32) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (found.length >= 32) return;
            const fullPath = path.join(folder, entry.name);
            if (entry.isFile() && accept(fullPath)) {
                found.push(fullPath);
            } else if (
                entry.isDirectory() &&
                !entry.isSymbolicLink() &&
                !entry.name.startsWith(".") &&
                !["node_modules", ".git", "dist"].includes(entry.name)
            ) {
                visit(fullPath, depth + 1);
            }
        }
    };
    visit(root, 0);
    return found;
}

function normalizeResourcePath(rawPath: string): string {
    if (rawPath === "/" || rawPath === "." || rawPath === "./") return "";
    if (!rawPath || rawPath.includes("\0") || rawPath.includes("\\")) {
        throw new Error(`Unsafe firmware resource path: ${JSON.stringify(rawPath)}`);
    }
    if (rawPath.length > MAX_RESOURCE_PATH || path.posix.isAbsolute(rawPath)) {
        throw new Error(`Unsafe firmware resource path: ${rawPath}`);
    }
    const withoutDot = rawPath.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (!withoutDot) return "";
    const segments = withoutDot.split("/");
    if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
        throw new Error(`Unsafe firmware resource path: ${rawPath}`);
    }
    const normalized = path.posix.normalize(withoutDot);
    if (normalized === ".." || normalized.startsWith("../")) {
        throw new Error(`Unsafe firmware resource path: ${rawPath}`);
    }
    return normalized;
}

function normalizeLocalRelativePath(rawPath: string): string {
    const normalizedSeparators = rawPath.trim().replace(/[\\/]+/g, path.sep);
    if (
        !normalizedSeparators ||
        path.isAbsolute(normalizedSeparators) ||
        normalizedSeparators.split(path.sep).some(segment => segment === "..")
    ) {
        throw new Error(`Unsafe firmware package path: ${rawPath}`);
    }
    return normalizedSeparators;
}

function resolveInside(root: string, relativePath: string): string {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
    const relative = path.relative(resolvedRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path escapes firmware storage: ${relativePath}`);
    }
    return resolved;
}

async function ensureSafeDirectory(root: string, relativePath: string): Promise<void> {
    const resolvedRoot = path.resolve(root);
    await fs.promises.mkdir(resolvedRoot, { recursive: true });
    const rootStat = await fs.promises.lstat(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Virtual SD root is not a safe directory: ${resolvedRoot}`);
    }
    if (!relativePath) return;
    const normalized = normalizeResourcePath(relativePath);
    let current = resolvedRoot;
    for (const segment of normalized.split("/")) {
        current = path.join(current, segment);
        const existing = await lstatIfPresent(current);
        if (!existing) {
            await fs.promises.mkdir(current);
            continue;
        }
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
            throw new Error(`Virtual SD path is not a safe directory: ${relativePath}`);
        }
    }
}

async function removeManagedFile(root: string, relativePath: string): Promise<void> {
    const normalized = normalizeResourcePath(relativePath);
    if (!normalized) return;
    const target = resolveInside(root, normalized);
    const existing = await lstatIfPresent(target);
    if (!existing) return;
    if (existing.isDirectory() && !existing.isSymbolicLink()) return;
    await fs.promises.unlink(target);
}

async function removeManagedDirectoryIfEmpty(root: string, relativePath: string): Promise<void> {
    const normalized = normalizeResourcePath(relativePath);
    if (!normalized) return;
    const target = resolveInside(root, normalized);
    const existing = await lstatIfPresent(target);
    if (!existing || !existing.isDirectory() || existing.isSymbolicLink()) return;
    try {
        await fs.promises.rmdir(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
}

async function readManagedManifest(manifestPath: string): Promise<ManagedResourceManifest | undefined> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as Partial<ManagedResourceManifest>;
        if (
            parsed.schemaVersion !== 1 ||
            typeof parsed.archiveSha256 !== "string" ||
            !Array.isArray(parsed.files) ||
            !Array.isArray(parsed.directories) ||
            typeof parsed.totalBytes !== "number"
        ) return undefined;
        const files = parsed.files.map(normalizeResourcePath);
        const directories = parsed.directories.map(normalizeResourcePath).filter(Boolean);
        if (files.some(value => !value)) return undefined;
        return {
            schemaVersion: 1,
            archiveSha256: parsed.archiveSha256,
            archivePath: typeof parsed.archivePath === "string" ? parsed.archivePath : "",
            updateManifestPath: typeof parsed.updateManifestPath === "string" ? parsed.updateManifestPath : "",
            version: typeof parsed.version === "string" ? parsed.version : "unknown",
            files,
            directories,
            totalBytes: parsed.totalBytes,
            stagedAt: typeof parsed.stagedAt === "string" ? parsed.stagedAt : "",
        };
    } catch {
        return undefined;
    }
}

async function lstatIfPresent(filePath: string): Promise<fs.Stats | undefined> {
    try {
        return await fs.promises.lstat(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function validateTarChecksum(header: Buffer): void {
    const expected = parseOctal(header.subarray(148, 156));
    if (!Number.isFinite(expected)) throw new Error("Invalid firmware resource tar checksum.");
    let actual = 0;
    for (let index = 0; index < header.length; index++) {
        actual += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (actual !== expected) throw new Error("Firmware resource tar checksum mismatch.");
}

function readTarSize(header: Buffer): number {
    if (header[124] & 0x80) throw new Error("Base-256 tar sizes are not supported for firmware resources.");
    const size = parseOctal(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid firmware resource tar entry size.");
    return size;
}

function parseOctal(value: Buffer): number {
    const text = value.toString("ascii").replace(/\0.*$/, "").trim();
    if (!text) return 0;
    if (!/^[0-7]+$/.test(text)) return Number.NaN;
    return Number.parseInt(text, 8);
}

function readTarString(header: Buffer, offset: number, length: number): string {
    const value = header.subarray(offset, offset + length);
    const terminator = value.indexOf(0);
    return value.subarray(0, terminator >= 0 ? terminator : value.length).toString("utf8");
}

function isZeroBlock(block: Buffer): boolean {
    for (const value of block) if (value !== 0) return false;
    return true;
}

function existingDirectory(value: string): string {
    try {
        const resolved = path.resolve(value);
        return fs.statSync(resolved).isDirectory() ? resolved : "";
    } catch {
        return "";
    }
}

function safeRealPath(value: string): string {
    try {
        return fs.realpathSync(value);
    } catch {
        return path.resolve(value || ".");
    }
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function pathDepth(relativePath: string): number {
    return relativePath.split("/").length;
}

export const firmwareResourcesTestHooks = {
    decodeHeatshrinkStream,
    findFirmwareResourcePackage,
    parseFirmwareResourceArchive,
    stageFirmwareResources,
};
