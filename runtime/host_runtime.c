#include "host_runtime.h"

#include <direct.h>
#include <dirent.h>
#include <errno.h>
#include <expansion/expansion.h>
#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_rtc.h>
#include <furi_hal_serial.h>
#include <furi_hal_serial_control.h>
#include <furi_hal_speaker.h>
#include <subghz/devices/devices.h>
#include <gui/elements.h>
#include <gui/gui.h>
#include <notification/notification.h>
#include <notification/notification_messages.h>
#include <stdarg.h>
#include <storage/storage.h>
#include <toolbox/saved_struct.h>
#include <targets/f7/furi_hal/furi_hal_usb_cdc.h>
#include <sys/stat.h>
#include <time.h>
#include <windows.h>

struct FuriMutex {
    CRITICAL_SECTION section;
};

struct FuriSemaphore {
    HANDLE handle;
};

struct FuriMessageQueue {
    CRITICAL_SECTION section;
    CONDITION_VARIABLE not_empty;
    CONDITION_VARIABLE not_full;
    uint8_t* data;
    uint32_t capacity;
    uint32_t item_size;
    uint32_t head;
    uint32_t tail;
    uint32_t count;
};

struct FuriStreamBuffer {
    CRITICAL_SECTION section;
    CONDITION_VARIABLE changed;
    uint8_t* data;
    size_t capacity;
    size_t head;
    size_t tail;
    size_t count;
};

struct FuriString {
    char* value;
};

struct FuriThread {
    HANDLE handle;
    FuriThreadCallback callback;
    void* context;
    volatile LONG exit_requested;
    FuriEventLoop* event_loop;
};

struct Storage {
    int unused;
};

struct File {
    FILE* stream;
    DIR* directory;
    char directory_path[4096];
};

struct Gui {
    int unused;
};

struct NotificationApp {
    int unused;
};

struct Expansion {
    int unused;
};

struct ViewPort {
    ViewPortDrawCallback draw;
    void* draw_context;
    ViewPortInputCallback input;
    void* input_context;
    bool enabled;
};

struct Canvas {
    Color color;
    Font font;
    char* commands;
    size_t length;
    size_t capacity;
    bool first;
};

static Storage runtime_storage;
static Gui runtime_gui;
static NotificationApp runtime_notification;
static Expansion runtime_expansion;
static ViewPort* runtime_view_port;
static CRITICAL_SECTION runtime_output_lock;
static CRITICAL_SECTION runtime_view_lock;
static ULONGLONG runtime_start_tick;
static char runtime_storage_root[4096];
static uint32_t runtime_input_sequence;
static DWORD runtime_thread_tls = TLS_OUT_OF_INDEXES;
static bool runtime_speaker_playing;
static float runtime_speaker_frequency;
static float runtime_speaker_volume;

const NotificationSequence sequence_display_backlight_enforce_on = 1;
const NotificationSequence sequence_display_backlight_enforce_auto = 2;
const NotificationSequence sequence_single_vibro = 3;
const NotificationSequence sequence_success = 4;
const NotificationSequence sequence_error = 5;
FuriHalI2cBusHandle furi_hal_i2c_handle_external = {0};
static CdcCallbacks* runtime_cdc_callbacks;
static void* runtime_cdc_context;

static DWORD runtime_timeout(uint32_t timeout) {
    return timeout == FuriWaitForever ? INFINITE : timeout;
}

static void runtime_json_string(FILE* output, const char* value) {
    fputc('"', output);
    for(const unsigned char* cursor = (const unsigned char*)(value ? value : ""); *cursor; cursor++) {
        switch(*cursor) {
        case '"':
            fputs("\\\"", output);
            break;
        case '\\':
            fputs("\\\\", output);
            break;
        case '\n':
            fputs("\\n", output);
            break;
        case '\r':
            fputs("\\r", output);
            break;
        case '\t':
            fputs("\\t", output);
            break;
        default:
            if(*cursor < 0x20) {
                fprintf(output, "\\u%04x", *cursor);
            } else {
                fputc(*cursor, output);
            }
            break;
        }
    }
    fputc('"', output);
}

void runtime_log(const char* level, const char* tag, const char* format, ...) {
    char message[1024];
    va_list args;
    va_start(args, format);
    vsnprintf(message, sizeof(message), format, args);
    va_end(args);

    EnterCriticalSection(&runtime_output_lock);
    fputs("{\"type\":\"log\",\"level\":", stdout);
    runtime_json_string(stdout, level);
    fputs(",\"tag\":", stdout);
    runtime_json_string(stdout, tag);
    fputs(",\"text\":", stdout);
    runtime_json_string(stdout, message);
    fputs("}\n", stdout);
    fflush(stdout);
    LeaveCriticalSection(&runtime_output_lock);
}

void runtime_emit_status(const char* state, int32_t exit_code) {
    EnterCriticalSection(&runtime_output_lock);
    fputs("{\"type\":\"status\",\"state\":", stdout);
    runtime_json_string(stdout, state);
    fprintf(stdout, ",\"exitCode\":%ld}\n", (long)exit_code);
    fflush(stdout);
    LeaveCriticalSection(&runtime_output_lock);
}

static void runtime_emit_audio(
    bool playing,
    float frequency,
    float volume,
    uint32_t duration_ms) {
    EnterCriticalSection(&runtime_output_lock);
    fprintf(
        stdout,
        "{\"type\":\"audio\",\"playing\":%s,\"frequency\":%.3f,\"volume\":%.4f",
        playing ? "true" : "false",
        playing ? frequency : 0.0f,
        playing ? volume : 0.0f);
    if(duration_ms) fprintf(stdout, ",\"durationMs\":%lu", (unsigned long)duration_ms);
    fputs("}\n", stdout);
    fflush(stdout);
    LeaveCriticalSection(&runtime_output_lock);
}

void runtime_check_failed(const char* expression, const char* file, int line) {
    runtime_log("error", "check", "%s failed at %s:%d", expression, file, line);
    abort();
}

uint32_t furi_get_tick(void) {
    return (uint32_t)(GetTickCount64() - runtime_start_tick);
}

void furi_delay_tick(uint32_t ticks) {
    Sleep(ticks);
}

static DWORD WINAPI runtime_thread_entry(void* context) {
    FuriThread* thread = context;
    if(runtime_thread_tls != TLS_OUT_OF_INDEXES) TlsSetValue(runtime_thread_tls, thread);
    const DWORD result =
        thread && thread->callback ? (DWORD)thread->callback(thread->context) : 0;
    if(runtime_thread_tls != TLS_OUT_OF_INDEXES) TlsSetValue(runtime_thread_tls, NULL);
    return result;
}

FuriThread* furi_thread_alloc_ex(
    const char* name,
    uint32_t stack_size,
    FuriThreadCallback callback,
    void* context) {
    UNUSED(name);
    UNUSED(stack_size);
    if(!callback) return NULL;
    FuriThread* thread = calloc(1, sizeof(FuriThread));
    if(thread) {
        thread->callback = callback;
        thread->context = context;
    }
    return thread;
}

void furi_thread_set_priority(FuriThread* thread, FuriThreadPriority priority) {
    UNUSED(thread);
    UNUSED(priority);
}

void furi_thread_start(FuriThread* thread) {
    if(thread && !thread->handle) {
        thread->handle = CreateThread(NULL, 0, runtime_thread_entry, thread, 0, NULL);
    }
}

void furi_thread_join(FuriThread* thread) {
    if(thread && thread->handle) WaitForSingleObject(thread->handle, INFINITE);
}

void furi_thread_free(FuriThread* thread) {
    if(!thread) return;
    if(thread->handle) CloseHandle(thread->handle);
    free(thread);
}

bool furi_thread_signal(const FuriThread* thread, uint32_t signal, void* arg) {
    UNUSED(arg);
    if(!thread || signal != FuriSignalExit) return false;
    FuriThread* mutable_thread = (FuriThread*)thread;
    InterlockedExchange(&mutable_thread->exit_requested, 1);
    FuriEventLoop* loop = mutable_thread->event_loop;
    if(loop) furi_event_loop_stop(loop);
    return true;
}

void furi_thread_yield(void) {
    if(!SwitchToThread()) Sleep(0);
}

void runtime_thread_set_event_loop(FuriEventLoop* loop) {
    if(runtime_thread_tls == TLS_OUT_OF_INDEXES) return;
    FuriThread* thread = TlsGetValue(runtime_thread_tls);
    if(!thread) return;
    thread->event_loop = loop;
    if(loop && InterlockedCompareExchange(&thread->exit_requested, 0, 0)) {
        furi_event_loop_stop(loop);
    }
}

uint32_t furi_ms_to_ticks(uint32_t milliseconds) {
    return milliseconds;
}

void furi_delay_ms(uint32_t milliseconds) {
    Sleep(milliseconds);
}

const char* input_get_key_name(InputKey key) {
    switch(key) {
    case InputKeyUp:
        return "Up";
    case InputKeyDown:
        return "Down";
    case InputKeyRight:
        return "Right";
    case InputKeyLeft:
        return "Left";
    case InputKeyOk:
        return "Ok";
    case InputKeyBack:
        return "Back";
    default:
        return "Unknown";
    }
}

const char* input_get_type_name(InputType type) {
    switch(type) {
    case InputTypePress:
        return "Press";
    case InputTypeRelease:
        return "Release";
    case InputTypeShort:
        return "Short";
    case InputTypeLong:
        return "Long";
    case InputTypeRepeat:
        return "Repeat";
    default:
        return "Unknown";
    }
}

size_t memmgr_get_free_heap(void) {
    return 256U * 1024U * 1024U;
}

FuriMutex* furi_mutex_alloc(FuriMutexType type) {
    UNUSED(type);
    FuriMutex* mutex = calloc(1, sizeof(FuriMutex));
    if(mutex) InitializeCriticalSection(&mutex->section);
    return mutex;
}

void furi_mutex_free(FuriMutex* mutex) {
    if(!mutex) return;
    DeleteCriticalSection(&mutex->section);
    free(mutex);
}

FuriStatus furi_mutex_acquire(FuriMutex* mutex, uint32_t timeout) {
    if(!mutex) return FuriStatusError;
    if(timeout == FuriWaitForever) {
        EnterCriticalSection(&mutex->section);
        return FuriStatusOk;
    }
    const ULONGLONG deadline = GetTickCount64() + timeout;
    do {
        if(TryEnterCriticalSection(&mutex->section)) return FuriStatusOk;
        Sleep(1);
    } while(GetTickCount64() <= deadline);
    return FuriStatusErrorTimeout;
}

FuriStatus furi_mutex_release(FuriMutex* mutex) {
    if(!mutex) return FuriStatusError;
    LeaveCriticalSection(&mutex->section);
    return FuriStatusOk;
}

FuriSemaphore* furi_semaphore_alloc(uint32_t max_count, uint32_t initial_count) {
    if(!max_count || initial_count > max_count) return NULL;
    FuriSemaphore* semaphore = calloc(1, sizeof(FuriSemaphore));
    if(!semaphore) return NULL;
    semaphore->handle = CreateSemaphoreA(NULL, (LONG)initial_count, (LONG)max_count, NULL);
    if(!semaphore->handle) {
        free(semaphore);
        return NULL;
    }
    return semaphore;
}

void furi_semaphore_free(FuriSemaphore* semaphore) {
    if(!semaphore) return;
    CloseHandle(semaphore->handle);
    free(semaphore);
}

FuriStatus furi_semaphore_acquire(FuriSemaphore* semaphore, uint32_t timeout) {
    if(!semaphore) return FuriStatusError;
    const DWORD result = WaitForSingleObject(semaphore->handle, runtime_timeout(timeout));
    return result == WAIT_OBJECT_0 ? FuriStatusOk : FuriStatusErrorTimeout;
}

FuriStatus furi_semaphore_release(FuriSemaphore* semaphore) {
    if(!semaphore) return FuriStatusError;
    return ReleaseSemaphore(semaphore->handle, 1, NULL) ? FuriStatusOk : FuriStatusErrorResource;
}

FuriMessageQueue* furi_message_queue_alloc(uint32_t capacity, uint32_t item_size) {
    if(!capacity || !item_size) return NULL;
    FuriMessageQueue* queue = calloc(1, sizeof(FuriMessageQueue));
    if(!queue) return NULL;
    queue->data = calloc(capacity, item_size);
    if(!queue->data) {
        free(queue);
        return NULL;
    }
    queue->capacity = capacity;
    queue->item_size = item_size;
    InitializeCriticalSection(&queue->section);
    InitializeConditionVariable(&queue->not_empty);
    InitializeConditionVariable(&queue->not_full);
    return queue;
}

void furi_message_queue_free(FuriMessageQueue* queue) {
    if(!queue) return;
    DeleteCriticalSection(&queue->section);
    free(queue->data);
    free(queue);
}

FuriStatus furi_message_queue_put(
    FuriMessageQueue* queue,
    const void* item,
    uint32_t timeout) {
    if(!queue || !item) return FuriStatusError;
    EnterCriticalSection(&queue->section);
    while(queue->count == queue->capacity) {
        if(timeout == 0 ||
           !SleepConditionVariableCS(
               &queue->not_full, &queue->section, runtime_timeout(timeout))) {
            LeaveCriticalSection(&queue->section);
            return FuriStatusErrorTimeout;
        }
    }
    memcpy(
        queue->data + ((size_t)queue->tail * queue->item_size),
        item,
        queue->item_size);
    queue->tail = (queue->tail + 1U) % queue->capacity;
    queue->count++;
    WakeConditionVariable(&queue->not_empty);
    LeaveCriticalSection(&queue->section);
    return FuriStatusOk;
}

FuriStatus furi_message_queue_get(FuriMessageQueue* queue, void* item, uint32_t timeout) {
    if(!queue || !item) return FuriStatusError;
    EnterCriticalSection(&queue->section);
    while(queue->count == 0) {
        if(timeout == 0 ||
           !SleepConditionVariableCS(
               &queue->not_empty, &queue->section, runtime_timeout(timeout))) {
            LeaveCriticalSection(&queue->section);
            return FuriStatusErrorTimeout;
        }
    }
    memcpy(
        item,
        queue->data + ((size_t)queue->head * queue->item_size),
        queue->item_size);
    queue->head = (queue->head + 1U) % queue->capacity;
    queue->count--;
    WakeConditionVariable(&queue->not_full);
    LeaveCriticalSection(&queue->section);
    return FuriStatusOk;
}

uint32_t runtime_message_queue_count(FuriMessageQueue* queue) {
    if(!queue) return 0;
    EnterCriticalSection(&queue->section);
    const uint32_t count = queue->count;
    LeaveCriticalSection(&queue->section);
    return count;
}

uint32_t runtime_message_queue_capacity(FuriMessageQueue* queue) {
    return queue ? queue->capacity : 0;
}

FuriStreamBuffer* furi_stream_buffer_alloc(size_t capacity, size_t trigger_level) {
    UNUSED(trigger_level);
    FuriStreamBuffer* stream = calloc(1, sizeof(FuriStreamBuffer));
    if(!stream) return NULL;
    stream->data = calloc(capacity, 1);
    if(!stream->data) {
        free(stream);
        return NULL;
    }
    stream->capacity = capacity;
    InitializeCriticalSection(&stream->section);
    InitializeConditionVariable(&stream->changed);
    return stream;
}

void furi_stream_buffer_free(FuriStreamBuffer* stream) {
    if(!stream) return;
    DeleteCriticalSection(&stream->section);
    free(stream->data);
    free(stream);
}

size_t furi_stream_buffer_send(
    FuriStreamBuffer* stream,
    const void* data,
    size_t size,
    uint32_t timeout) {
    if(!stream || !data) return 0;
    const uint8_t* bytes = data;
    size_t sent = 0;
    EnterCriticalSection(&stream->section);
    while(sent < size) {
        while(stream->count == stream->capacity) {
            if(timeout == 0 ||
               !SleepConditionVariableCS(
                   &stream->changed, &stream->section, runtime_timeout(timeout))) {
                LeaveCriticalSection(&stream->section);
                return sent;
            }
        }
        stream->data[stream->tail] = bytes[sent++];
        stream->tail = (stream->tail + 1U) % stream->capacity;
        stream->count++;
    }
    WakeAllConditionVariable(&stream->changed);
    LeaveCriticalSection(&stream->section);
    return sent;
}

size_t furi_stream_buffer_receive(
    FuriStreamBuffer* stream,
    void* data,
    size_t size,
    uint32_t timeout) {
    if(!stream || !data) return 0;
    uint8_t* bytes = data;
    size_t received = 0;
    EnterCriticalSection(&stream->section);
    while(stream->count == 0) {
        if(timeout == 0 ||
           !SleepConditionVariableCS(
               &stream->changed, &stream->section, runtime_timeout(timeout))) {
            LeaveCriticalSection(&stream->section);
            return 0;
        }
    }
    while(received < size && stream->count > 0) {
        bytes[received++] = stream->data[stream->head];
        stream->head = (stream->head + 1U) % stream->capacity;
        stream->count--;
    }
    WakeAllConditionVariable(&stream->changed);
    LeaveCriticalSection(&stream->section);
    return received;
}

size_t runtime_stream_buffer_count(FuriStreamBuffer* stream) {
    if(!stream) return 0;
    EnterCriticalSection(&stream->section);
    const size_t count = stream->count;
    LeaveCriticalSection(&stream->section);
    return count;
}

size_t runtime_stream_buffer_capacity(FuriStreamBuffer* stream) {
    return stream ? stream->capacity : 0;
}

bool runtime_mutex_available(FuriMutex* mutex) {
    if(!mutex || !TryEnterCriticalSection(&mutex->section)) return false;
    LeaveCriticalSection(&mutex->section);
    return true;
}

static FuriString* runtime_string_alloc(const char* value) {
    FuriString* string = calloc(1, sizeof(FuriString));
    if(!string) return NULL;
    string->value = _strdup(value ? value : "");
    if(!string->value) {
        free(string);
        return NULL;
    }
    return string;
}

FuriString* furi_string_alloc(void) {
    return runtime_string_alloc("");
}

FuriString* furi_string_alloc_set(const char* value) {
    return runtime_string_alloc(value);
}

FuriString* furi_string_alloc_printf(const char* format, ...) {
    char text[4096];
    va_list args;
    va_start(args, format);
    vsnprintf(text, sizeof(text), format, args);
    va_end(args);
    return runtime_string_alloc(text);
}

int furi_string_printf(FuriString* string, const char* format, ...) {
    if(!string || !format) return -1;
    va_list args;
    va_start(args, format);
    va_list count_args;
    va_copy(count_args, args);
    const int formatted_length = vsnprintf(NULL, 0, format, count_args);
    va_end(count_args);
    if(formatted_length < 0) {
        va_end(args);
        return formatted_length;
    }
    // Format before releasing the old buffer so arguments may safely refer
    // to the string's current value, matching the firmware API behavior.
    char* formatted = malloc((size_t)formatted_length + 1);
    if(!formatted) {
        va_end(args);
        return -1;
    }
    const int written =
        vsnprintf(formatted, (size_t)formatted_length + 1, format, args);
    va_end(args);
    if(written < 0) {
        free(formatted);
        return written;
    }
    free(string->value);
    string->value = formatted;
    return written;
}

int furi_string_cat_printf(FuriString* string, const char* format, ...) {
    if(!string || !format) return -1;
    va_list args;
    va_start(args, format);
    va_list count_args;
    va_copy(count_args, args);
    const int append_length = vsnprintf(NULL, 0, format, count_args);
    va_end(count_args);
    if(append_length < 0) {
        va_end(args);
        return append_length;
    }
    const size_t current_length = strlen(string->value);
    char* resized = realloc(string->value, current_length + (size_t)append_length + 1);
    if(!resized) {
        va_end(args);
        return -1;
    }
    string->value = resized;
    const int written = vsnprintf(
        string->value + current_length,
        (size_t)append_length + 1,
        format,
        args);
    va_end(args);
    return written;
}

void furi_string_free(FuriString* string) {
    if(!string) return;
    free(string->value);
    free(string);
}

const char* furi_string_get_cstr(const FuriString* string) {
    return string ? string->value : "";
}

void* furi_record_open(const char* name) {
    if(!name) return NULL;
    if(strcmp(name, RECORD_GUI) == 0) return &runtime_gui;
    if(strcmp(name, RECORD_STORAGE) == 0) return &runtime_storage;
    if(strcmp(name, RECORD_NOTIFICATION) == 0) return &runtime_notification;
    if(strcmp(name, RECORD_EXPANSION) == 0) return &runtime_expansion;
    runtime_log("warn", "record", "Unsupported record requested: %s", name);
    return &runtime_storage;
}

void furi_record_close(const char* name) {
    UNUSED(name);
}

size_t strlcpy(char* destination, const char* source, size_t size) {
    const size_t length = source ? strlen(source) : 0;
    if(size) {
        const size_t copy = length >= size ? size - 1 : length;
        if(copy) memcpy(destination, source, copy);
        destination[copy] = '\0';
    }
    return length;
}

size_t strlcat(char* destination, const char* source, size_t size) {
    const size_t current = strnlen(destination, size);
    if(current == size) return current + strlen(source);
    return current + strlcpy(destination + current, source, size - current);
}

static bool runtime_path(const char* path, char* output, size_t output_size) {
    if(!path || strstr(path, "..")) return false;
    while(*path == '/' || *path == '\\') path++;
    const int written = snprintf(
        output,
        output_size,
        "%s%c%s",
        runtime_storage_root,
        '\\',
        path);
    if(written < 0 || (size_t)written >= output_size) return false;
    for(char* cursor = output + strlen(runtime_storage_root); *cursor; cursor++) {
        if(*cursor == '/') *cursor = '\\';
    }
    return true;
}

static bool runtime_mkdirs(const char* path, bool include_last) {
    char copy[4096];
    if(strlcpy(copy, path, sizeof(copy)) >= sizeof(copy)) return false;
    const size_t root_length = strlen(runtime_storage_root);
    for(char* cursor = copy + root_length + 1; *cursor; cursor++) {
        if(*cursor != '\\' && *cursor != '/') continue;
        const char saved = *cursor;
        *cursor = '\0';
        if(_mkdir(copy) != 0 && errno != EEXIST) return false;
        *cursor = saved;
    }
    if(include_last && _mkdir(copy) != 0 && errno != EEXIST) return false;
    return true;
}

File* storage_file_alloc(Storage* storage) {
    UNUSED(storage);
    return calloc(1, sizeof(File));
}

void storage_file_free(File* file) {
    if(!file) return;
    storage_file_close(file);
    free(file);
}

bool storage_file_open(
    File* file,
    const char* path,
    FS_AccessMode access_mode,
    FS_OpenMode open_mode) {
    if(!file) return false;
    storage_file_close(file);
    char host_path[4096];
    if(!runtime_path(path, host_path, sizeof(host_path))) return false;
    if(access_mode != FSAM_READ) runtime_mkdirs(host_path, false);

    const char* mode = "rb";
    if(access_mode == FSAM_READ) {
        mode = "rb";
    } else if(open_mode == FSOM_CREATE_ALWAYS) {
        mode = access_mode == FSAM_READ_WRITE ? "w+b" : "wb";
    } else if(open_mode == FSOM_OPEN_APPEND) {
        mode = access_mode == FSAM_READ_WRITE ? "a+b" : "ab";
    } else if(open_mode == FSOM_OPEN_ALWAYS) {
        mode = access_mode == FSAM_READ_WRITE ? "r+b" : "ab";
    } else {
        mode = access_mode == FSAM_READ_WRITE ? "r+b" : "wb";
    }
    file->stream = fopen(host_path, mode);
    if(!file->stream && open_mode == FSOM_OPEN_ALWAYS) {
        file->stream = fopen(host_path, "w+b");
    }
    return file->stream != NULL;
}

bool storage_file_close(File* file) {
    if(!file) return false;
    bool closed = true;
    if(file->stream) {
        closed = fclose(file->stream) == 0;
        file->stream = NULL;
    }
    if(file->directory) {
        closed = closedir(file->directory) == 0 && closed;
        file->directory = NULL;
    }
    return closed;
}

bool storage_file_is_open(File* file) {
    return file && file->stream;
}

uint16_t storage_file_read(File* file, void* data, uint16_t bytes_to_read) {
    if(!file || !file->stream) return 0;
    return (uint16_t)fread(data, 1, bytes_to_read, file->stream);
}

uint16_t storage_file_write(File* file, const void* data, uint16_t bytes_to_write) {
    if(!file || !file->stream) return 0;
    return (uint16_t)fwrite(data, 1, bytes_to_write, file->stream);
}

bool storage_file_seek(File* file, uint32_t offset, bool from_start) {
    if(!file || !file->stream) return false;
    return fseek(file->stream, (long)offset, from_start ? SEEK_SET : SEEK_CUR) == 0;
}

uint64_t storage_file_size(File* file) {
    if(!file || !file->stream) return 0;
    const long current = ftell(file->stream);
    fseek(file->stream, 0, SEEK_END);
    const long size = ftell(file->stream);
    fseek(file->stream, current, SEEK_SET);
    return size < 0 ? 0 : (uint64_t)size;
}

uint64_t storage_file_tell(File* file) {
    if(!file || !file->stream) return 0;
    const long position = ftell(file->stream);
    return position < 0 ? 0 : (uint64_t)position;
}

bool storage_file_eof(File* file) {
    return !file || !file->stream || feof(file->stream) != 0;
}

FS_Error storage_file_get_error(File* file) {
    return file && file->stream && !ferror(file->stream) ? FSE_OK : FSE_INTERNAL;
}

bool storage_file_sync(File* file) {
    return file && file->stream && fflush(file->stream) == 0;
}

bool storage_file_exists(Storage* storage, const char* path) {
    UNUSED(storage);
    char host_path[4096];
    struct stat status;
    return runtime_path(path, host_path, sizeof(host_path)) && stat(host_path, &status) == 0;
}

bool storage_dir_open(File* file, const char* path) {
    if(!file) return false;
    storage_file_close(file);
    if(!runtime_path(path, file->directory_path, sizeof(file->directory_path))) return false;
    file->directory = opendir(file->directory_path);
    return file->directory != NULL;
}

bool storage_dir_read(
    File* file,
    FileInfo* file_info,
    char* name,
    uint16_t name_length) {
    if(!file || !file->directory || !file_info || !name || !name_length) return false;
    struct dirent* entry;
    while((entry = readdir(file->directory)) != NULL) {
        if(strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        strlcpy(name, entry->d_name, name_length);
        char full_path[4096];
        snprintf(
            full_path,
            sizeof(full_path),
            "%s%c%s",
            file->directory_path,
            '\\',
            entry->d_name);
        struct stat status;
        memset(file_info, 0, sizeof(*file_info));
        if(stat(full_path, &status) == 0) {
            if((status.st_mode & S_IFDIR) != 0) file_info->flags |= FSF_DIRECTORY;
            file_info->size = (uint64_t)status.st_size;
        }
        return true;
    }
    return false;
}

bool storage_dir_close(File* file) {
    if(!file || !file->directory) return false;
    const bool result = closedir(file->directory) == 0;
    file->directory = NULL;
    return result;
}

bool file_info_is_dir(const FileInfo* file_info) {
    return file_info && (file_info->flags & FSF_DIRECTORY) != 0;
}

FS_Error storage_common_mkdir(Storage* storage, const char* path) {
    UNUSED(storage);
    char host_path[4096];
    if(!runtime_path(path, host_path, sizeof(host_path))) return FSE_INVALID_NAME;

    struct stat status;
    if(stat(host_path, &status) == 0) return FSE_EXIST;

    return runtime_mkdirs(host_path, true) ? FSE_OK : FSE_INTERNAL;
}

bool storage_simply_mkdir(Storage* storage, const char* path) {
    const FS_Error result = storage_common_mkdir(storage, path);
    return result == FSE_OK || result == FSE_EXIST;
}

void storage_common_resolve_path_and_ensure_app_directory(
    Storage* storage,
    FuriString* path) {
    UNUSED(storage);
    if(!path) return;
    char host_path[4096];
    if(runtime_path(furi_string_get_cstr(path), host_path, sizeof(host_path))) {
        runtime_mkdirs(host_path, false);
    }
}

bool saved_struct_load(
    const char* path,
    void* data,
    size_t data_size,
    uint8_t magic,
    uint8_t version) {
    File file = {0};
    uint8_t header[2];
    const bool opened = storage_file_open(&file, path, FSAM_READ, FSOM_OPEN_EXISTING);
    const bool valid = opened && fread(header, 1, sizeof(header), file.stream) == sizeof(header) &&
                       header[0] == magic && header[1] == version &&
                       fread(data, 1, data_size, file.stream) == data_size;
    storage_file_close(&file);
    return valid;
}

bool saved_struct_save(
    const char* path,
    const void* data,
    size_t data_size,
    uint8_t magic,
    uint8_t version) {
    File file = {0};
    const uint8_t header[2] = {magic, version};
    const bool opened = storage_file_open(&file, path, FSAM_WRITE, FSOM_CREATE_ALWAYS);
    const bool valid = opened && fwrite(header, 1, sizeof(header), file.stream) == sizeof(header) &&
                       fwrite(data, 1, data_size, file.stream) == data_size &&
                       fflush(file.stream) == 0;
    storage_file_close(&file);
    return valid;
}

uint8_t furi_hal_power_get_pct(void) {
    return 100;
}

float furi_hal_power_get_usb_voltage(void) {
    return 5.0f;
}

bool furi_hal_power_is_otg_enabled(void) {
    return true;
}

bool furi_hal_power_enable_otg(void) {
    return true;
}

void furi_hal_power_disable_otg(void) {}
void furi_hal_power_insomnia_enter(void) {}
void furi_hal_power_insomnia_exit(void) {}

static void canvas_reserve(Canvas* canvas, size_t extra) {
    const size_t required = canvas->length + extra + 1;
    if(required <= canvas->capacity) return;
    size_t capacity = canvas->capacity ? canvas->capacity : 2048;
    while(capacity < required) capacity *= 2;
    char* commands = realloc(canvas->commands, capacity);
    furi_check(commands);
    canvas->commands = commands;
    canvas->capacity = capacity;
}

static void canvas_append(Canvas* canvas, const char* format, ...) {
    while(true) {
        canvas_reserve(canvas, 256);
        va_list args;
        va_start(args, format);
        const int written = vsnprintf(
            canvas->commands + canvas->length,
            canvas->capacity - canvas->length,
            format,
            args);
        va_end(args);
        if(written < 0) return;
        if((size_t)written < canvas->capacity - canvas->length) {
            canvas->length += (size_t)written;
            return;
        }
        canvas_reserve(canvas, (size_t)written + 1);
    }
}

static void canvas_prefix(Canvas* canvas, const char* op) {
    if(!canvas->first) canvas_append(canvas, ",");
    canvas->first = false;
    canvas_append(canvas, "{\"op\":\"%s\",\"args\":[", op);
}

static void canvas_text_argument(Canvas* canvas, const char* text) {
    canvas_append(canvas, "\"");
    for(const unsigned char* cursor = (const unsigned char*)(text ? text : ""); *cursor; cursor++) {
        switch(*cursor) {
        case '"':
            canvas_append(canvas, "\\\"");
            break;
        case '\\':
            canvas_append(canvas, "\\\\");
            break;
        case '\n':
            canvas_append(canvas, "\\n");
            break;
        case '\r':
            canvas_append(canvas, "\\r");
            break;
        case '\t':
            canvas_append(canvas, "\\t");
            break;
        default:
            if(*cursor < 0x20) canvas_append(canvas, "\\u%04x", *cursor);
            else canvas_append(canvas, "%c", *cursor);
            break;
        }
    }
    canvas_append(canvas, "\"");
}

static const char* canvas_font_name(Font font) {
    switch(font) {
    case FontPrimary:
        return "FontPrimary";
    case FontBigNumbers:
        return "FontBigNumbers";
    case FontKeyboard:
        return "FontKeyboard";
    case FontBatteryPercent:
        return "FontBatteryPercent";
    default:
        return "FontSecondary";
    }
}

static const char* canvas_color_name(Color color) {
    if(color == ColorWhite) return "ColorWhite";
    if(color == ColorXOR) return "ColorXOR";
    return "ColorBlack";
}

static const char* canvas_align_name(Align align) {
    switch(align) {
    case AlignRight:
        return "AlignRight";
    case AlignCenter:
        return "AlignCenter";
    case AlignTop:
        return "AlignTop";
    case AlignBottom:
        return "AlignBottom";
    default:
        return "AlignLeft";
    }
}

void canvas_clear(Canvas* canvas) {
    if(!canvas) return;
    canvas_prefix(canvas, "clear");
    canvas_append(canvas, "]}");
}

void canvas_set_color(Canvas* canvas, Color color) {
    if(!canvas) return;
    canvas->color = color;
    canvas_prefix(canvas, "setColor");
    canvas_append(canvas, "\"%s\"]}", canvas_color_name(color));
}

void canvas_set_font(Canvas* canvas, Font font) {
    if(!canvas) return;
    canvas->font = font;
    canvas_prefix(canvas, "setFont");
    canvas_append(canvas, "\"%s\"]}", canvas_font_name(font));
}

void canvas_set_custom_u8g2_font(Canvas* canvas, const uint8_t* font) {
    UNUSED(font);
    canvas_set_font(canvas, FontSecondary);
}

void canvas_invert_color(Canvas* canvas) {
    if(!canvas) return;
    canvas_prefix(canvas, "invertColor");
    canvas_append(canvas, "]}");
}

static void canvas_numbers(
    Canvas* canvas,
    const char* op,
    const int32_t* values,
    size_t count) {
    if(!canvas) return;
    canvas_prefix(canvas, op);
    for(size_t index = 0; index < count; index++) {
        canvas_append(canvas, "%s%ld", index ? "," : "", (long)values[index]);
    }
    canvas_append(canvas, "]}");
}

void canvas_draw_dot(Canvas* canvas, int32_t x, int32_t y) {
    const int32_t values[] = {x, y};
    canvas_numbers(canvas, "dot", values, COUNT_OF(values));
}

void canvas_draw_line(
    Canvas* canvas,
    int32_t x1,
    int32_t y1,
    int32_t x2,
    int32_t y2) {
    const int32_t values[] = {x1, y1, x2, y2};
    canvas_numbers(canvas, "line", values, COUNT_OF(values));
}

void canvas_draw_box(Canvas* canvas, int32_t x, int32_t y, int32_t width, int32_t height) {
    const int32_t values[] = {x, y, width, height};
    canvas_numbers(canvas, "box", values, COUNT_OF(values));
}

void canvas_draw_frame(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height) {
    const int32_t values[] = {x, y, width, height};
    canvas_numbers(canvas, "frame", values, COUNT_OF(values));
}

void canvas_draw_rbox(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height,
    int32_t radius) {
    const int32_t values[] = {x, y, width, height, radius};
    canvas_numbers(canvas, "rbox", values, COUNT_OF(values));
}

void canvas_draw_rframe(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height,
    int32_t radius) {
    const int32_t values[] = {x, y, width, height, radius};
    canvas_numbers(canvas, "rframe", values, COUNT_OF(values));
}

void canvas_draw_circle(Canvas* canvas, int32_t x, int32_t y, int32_t radius) {
    const int32_t values[] = {x, y, radius};
    canvas_numbers(canvas, "circle", values, COUNT_OF(values));
}

void canvas_draw_disc(Canvas* canvas, int32_t x, int32_t y, int32_t radius) {
    const int32_t values[] = {x, y, radius};
    canvas_numbers(canvas, "disc", values, COUNT_OF(values));
}

void canvas_draw_str(Canvas* canvas, int32_t x, int32_t y, const char* text) {
    if(!canvas) return;
    canvas_prefix(canvas, "text");
    canvas_append(canvas, "%ld,%ld,", (long)x, (long)y);
    canvas_text_argument(canvas, text);
    canvas_append(canvas, "]}");
}

void canvas_draw_str_aligned(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    AlignHorizontal horizontal,
    AlignVertical vertical,
    const char* text) {
    if(!canvas) return;
    canvas_prefix(canvas, "textAligned");
    canvas_append(canvas, "%ld,%ld,", (long)x, (long)y);
    canvas_text_argument(canvas, text);
    canvas_append(
        canvas,
        ",\"%s\",\"%s\"]}",
        canvas_align_name(horizontal),
        canvas_align_name(vertical));
}

void canvas_draw_xbm(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height,
    const uint8_t* bitmap) {
    if(!canvas || !bitmap || width <= 0 || height <= 0) return;
    size_t bytes = ((size_t)width + 7U) / 8U * (size_t)height;
    if(bytes > 16384U) bytes = 16384U;
    canvas_prefix(canvas, "xbmData");
    canvas_append(canvas, "%ld,%ld,%ld,%ld,\"", (long)x, (long)y, (long)width, (long)height);
    for(size_t index = 0; index < bytes; index++) canvas_append(canvas, "%02x", bitmap[index]);
    canvas_append(canvas, "\"]}");
}

void canvas_draw_icon(Canvas* canvas, int32_t x, int32_t y, const Icon* icon) {
    if(icon && icon->frames && icon->frame_count) {
        canvas_draw_xbm(canvas, x, y, icon->width, icon->height, icon->frames[0]);
    }
}

void canvas_draw_icon_ex(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    const Icon* icon,
    IconRotation rotation) {
    if(!canvas || !icon || !icon->frames || !icon->frame_count) return;
    if(rotation == IconRotation0) {
        canvas_draw_icon(canvas, x, y, icon);
        return;
    }
    const int32_t source_width = icon->width;
    const int32_t source_height = icon->height;
    const int32_t target_width =
        (rotation == IconRotation90 || rotation == IconRotation270) ? source_height : source_width;
    const int32_t target_height =
        (rotation == IconRotation90 || rotation == IconRotation270) ? source_width : source_height;
    const size_t row_bytes = ((size_t)target_width + 7U) / 8U;
    uint8_t* rotated = calloc(row_bytes * (size_t)target_height, 1);
    if(!rotated) return;
    const uint8_t* source = icon->frames[0];
    const size_t source_row_bytes = ((size_t)source_width + 7U) / 8U;
    for(int32_t sy = 0; sy < source_height; sy++) {
        for(int32_t sx = 0; sx < source_width; sx++) {
            if(!(source[(size_t)sy * source_row_bytes + (size_t)sx / 8U] & (1U << (sx & 7)))) continue;
            int32_t tx = sx;
            int32_t ty = sy;
            if(rotation == IconRotation90) {
                tx = source_height - 1 - sy;
                ty = sx;
            } else if(rotation == IconRotation180) {
                tx = source_width - 1 - sx;
                ty = source_height - 1 - sy;
            } else if(rotation == IconRotation270) {
                tx = sy;
                ty = source_width - 1 - sx;
            }
            rotated[(size_t)ty * row_bytes + (size_t)tx / 8U] |= (uint8_t)(1U << (tx & 7));
        }
    }
    canvas_draw_xbm(canvas, x, y, target_width, target_height, rotated);
    free(rotated);
}

size_t canvas_width(Canvas* canvas) {
    UNUSED(canvas);
    return 128;
}

size_t canvas_height(Canvas* canvas) {
    UNUSED(canvas);
    return 64;
}

size_t canvas_string_width(Canvas* canvas, const char* text) {
    if(!text) return 0;
    const size_t scale = canvas && canvas->font == FontBigNumbers ? 2U : 1U;
    const size_t advance = canvas && canvas->font == FontPrimary ? 7U : 6U;
    return strlen(text) * advance * scale;
}

void elements_multiline_text(Canvas* canvas, int32_t x, int32_t y, const char* text) {
    if(!canvas || !text) return;
    char* copy = _strdup(text);
    if(!copy) return;
    int32_t baseline = y + 7;
    char* context = NULL;
    for(char* line = strtok_s(copy, "\n", &context); line; line = strtok_s(NULL, "\n", &context)) {
        canvas_draw_str(canvas, x, baseline, line);
        baseline += 8;
    }
    free(copy);
}

static void elements_button(Canvas* canvas, const char* position, const char* text) {
    if(!canvas) return;
    canvas_prefix(canvas, "button");
    canvas_append(canvas, "\"%s\",", position);
    canvas_text_argument(canvas, text);
    canvas_append(canvas, "]}");
}

void elements_button_left(Canvas* canvas, const char* text) {
    elements_button(canvas, "left", text);
}

void elements_button_center(Canvas* canvas, const char* text) {
    elements_button(canvas, "center", text);
}

void elements_button_right(Canvas* canvas, const char* text) {
    elements_button(canvas, "right", text);
}

void elements_scrollbar(Canvas* canvas, uint32_t position, uint32_t total) {
    if(!canvas || total == 0) return;
    canvas_draw_frame(canvas, 124, 0, 4, 64);
    uint32_t thumb_height = total <= 1 ? 62 : (62u / total);
    if(thumb_height < 3) thumb_height = 3;
    uint32_t travel = 62u - thumb_height;
    uint32_t y = total <= 1 ? 1 : 1u + (travel * position) / (total - 1u);
    canvas_draw_box(canvas, 125, (int32_t)y, 2, (int32_t)thumb_height);
}

ViewPort* view_port_alloc(void) {
    ViewPort* view_port = calloc(1, sizeof(ViewPort));
    if(view_port) view_port->enabled = true;
    return view_port;
}

void view_port_free(ViewPort* view_port) {
    if(!view_port) return;
    EnterCriticalSection(&runtime_view_lock);
    if(runtime_view_port == view_port) runtime_view_port = NULL;
    LeaveCriticalSection(&runtime_view_lock);
    free(view_port);
}

void view_port_draw_callback_set(
    ViewPort* view_port,
    ViewPortDrawCallback callback,
    void* context) {
    if(!view_port) return;
    view_port->draw = callback;
    view_port->draw_context = context;
}

void view_port_input_callback_set(
    ViewPort* view_port,
    ViewPortInputCallback callback,
    void* context) {
    if(!view_port) return;
    view_port->input = callback;
    view_port->input_context = context;
}

void view_port_update(ViewPort* view_port) {
    if(!view_port || !view_port->enabled || !view_port->draw) return;
    Canvas canvas = {
        .color = ColorBlack,
        .font = FontSecondary,
        .first = true,
    };
    canvas_reserve(&canvas, 2);
    canvas.commands[canvas.length++] = '[';
    canvas.commands[canvas.length] = '\0';
    view_port->draw(&canvas, view_port->draw_context);
    canvas_append(&canvas, "]");

    EnterCriticalSection(&runtime_output_lock);
    fprintf(stdout, "{\"type\":\"frame\",\"commands\":%s}\n", canvas.commands);
    fflush(stdout);
    LeaveCriticalSection(&runtime_output_lock);
    free(canvas.commands);
}

void view_port_enabled_set(ViewPort* view_port, bool enabled) {
    if(view_port) view_port->enabled = enabled;
}

void gui_add_view_port(Gui* gui, ViewPort* view_port, GuiLayer layer) {
    UNUSED(gui);
    UNUSED(layer);
    EnterCriticalSection(&runtime_view_lock);
    runtime_view_port = view_port;
    LeaveCriticalSection(&runtime_view_lock);
    view_port_update(view_port);
}

void gui_remove_view_port(Gui* gui, ViewPort* view_port) {
    UNUSED(gui);
    EnterCriticalSection(&runtime_view_lock);
    if(runtime_view_port == view_port) runtime_view_port = NULL;
    LeaveCriticalSection(&runtime_view_lock);
}

static bool runtime_input_key(const char* name, InputKey* key) {
    if(_stricmp(name, "up") == 0) *key = InputKeyUp;
    else if(_stricmp(name, "down") == 0) *key = InputKeyDown;
    else if(_stricmp(name, "left") == 0) *key = InputKeyLeft;
    else if(_stricmp(name, "right") == 0) *key = InputKeyRight;
    else if(_stricmp(name, "ok") == 0) *key = InputKeyOk;
    else if(_stricmp(name, "back") == 0) *key = InputKeyBack;
    else return false;
    return true;
}

static bool runtime_input_type(const char* name, InputType* type) {
    if(_stricmp(name, "press") == 0) *type = InputTypePress;
    else if(_stricmp(name, "release") == 0) *type = InputTypeRelease;
    else if(_stricmp(name, "short") == 0) *type = InputTypeShort;
    else if(_stricmp(name, "long") == 0) *type = InputTypeLong;
    else if(_stricmp(name, "repeat") == 0) *type = InputTypeRepeat;
    else return false;
    return true;
}

bool runtime_dispatch_input(const char* key_name, const char* type_name) {
    InputEvent event;
    if(!runtime_input_key(key_name, &event.key) ||
       !runtime_input_type(type_name, &event.type)) {
        return false;
    }
    event.sequence = runtime_input_sequence++;
    EnterCriticalSection(&runtime_view_lock);
    ViewPort* view_port = runtime_view_port;
    if(view_port && view_port->input) {
        view_port->input(&event, view_port->input_context);
    }
    LeaveCriticalSection(&runtime_view_lock);
    return view_port != NULL;
}

void notification_message(
    NotificationApp* app,
    const NotificationSequence* sequence) {
    UNUSED(app);
    if(sequence == &sequence_single_vibro) runtime_log("info", "notification", "vibration");
    else if(sequence == &sequence_success) {
        runtime_log("info", "notification", "success");
        runtime_emit_audio(true, 880.0f, 0.5f, 120);
    } else if(sequence == &sequence_error) {
        runtime_log("info", "notification", "error");
        runtime_emit_audio(true, 220.0f, 0.6f, 180);
    }
}

void furi_hal_i2c_acquire(FuriHalI2cBusHandle* handle) {
    UNUSED(handle);
}

void furi_hal_i2c_release(FuriHalI2cBusHandle* handle) {
    UNUSED(handle);
}

bool furi_hal_i2c_is_device_ready(
    FuriHalI2cBusHandle* handle,
    uint8_t address,
    uint32_t timeout) {
    UNUSED(handle);
    UNUSED(address);
    UNUSED(timeout);
    return false;
}

bool furi_hal_i2c_tx(
    FuriHalI2cBusHandle* handle,
    uint8_t address,
    const uint8_t* data,
    size_t size,
    uint32_t timeout) {
    UNUSED(handle);
    UNUSED(address);
    UNUSED(data);
    UNUSED(size);
    UNUSED(timeout);
    return false;
}

bool furi_hal_i2c_rx(
    FuriHalI2cBusHandle* handle,
    uint8_t address,
    uint8_t* data,
    size_t size,
    uint32_t timeout) {
    UNUSED(handle);
    UNUSED(address);
    if(data && size) memset(data, 0, size);
    UNUSED(timeout);
    return false;
}

void furi_hal_usb_unlock(void) {}

bool furi_hal_usb_set_config(const void* config, void* context) {
    UNUSED(config);
    UNUSED(context);
    return true;
}

void furi_hal_cdc_set_callbacks(uint8_t channel, CdcCallbacks* callbacks, void* context) {
    UNUSED(channel);
    runtime_cdc_callbacks = callbacks;
    runtime_cdc_context = context;
    if(callbacks && callbacks->state_callback) {
        callbacks->state_callback(context, CdcStateDisconnected);
    }
}

void furi_hal_cdc_send(uint8_t channel, uint8_t* data, uint16_t length) {
    UNUSED(channel);
    UNUSED(data);
    UNUSED(length);
    if(runtime_cdc_callbacks && runtime_cdc_callbacks->tx_ep_callback) {
        runtime_cdc_callbacks->tx_ep_callback(runtime_cdc_context);
    }
}

int32_t furi_hal_cdc_receive(uint8_t channel, uint8_t* data, uint16_t length) {
    UNUSED(channel);
    UNUSED(data);
    UNUSED(length);
    return 0;
}

void furi_hal_rtc_get_datetime(DateTime* datetime) {
    if(!datetime) return;
    time_t now = time(NULL);
    struct tm local;
    localtime_s(&local, &now);
    datetime->year = (uint16_t)(local.tm_year + 1900);
    datetime->month = (uint8_t)(local.tm_mon + 1);
    datetime->day = (uint8_t)local.tm_mday;
    datetime->hour = (uint8_t)local.tm_hour;
    datetime->minute = (uint8_t)local.tm_min;
    datetime->second = (uint8_t)local.tm_sec;
    datetime->weekday = (uint8_t)local.tm_wday;
}

bool furi_hal_rtc_is_flag_set(FuriHalRtcFlag flag) {
    UNUSED(flag);
    return false;
}

bool furi_hal_speaker_acquire(uint32_t timeout) {
    UNUSED(timeout);
    return true;
}

bool furi_hal_speaker_is_mine(void) {
    return true;
}

struct SubGhzDevice {
    uint32_t frequency;
    float rssi;
};

static struct SubGhzDevice host_subghz_device = {462562500u, -100.0f};
const GpioPin gpio_speaker = {0};

void furi_hal_gpio_init(
    const GpioPin* pin,
    GpioMode mode,
    GpioPull pull,
    GpioSpeed speed) {
    UNUSED(pin);
    UNUSED(mode);
    UNUSED(pull);
    UNUSED(speed);
}

void furi_hal_gpio_write(const GpioPin* pin, bool state) {
    UNUSED(pin);
    UNUSED(state);
}

bool furi_hal_gpio_read(const GpioPin* pin) {
    UNUSED(pin);
    return false;
}

void subghz_devices_init(void) {}
void subghz_devices_deinit(void) {}
const SubGhzDevice* subghz_devices_get_by_name(const char* name) {
    (void)name;
    return &host_subghz_device;
}
bool subghz_devices_begin(const SubGhzDevice* device) {
    return device != NULL;
}
void subghz_devices_end(const SubGhzDevice* device) {
    (void)device;
}
bool subghz_devices_is_frequency_valid(const SubGhzDevice* device, uint32_t frequency) {
    (void)device;
    return frequency >= 300000000u && frequency <= 928000000u;
}
void subghz_devices_load_preset(
    const SubGhzDevice* device,
    FuriHalSubGhzPreset preset,
    const uint8_t* preset_data) {
    (void)device;
    (void)preset;
    (void)preset_data;
}
uint32_t subghz_devices_set_frequency(const SubGhzDevice* device, uint32_t frequency) {
    if(device) ((SubGhzDevice*)device)->frequency = frequency;
    return frequency;
}
bool subghz_devices_start_async_rx(
    const SubGhzDevice* device,
    SubGhzDeviceAsyncRxCallback callback,
    void* context) {
    (void)device;
    (void)callback;
    (void)context;
    return true;
}
void subghz_devices_stop_async_rx(const SubGhzDevice* device) {
    (void)device;
}
void subghz_devices_idle(const SubGhzDevice* device) {
    (void)device;
}
float subghz_devices_get_rssi(const SubGhzDevice* device) {
    return device ? device->rssi : -127.0f;
}
void subghz_devices_set_async_mirror_pin(const SubGhzDevice* device, const GpioPin* pin) {
    (void)device;
    (void)pin;
}

void furi_hal_speaker_release(void) {
    furi_hal_speaker_stop();
}

void furi_hal_speaker_start(float frequency, float volume) {
    if(frequency != frequency || volume != volume || frequency < 20.0f || frequency > 20000.0f ||
       volume <= 0.0f) {
        furi_hal_speaker_stop();
        return;
    }
    if(volume > 1.0f) volume = 1.0f;
    runtime_speaker_frequency = frequency;
    runtime_speaker_volume = volume;
    runtime_speaker_playing = true;
    runtime_emit_audio(true, frequency, volume, 0);
}

void furi_hal_speaker_stop(void) {
    if(!runtime_speaker_playing) return;
    runtime_speaker_playing = false;
    runtime_emit_audio(false, 0.0f, 0.0f, 0);
}

void furi_hal_speaker_set_volume(float volume) {
    if(volume != volume || volume <= 0.0f) {
        furi_hal_speaker_stop();
        return;
    }
    if(volume > 1.0f) volume = 1.0f;
    runtime_speaker_volume = volume;
    if(runtime_speaker_playing) {
        runtime_emit_audio(true, runtime_speaker_frequency, runtime_speaker_volume, 0);
    }
}

void expansion_disable(Expansion* expansion) {
    UNUSED(expansion);
}

void expansion_enable(Expansion* expansion) {
    UNUSED(expansion);
}

FuriHalSerialHandle* furi_hal_serial_control_acquire(FuriHalSerialId id) {
    UNUSED(id);
    return NULL;
}

void furi_hal_serial_control_release(FuriHalSerialHandle* handle) {
    UNUSED(handle);
}

void furi_hal_serial_init(FuriHalSerialHandle* handle, uint32_t baud) {
    UNUSED(handle);
    UNUSED(baud);
}

void furi_hal_serial_deinit(FuriHalSerialHandle* handle) {
    UNUSED(handle);
}

void furi_hal_serial_set_br(FuriHalSerialHandle* handle, uint32_t baud) {
    UNUSED(handle);
    UNUSED(baud);
}

void furi_hal_serial_tx(
    FuriHalSerialHandle* handle,
    const uint8_t* data,
    size_t size) {
    UNUSED(handle);
    UNUSED(data);
    UNUSED(size);
}

void furi_hal_serial_tx_wait_complete(FuriHalSerialHandle* handle) {
    UNUSED(handle);
}

void furi_hal_serial_dma_rx_start(
    FuriHalSerialHandle* handle,
    FuriHalSerialDmaRxCallback callback,
    void* context,
    bool report_errors) {
    UNUSED(handle);
    UNUSED(callback);
    UNUSED(context);
    UNUSED(report_errors);
}

void furi_hal_serial_dma_rx_stop(FuriHalSerialHandle* handle) {
    UNUSED(handle);
}

size_t furi_hal_serial_dma_rx(
    FuriHalSerialHandle* handle,
    uint8_t* data,
    size_t size) {
    UNUSED(handle);
    UNUSED(data);
    UNUSED(size);
    return 0;
}

void runtime_initialize(void) {
    runtime_start_tick = GetTickCount64();
    runtime_thread_tls = TlsAlloc();
    InitializeCriticalSection(&runtime_output_lock);
    InitializeCriticalSection(&runtime_view_lock);
    const char* configured = getenv("FLIPPER_RUNTIME_STORAGE");
    strlcpy(
        runtime_storage_root,
        configured && *configured ? configured : ".flipper-runtime-storage",
        sizeof(runtime_storage_root));
    for(char* cursor = runtime_storage_root; *cursor; cursor++) {
        if(*cursor == '/') *cursor = '\\';
    }
    _mkdir(runtime_storage_root);
}

void runtime_shutdown(void) {
    furi_hal_speaker_stop();
    if(runtime_thread_tls != TLS_OUT_OF_INDEXES) {
        TlsFree(runtime_thread_tls);
        runtime_thread_tls = TLS_OUT_OF_INDEXES;
    }
    DeleteCriticalSection(&runtime_view_lock);
    DeleteCriticalSection(&runtime_output_lock);
}
