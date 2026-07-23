#pragma once

#include <furi.h>
#include <gui/gui.h>
#include <gui/scene_manager.h>
#include <gui/view.h>

typedef enum {
    ViewDispatcherTypeDesktop,
    ViewDispatcherTypeWindow,
    ViewDispatcherTypeFullscreen,
} ViewDispatcherType;

typedef struct ViewDispatcher ViewDispatcher;
typedef bool (*ViewDispatcherCustomEventCallback)(void*, uint32_t);
typedef bool (*ViewDispatcherNavigationEventCallback)(void*);
typedef void (*ViewDispatcherTickEventCallback)(void*);

ViewDispatcher* view_dispatcher_alloc(void);
ViewDispatcher* view_dispatcher_alloc_ex(FuriEventLoop* loop);
void view_dispatcher_free(ViewDispatcher* dispatcher);
void view_dispatcher_enable_queue(ViewDispatcher* dispatcher);
void view_dispatcher_send_custom_event(ViewDispatcher* dispatcher, uint32_t event);
void view_dispatcher_set_custom_event_callback(
    ViewDispatcher* dispatcher, ViewDispatcherCustomEventCallback callback);
void view_dispatcher_set_navigation_event_callback(
    ViewDispatcher* dispatcher, ViewDispatcherNavigationEventCallback callback);
void view_dispatcher_set_tick_event_callback(
    ViewDispatcher* dispatcher, ViewDispatcherTickEventCallback callback, uint32_t period);
void view_dispatcher_set_event_callback_context(ViewDispatcher* dispatcher, void* context);
FuriEventLoop* view_dispatcher_get_event_loop(ViewDispatcher* dispatcher);
void view_dispatcher_run(ViewDispatcher* dispatcher);
void view_dispatcher_stop(ViewDispatcher* dispatcher);
void view_dispatcher_add_view(ViewDispatcher* dispatcher, uint32_t id, View* view);
void view_dispatcher_remove_view(ViewDispatcher* dispatcher, uint32_t id);
void view_dispatcher_switch_to_view(ViewDispatcher* dispatcher, uint32_t id);
void view_dispatcher_send_to_front(ViewDispatcher* dispatcher);
void view_dispatcher_send_to_back(ViewDispatcher* dispatcher);
void view_dispatcher_attach_to_gui(
    ViewDispatcher* dispatcher, Gui* gui, ViewDispatcherType type);
