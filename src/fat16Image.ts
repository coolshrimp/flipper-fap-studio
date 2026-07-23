import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const BYTES_PER_SECTOR = 512;
const FAT_COUNT = 2;
const RESERVED_SECTORS = 1;
const FAT16_MIN_CLUSTERS = 4_085;
const FAT16_MAX_CLUSTERS = 65_524;
const DEFAULT_MIN_IMAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const DEFAULT_FREE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_CONTENT_BYTES = 384 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_ROOT_ENTRIES = 1_024;
const MAX_LFN_CODE_UNITS = 255;
const DOS_DATE_1980_01_01 = 0x0021;

type FatEntry = FatFile | FatDirectory;

interface FatNodeBase {
    name: string;
    shortName?: Buffer;
    needsLongName?: boolean;
    firstCluster?: number;
    clusterCount?: number;
}

interface FatFile extends FatNodeBase {
    kind: "file";
    data: Buffer;
}

interface FatDirectory extends FatNodeBase {
    kind: "directory";
    children: FatEntry[];
}

interface FatGeometry {
    imageBytes: number;
    totalSectors: number;
    sectorsPerCluster: number;
    sectorsPerFat: number;
    rootEntryCount: number;
    rootDirectorySectors: number;
    firstDataSector: number;
    dataClusterCount: number;
}

interface SourceStats {
    fileCount: number;
    directoryCount: number;
    contentBytes: number;
}

export interface Fat16ImageOptions {
    /** Smallest image to create. The actual image is a power of two and at least 4 MiB. */
    minimumImageBytes?: number;
    /** Hard upper bound for the generated image. Defaults to 512 MiB. */
    maximumImageBytes?: number;
    /** Free data space retained after materializing the source tree. Defaults to 16 MiB. */
    reserveFreeBytes?: number;
    /** Minimum fixed-root entry capacity. Defaults to 1024. */
    rootEntryCount?: number;
    /** Maximum number of files plus directories accepted from the host. */
    maxEntries?: number;
    /** Maximum combined file bytes accepted from the host. */
    maxContentBytes?: number;
    /** Maximum source directory nesting depth. */
    maxDepth?: number;
    /** FAT volume label, limited to eleven printable ASCII characters. */
    volumeLabel?: string;
}

export interface Fat16ImageMetadata {
    imagePath: string;
    imageBytes: number;
    contentFingerprint: string;
    fileCount: number;
    directoryCount: number;
    contentBytes: number;
    bytesPerSector: 512;
    sectorsPerCluster: number;
    clusterBytes: number;
    totalSectors: number;
    dataClusters: number;
    usedClusters: number;
    freeClusters: number;
    freeBytes: number;
    rootEntryCount: number;
    reusedExisting: boolean;
}

export interface Fat16MergeOptions {
    /** Replace host files with the image copy when their bytes differ. Defaults to true. */
    overwriteFiles?: boolean;
    maxEntries?: number;
    maxContentBytes?: number;
    maxDepth?: number;
}

export interface Fat16MergeMetadata {
    imagePath: string;
    destinationRoot: string;
    contentFingerprint: string;
    fileCount: number;
    directoryCount: number;
    contentBytes: number;
    filesWritten: number;
    filesUnchanged: number;
    filesSkipped: number;
    directoriesCreated: number;
}

interface NormalizedOptions {
    minimumImageBytes: number;
    maximumImageBytes: number;
    reserveFreeBytes: number;
    rootEntryCount: number;
    maxEntries: number;
    maxContentBytes: number;
    maxDepth: number;
    volumeLabel: string;
}

/**
 * Materialize `rootDir` as the root of a FAT16 superfloppy image.
 *
 * The image is deterministic for identical source contents and options. Host
 * symlinks and special files are rejected so an extracted firmware resource
 * tree cannot escape the requested root.
 */
export function buildFat16Image(
    rootDir: string,
    imagePath: string,
    options: Fat16ImageOptions = {},
): Fat16ImageMetadata {
    const normalized = normalizeOptions(options);
    const sourceRoot = path.resolve(rootDir);
    const outputPath = path.resolve(imagePath);
    assertOutputOutsideSource(sourceRoot, outputPath);

    const stats: SourceStats = { fileCount: 0, directoryCount: 0, contentBytes: 0 };
    const root = readHostDirectory(sourceRoot, "", 0, stats, normalized);
    prepareDirectoryNames(root);

    const fingerprint = fingerprintTree(root);
    const rootSlots = directoryEntrySlots(root, true);
    const rootEntryCount = roundUp(
        Math.max(normalized.rootEntryCount, rootSlots + 128),
        BYTES_PER_SECTOR / 32,
    );
    if(rootEntryCount > 65_520) {
        throw new Error(`FAT16 root directory needs ${rootEntryCount} entries; maximum is 65520`);
    }

    const geometry = chooseGeometry(root, rootEntryCount, normalized);
    const usedClusters = allocateClusters(root, geometry);
    const image = renderImage(root, geometry, normalized.volumeLabel);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    try {
        const existing = fs.lstatSync(outputPath);
        if(existing.isSymbolicLink() || !existing.isFile()) {
            throw new Error(`FAT image destination must be a regular file: ${outputPath}`);
        }
    } catch(error) {
        if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const reusedExisting = fileEqualsBuffer(outputPath, image);
    if(!reusedExisting) writeImageAtomically(outputPath, image);

    const freeClusters = geometry.dataClusterCount - usedClusters;
    return {
        imagePath: outputPath,
        imageBytes: geometry.imageBytes,
        contentFingerprint: fingerprint,
        fileCount: stats.fileCount,
        directoryCount: stats.directoryCount,
        contentBytes: stats.contentBytes,
        bytesPerSector: BYTES_PER_SECTOR,
        sectorsPerCluster: geometry.sectorsPerCluster,
        clusterBytes: geometry.sectorsPerCluster * BYTES_PER_SECTOR,
        totalSectors: geometry.totalSectors,
        dataClusters: geometry.dataClusterCount,
        usedClusters,
        freeClusters,
        freeBytes: freeClusters * geometry.sectorsPerCluster * BYTES_PER_SECTOR,
        rootEntryCount: geometry.rootEntryCount,
        reusedExisting,
    };
}

/**
 * Merge the logical contents of an existing FAT16 image into a host directory.
 *
 * Nothing in `destinationRoot` is deleted. Directory/file type conflicts and
 * symbolic links are rejected. This is intended to run before firmware
 * resources are re-staged, allowing raw-firmware settings and saves to survive
 * a deterministic image rebuild.
 */
export function mergeFat16Image(
    imagePath: string,
    destinationRoot: string,
    options: Fat16MergeOptions = {},
): Fat16MergeMetadata {
    const sourcePath = path.resolve(imagePath);
    const targetRoot = path.resolve(destinationRoot);
    const maxEntries = integerOption(
        "maxEntries",
        options.maxEntries,
        DEFAULT_MAX_ENTRIES,
        1,
    );
    const maxContentBytes = integerOption(
        "maxContentBytes",
        options.maxContentBytes,
        DEFAULT_MAX_CONTENT_BYTES,
        0,
    );
    const maxDepth = integerOption("maxDepth", options.maxDepth, DEFAULT_MAX_DEPTH, 1);
    const parsed = readFat16Image(sourcePath, maxEntries, maxContentBytes, maxDepth);

    fs.mkdirSync(targetRoot, { recursive: true });
    const rootStat = fs.lstatSync(targetRoot);
    if(rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error(`FAT merge destination must be a real directory: ${targetRoot}`);
    }

    const mergeStats = {
        filesWritten: 0,
        filesUnchanged: 0,
        filesSkipped: 0,
        directoriesCreated: 0,
    };
    mergeDirectoryToHost(
        parsed.root,
        targetRoot,
        options.overwriteFiles !== false,
        mergeStats,
    );
    return {
        imagePath: sourcePath,
        destinationRoot: targetRoot,
        contentFingerprint: fingerprintTree(parsed.root),
        fileCount: parsed.stats.fileCount,
        directoryCount: parsed.stats.directoryCount,
        contentBytes: parsed.stats.contentBytes,
        ...mergeStats,
    };
}

function normalizeOptions(options: Fat16ImageOptions): NormalizedOptions {
    const minimumImageBytes = integerOption(
        "minimumImageBytes",
        options.minimumImageBytes,
        DEFAULT_MIN_IMAGE_BYTES,
        4 * 1024 * 1024,
    );
    const maximumImageBytes = integerOption(
        "maximumImageBytes",
        options.maximumImageBytes,
        DEFAULT_MAX_IMAGE_BYTES,
        minimumImageBytes,
    );
    const reserveFreeBytes = integerOption(
        "reserveFreeBytes",
        options.reserveFreeBytes,
        DEFAULT_FREE_BYTES,
        0,
    );
    const rootEntryCount = roundUp(
        integerOption("rootEntryCount", options.rootEntryCount, DEFAULT_ROOT_ENTRIES, 16),
        16,
    );
    const maxEntries = integerOption(
        "maxEntries",
        options.maxEntries,
        DEFAULT_MAX_ENTRIES,
        1,
    );
    const maxContentBytes = integerOption(
        "maxContentBytes",
        options.maxContentBytes,
        DEFAULT_MAX_CONTENT_BYTES,
        0,
    );
    const maxDepth = integerOption("maxDepth", options.maxDepth, DEFAULT_MAX_DEPTH, 1);
    if(maximumImageBytes > 1024 * 1024 * 1024) {
        throw new Error("maximumImageBytes cannot exceed 1 GiB");
    }
    if(rootEntryCount > 65_520) {
        throw new Error("rootEntryCount cannot exceed 65520");
    }

    const label = (options.volumeLabel ?? "FLIPPER SD").toUpperCase();
    if(!/^[\x20-\x7e]{1,11}$/.test(label) || /["*+,./:;<=>?\[\\\]|]/.test(label)) {
        throw new Error("volumeLabel must be 1-11 FAT-compatible printable ASCII characters");
    }

    return {
        minimumImageBytes,
        maximumImageBytes,
        reserveFreeBytes,
        rootEntryCount,
        maxEntries,
        maxContentBytes,
        maxDepth,
        volumeLabel: label.padEnd(11, " "),
    };
}

function integerOption(name: string, value: number | undefined, fallback: number, minimum: number): number {
    const result = value ?? fallback;
    if(!Number.isSafeInteger(result) || result < minimum) {
        throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
    }
    return result;
}

function assertOutputOutsideSource(sourceRoot: string, outputPath: string): void {
    const relative = path.relative(sourceRoot, outputPath);
    if(relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        throw new Error("FAT image path must be outside the source directory");
    }
}

function readHostDirectory(
    absolutePath: string,
    name: string,
    depth: number,
    stats: SourceStats,
    options: NormalizedOptions,
): FatDirectory {
    if(depth > options.maxDepth) {
        throw new Error(`Source directory exceeds maximum depth ${options.maxDepth}: ${absolutePath}`);
    }
    const rootStat = fs.lstatSync(absolutePath);
    if(rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error(`FAT source must be a real directory: ${absolutePath}`);
    }

    const result: FatDirectory = { kind: "directory", name, children: [] };
    const dirents = fs.readdirSync(absolutePath, { withFileTypes: true })
        .sort((left, right) => compareNames(left.name, right.name));
    const foldedNames = new Set<string>();

    for(const dirent of dirents) {
        validateLongName(dirent.name);
        const folded = foldName(dirent.name);
        if(foldedNames.has(folded)) {
            throw new Error(`FAT cannot represent case-insensitive duplicate name: ${absolutePath}${path.sep}${dirent.name}`);
        }
        foldedNames.add(folded);
        const childPath = path.join(absolutePath, dirent.name);
        const childStat = fs.lstatSync(childPath);
        if(childStat.isSymbolicLink()) {
            throw new Error(`Symbolic links are not supported in FAT images: ${childPath}`);
        }

        if(childStat.isDirectory()) {
            stats.directoryCount += 1;
            checkEntryLimit(stats, options);
            result.children.push(readHostDirectory(
                childPath,
                dirent.name,
                depth + 1,
                stats,
                options,
            ));
        } else if(childStat.isFile()) {
            const data = fs.readFileSync(childPath);
            stats.fileCount += 1;
            stats.contentBytes += data.length;
            checkEntryLimit(stats, options);
            if(stats.contentBytes > options.maxContentBytes) {
                throw new Error(
                    `Source files contain ${stats.contentBytes} bytes; limit is ${options.maxContentBytes}`,
                );
            }
            result.children.push({ kind: "file", name: dirent.name, data });
        } else {
            throw new Error(`Special files are not supported in FAT images: ${childPath}`);
        }
    }
    return result;
}

function checkEntryLimit(stats: SourceStats, options: NormalizedOptions): void {
    if(stats.fileCount + stats.directoryCount > options.maxEntries) {
        throw new Error(`Source has more than ${options.maxEntries} FAT entries`);
    }
}

function validateLongName(name: string): void {
    if(name.length < 1 || name.length > MAX_LFN_CODE_UNITS) {
        throw new Error(`FAT filename must contain 1-${MAX_LFN_CODE_UNITS} UTF-16 code units: ${name}`);
    }
    if(name === "." || name === ".." || /[\x00-\x1f"*/:<>?\\|]/.test(name) || /[ .]$/.test(name)) {
        throw new Error(`Filename is not FAT-compatible: ${name}`);
    }
    for(let index = 0; index < name.length; index += 1) {
        const unit = name.charCodeAt(index);
        if(unit >= 0xd800 && unit <= 0xdbff) {
            const next = name.charCodeAt(index + 1);
            if(next < 0xdc00 || next > 0xdfff) throw new Error(`Filename contains invalid Unicode: ${name}`);
            index += 1;
        } else if(unit >= 0xdc00 && unit <= 0xdfff) {
            throw new Error(`Filename contains invalid Unicode: ${name}`);
        }
    }
}

function prepareDirectoryNames(directory: FatDirectory): void {
    directory.children.sort((left, right) => compareNames(left.name, right.name));
    const used = new Set<string>();
    for(const child of directory.children) {
        const direct = directShortName(child.name);
        if(direct && !used.has(direct.toString("ascii"))) {
            child.shortName = direct;
            child.needsLongName = false;
        } else {
            child.shortName = generatedShortName(child.name, used);
            child.needsLongName = true;
        }
        used.add(child.shortName.toString("ascii"));
        if(child.kind === "directory") prepareDirectoryNames(child);
    }
}

function directShortName(name: string): Buffer | undefined {
    const match = /^([A-Z0-9$%'_@~`!(){}^#&-]{1,8})(?:\.([A-Z0-9$%'_@~`!(){}^#&-]{1,3}))?$/.exec(name);
    if(!match) return undefined;
    return shortNameBuffer(match[1], match[2] ?? "");
}

function generatedShortName(name: string, used: Set<string>): Buffer {
    const dot = name.lastIndexOf(".");
    const rawBase = dot > 0 ? name.slice(0, dot) : name;
    const rawExtension = dot > 0 ? name.slice(dot + 1) : "";
    const base = sanitizeShortPart(rawBase) || "FILE";
    const extension = sanitizeShortPart(rawExtension).slice(0, 3);
    for(let suffixNumber = 1; suffixNumber <= 999_999; suffixNumber += 1) {
        const suffix = `~${suffixNumber}`;
        const candidate = shortNameBuffer(base.slice(0, 8 - suffix.length) + suffix, extension);
        if(!used.has(candidate.toString("ascii"))) return candidate;
    }
    throw new Error(`Could not allocate a unique FAT short name for ${name}`);
}

function sanitizeShortPart(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9$%'_@~`!(){}^#&-]/g, "");
}

function shortNameBuffer(base: string, extension: string): Buffer {
    const result = Buffer.alloc(11, 0x20);
    result.write(base, 0, Math.min(8, base.length), "ascii");
    result.write(extension, 8, Math.min(3, extension.length), "ascii");
    return result;
}

function directoryEntrySlots(directory: FatDirectory, root: boolean): number {
    let slots = root ? 2 : 3; // volume label/end, or ./../end
    for(const child of directory.children) {
        slots += 1 + (child.needsLongName ? Math.ceil(child.name.length / 13) : 0);
    }
    return slots;
}

function chooseGeometry(
    root: FatDirectory,
    rootEntryCount: number,
    options: NormalizedOptions,
): FatGeometry {
    let imageBytes = nextPowerOfTwo(Math.max(options.minimumImageBytes, 4 * 1024 * 1024));
    imageBytes = roundUp(imageBytes, BYTES_PER_SECTOR * 1_024);
    while(imageBytes <= options.maximumImageBytes) {
        const totalSectors = imageBytes / BYTES_PER_SECTOR;
        for(const sectorsPerCluster of [1, 2, 4, 8, 16, 32, 64, 128]) {
            const geometry = calculateGeometry(totalSectors, sectorsPerCluster, rootEntryCount);
            if(
                geometry.dataClusterCount < FAT16_MIN_CLUSTERS ||
                geometry.dataClusterCount > FAT16_MAX_CLUSTERS
            ) {
                continue;
            }
            const required = requiredClusters(root, sectorsPerCluster * BYTES_PER_SECTOR);
            const reserve = Math.ceil(options.reserveFreeBytes / (sectorsPerCluster * BYTES_PER_SECTOR));
            if(required + reserve <= geometry.dataClusterCount) return geometry;
        }
        imageBytes *= 2;
    }
    throw new Error(
        `Source tree and requested free space do not fit in a FAT16 image up to ${options.maximumImageBytes} bytes`,
    );
}

function calculateGeometry(
    totalSectors: number,
    sectorsPerCluster: number,
    rootEntryCount: number,
): FatGeometry {
    const rootDirectorySectors = Math.ceil(rootEntryCount * 32 / BYTES_PER_SECTOR);
    let sectorsPerFat = 1;
    for(let iteration = 0; iteration < 32; iteration += 1) {
        const dataSectors = totalSectors
            - RESERVED_SECTORS
            - rootDirectorySectors
            - FAT_COUNT * sectorsPerFat;
        const dataClusters = Math.max(0, Math.floor(dataSectors / sectorsPerCluster));
        const next = Math.ceil((dataClusters + 2) * 2 / BYTES_PER_SECTOR);
        if(next === sectorsPerFat) break;
        sectorsPerFat = next;
    }
    const firstDataSector = RESERVED_SECTORS + FAT_COUNT * sectorsPerFat + rootDirectorySectors;
    const dataClusterCount = Math.floor((totalSectors - firstDataSector) / sectorsPerCluster);
    return {
        imageBytes: totalSectors * BYTES_PER_SECTOR,
        totalSectors,
        sectorsPerCluster,
        sectorsPerFat,
        rootEntryCount,
        rootDirectorySectors,
        firstDataSector,
        dataClusterCount,
    };
}

function requiredClusters(root: FatDirectory, clusterBytes: number): number {
    let result = 0;
    const visit = (directory: FatDirectory): void => {
        for(const child of directory.children) {
            if(child.kind === "file") {
                result += Math.ceil(child.data.length / clusterBytes);
            } else {
                result += Math.max(1, Math.ceil(directoryEntrySlots(child, false) * 32 / clusterBytes));
                visit(child);
            }
        }
    };
    visit(root);
    return result;
}

function allocateClusters(root: FatDirectory, geometry: FatGeometry): number {
    const clusterBytes = geometry.sectorsPerCluster * BYTES_PER_SECTOR;
    let nextCluster = 2;
    const allocate = (entry: FatEntry, count: number): void => {
        entry.clusterCount = count;
        entry.firstCluster = count > 0 ? nextCluster : 0;
        nextCluster += count;
    };
    const visit = (directory: FatDirectory): void => {
        for(const child of directory.children) {
            if(child.kind === "file") {
                allocate(child, Math.ceil(child.data.length / clusterBytes));
            } else {
                allocate(child, Math.max(1, Math.ceil(directoryEntrySlots(child, false) * 32 / clusterBytes)));
                visit(child);
            }
        }
    };
    visit(root);
    const used = nextCluster - 2;
    if(used > geometry.dataClusterCount) throw new Error("Internal FAT allocation exceeds image capacity");
    return used;
}

function renderImage(root: FatDirectory, geometry: FatGeometry, volumeLabel: string): Buffer {
    const image = Buffer.alloc(geometry.imageBytes);
    renderBootSector(image.subarray(0, BYTES_PER_SECTOR), geometry, volumeLabel);

    const fat = Buffer.alloc(geometry.sectorsPerFat * BYTES_PER_SECTOR);
    fat.writeUInt16LE(0xfff8, 0);
    fat.writeUInt16LE(0xffff, 2);
    walkEntries(root, entry => {
        const first = entry.firstCluster ?? 0;
        const count = entry.clusterCount ?? 0;
        for(let offset = 0; offset < count; offset += 1) {
            fat.writeUInt16LE(offset + 1 === count ? 0xffff : first + offset + 1, (first + offset) * 2);
        }
    });
    const firstFatOffset = RESERVED_SECTORS * BYTES_PER_SECTOR;
    fat.copy(image, firstFatOffset);
    fat.copy(image, firstFatOffset + fat.length);

    const rootOffset = (
        RESERVED_SECTORS + FAT_COUNT * geometry.sectorsPerFat
    ) * BYTES_PER_SECTOR;
    const rootBuffer = image.subarray(rootOffset, rootOffset + geometry.rootEntryCount * 32);
    writeVolumeLabelEntry(rootBuffer.subarray(0, 32), volumeLabel);
    writeChildEntries(rootBuffer, 32, root.children);

    const clusterBytes = geometry.sectorsPerCluster * BYTES_PER_SECTOR;
    const clusterOffset = (cluster: number): number => (
        geometry.firstDataSector + (cluster - 2) * geometry.sectorsPerCluster
    ) * BYTES_PER_SECTOR;

    const writeDirectory = (directory: FatDirectory, parent: FatDirectory | undefined): void => {
        if(directory !== root) {
            const count = directory.clusterCount ?? 0;
            const buffer = image.subarray(
                clusterOffset(directory.firstCluster ?? 0),
                clusterOffset(directory.firstCluster ?? 0) + count * clusterBytes,
            );
            writeDotEntry(buffer.subarray(0, 32), ".", directory.firstCluster ?? 0);
            writeDotEntry(buffer.subarray(32, 64), "..", parent === root ? 0 : (parent?.firstCluster ?? 0));
            writeChildEntries(buffer, 64, directory.children);
        }
        for(const child of directory.children) {
            if(child.kind === "directory") {
                writeDirectory(child, directory);
            } else if(child.data.length > 0) {
                child.data.copy(image, clusterOffset(child.firstCluster ?? 0));
            }
        }
    };
    writeDirectory(root, undefined);
    return image;
}

function renderBootSector(sector: Buffer, geometry: FatGeometry, volumeLabel: string): void {
    sector.set([0xeb, 0x3c, 0x90], 0);
    sector.write("MSDOS5.0", 3, 8, "ascii");
    sector.writeUInt16LE(BYTES_PER_SECTOR, 11);
    sector[13] = geometry.sectorsPerCluster;
    sector.writeUInt16LE(RESERVED_SECTORS, 14);
    sector[16] = FAT_COUNT;
    sector.writeUInt16LE(geometry.rootEntryCount, 17);
    if(geometry.totalSectors < 65_536) {
        sector.writeUInt16LE(geometry.totalSectors, 19);
    } else {
        sector.writeUInt32LE(geometry.totalSectors, 32);
    }
    sector[21] = 0xf8;
    sector.writeUInt16LE(geometry.sectorsPerFat, 22);
    sector.writeUInt16LE(32, 24);
    sector.writeUInt16LE(64, 26);
    sector[36] = 0x80;
    sector[38] = 0x29;
    sector.writeUInt32LE(0x465a5344, 39);
    sector.write(volumeLabel, 43, 11, "ascii");
    sector.write("FAT16   ", 54, 8, "ascii");
    sector[510] = 0x55;
    sector[511] = 0xaa;
}

function writeVolumeLabelEntry(target: Buffer, volumeLabel: string): void {
    target.fill(0);
    target.write(volumeLabel, 0, 11, "ascii");
    target[11] = 0x08;
    writeEntryTimestamps(target);
}

function writeDotEntry(target: Buffer, name: "." | "..", cluster: number): void {
    target.fill(0);
    target.fill(0x20, 0, 11);
    target.write(name, 0, name.length, "ascii");
    target[11] = 0x10;
    target.writeUInt16LE(cluster, 26);
    writeEntryTimestamps(target);
}

function writeChildEntries(target: Buffer, startOffset: number, children: FatEntry[]): void {
    let offset = startOffset;
    for(const child of children) {
        if(!child.shortName) throw new Error(`Missing FAT short name for ${child.name}`);
        if(child.needsLongName) {
            const longEntries = encodeLongNameEntries(child.name, child.shortName);
            for(const entry of longEntries) {
                if(offset + 32 > target.length) throw new Error("Directory entry allocation overflow");
                entry.copy(target, offset);
                offset += 32;
            }
        }
        if(offset + 32 > target.length) throw new Error("Directory entry allocation overflow");
        writeShortEntry(target.subarray(offset, offset + 32), child);
        offset += 32;
    }
    // Buffers are zero-filled, so the next entry remains the required end marker.
}

function writeShortEntry(target: Buffer, entry: FatEntry): void {
    target.fill(0);
    entry.shortName?.copy(target, 0);
    target[11] = entry.kind === "directory" ? 0x10 : 0x20;
    writeEntryTimestamps(target);
    target.writeUInt16LE(entry.firstCluster ?? 0, 26);
    if(entry.kind === "file") target.writeUInt32LE(entry.data.length, 28);
}

function writeEntryTimestamps(target: Buffer): void {
    target.writeUInt16LE(DOS_DATE_1980_01_01, 16);
    target.writeUInt16LE(DOS_DATE_1980_01_01, 18);
    target.writeUInt16LE(DOS_DATE_1980_01_01, 24);
}

function encodeLongNameEntries(name: string, shortName: Buffer): Buffer[] {
    const units = Array.from({ length: name.length }, (_, index) => name.charCodeAt(index));
    const count = Math.ceil(units.length / 13);
    const checksum = shortNameChecksum(shortName);
    const result: Buffer[] = [];
    for(let sequence = count; sequence >= 1; sequence -= 1) {
        const entry = Buffer.alloc(32, 0xff);
        entry[0] = sequence | (sequence === count ? 0x40 : 0);
        entry[11] = 0x0f;
        entry[12] = 0;
        entry[13] = checksum;
        entry.writeUInt16LE(0, 26);
        const chunk = units.slice((sequence - 1) * 13, sequence * 13);
        if(sequence === count && chunk.length < 13) chunk.push(0);
        while(chunk.length < 13) chunk.push(0xffff);
        const positions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
        positions.forEach((position, index) => entry.writeUInt16LE(chunk[index], position));
        result.push(entry);
    }
    return result;
}

function shortNameChecksum(shortName: Buffer): number {
    let checksum = 0;
    for(const byte of shortName) {
        checksum = (((checksum & 1) << 7) | (checksum >> 1)) + byte;
        checksum &= 0xff;
    }
    return checksum;
}

function fingerprintTree(root: FatDirectory): string {
    const hash = crypto.createHash("sha256");
    const visit = (directory: FatDirectory, prefix: string): void => {
        for(const child of directory.children.slice().sort((left, right) => compareNames(left.name, right.name))) {
            const relative = prefix ? `${prefix}/${child.name}` : child.name;
            const encoded = Buffer.from(relative, "utf8");
            const header = Buffer.alloc(9);
            header[0] = child.kind === "directory" ? 0x44 : 0x46;
            header.writeUInt32LE(encoded.length, 1);
            header.writeUInt32LE(child.kind === "file" ? child.data.length : 0, 5);
            hash.update(header);
            hash.update(encoded);
            if(child.kind === "file") hash.update(child.data);
            else visit(child, relative);
        }
    };
    visit(root, "");
    return hash.digest("hex");
}

function walkEntries(directory: FatDirectory, callback: (entry: FatEntry) => void): void {
    for(const child of directory.children) {
        callback(child);
        if(child.kind === "directory") walkEntries(child, callback);
    }
}

function readFat16Image(
    imagePath: string,
    maxEntries: number,
    maxContentBytes: number,
    maxDepth: number,
): { root: FatDirectory; stats: SourceStats } {
    const imageStat = fs.statSync(imagePath);
    if(!imageStat.isFile() || imageStat.size > 1024 * 1024 * 1024) {
        throw new Error(`FAT image must be a regular file no larger than 1 GiB: ${imagePath}`);
    }
    const image = fs.readFileSync(imagePath);
    if(image.length < BYTES_PER_SECTOR || image[510] !== 0x55 || image[511] !== 0xaa) {
        throw new Error(`Not a FAT superfloppy image: ${imagePath}`);
    }
    const bytesPerSector = image.readUInt16LE(11);
    const sectorsPerCluster = image[13];
    const reservedSectors = image.readUInt16LE(14);
    const fatCount = image[16];
    const rootEntryCount = image.readUInt16LE(17);
    const sectorsPerFat = image.readUInt16LE(22);
    const totalSectors = image.readUInt16LE(19) || image.readUInt32LE(32);
    if(
        bytesPerSector !== BYTES_PER_SECTOR ||
        sectorsPerCluster < 1 ||
        sectorsPerCluster > 128 ||
        (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0 ||
        reservedSectors < 1 ||
        fatCount < 1 ||
        rootEntryCount < 1 ||
        sectorsPerFat < 1 ||
        totalSectors < 1 ||
        totalSectors * bytesPerSector !== image.length
    ) {
        throw new Error(`Unsupported or inconsistent FAT16 geometry: ${imagePath}`);
    }

    const rootDirectorySectors = Math.ceil(rootEntryCount * 32 / bytesPerSector);
    const firstRootSector = reservedSectors + fatCount * sectorsPerFat;
    const firstDataSector = firstRootSector + rootDirectorySectors;
    const dataClusterCount = Math.floor(
        (totalSectors - firstDataSector) / sectorsPerCluster,
    );
    if(dataClusterCount < FAT16_MIN_CLUSTERS || dataClusterCount > FAT16_MAX_CLUSTERS) {
        throw new Error(`Image is not a FAT16 volume: ${imagePath}`);
    }
    const fatOffset = reservedSectors * bytesPerSector;
    const fatLength = sectorsPerFat * bytesPerSector;
    if(fatOffset + fatLength > image.length || fatLength < (dataClusterCount + 2) * 2) {
        throw new Error(`FAT16 allocation table is truncated: ${imagePath}`);
    }
    const clusterBytes = sectorsPerCluster * bytesPerSector;
    const stats: SourceStats = { fileCount: 0, directoryCount: 0, contentBytes: 0 };
    const visitedDirectories = new Set<number>();

    const readChain = (firstCluster: number, exactBytes?: number): Buffer => {
        if(firstCluster === 0) {
            if((exactBytes ?? 0) === 0) return Buffer.alloc(0);
            throw new Error("Non-empty FAT file has no first cluster");
        }
        const chunks: Buffer[] = [];
        const visited = new Set<number>();
        let cluster = firstCluster;
        while(true) {
            if(cluster < 2 || cluster >= dataClusterCount + 2 || visited.has(cluster)) {
                throw new Error(`Invalid or cyclic FAT cluster chain at ${cluster}`);
            }
            visited.add(cluster);
            const offset = (
                firstDataSector + (cluster - 2) * sectorsPerCluster
            ) * bytesPerSector;
            chunks.push(image.subarray(offset, offset + clusterBytes));
            const next = image.readUInt16LE(fatOffset + cluster * 2);
            if(next >= 0xfff8) break;
            if(next === 0 || next === 1 || next === 0xfff7 || (next >= 0xfff0 && next < 0xfff8)) {
                throw new Error(`Invalid FAT cluster-chain value 0x${next.toString(16)}`);
            }
            cluster = next;
            if(visited.size > dataClusterCount) throw new Error("FAT cluster chain is too long");
        }
        const available = chunks.length * clusterBytes;
        if(exactBytes !== undefined && exactBytes > available) {
            throw new Error(`FAT file size ${exactBytes} exceeds its cluster chain (${available})`);
        }
        const combined = Buffer.concat(chunks, available);
        return exactBytes === undefined ? combined : Buffer.from(combined.subarray(0, exactBytes));
    };

    const parseDirectory = (
        data: Buffer,
        name: string,
        depth: number,
        directoryCluster: number,
    ): FatDirectory => {
        if(depth > maxDepth) throw new Error(`FAT image exceeds maximum depth ${maxDepth}`);
        if(directoryCluster !== 0) {
            if(visitedDirectories.has(directoryCluster)) {
                throw new Error(`FAT directory cycle at cluster ${directoryCluster}`);
            }
            visitedDirectories.add(directoryCluster);
        }
        const directory: FatDirectory = { kind: "directory", name, children: [] };
        const foldedNames = new Set<string>();
        let pendingLongEntries: Buffer[] = [];
        for(let offset = 0; offset + 32 <= data.length; offset += 32) {
            const entry = data.subarray(offset, offset + 32);
            if(entry[0] === 0) break;
            if(entry[0] === 0xe5) {
                pendingLongEntries = [];
                continue;
            }
            const attributes = entry[11];
            if(attributes === 0x0f) {
                pendingLongEntries.push(Buffer.from(entry));
                continue;
            }
            if(attributes & 0x08) {
                pendingLongEntries = [];
                continue;
            }

            const shortName = Buffer.from(entry.subarray(0, 11));
            const longName = decodeLongNameEntries(pendingLongEntries, shortName);
            pendingLongEntries = [];
            const entryName = longName ?? decodeShortName(shortName, entry[12]);
            if(entryName === "." || entryName === "..") continue;
            validateLongName(entryName);
            const folded = foldName(entryName);
            if(foldedNames.has(folded)) {
                throw new Error(`FAT directory contains duplicate name: ${entryName}`);
            }
            foldedNames.add(folded);

            const firstCluster = entry.readUInt16LE(26);
            const fileSize = entry.readUInt32LE(28);
            stats.fileCount += (attributes & 0x10) === 0 ? 1 : 0;
            stats.directoryCount += (attributes & 0x10) !== 0 ? 1 : 0;
            if(stats.fileCount + stats.directoryCount > maxEntries) {
                throw new Error(`FAT image has more than ${maxEntries} entries`);
            }
            if(attributes & 0x10) {
                if(firstCluster < 2) throw new Error(`FAT subdirectory has invalid cluster: ${entryName}`);
                directory.children.push(parseDirectory(
                    readChain(firstCluster),
                    entryName,
                    depth + 1,
                    firstCluster,
                ));
            } else {
                stats.contentBytes += fileSize;
                if(stats.contentBytes > maxContentBytes) {
                    throw new Error(
                        `FAT image contains ${stats.contentBytes} file bytes; limit is ${maxContentBytes}`,
                    );
                }
                directory.children.push({
                    kind: "file",
                    name: entryName,
                    data: readChain(firstCluster, fileSize),
                });
            }
        }
        directory.children.sort((left, right) => compareNames(left.name, right.name));
        return directory;
    };

    const rootOffset = firstRootSector * bytesPerSector;
    const root = parseDirectory(
        image.subarray(rootOffset, rootOffset + rootEntryCount * 32),
        "",
        0,
        0,
    );
    return { root, stats };
}

function decodeLongNameEntries(entries: Buffer[], shortName: Buffer): string | undefined {
    if(entries.length === 0) return undefined;
    const count = entries[0][0] & 0x1f;
    if(count < 1 || (entries[0][0] & 0x40) === 0 || entries.length !== count) return undefined;
    const checksum = shortNameChecksum(shortName);
    const positions = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
    const chunks: number[][] = [];
    for(let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const sequence = entry[0] & 0x1f;
        if(
            sequence !== count - index ||
            entry[11] !== 0x0f ||
            entry[13] !== checksum
        ) {
            return undefined;
        }
        chunks[sequence - 1] = positions.map(position => entry.readUInt16LE(position));
    }
    const units = chunks.flat();
    const terminator = units.indexOf(0);
    const meaningful = units
        .slice(0, terminator >= 0 ? terminator : units.length)
        .filter(unit => unit !== 0xffff);
    return String.fromCharCode(...meaningful);
}

function decodeShortName(shortName: Buffer, caseFlags: number): string {
    const copy = Buffer.from(shortName);
    if(copy[0] === 0x05) copy[0] = 0xe5;
    let base = copy.toString("latin1", 0, 8).trimEnd();
    let extension = copy.toString("latin1", 8, 11).trimEnd();
    if(caseFlags & 0x08) base = base.toLowerCase();
    if(caseFlags & 0x10) extension = extension.toLowerCase();
    return extension ? `${base}.${extension}` : base;
}

function mergeDirectoryToHost(
    directory: FatDirectory,
    hostDirectory: string,
    overwriteFiles: boolean,
    stats: {
        filesWritten: number;
        filesUnchanged: number;
        filesSkipped: number;
        directoriesCreated: number;
    },
): void {
    const hostNames = fs.readdirSync(hostDirectory);
    const namesByFold = new Map(hostNames.map(name => [foldName(name), name]));
    for(const child of directory.children) {
        const existingName = namesByFold.get(foldName(child.name));
        const targetPath = path.join(hostDirectory, existingName ?? child.name);
        let existing: fs.Stats | undefined;
        try {
            existing = fs.lstatSync(targetPath);
        } catch(error) {
            if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if(existing?.isSymbolicLink()) {
            throw new Error(`Refusing to merge through symbolic link: ${targetPath}`);
        }

        if(child.kind === "directory") {
            if(existing && !existing.isDirectory()) {
                throw new Error(`Cannot merge FAT directory over host file: ${targetPath}`);
            }
            if(!existing) {
                fs.mkdirSync(targetPath);
                stats.directoriesCreated += 1;
            }
            mergeDirectoryToHost(child, targetPath, overwriteFiles, stats);
        } else {
            if(existing?.isDirectory()) {
                throw new Error(`Cannot merge FAT file over host directory: ${targetPath}`);
            }
            if(existing && fileEqualsBuffer(targetPath, child.data)) {
                stats.filesUnchanged += 1;
            } else if(existing && !overwriteFiles) {
                stats.filesSkipped += 1;
            } else {
                writeImageAtomically(targetPath, child.data);
                stats.filesWritten += 1;
            }
        }
    }
}

function fileEqualsBuffer(filePath: string, expected: Buffer): boolean {
    try {
        const stat = fs.statSync(filePath);
        if(!stat.isFile() || stat.size !== expected.length) return false;
        return fs.readFileSync(filePath).equals(expected);
    } catch(error) {
        if((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function writeImageAtomically(imagePath: string, image: Buffer): void {
    const temporaryPath = `${imagePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(temporaryPath, image);
        fs.renameSync(temporaryPath, imagePath);
    } catch(error) {
        try {
            fs.unlinkSync(temporaryPath);
        } catch {
            // Keep the original error.
        }
        throw error;
    }
}

function foldName(name: string): string {
    return name.toUpperCase();
}

function compareNames(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function roundUp(value: number, multiple: number): number {
    return Math.ceil(value / multiple) * multiple;
}

function nextPowerOfTwo(value: number): number {
    let result = 1;
    while(result < value) result *= 2;
    return result;
}
