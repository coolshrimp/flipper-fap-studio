export interface StorageVolumeInfo {
    totalSpace: number;
    freeSpace: number;
    sharedWithExt?: boolean;
    contentBytes?: number;
    contentComplete?: boolean;
}

export function storageVolumesShareFilesystem(
    ext: StorageVolumeInfo | null,
    internal: StorageVolumeInfo | null,
): boolean {
    return Boolean(
        ext &&
        internal &&
        ext.totalSpace > 0 &&
        ext.totalSpace === internal.totalSpace &&
        ext.freeSpace === internal.freeSpace,
    );
}

/**
 * Recent Flipper firmware implements /int as a virtual directory on the SD
 * filesystem. Its filesystem-info RPC therefore returns the same capacity as
 * /ext. Mark that case explicitly instead of presenting a second SD-sized
 * internal drive.
 */
export function reconcileStorageVolumes(
    ext: StorageVolumeInfo | null,
    internal: StorageVolumeInfo | null,
    internalContent?: { bytes: number; complete: boolean },
): { ext: StorageVolumeInfo | null; int: StorageVolumeInfo | null } {
    if (!storageVolumesShareFilesystem(ext, internal) || !internal) {
        return { ext, int: internal };
    }
    return {
        ext,
        int: {
            ...internal,
            sharedWithExt: true,
            contentBytes: internalContent?.bytes,
            contentComplete: internalContent?.complete,
        },
    };
}
