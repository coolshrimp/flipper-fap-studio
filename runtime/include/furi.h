#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef FLIPPER_RUNTIME_APP_ID
#define FLIPPER_RUNTIME_APP_ID "desktop_app"
#endif

#define APP_DATA_PATH(path) "/ext/apps_data/" FLIPPER_RUNTIME_APP_ID "/" path
#define EXT_PATH(path) "/ext/" path
#define COUNT_OF(array) (sizeof(array) / sizeof((array)[0]))
#define UNUSED(value) ((void)(value))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define FuriWaitForever UINT32_MAX
#define FURI_DEPRECATED

#define RECORD_GUI "gui"
#define RECORD_STORAGE "storage"
#define RECORD_NOTIFICATION "notification"
#define RECORD_EXPANSION "expansion"
#define RECORD_CLI_VCP "cli_vcp"

typedef enum {
    FuriStatusOk = 0,
    FuriStatusError = -1,
    FuriStatusErrorTimeout = -2,
    FuriStatusErrorResource = -3,
    FuriStatusErrorParameter = -4,
    FuriStatusErrorNoMemory = -5,
    FuriStatusErrorISR = -6,
} FuriStatus;

typedef enum {
    FuriSignalExit,
    FuriSignalCustom = 100,
} FuriSignal;

typedef enum {
    FuriMutexTypeNormal = 0,
    FuriMutexTypeRecursive,
} FuriMutexType;

typedef struct FuriMessageQueue FuriMessageQueue;
typedef struct FuriMutex FuriMutex;
typedef struct FuriSemaphore FuriSemaphore;
typedef struct FuriStreamBuffer FuriStreamBuffer;
typedef struct FuriString FuriString;
typedef struct FuriThread FuriThread;
typedef struct FuriTimer FuriTimer;
typedef struct FuriEventFlag FuriEventFlag;
typedef struct FuriEventLoop FuriEventLoop;
typedef struct FuriEventLoopTimer FuriEventLoopTimer;
typedef void FuriEventLoopObject;
typedef int32_t (*FuriThreadCallback)(void* context);

typedef enum {
    FuriThreadPriorityLow,
    FuriThreadPriorityNormal,
    FuriThreadPriorityHigh,
} FuriThreadPriority;

typedef enum {
    FuriTimerTypeOnce,
    FuriTimerTypePeriodic,
} FuriTimerType;
typedef void (*FuriTimerCallback)(void*);
typedef void (*FuriTimerPendigCallback)(void*, uint32_t);
typedef enum {
    FuriTimerThreadPriorityNormal,
    FuriTimerThreadPriorityElevated,
} FuriTimerThreadPriority;

enum {
    FuriFlagWaitAny = 0,
    FuriFlagWaitAll = 1,
    FuriFlagNoClear = 2,
    FuriFlagError = 0x80000000U,
    FuriFlagErrorUnknown = 0xFFFFFFFFU,
    FuriFlagErrorTimeout = 0xFFFFFFFEU,
    FuriFlagErrorResource = 0xFFFFFFFDU,
    FuriFlagErrorParameter = 0xFFFFFFFCU,
    FuriFlagErrorISR = 0xFFFFFFFAU,
};

typedef enum {
    FuriEventLoopEventIn = 1,
    FuriEventLoopEventOut = 2,
    FuriEventLoopEventMask = 3,
    FuriEventLoopEventFlagEdge = 4,
    FuriEventLoopEventFlagOnce = 8,
    FuriEventLoopEventFlagMask = 0xFFFFFFFCU,
    FuriEventLoopEventReserved = UINT32_MAX,
} FuriEventLoopEvent;
typedef void (*FuriEventLoopTickCallback)(void*);
typedef void (*FuriEventLoopPendingCallback)(void*);
typedef void (*FuriEventLoopEventCallback)(FuriEventLoopObject*, void*);
typedef void (*FuriEventLoopThreadFlagsCallback)(void*);
typedef enum {
    FuriEventLoopTimerTypeOnce,
    FuriEventLoopTimerTypePeriodic,
} FuriEventLoopTimerType;
typedef void (*FuriEventLoopTimerCallback)(void*);

void runtime_log(const char* level, const char* tag, const char* format, ...);
void runtime_check_failed(const char* expression, const char* file, int line);

#define furi_check(expression) \
    do { \
        if(!(expression)) runtime_check_failed(#expression, __FILE__, __LINE__); \
    } while(0)
#define furi_assert(expression) furi_check(expression)
#define FURI_LOG_E(tag, format, ...) runtime_log("error", tag, format, ##__VA_ARGS__)
#define FURI_LOG_W(tag, format, ...) runtime_log("warn", tag, format, ##__VA_ARGS__)
#define FURI_LOG_I(tag, format, ...) runtime_log("info", tag, format, ##__VA_ARGS__)
#define FURI_LOG_D(tag, format, ...) runtime_log("debug", tag, format, ##__VA_ARGS__)
#define FURI_LOG_T(tag, format, ...) runtime_log("trace", tag, format, ##__VA_ARGS__)

uint32_t furi_get_tick(void);
uint32_t furi_ms_to_ticks(uint32_t milliseconds);
void furi_delay_ms(uint32_t milliseconds);
void furi_delay_tick(uint32_t ticks);
size_t memmgr_get_free_heap(void);

FuriThread* furi_thread_alloc_ex(
    const char* name,
    uint32_t stack_size,
    FuriThreadCallback callback,
    void* context);
void furi_thread_set_priority(FuriThread* thread, FuriThreadPriority priority);
void furi_thread_start(FuriThread* thread);
void furi_thread_join(FuriThread* thread);
void furi_thread_free(FuriThread* thread);
bool furi_thread_signal(const FuriThread* thread, uint32_t signal, void* arg);
void furi_thread_yield(void);

FuriTimer* furi_timer_alloc(FuriTimerCallback callback, FuriTimerType type, void* context);
void furi_timer_free(FuriTimer* timer);
void furi_timer_flush(void);
FuriStatus furi_timer_start(FuriTimer* timer, uint32_t ticks);
FuriStatus furi_timer_restart(FuriTimer* timer, uint32_t ticks);
FuriStatus furi_timer_stop(FuriTimer* timer);
uint32_t furi_timer_is_running(FuriTimer* timer);
uint32_t furi_timer_get_expire_time(FuriTimer* timer);
void furi_timer_pending_callback(FuriTimerPendigCallback callback, void* context, uint32_t arg);
void furi_timer_set_thread_priority(FuriTimerThreadPriority priority);

FuriEventFlag* furi_event_flag_alloc(void);
void furi_event_flag_free(FuriEventFlag* flag);
uint32_t furi_event_flag_set(FuriEventFlag* flag, uint32_t flags);
uint32_t furi_event_flag_clear(FuriEventFlag* flag, uint32_t flags);
uint32_t furi_event_flag_get(FuriEventFlag* flag);
uint32_t furi_event_flag_wait(
    FuriEventFlag* flag, uint32_t flags, uint32_t options, uint32_t timeout);

FuriEventLoop* furi_event_loop_alloc(void);
void furi_event_loop_free(FuriEventLoop* loop);
void furi_event_loop_run(FuriEventLoop* loop);
void furi_event_loop_stop(FuriEventLoop* loop);
void furi_event_loop_tick_set(
    FuriEventLoop*, uint32_t, FuriEventLoopTickCallback, void*);
void furi_event_loop_pend_callback(
    FuriEventLoop*, FuriEventLoopPendingCallback, void*);
void furi_event_loop_subscribe_event_flag(
    FuriEventLoop*, FuriEventFlag*, FuriEventLoopEvent, FuriEventLoopEventCallback, void*);
void furi_event_loop_subscribe_message_queue(
    FuriEventLoop*, FuriMessageQueue*, FuriEventLoopEvent, FuriEventLoopEventCallback, void*);
void furi_event_loop_subscribe_stream_buffer(
    FuriEventLoop*, FuriStreamBuffer*, FuriEventLoopEvent, FuriEventLoopEventCallback, void*);
void furi_event_loop_subscribe_mutex(
    FuriEventLoop*, FuriMutex*, FuriEventLoopEvent, FuriEventLoopEventCallback, void*);
void furi_event_loop_unsubscribe(FuriEventLoop*, FuriEventLoopObject*);
bool furi_event_loop_is_subscribed(FuriEventLoop*, FuriEventLoopObject*);

FuriEventLoopTimer* furi_event_loop_timer_alloc(
    FuriEventLoop*, FuriEventLoopTimerCallback, FuriEventLoopTimerType, void*);
void furi_event_loop_timer_free(FuriEventLoopTimer*);
void furi_event_loop_timer_start(FuriEventLoopTimer*, uint32_t);
void furi_event_loop_timer_restart(FuriEventLoopTimer*);
void furi_event_loop_timer_stop(FuriEventLoopTimer*);
uint32_t furi_event_loop_timer_get_remaining_time(const FuriEventLoopTimer*);
uint32_t furi_event_loop_timer_get_interval(const FuriEventLoopTimer*);
bool furi_event_loop_timer_is_running(const FuriEventLoopTimer*);

FuriMutex* furi_mutex_alloc(FuriMutexType type);
void furi_mutex_free(FuriMutex* mutex);
FuriStatus furi_mutex_acquire(FuriMutex* mutex, uint32_t timeout);
FuriStatus furi_mutex_release(FuriMutex* mutex);

FuriSemaphore* furi_semaphore_alloc(uint32_t max_count, uint32_t initial_count);
void furi_semaphore_free(FuriSemaphore* semaphore);
FuriStatus furi_semaphore_acquire(FuriSemaphore* semaphore, uint32_t timeout);
FuriStatus furi_semaphore_release(FuriSemaphore* semaphore);

FuriMessageQueue* furi_message_queue_alloc(uint32_t capacity, uint32_t item_size);
void furi_message_queue_free(FuriMessageQueue* queue);
FuriStatus furi_message_queue_put(
    FuriMessageQueue* queue,
    const void* item,
    uint32_t timeout);
FuriStatus furi_message_queue_get(FuriMessageQueue* queue, void* item, uint32_t timeout);

FuriStreamBuffer* furi_stream_buffer_alloc(size_t capacity, size_t trigger_level);
void furi_stream_buffer_free(FuriStreamBuffer* stream);
size_t furi_stream_buffer_send(
    FuriStreamBuffer* stream,
    const void* data,
    size_t size,
    uint32_t timeout);
size_t furi_stream_buffer_receive(
    FuriStreamBuffer* stream,
    void* data,
    size_t size,
    uint32_t timeout);

FuriString* furi_string_alloc(void);
FuriString* furi_string_alloc_set(const char* value);
FuriString* furi_string_alloc_printf(const char* format, ...);
int furi_string_printf(FuriString* string, const char* format, ...);
int furi_string_cat_printf(FuriString* string, const char* format, ...);
void furi_string_free(FuriString* string);
const char* furi_string_get_cstr(const FuriString* string);

void* furi_record_open(const char* name);
void furi_record_close(const char* name);

size_t strlcpy(char* destination, const char* source, size_t size);
size_t strlcat(char* destination, const char* source, size_t size);
