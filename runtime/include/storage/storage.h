#pragma once

#include <furi.h>

typedef struct Storage Storage;
typedef struct File File;

typedef enum {
    FSAM_READ = 1,
    FSAM_WRITE = 2,
    FSAM_READ_WRITE = 3,
} FS_AccessMode;

typedef enum {
    FSOM_OPEN_EXISTING = 1,
    FSOM_OPEN_ALWAYS = 2,
    FSOM_OPEN_APPEND = 4,
    FSOM_CREATE_NEW = 8,
    FSOM_CREATE_ALWAYS = 16,
} FS_OpenMode;

typedef enum {
    FSE_OK = 0,
    FSE_NOT_READY,
    FSE_EXIST,
    FSE_NOT_EXIST,
    FSE_INVALID_PARAMETER,
    FSE_DENIED,
    FSE_INVALID_NAME,
    FSE_INTERNAL,
    FSE_NOT_IMPLEMENTED,
    FSE_ALREADY_OPEN,
} FS_Error;

typedef enum {
    FSF_DIRECTORY = (1 << 0),
} FS_Flags;

typedef struct {
    uint8_t flags;
    uint64_t size;
} FileInfo;

File* storage_file_alloc(Storage* storage);
void storage_file_free(File* file);
bool storage_file_open(
    File* file,
    const char* path,
    FS_AccessMode access_mode,
    FS_OpenMode open_mode);
bool storage_file_close(File* file);
bool storage_file_is_open(File* file);
uint16_t storage_file_read(File* file, void* data, uint16_t bytes_to_read);
uint16_t storage_file_write(File* file, const void* data, uint16_t bytes_to_write);
bool storage_file_seek(File* file, uint32_t offset, bool from_start);
uint64_t storage_file_size(File* file);
uint64_t storage_file_tell(File* file);
bool storage_file_eof(File* file);
FS_Error storage_file_get_error(File* file);
bool storage_file_sync(File* file);
bool storage_file_exists(Storage* storage, const char* path);

bool storage_dir_open(File* file, const char* path);
bool storage_dir_read(
    File* file,
    FileInfo* file_info,
    char* name,
    uint16_t name_length);
bool storage_dir_close(File* file);
bool file_info_is_dir(const FileInfo* file_info);

FS_Error storage_common_mkdir(Storage* storage, const char* path);
bool storage_simply_mkdir(Storage* storage, const char* path);
void storage_common_resolve_path_and_ensure_app_directory(
    Storage* storage,
    FuriString* path);
