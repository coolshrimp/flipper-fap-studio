#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_gpio.h>
#include <furi_hal_random.h>
#include <furi_hal_resources.h>
#include <furi_hal_speaker.h>
#include <gui/gui.h>
#include <gui/elements.h>
#include <gui/modules/submenu.h>
#include <gui/modules/variable_item_list.h>
#include <gui/modules/widget.h>
#include <gui/scene_manager.h>
#include <gui/view_dispatcher.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>
#include <subghz/devices/devices.h>

#include "runtime_compat_icons.h"

enum {
    RuntimeViewMenu,
    RuntimeViewVariable,
    RuntimeViewWidget,
};

enum {
    RuntimeSceneMenu,
    RuntimeSceneVariable,
    RuntimeSceneWidget,
    RuntimeSceneCount,
};

typedef struct {
    ViewDispatcher* dispatcher;
    SceneManager* scene_manager;
    Submenu* submenu;
    VariableItemList* variable_list;
    Widget* widget;
    FuriEventFlag* timer_flag;
    int loop_ticks;
} RuntimeCompatApp;

static void runtime_walkie_api_compile_probe(Canvas* canvas) {
    const SubGhzDevice* radio = subghz_devices_get_by_name("cc1101_int");
    subghz_devices_begin(radio);
    subghz_devices_load_preset(radio, FuriHalSubGhzPreset2FSKDev238Async, NULL);
    subghz_devices_set_frequency(radio, 433920000);
    subghz_devices_set_async_mirror_pin(radio, &gpio_speaker);
    (void)subghz_devices_get_rssi(radio);
    (void)furi_hal_speaker_is_mine();
    elements_scrollbar(canvas, 1, 3);
    subghz_devices_end(radio);
}

static void runtime_fm_api_compile_probe(Canvas* canvas) {
    const GpioPin reset = {.port = GPIOA, .pin = LL_GPIO_PIN_4};
    uint8_t data[2] = {0};
    furi_hal_gpio_init(&reset, GpioModeOutputPushPull, GpioPullNo, GpioSpeedVeryHigh);
    furi_hal_gpio_write(&reset, false);
    (void)furi_hal_gpio_read(&reset);
    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
    (void)furi_hal_i2c_is_device_ready(&furi_hal_i2c_handle_external, 0x20, 10);
    (void)furi_hal_i2c_tx(&furi_hal_i2c_handle_external, 0x20, data, sizeof(data), 10);
    (void)furi_hal_i2c_rx(&furi_hal_i2c_handle_external, 0x20, data, sizeof(data), 10);
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
    canvas_draw_icon_ex(canvas, 0, 0, &I_test_8x8, IconRotation90);
    (void)canvas_width(canvas);
    (void)canvas_height(canvas);
    notification_message(NULL, &sequence_success);
    notification_message(NULL, &sequence_error);
}

static void runtime_timer_callback(void* context) {
    furi_event_flag_set(context, 1);
}

static void runtime_loop_timer_callback(void* context) {
    RuntimeCompatApp* app = context;
    app->loop_ticks++;
    if(app->loop_ticks >= 2) {
        furi_event_loop_stop(view_dispatcher_get_event_loop(app->dispatcher));
    }
}

typedef struct {
    volatile bool started;
} RuntimeWorkerContext;

static int32_t runtime_worker(void* context) {
    RuntimeWorkerContext* worker = context;
    FuriEventLoop* loop = furi_event_loop_alloc();
    worker->started = true;
    furi_event_loop_run(loop);
    furi_event_loop_free(loop);
    return 0;
}

static void runtime_variable_changed(VariableItem* item) {
    const uint8_t value = variable_item_get_current_value_index(item);
    variable_item_set_current_value_text(item, value ? "Fast" : "Slow");
}

static void runtime_menu_selected(void* context, uint32_t index) {
    RuntimeCompatApp* app = context;
    view_dispatcher_send_custom_event(app->dispatcher, index);
}

static void runtime_variable_enter(void* context, uint32_t index) {
    UNUSED(index);
    RuntimeCompatApp* app = context;
    view_dispatcher_send_custom_event(app->dispatcher, RuntimeSceneWidget);
}

static void runtime_widget_button(GuiButtonType button, InputType type, void* context) {
    RuntimeCompatApp* app = context;
    if(button == GuiButtonTypeCenter && type == InputTypeShort) {
        view_dispatcher_stop(app->dispatcher);
    }
}

static void runtime_scene_menu_enter(void* context) {
    RuntimeCompatApp* app = context;
    view_dispatcher_switch_to_view(app->dispatcher, RuntimeViewMenu);
}

static void runtime_scene_variable_enter(void* context) {
    RuntimeCompatApp* app = context;
    view_dispatcher_switch_to_view(app->dispatcher, RuntimeViewVariable);
}

static void runtime_scene_widget_enter(void* context) {
    RuntimeCompatApp* app = context;
    view_dispatcher_switch_to_view(app->dispatcher, RuntimeViewWidget);
}

static bool runtime_scene_event(void* context, SceneManagerEvent event) {
    RuntimeCompatApp* app = context;
    if(event.type != SceneManagerEventTypeCustom) return false;
    scene_manager_next_scene(app->scene_manager, event.event);
    return true;
}

static void runtime_scene_exit(void* context) {
    UNUSED(context);
}

static const AppSceneOnEnterCallback runtime_enter_handlers[] = {
    runtime_scene_menu_enter,
    runtime_scene_variable_enter,
    runtime_scene_widget_enter,
};
static const AppSceneOnEventCallback runtime_event_handlers[] = {
    runtime_scene_event,
    runtime_scene_event,
    runtime_scene_event,
};
static const AppSceneOnExitCallback runtime_exit_handlers[] = {
    runtime_scene_exit,
    runtime_scene_exit,
    runtime_scene_exit,
};
static const SceneManagerHandlers runtime_scene_handlers = {
    .on_enter_handlers = runtime_enter_handlers,
    .on_event_handlers = runtime_event_handlers,
    .on_exit_handlers = runtime_exit_handlers,
    .scene_num = RuntimeSceneCount,
};

static bool runtime_custom_event(void* context, uint32_t event) {
    RuntimeCompatApp* app = context;
    return scene_manager_handle_custom_event(app->scene_manager, event);
}

int32_t runtime_compat_main(void* context) {
    UNUSED(context);
    RuntimeCompatApp app = {0};

    furi_check(furi_hal_speaker_acquire(100));
    furi_hal_speaker_start(440.0f, 0.25f);
    furi_hal_speaker_set_volume(0.5f);
    furi_hal_speaker_stop();
    furi_hal_speaker_release();
    notification_message(NULL, &sequence_success);
    notification_message(NULL, &sequence_error);

    FuriString* formatted = furi_string_alloc_set("replace me");
    furi_check(furi_string_printf(formatted, "%s-%d", "runtime", 42) == 10);
    furi_check(strcmp(furi_string_get_cstr(formatted), "runtime-42") == 0);
    furi_check(
        furi_string_printf(formatted, "%s-%d", furi_string_get_cstr(formatted), 7) == 12);
    furi_check(strcmp(furi_string_get_cstr(formatted), "runtime-42-7") == 0);
    furi_string_free(formatted);

    Storage* storage = furi_record_open(RECORD_STORAGE);
    const char* common_directory = APP_DATA_PATH("mkdir/common");
    const char* simple_directory = APP_DATA_PATH("mkdir/simple");
    furi_check(storage_common_mkdir(storage, common_directory) == FSE_OK);
    furi_check(storage_common_mkdir(storage, common_directory) == FSE_EXIST);
    furi_check(storage_simply_mkdir(storage, common_directory));
    furi_check(storage_simply_mkdir(storage, simple_directory));
    File* directory = storage_file_alloc(storage);
    furi_check(storage_dir_open(directory, simple_directory));
    storage_dir_close(directory);
    storage_file_free(directory);
    furi_record_close(RECORD_STORAGE);

    app.timer_flag = furi_event_flag_alloc();
    FuriTimer* timer = furi_timer_alloc(runtime_timer_callback, FuriTimerTypeOnce, app.timer_flag);
    furi_check(furi_timer_start(timer, 5) == FuriStatusOk);
    furi_check(furi_event_flag_wait(app.timer_flag, 1, FuriFlagWaitAny, 250) == 1);
    furi_timer_free(timer);

    uint8_t random_data[8] = {0};
    furi_hal_random_fill_buf(random_data, sizeof(random_data));
    furi_check(furi_hal_random_get() != furi_hal_random_get());

    RuntimeWorkerContext worker_context = {0};
    FuriThread* worker = furi_thread_alloc_ex("RuntimeLoop", 1024, runtime_worker, &worker_context);
    furi_thread_start(worker);
    while(!worker_context.started) furi_thread_yield();
    furi_check(furi_thread_signal(worker, FuriSignalExit, NULL));
    furi_thread_join(worker);
    furi_thread_free(worker);

    app.dispatcher = view_dispatcher_alloc();
    app.submenu = submenu_alloc();
    app.variable_list = variable_item_list_alloc();
    app.widget = widget_alloc();
    app.scene_manager = scene_manager_alloc(&runtime_scene_handlers, &app);

    submenu_set_header(app.submenu, "Runtime APIs");
    submenu_add_item(app.submenu, "About", RuntimeSceneWidget, runtime_menu_selected, &app);
    submenu_add_item(app.submenu, "Settings", RuntimeSceneVariable, runtime_menu_selected, &app);

    VariableItem* speed =
        variable_item_list_add(app.variable_list, "Speed", 2, runtime_variable_changed, &app);
    variable_item_set_current_value_text(speed, "Slow");
    variable_item_list_set_enter_callback(app.variable_list, runtime_variable_enter, &app);

    widget_add_icon_element(app.widget, 4, 4, &I_test_8x8);
    widget_add_string_element(
        app.widget, 64, 18, AlignCenter, AlignCenter, FontPrimary, "Runtime OK");
    widget_add_button_element(
        app.widget, GuiButtonTypeCenter, "Close", runtime_widget_button, &app);

    view_dispatcher_add_view(app.dispatcher, RuntimeViewMenu, submenu_get_view(app.submenu));
    view_dispatcher_add_view(
        app.dispatcher, RuntimeViewVariable, variable_item_list_get_view(app.variable_list));
    view_dispatcher_add_view(app.dispatcher, RuntimeViewWidget, widget_get_view(app.widget));
    view_dispatcher_set_event_callback_context(app.dispatcher, &app);
    view_dispatcher_set_custom_event_callback(app.dispatcher, runtime_custom_event);
    view_dispatcher_attach_to_gui(
        app.dispatcher, furi_record_open(RECORD_GUI), ViewDispatcherTypeFullscreen);

    FuriEventLoopTimer* loop_timer = furi_event_loop_timer_alloc(
        view_dispatcher_get_event_loop(app.dispatcher),
        runtime_loop_timer_callback,
        FuriEventLoopTimerTypePeriodic,
        &app);
    furi_event_loop_timer_start(loop_timer, 5);
    view_dispatcher_run(app.dispatcher);
    furi_check(app.loop_ticks >= 2);
    furi_event_loop_timer_free(loop_timer);

    app.loop_ticks = 0;
    scene_manager_next_scene(app.scene_manager, RuntimeSceneMenu);
    view_dispatcher_run(app.dispatcher);

    view_dispatcher_remove_view(app.dispatcher, RuntimeViewWidget);
    view_dispatcher_remove_view(app.dispatcher, RuntimeViewVariable);
    view_dispatcher_remove_view(app.dispatcher, RuntimeViewMenu);
    scene_manager_free(app.scene_manager);
    widget_free(app.widget);
    variable_item_list_free(app.variable_list);
    submenu_free(app.submenu);
    view_dispatcher_free(app.dispatcher);
    furi_event_flag_free(app.timer_flag);
    furi_record_close(RECORD_GUI);
    return 0;
}
