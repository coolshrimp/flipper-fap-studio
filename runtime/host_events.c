#include "host_runtime.h"

#include <furi.h>
#include <furi_hal_random.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

struct FuriEventFlag {
    CRITICAL_SECTION lock;
    CONDITION_VARIABLE changed;
    uint32_t flags;
};

struct FuriTimer {
    CRITICAL_SECTION lock;
    HANDLE wake;
    HANDLE thread;
    FuriTimerCallback callback;
    void* context;
    FuriTimerType type;
    bool terminate;
    bool running;
    uint32_t interval;
    uint32_t expires;
};

typedef enum {
    RuntimeSubscriptionFlag,
    RuntimeSubscriptionQueue,
    RuntimeSubscriptionStream,
    RuntimeSubscriptionMutex,
} RuntimeSubscriptionType;

typedef struct {
    void* object;
    FuriEventLoopEvent event;
    FuriEventLoopEventCallback callback;
    void* context;
    RuntimeSubscriptionType type;
    bool previous_ready;
} RuntimeSubscription;

struct FuriEventLoopTimer {
    FuriEventLoop* loop;
    FuriEventLoopTimerCallback callback;
    void* context;
    FuriEventLoopTimerType type;
    uint32_t interval;
    uint32_t expires;
    bool running;
    FuriEventLoopTimer* next;
};

struct FuriEventLoop {
    volatile LONG running;
    RuntimeSubscription subscriptions[32];
    size_t subscription_count;
    FuriEventLoopTickCallback tick_callback;
    void* tick_context;
    uint32_t tick_interval;
    uint32_t next_tick;
    FuriEventLoopPendingCallback pending_callback;
    void* pending_context;
    FuriEventLoopTimer* timers;
};

static DWORD WINAPI runtime_timer_thread(void* context) {
    FuriTimer* timer = context;
    while(true) {
        EnterCriticalSection(&timer->lock);
        const bool terminate = timer->terminate;
        const bool running = timer->running;
        const uint32_t interval = timer->interval;
        LeaveCriticalSection(&timer->lock);
        if(terminate) break;
        const DWORD wait = WaitForSingleObject(timer->wake, running ? interval : INFINITE);
        if(wait == WAIT_OBJECT_0) continue;
        EnterCriticalSection(&timer->lock);
        if(timer->running && !timer->terminate) {
            if(timer->type == FuriTimerTypeOnce) timer->running = false;
            else {
                timer->expires = furi_get_tick() + timer->interval;
            }
            FuriTimerCallback callback = timer->callback;
            void* callback_context = timer->context;
            LeaveCriticalSection(&timer->lock);
            if(callback) callback(callback_context);
        } else {
            LeaveCriticalSection(&timer->lock);
        }
    }
    return 0;
}

FuriTimer* furi_timer_alloc(FuriTimerCallback callback, FuriTimerType type, void* context) {
    if(!callback) return NULL;
    FuriTimer* timer = calloc(1, sizeof(FuriTimer));
    if(!timer) return NULL;
    InitializeCriticalSection(&timer->lock);
    timer->wake = CreateEvent(NULL, FALSE, FALSE, NULL);
    timer->callback = callback;
    timer->context = context;
    timer->type = type;
    timer->thread = CreateThread(NULL, 0, runtime_timer_thread, timer, 0, NULL);
    if(!timer->wake || !timer->thread) {
        if(timer->wake) CloseHandle(timer->wake);
        if(timer->thread) CloseHandle(timer->thread);
        DeleteCriticalSection(&timer->lock);
        free(timer);
        return NULL;
    }
    return timer;
}

void furi_timer_free(FuriTimer* timer) {
    if(!timer) return;
    EnterCriticalSection(&timer->lock);
    timer->terminate = true;
    timer->running = false;
    LeaveCriticalSection(&timer->lock);
    SetEvent(timer->wake);
    WaitForSingleObject(timer->thread, INFINITE);
    CloseHandle(timer->thread);
    CloseHandle(timer->wake);
    DeleteCriticalSection(&timer->lock);
    free(timer);
}

void furi_timer_flush(void) {}

FuriStatus furi_timer_start(FuriTimer* timer, uint32_t ticks) {
    if(!timer || !ticks) return FuriStatusError;
    EnterCriticalSection(&timer->lock);
    timer->interval = ticks;
    timer->expires = furi_get_tick() + ticks;
    timer->running = true;
    LeaveCriticalSection(&timer->lock);
    SetEvent(timer->wake);
    return FuriStatusOk;
}

FuriStatus furi_timer_restart(FuriTimer* timer, uint32_t ticks) {
    return furi_timer_start(timer, ticks);
}

FuriStatus furi_timer_stop(FuriTimer* timer) {
    if(!timer) return FuriStatusError;
    EnterCriticalSection(&timer->lock);
    timer->running = false;
    LeaveCriticalSection(&timer->lock);
    SetEvent(timer->wake);
    return FuriStatusOk;
}

uint32_t furi_timer_is_running(FuriTimer* timer) {
    if(!timer) return 0;
    EnterCriticalSection(&timer->lock);
    const bool running = timer->running;
    LeaveCriticalSection(&timer->lock);
    return running;
}

uint32_t furi_timer_get_expire_time(FuriTimer* timer) {
    return timer ? timer->expires : 0;
}

void furi_timer_pending_callback(FuriTimerPendigCallback callback, void* context, uint32_t arg) {
    if(callback) callback(context, arg);
}

void furi_timer_set_thread_priority(FuriTimerThreadPriority priority) {
    UNUSED(priority);
}

FuriEventFlag* furi_event_flag_alloc(void) {
    FuriEventFlag* flag = calloc(1, sizeof(FuriEventFlag));
    if(flag) {
        InitializeCriticalSection(&flag->lock);
        InitializeConditionVariable(&flag->changed);
    }
    return flag;
}

void furi_event_flag_free(FuriEventFlag* flag) {
    if(!flag) return;
    DeleteCriticalSection(&flag->lock);
    free(flag);
}

uint32_t furi_event_flag_set(FuriEventFlag* flag, uint32_t flags) {
    if(!flag) return FuriFlagErrorParameter;
    EnterCriticalSection(&flag->lock);
    flag->flags |= flags;
    const uint32_t result = flag->flags;
    WakeAllConditionVariable(&flag->changed);
    LeaveCriticalSection(&flag->lock);
    return result;
}

uint32_t furi_event_flag_clear(FuriEventFlag* flag, uint32_t flags) {
    if(!flag) return FuriFlagErrorParameter;
    EnterCriticalSection(&flag->lock);
    flag->flags &= ~flags;
    const uint32_t result = flag->flags;
    LeaveCriticalSection(&flag->lock);
    return result;
}

uint32_t furi_event_flag_get(FuriEventFlag* flag) {
    if(!flag) return FuriFlagErrorParameter;
    EnterCriticalSection(&flag->lock);
    const uint32_t result = flag->flags;
    LeaveCriticalSection(&flag->lock);
    return result;
}

uint32_t furi_event_flag_wait(
    FuriEventFlag* flag, uint32_t flags, uint32_t options, uint32_t timeout) {
    if(!flag || !flags) return FuriFlagErrorParameter;
    EnterCriticalSection(&flag->lock);
    const bool wait_all = (options & FuriFlagWaitAll) != 0;
    while(wait_all ? ((flag->flags & flags) != flags) : ((flag->flags & flags) == 0)) {
        if(timeout == 0 || !SleepConditionVariableCS(
            &flag->changed, &flag->lock, timeout == FuriWaitForever ? INFINITE : timeout)) {
            LeaveCriticalSection(&flag->lock);
            return FuriFlagErrorTimeout;
        }
    }
    const uint32_t result = flag->flags & flags;
    if(!(options & FuriFlagNoClear)) flag->flags &= ~result;
    LeaveCriticalSection(&flag->lock);
    return result;
}

FuriEventLoop* furi_event_loop_alloc(void) {
    return calloc(1, sizeof(FuriEventLoop));
}

void furi_event_loop_free(FuriEventLoop* loop) {
    free(loop);
}

static bool runtime_subscription_ready(const RuntimeSubscription* subscription) {
    const bool out = (subscription->event & FuriEventLoopEventMask) == FuriEventLoopEventOut;
    switch(subscription->type) {
    case RuntimeSubscriptionFlag:
        return furi_event_flag_get(subscription->object) != 0;
    case RuntimeSubscriptionQueue: {
        const uint32_t count = runtime_message_queue_count(subscription->object);
        return out ? count < runtime_message_queue_capacity(subscription->object) : count > 0;
    }
    case RuntimeSubscriptionStream: {
        const size_t count = runtime_stream_buffer_count(subscription->object);
        return out ? count < runtime_stream_buffer_capacity(subscription->object) : count > 0;
    }
    case RuntimeSubscriptionMutex:
        return runtime_mutex_available(subscription->object);
    }
    return false;
}

void furi_event_loop_run(FuriEventLoop* loop) {
    if(!loop) return;
    InterlockedExchange(&loop->running, 1);
    runtime_thread_set_event_loop(loop);
    loop->next_tick = furi_get_tick() + loop->tick_interval;
    while(InterlockedCompareExchange(&loop->running, 1, 1)) {
        if(loop->pending_callback) {
            FuriEventLoopPendingCallback callback = loop->pending_callback;
            void* context = loop->pending_context;
            loop->pending_callback = NULL;
            callback(context);
        }
        const uint32_t now = furi_get_tick();
        for(FuriEventLoopTimer* timer = loop->timers; timer; timer = timer->next) {
            if(timer->running && (int32_t)(now - timer->expires) >= 0) {
                if(timer->type == FuriEventLoopTimerTypePeriodic) timer->expires = now + timer->interval;
                else timer->running = false;
                timer->callback(timer->context);
            }
        }
        for(size_t index = 0; index < loop->subscription_count;) {
            RuntimeSubscription* subscription = &loop->subscriptions[index];
            const bool ready = runtime_subscription_ready(subscription);
            const bool edge = (subscription->event & FuriEventLoopEventFlagEdge) != 0;
            const bool fire = ready && (!edge || !subscription->previous_ready);
            subscription->previous_ready = ready;
            if(fire) {
                FuriEventLoopEventCallback callback = subscription->callback;
                void* object = subscription->object;
                void* context = subscription->context;
                if(subscription->event & FuriEventLoopEventFlagOnce) {
                    memmove(subscription, subscription + 1,
                        (loop->subscription_count - index - 1) * sizeof(*subscription));
                    loop->subscription_count--;
                } else {
                    index++;
                }
                callback(object, context);
            } else {
                index++;
            }
        }
        if(loop->tick_callback && loop->tick_interval &&
           (int32_t)(now - loop->next_tick) >= 0) {
            loop->next_tick = now + loop->tick_interval;
            loop->tick_callback(loop->tick_context);
        }
        Sleep(2);
    }
    runtime_thread_set_event_loop(NULL);
}

void furi_event_loop_stop(FuriEventLoop* loop) {
    if(loop) InterlockedExchange(&loop->running, 0);
}

void furi_event_loop_tick_set(
    FuriEventLoop* loop, uint32_t interval, FuriEventLoopTickCallback callback, void* context) {
    if(!loop) return;
    loop->tick_interval = interval;
    loop->tick_callback = callback;
    loop->tick_context = context;
}

void furi_event_loop_pend_callback(
    FuriEventLoop* loop, FuriEventLoopPendingCallback callback, void* context) {
    if(!loop) return;
    loop->pending_callback = callback;
    loop->pending_context = context;
}

static void runtime_event_loop_subscribe(
    FuriEventLoop* loop, void* object, FuriEventLoopEvent event,
    FuriEventLoopEventCallback callback, void* context, RuntimeSubscriptionType type) {
    if(!loop || !object || !callback || loop->subscription_count >= COUNT_OF(loop->subscriptions)) return;
    RuntimeSubscription* subscription = &loop->subscriptions[loop->subscription_count++];
    *subscription = (RuntimeSubscription){
        .object = object, .event = event, .callback = callback, .context = context, .type = type};
}

#define DEFINE_SUBSCRIBE(name, object_type, runtime_type) \
    void name(FuriEventLoop* loop, object_type* object, FuriEventLoopEvent event, \
              FuriEventLoopEventCallback callback, void* context) { \
        runtime_event_loop_subscribe(loop, object, event, callback, context, runtime_type); \
    }
DEFINE_SUBSCRIBE(furi_event_loop_subscribe_event_flag, FuriEventFlag, RuntimeSubscriptionFlag)
DEFINE_SUBSCRIBE(furi_event_loop_subscribe_message_queue, FuriMessageQueue, RuntimeSubscriptionQueue)
DEFINE_SUBSCRIBE(furi_event_loop_subscribe_stream_buffer, FuriStreamBuffer, RuntimeSubscriptionStream)
DEFINE_SUBSCRIBE(furi_event_loop_subscribe_mutex, FuriMutex, RuntimeSubscriptionMutex)

void furi_event_loop_unsubscribe(FuriEventLoop* loop, FuriEventLoopObject* object) {
    if(!loop || !object) return;
    for(size_t index = 0; index < loop->subscription_count; index++) {
        if(loop->subscriptions[index].object == object) {
            memmove(&loop->subscriptions[index], &loop->subscriptions[index + 1],
                (loop->subscription_count - index - 1) * sizeof(RuntimeSubscription));
            loop->subscription_count--;
            return;
        }
    }
}

bool furi_event_loop_is_subscribed(FuriEventLoop* loop, FuriEventLoopObject* object) {
    if(!loop || !object) return false;
    for(size_t index = 0; index < loop->subscription_count; index++)
        if(loop->subscriptions[index].object == object) return true;
    return false;
}

FuriEventLoopTimer* furi_event_loop_timer_alloc(
    FuriEventLoop* loop, FuriEventLoopTimerCallback callback,
    FuriEventLoopTimerType type, void* context) {
    if(!loop || !callback) return NULL;
    FuriEventLoopTimer* timer = calloc(1, sizeof(FuriEventLoopTimer));
    if(!timer) return NULL;
    timer->loop = loop;
    timer->callback = callback;
    timer->context = context;
    timer->type = type;
    timer->next = loop->timers;
    loop->timers = timer;
    return timer;
}

void furi_event_loop_timer_free(FuriEventLoopTimer* timer) {
    if(!timer) return;
    FuriEventLoopTimer** cursor = &timer->loop->timers;
    while(*cursor && *cursor != timer) cursor = &(*cursor)->next;
    if(*cursor) *cursor = timer->next;
    free(timer);
}

void furi_event_loop_timer_start(FuriEventLoopTimer* timer, uint32_t interval) {
    if(!timer || !interval) return;
    timer->interval = interval;
    timer->expires = furi_get_tick() + interval;
    timer->running = true;
}

void furi_event_loop_timer_restart(FuriEventLoopTimer* timer) {
    if(timer && timer->interval) furi_event_loop_timer_start(timer, timer->interval);
}

void furi_event_loop_timer_stop(FuriEventLoopTimer* timer) {
    if(timer) timer->running = false;
}

uint32_t furi_event_loop_timer_get_remaining_time(const FuriEventLoopTimer* timer) {
    if(!timer || !timer->running) return 0;
    const int32_t remaining = (int32_t)(timer->expires - furi_get_tick());
    return remaining > 0 ? (uint32_t)remaining : 0;
}

uint32_t furi_event_loop_timer_get_interval(const FuriEventLoopTimer* timer) {
    return timer ? timer->interval : 0;
}

bool furi_event_loop_timer_is_running(const FuriEventLoopTimer* timer) {
    return timer && timer->running;
}

static volatile LONG runtime_random_state = 0x6D2B79F5;

void furi_hal_random_init(void) {
    InterlockedExchange(&runtime_random_state, (LONG)(GetTickCount() ^ GetCurrentProcessId()));
}

uint32_t furi_hal_random_get(void) {
    uint32_t old_value;
    uint32_t next;
    do {
        old_value = (uint32_t)InterlockedCompareExchange(&runtime_random_state, 0, 0);
        next = old_value ? old_value : 0x6D2B79F5U;
        next ^= next << 13;
        next ^= next >> 17;
        next ^= next << 5;
    } while((uint32_t)InterlockedCompareExchange(
        &runtime_random_state, (LONG)next, (LONG)old_value) != old_value);
    return next;
}

void furi_hal_random_fill_buf(uint8_t* buffer, uint32_t length) {
    if(!buffer) return;
    uint32_t value = 0;
    for(uint32_t index = 0; index < length; index++) {
        if((index & 3U) == 0) value = furi_hal_random_get();
        buffer[index] = (uint8_t)(value >> ((index & 3U) * 8U));
    }
}
