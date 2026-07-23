#include <furi.h>
#include <gui/elements.h>
#include <gui/icon.h>
#include <gui/modules/submenu.h>
#include <gui/modules/variable_item_list.h>
#include <gui/modules/widget.h>
#include <gui/scene_manager.h>
#include <gui/view_dispatcher.h>
#include <stdlib.h>
#include <string.h>

struct View {
    ViewDrawCallback draw;
    ViewInputCallback input;
    ViewCustomCallback custom;
    ViewNavigationCallback previous;
    ViewCallback enter;
    ViewCallback exit;
    ViewUpdateCallback update;
    void* update_context;
    void* context;
    void* model;
    size_t model_size;
    ViewModelType model_type;
    ViewOrientation orientation;
};

View* view_alloc(void) {
    return calloc(1, sizeof(View));
}

void view_free(View* view) {
    if(!view) return;
    free(view->model);
    free(view);
}

void view_tie_icon_animation(View* view, IconAnimation* animation) {
    UNUSED(view);
    UNUSED(animation);
}

void view_set_draw_callback(View* view, ViewDrawCallback callback) {
    if(view) view->draw = callback;
}
void view_set_input_callback(View* view, ViewInputCallback callback) {
    if(view) view->input = callback;
}
void view_set_custom_callback(View* view, ViewCustomCallback callback) {
    if(view) view->custom = callback;
}
void view_set_previous_callback(View* view, ViewNavigationCallback callback) {
    if(view) view->previous = callback;
}
void view_set_enter_callback(View* view, ViewCallback callback) {
    if(view) view->enter = callback;
}
void view_set_exit_callback(View* view, ViewCallback callback) {
    if(view) view->exit = callback;
}
void view_set_update_callback(View* view, ViewUpdateCallback callback) {
    if(view) view->update = callback;
}
void view_set_update_callback_context(View* view, void* context) {
    if(view) view->update_context = context;
}
void view_set_context(View* view, void* context) {
    if(view) view->context = context;
}
void view_set_orientation(View* view, ViewOrientation orientation) {
    if(view) view->orientation = orientation;
}
void view_allocate_model(View* view, ViewModelType type, size_t size) {
    if(!view) return;
    free(view->model);
    view->model = calloc(1, size);
    view->model_size = size;
    view->model_type = type;
}
void view_free_model(View* view) {
    if(!view) return;
    free(view->model);
    view->model = NULL;
    view->model_size = 0;
}
void* view_get_model(View* view) {
    return view ? view->model : NULL;
}
void view_commit_model(View* view, bool update) {
    if(view && update && view->update) view->update(view, view->update_context);
}

typedef struct {
    uint32_t id;
    View* view;
} RuntimeViewEntry;

struct ViewDispatcher {
    RuntimeViewEntry views[64];
    size_t view_count;
    View* active;
    uint32_t active_id;
    ViewPort* viewport;
    FuriEventLoop* loop;
    bool owns_loop;
    ViewDispatcherCustomEventCallback custom_callback;
    ViewDispatcherNavigationEventCallback navigation_callback;
    ViewDispatcherTickEventCallback tick_callback;
    void* context;
};

static View* runtime_dispatcher_find(ViewDispatcher* dispatcher, uint32_t id) {
    if(!dispatcher) return NULL;
    for(size_t index = 0; index < dispatcher->view_count; index++)
        if(dispatcher->views[index].id == id) return dispatcher->views[index].view;
    return NULL;
}

static void runtime_dispatcher_draw(Canvas* canvas, void* context) {
    ViewDispatcher* dispatcher = context;
    if(dispatcher && dispatcher->active && dispatcher->active->draw)
        dispatcher->active->draw(canvas, dispatcher->active->model);
}

static void runtime_dispatcher_update(View* view, void* context) {
    UNUSED(view);
    ViewDispatcher* dispatcher = context;
    if(dispatcher && dispatcher->viewport) view_port_update(dispatcher->viewport);
}

static void runtime_dispatcher_input(InputEvent* event, void* context) {
    ViewDispatcher* dispatcher = context;
    if(!dispatcher || !event) return;
    bool consumed = false;
    if(dispatcher->active && dispatcher->active->input)
        consumed = dispatcher->active->input(event, dispatcher->active->context);
    if(consumed || event->key != InputKeyBack || event->type != InputTypeShort) return;
    if(dispatcher->active && dispatcher->active->previous) {
        const uint32_t next = dispatcher->active->previous(dispatcher->active->context);
        if(next != VIEW_IGNORE) {
            if(next == VIEW_NONE) view_dispatcher_stop(dispatcher);
            else view_dispatcher_switch_to_view(dispatcher, next);
            return;
        }
    }
    if(dispatcher->navigation_callback)
        dispatcher->navigation_callback(dispatcher->context);
}

static void runtime_dispatcher_tick(void* context) {
    ViewDispatcher* dispatcher = context;
    if(dispatcher && dispatcher->tick_callback) dispatcher->tick_callback(dispatcher->context);
}

ViewDispatcher* view_dispatcher_alloc_ex(FuriEventLoop* loop) {
    ViewDispatcher* dispatcher = calloc(1, sizeof(ViewDispatcher));
    if(!dispatcher) return NULL;
    dispatcher->loop = loop;
    dispatcher->viewport = view_port_alloc();
    view_port_draw_callback_set(dispatcher->viewport, runtime_dispatcher_draw, dispatcher);
    view_port_input_callback_set(dispatcher->viewport, runtime_dispatcher_input, dispatcher);
    return dispatcher;
}

ViewDispatcher* view_dispatcher_alloc(void) {
    ViewDispatcher* dispatcher = view_dispatcher_alloc_ex(furi_event_loop_alloc());
    if(dispatcher) dispatcher->owns_loop = true;
    return dispatcher;
}

void view_dispatcher_free(ViewDispatcher* dispatcher) {
    if(!dispatcher) return;
    if(dispatcher->active && dispatcher->active->exit)
        dispatcher->active->exit(dispatcher->active->context);
    view_port_free(dispatcher->viewport);
    if(dispatcher->owns_loop) furi_event_loop_free(dispatcher->loop);
    free(dispatcher);
}

void view_dispatcher_enable_queue(ViewDispatcher* dispatcher) {
    UNUSED(dispatcher);
}

void view_dispatcher_send_custom_event(ViewDispatcher* dispatcher, uint32_t event) {
    if(!dispatcher) return;
    bool consumed = false;
    if(dispatcher->active && dispatcher->active->custom)
        consumed = dispatcher->active->custom(event, dispatcher->active->context);
    if(!consumed && dispatcher->custom_callback)
        dispatcher->custom_callback(dispatcher->context, event);
}

void view_dispatcher_set_custom_event_callback(
    ViewDispatcher* dispatcher, ViewDispatcherCustomEventCallback callback) {
    if(dispatcher) dispatcher->custom_callback = callback;
}
void view_dispatcher_set_navigation_event_callback(
    ViewDispatcher* dispatcher, ViewDispatcherNavigationEventCallback callback) {
    if(dispatcher) dispatcher->navigation_callback = callback;
}
void view_dispatcher_set_tick_event_callback(
    ViewDispatcher* dispatcher, ViewDispatcherTickEventCallback callback, uint32_t period) {
    if(!dispatcher) return;
    dispatcher->tick_callback = callback;
    furi_event_loop_tick_set(dispatcher->loop, period, runtime_dispatcher_tick, dispatcher);
}
void view_dispatcher_set_event_callback_context(ViewDispatcher* dispatcher, void* context) {
    if(dispatcher) dispatcher->context = context;
}
FuriEventLoop* view_dispatcher_get_event_loop(ViewDispatcher* dispatcher) {
    return dispatcher ? dispatcher->loop : NULL;
}
void view_dispatcher_run(ViewDispatcher* dispatcher) {
    if(dispatcher) furi_event_loop_run(dispatcher->loop);
}
void view_dispatcher_stop(ViewDispatcher* dispatcher) {
    if(dispatcher) furi_event_loop_stop(dispatcher->loop);
}
void view_dispatcher_add_view(ViewDispatcher* dispatcher, uint32_t id, View* view) {
    if(!dispatcher || !view || dispatcher->view_count >= COUNT_OF(dispatcher->views)) return;
    dispatcher->views[dispatcher->view_count++] = (RuntimeViewEntry){id, view};
    view_set_update_callback(view, runtime_dispatcher_update);
    view_set_update_callback_context(view, dispatcher);
}
void view_dispatcher_remove_view(ViewDispatcher* dispatcher, uint32_t id) {
    if(!dispatcher) return;
    for(size_t index = 0; index < dispatcher->view_count; index++) {
        if(dispatcher->views[index].id != id) continue;
        if(dispatcher->active == dispatcher->views[index].view) dispatcher->active = NULL;
        memmove(&dispatcher->views[index], &dispatcher->views[index + 1],
            (dispatcher->view_count - index - 1) * sizeof(RuntimeViewEntry));
        dispatcher->view_count--;
        return;
    }
}
void view_dispatcher_switch_to_view(ViewDispatcher* dispatcher, uint32_t id) {
    if(!dispatcher) return;
    View* next = runtime_dispatcher_find(dispatcher, id);
    if(!next || next == dispatcher->active) return;
    if(dispatcher->active && dispatcher->active->exit)
        dispatcher->active->exit(dispatcher->active->context);
    dispatcher->active = next;
    dispatcher->active_id = id;
    if(next->enter) next->enter(next->context);
    view_port_update(dispatcher->viewport);
}
void view_dispatcher_send_to_front(ViewDispatcher* dispatcher) { UNUSED(dispatcher); }
void view_dispatcher_send_to_back(ViewDispatcher* dispatcher) { UNUSED(dispatcher); }
void view_dispatcher_attach_to_gui(
    ViewDispatcher* dispatcher, Gui* gui, ViewDispatcherType type) {
    if(dispatcher) gui_add_view_port(gui, dispatcher->viewport, (GuiLayer)type);
}

struct SceneManager {
    const SceneManagerHandlers* handlers;
    void* context;
    uint32_t states[128];
    uint32_t stack[128];
    size_t depth;
    bool stopped;
};

static void runtime_scene_enter(SceneManager* manager, uint32_t scene) {
    if(manager->handlers->on_enter_handlers && scene < manager->handlers->scene_num) {
        AppSceneOnEnterCallback callback = manager->handlers->on_enter_handlers[scene];
        if(callback) callback(manager->context);
    }
}
static void runtime_scene_exit(SceneManager* manager, uint32_t scene) {
    if(manager->handlers->on_exit_handlers && scene < manager->handlers->scene_num) {
        AppSceneOnExitCallback callback = manager->handlers->on_exit_handlers[scene];
        if(callback) callback(manager->context);
    }
}
static bool runtime_scene_event(SceneManager* manager, SceneManagerEvent event) {
    if(!manager || !manager->depth || !manager->handlers->on_event_handlers) return false;
    const uint32_t scene = manager->stack[manager->depth - 1];
    if(scene >= manager->handlers->scene_num) return false;
    AppSceneOnEventCallback callback = manager->handlers->on_event_handlers[scene];
    return callback ? callback(manager->context, event) : false;
}
SceneManager* scene_manager_alloc(const SceneManagerHandlers* handlers, void* context) {
    if(!handlers) return NULL;
    SceneManager* manager = calloc(1, sizeof(SceneManager));
    if(manager) {
        manager->handlers = handlers;
        manager->context = context;
    }
    return manager;
}
void scene_manager_free(SceneManager* manager) { free(manager); }
void scene_manager_set_scene_state(SceneManager* manager, uint32_t scene, uint32_t state) {
    if(manager && scene < COUNT_OF(manager->states)) manager->states[scene] = state;
}
uint32_t scene_manager_get_scene_state(const SceneManager* manager, uint32_t scene) {
    return manager && scene < COUNT_OF(manager->states) ? manager->states[scene] : 0;
}
bool scene_manager_handle_custom_event(SceneManager* manager, uint32_t event) {
    return runtime_scene_event(manager, (SceneManagerEvent){SceneManagerEventTypeCustom, event});
}
bool scene_manager_handle_back_event(SceneManager* manager) {
    if(runtime_scene_event(manager, (SceneManagerEvent){SceneManagerEventTypeBack, 0})) return true;
    return scene_manager_previous_scene(manager);
}
void scene_manager_handle_tick_event(SceneManager* manager) {
    runtime_scene_event(manager, (SceneManagerEvent){SceneManagerEventTypeTick, 0});
}
void scene_manager_next_scene(SceneManager* manager, uint32_t scene) {
    if(!manager || scene >= manager->handlers->scene_num || manager->depth >= COUNT_OF(manager->stack)) return;
    if(manager->depth) runtime_scene_exit(manager, manager->stack[manager->depth - 1]);
    manager->stack[manager->depth++] = scene;
    runtime_scene_enter(manager, scene);
}
bool scene_manager_previous_scene(SceneManager* manager) {
    if(!manager || manager->depth < 2) return false;
    runtime_scene_exit(manager, manager->stack[manager->depth - 1]);
    manager->depth--;
    runtime_scene_enter(manager, manager->stack[manager->depth - 1]);
    return true;
}
bool scene_manager_has_previous_scene(const SceneManager* manager, uint32_t scene) {
    if(!manager || manager->depth < 2) return false;
    for(size_t index = 0; index + 1 < manager->depth; index++)
        if(manager->stack[index] == scene) return true;
    return false;
}
bool scene_manager_search_and_switch_to_previous_scene(SceneManager* manager, uint32_t scene) {
    if(!manager) return false;
    while(manager->depth > 1) {
        if(manager->stack[manager->depth - 2] == scene) return scene_manager_previous_scene(manager);
        runtime_scene_exit(manager, manager->stack[--manager->depth]);
    }
    return false;
}
bool scene_manager_search_and_switch_to_previous_scene_one_of(
    SceneManager* manager, const uint32_t* scenes, size_t count) {
    if(!manager || !scenes) return false;
    for(size_t depth = manager->depth; depth > 1; depth--) {
        const uint32_t candidate = manager->stack[depth - 2];
        for(size_t index = 0; index < count; index++)
            if(candidate == scenes[index])
                return scene_manager_search_and_switch_to_previous_scene(manager, candidate);
    }
    return false;
}
bool scene_manager_search_and_switch_to_another_scene(SceneManager* manager, uint32_t scene) {
    if(!manager || scene >= manager->handlers->scene_num) return false;
    if(manager->depth) runtime_scene_exit(manager, manager->stack[manager->depth - 1]);
    manager->depth = 1;
    manager->stack[0] = scene;
    runtime_scene_enter(manager, scene);
    return true;
}
uint32_t scene_manager_get_current_scene(SceneManager* manager) {
    return manager && manager->depth ? manager->stack[manager->depth - 1] : 0;
}
void scene_manager_stop(SceneManager* manager) {
    if(manager) manager->stopped = true;
}

typedef struct {
    char* label;
    uint32_t index;
    SubmenuItemCallback callback;
    SubmenuItemCallbackEx callback_ex;
    void* context;
} RuntimeSubmenuItem;
struct Submenu {
    View* view;
    RuntimeSubmenuItem items[64];
    size_t count;
    size_t selected;
    char* header;
};
static void runtime_submenu_draw(Canvas* canvas, void* model) {
    Submenu* submenu = model;
    canvas_clear(canvas);
    size_t start = submenu->selected > 3 ? submenu->selected - 3 : 0;
    int32_t y = 10;
    if(submenu->header) {
        canvas_set_font(canvas, FontPrimary);
        canvas_draw_str(canvas, 2, y, submenu->header);
        canvas_draw_line(canvas, 0, 12, 127, 12);
        y = 23;
    }
    for(size_t index = start; index < submenu->count && y <= 62; index++, y += 12) {
        if(index == submenu->selected) {
            canvas_draw_rbox(canvas, 1, y - 9, 126, 11, 2);
            canvas_set_color(canvas, ColorWhite);
        }
        canvas_set_font(canvas, FontSecondary);
        canvas_draw_str(canvas, 5, y, submenu->items[index].label);
        canvas_set_color(canvas, ColorBlack);
    }
}
static bool runtime_submenu_input(InputEvent* event, void* context) {
    Submenu* submenu = context;
    if(!submenu || !submenu->count) return false;
    if(event->type == InputTypeShort || event->type == InputTypeRepeat) {
        if(event->key == InputKeyUp) submenu->selected = submenu->selected ? submenu->selected - 1 : submenu->count - 1;
        else if(event->key == InputKeyDown) submenu->selected = (submenu->selected + 1) % submenu->count;
        else if(event->key == InputKeyOk) {
            RuntimeSubmenuItem* item = &submenu->items[submenu->selected];
            if(item->callback) item->callback(item->context, item->index);
            if(item->callback_ex) item->callback_ex(item->context, event->type, item->index);
            return true;
        } else return false;
        view_commit_model(submenu->view, true);
        return true;
    }
    if(event->key == InputKeyOk && submenu->items[submenu->selected].callback_ex) {
        RuntimeSubmenuItem* item = &submenu->items[submenu->selected];
        item->callback_ex(item->context, event->type, item->index);
        return true;
    }
    return false;
}
Submenu* submenu_alloc(void) {
    Submenu* submenu = calloc(1, sizeof(Submenu));
    if(!submenu) return NULL;
    submenu->view = view_alloc();
    view_set_context(submenu->view, submenu);
    view_set_draw_callback(submenu->view, runtime_submenu_draw);
    view_set_input_callback(submenu->view, runtime_submenu_input);
    submenu->view->model = submenu;
    return submenu;
}
void submenu_reset(Submenu* submenu) {
    if(!submenu) return;
    for(size_t index = 0; index < submenu->count; index++) free(submenu->items[index].label);
    submenu->count = submenu->selected = 0;
    free(submenu->header);
    submenu->header = NULL;
}
void submenu_free(Submenu* submenu) {
    if(!submenu) return;
    submenu_reset(submenu);
    submenu->view->model = NULL;
    view_free(submenu->view);
    free(submenu);
}
View* submenu_get_view(Submenu* submenu) { return submenu ? submenu->view : NULL; }
static void runtime_submenu_add(Submenu* submenu, const char* label, uint32_t index,
    SubmenuItemCallback callback, SubmenuItemCallbackEx callback_ex, void* context) {
    if(!submenu || submenu->count >= COUNT_OF(submenu->items)) return;
    submenu->items[submenu->count++] = (RuntimeSubmenuItem){
        .label = _strdup(label ? label : ""), .index = index,
        .callback = callback, .callback_ex = callback_ex, .context = context};
}
void submenu_add_item(Submenu* submenu, const char* label, uint32_t index,
    SubmenuItemCallback callback, void* context) {
    runtime_submenu_add(submenu, label, index, callback, NULL, context);
}
void submenu_add_item_ex(Submenu* submenu, const char* label, uint32_t index,
    SubmenuItemCallbackEx callback, void* context) {
    runtime_submenu_add(submenu, label, index, NULL, callback, context);
}
void submenu_change_item_label(Submenu* submenu, uint32_t index, const char* label) {
    if(!submenu) return;
    for(size_t item = 0; item < submenu->count; item++) if(submenu->items[item].index == index) {
        free(submenu->items[item].label);
        submenu->items[item].label = _strdup(label ? label : "");
        return;
    }
}
uint32_t submenu_get_selected_item(Submenu* submenu) {
    return submenu && submenu->count ? submenu->items[submenu->selected].index : 0;
}
void submenu_set_selected_item(Submenu* submenu, uint32_t index) {
    if(!submenu) return;
    for(size_t item = 0; item < submenu->count; item++)
        if(submenu->items[item].index == index) submenu->selected = item;
}
void submenu_set_header(Submenu* submenu, const char* header) {
    if(!submenu) return;
    free(submenu->header);
    submenu->header = header ? _strdup(header) : NULL;
}

typedef enum { WidgetText, WidgetButton, WidgetIcon, WidgetRect, WidgetCircle, WidgetLine } RuntimeWidgetKind;
typedef struct {
    RuntimeWidgetKind kind;
    int values[7];
    char* text;
    const Icon* icon;
    ButtonCallback callback;
    void* context;
} RuntimeWidgetElement;
struct Widget {
    View* view;
    RuntimeWidgetElement elements[64];
    size_t count;
};
static void runtime_widget_draw(Canvas* canvas, void* model) {
    Widget* widget = model;
    canvas_clear(canvas);
    for(size_t index = 0; index < widget->count; index++) {
        RuntimeWidgetElement* element = &widget->elements[index];
        switch(element->kind) {
        case WidgetText:
            canvas_set_font(canvas, (Font)element->values[4]);
            if(element->values[5]) elements_multiline_text(canvas, element->values[0], element->values[1], element->text);
            else canvas_draw_str_aligned(canvas, element->values[0], element->values[1],
                (Align)element->values[2], (Align)element->values[3], element->text);
            break;
        case WidgetButton:
            if(element->values[0] == GuiButtonTypeLeft) elements_button_left(canvas, element->text);
            else if(element->values[0] == GuiButtonTypeRight) elements_button_right(canvas, element->text);
            else elements_button_center(canvas, element->text);
            break;
        case WidgetIcon: canvas_draw_icon(canvas, element->values[0], element->values[1], element->icon); break;
        case WidgetRect:
            if(element->values[6]) canvas_draw_rbox(canvas, element->values[0], element->values[1],
                element->values[2], element->values[3], element->values[4]);
            else canvas_draw_rframe(canvas, element->values[0], element->values[1],
                element->values[2], element->values[3], element->values[4]);
            break;
        case WidgetCircle:
            if(element->values[3]) canvas_draw_disc(canvas, element->values[0], element->values[1], element->values[2]);
            else canvas_draw_circle(canvas, element->values[0], element->values[1], element->values[2]);
            break;
        case WidgetLine: canvas_draw_line(canvas, element->values[0], element->values[1], element->values[2], element->values[3]); break;
        }
    }
}
static bool runtime_widget_input(InputEvent* event, void* context) {
    Widget* widget = context;
    if(!widget) return false;
    GuiButtonType button;
    if(event->key == InputKeyLeft) button = GuiButtonTypeLeft;
    else if(event->key == InputKeyRight) button = GuiButtonTypeRight;
    else if(event->key == InputKeyOk) button = GuiButtonTypeCenter;
    else return false;
    for(size_t index = 0; index < widget->count; index++) {
        RuntimeWidgetElement* element = &widget->elements[index];
        if(element->kind == WidgetButton && element->values[0] == button && element->callback) {
            element->callback(button, event->type, element->context);
            return true;
        }
    }
    return false;
}
Widget* widget_alloc(void) {
    Widget* widget = calloc(1, sizeof(Widget));
    if(!widget) return NULL;
    widget->view = view_alloc();
    widget->view->model = widget;
    view_set_context(widget->view, widget);
    view_set_draw_callback(widget->view, runtime_widget_draw);
    view_set_input_callback(widget->view, runtime_widget_input);
    return widget;
}
void widget_reset(Widget* widget) {
    if(!widget) return;
    for(size_t index = 0; index < widget->count; index++) free(widget->elements[index].text);
    widget->count = 0;
}
void widget_free(Widget* widget) {
    if(!widget) return;
    widget_reset(widget);
    widget->view->model = NULL;
    view_free(widget->view);
    free(widget);
}
View* widget_get_view(Widget* widget) { return widget ? widget->view : NULL; }
static RuntimeWidgetElement* runtime_widget_add(Widget* widget, RuntimeWidgetKind kind) {
    if(!widget || widget->count >= COUNT_OF(widget->elements)) return NULL;
    RuntimeWidgetElement* element = &widget->elements[widget->count++];
    memset(element, 0, sizeof(*element));
    element->kind = kind;
    return element;
}
void widget_add_string_multiline_element(Widget* widget, uint8_t x, uint8_t y,
    Align horizontal, Align vertical, Font font, const char* text) {
    RuntimeWidgetElement* e = runtime_widget_add(widget, WidgetText); if(!e) return;
    e->values[0]=x;e->values[1]=y;e->values[2]=horizontal;e->values[3]=vertical;e->values[4]=font;e->values[5]=1;e->text=_strdup(text?text:"");
}
void widget_add_string_element(Widget* widget, uint8_t x, uint8_t y,
    Align horizontal, Align vertical, Font font, const char* text) {
    RuntimeWidgetElement* e = runtime_widget_add(widget, WidgetText); if(!e) return;
    e->values[0]=x;e->values[1]=y;e->values[2]=horizontal;e->values[3]=vertical;e->values[4]=font;e->text=_strdup(text?text:"");
}
void widget_add_text_box_element(Widget* widget, uint8_t x, uint8_t y, uint8_t width,
    uint8_t height, Align horizontal, Align vertical, const char* text, bool strip) {
    UNUSED(width); UNUSED(height); UNUSED(strip);
    widget_add_string_multiline_element(widget,x,y,horizontal,vertical,FontSecondary,text);
}
void widget_add_text_scroll_element(Widget* widget, uint8_t x, uint8_t y,
    uint8_t width, uint8_t height, const char* text) {
    UNUSED(width); UNUSED(height);
    widget_add_string_multiline_element(widget,x,y,AlignLeft,AlignTop,FontSecondary,text);
}
void widget_add_button_element(Widget* widget, GuiButtonType type, const char* text,
    ButtonCallback callback, void* context) {
    RuntimeWidgetElement* e = runtime_widget_add(widget, WidgetButton); if(!e) return;
    e->values[0]=type;e->text=_strdup(text?text:"");e->callback=callback;e->context=context;
}
void widget_add_icon_element(Widget* widget, uint8_t x, uint8_t y, const Icon* icon) {
    RuntimeWidgetElement* e=runtime_widget_add(widget,WidgetIcon);if(!e)return;e->values[0]=x;e->values[1]=y;e->icon=icon;
}
void widget_add_rect_element(Widget* widget,uint8_t x,uint8_t y,uint8_t width,uint8_t height,uint8_t radius,bool fill){
    RuntimeWidgetElement*e=runtime_widget_add(widget,WidgetRect);if(!e)return;e->values[0]=x;e->values[1]=y;e->values[2]=width;e->values[3]=height;e->values[4]=radius;e->values[6]=fill;
}
void widget_add_circle_element(Widget* widget,uint8_t x,uint8_t y,uint8_t radius,bool fill){
    RuntimeWidgetElement*e=runtime_widget_add(widget,WidgetCircle);if(!e)return;e->values[0]=x;e->values[1]=y;e->values[2]=radius;e->values[3]=fill;
}
void widget_add_line_element(Widget* widget,uint8_t x1,uint8_t y1,uint8_t x2,uint8_t y2){
    RuntimeWidgetElement*e=runtime_widget_add(widget,WidgetLine);if(!e)return;e->values[0]=x1;e->values[1]=y1;e->values[2]=x2;e->values[3]=y2;
}

struct VariableItem {
    char* label;
    char* value;
    uint8_t value_count;
    uint8_t current;
    VariableItemChangeCallback callback;
    void* context;
};
struct VariableItemList {
    View* view;
    VariableItem items[64];
    size_t count;
    size_t selected;
    VariableItemListEnterCallback enter_callback;
    void* enter_context;
};
static void runtime_variable_draw(Canvas* canvas, void* model) {
    VariableItemList* list = model;
    canvas_clear(canvas);
    size_t start = list->selected > 3 ? list->selected - 3 : 0;
    int y = 10;
    for(size_t index=start; index<list->count && y<=62; index++,y+=12) {
        if(index==list->selected){canvas_draw_rbox(canvas,1,y-9,126,11,2);canvas_set_color(canvas,ColorWhite);}
        canvas_set_font(canvas,FontSecondary);canvas_draw_str(canvas,4,y,list->items[index].label);
        canvas_draw_str_aligned(canvas,124,y,AlignRight,AlignBottom,list->items[index].value?list->items[index].value:"");
        canvas_set_color(canvas,ColorBlack);
    }
}
static bool runtime_variable_input(InputEvent* event, void* context) {
    VariableItemList* list = context;
    if(!list || !list->count ||
       !(event->type == InputTypeShort || event->type == InputTypeRepeat)) {
        return false;
    }
    VariableItem* item = &list->items[list->selected];
    if(event->key == InputKeyUp) {
        list->selected = list->selected ? list->selected - 1 : list->count - 1;
    } else if(event->key == InputKeyDown) {
        list->selected = (list->selected + 1) % list->count;
    } else if(event->key == InputKeyLeft || event->key == InputKeyRight) {
        if(item->value_count) {
            item->current = (uint8_t)(
                (item->current +
                 (event->key == InputKeyRight ? 1 : item->value_count - 1)) %
                item->value_count);
        }
        if(item->callback) item->callback(item);
    } else if(event->key == InputKeyOk) {
        if(list->enter_callback) {
            list->enter_callback(list->enter_context, (uint32_t)list->selected);
        }
    } else {
        return false;
    }
    view_commit_model(list->view, true);
    return true;
}
VariableItemList* variable_item_list_alloc(void){
    VariableItemList*list=calloc(1,sizeof(VariableItemList));if(!list)return NULL;list->view=view_alloc();list->view->model=list;view_set_context(list->view,list);view_set_draw_callback(list->view,runtime_variable_draw);view_set_input_callback(list->view,runtime_variable_input);return list;
}
void variable_item_list_reset(VariableItemList*list){if(!list)return;for(size_t i=0;i<list->count;i++){free(list->items[i].label);free(list->items[i].value);}list->count=list->selected=0;}
void variable_item_list_free(VariableItemList*list){if(!list)return;variable_item_list_reset(list);list->view->model=NULL;view_free(list->view);free(list);}
View* variable_item_list_get_view(VariableItemList*list){return list?list->view:NULL;}
VariableItem* variable_item_list_add(VariableItemList*list,const char*label,uint8_t count,VariableItemChangeCallback callback,void*context){
    if(!list || list->count >= COUNT_OF(list->items)) return NULL;
    VariableItem* item = &list->items[list->count++];
    item->label = _strdup(label ? label : "");
    item->value = _strdup("");
    item->value_count = count;
    item->callback = callback;
    item->context = context;
    return item;
}
void variable_item_list_set_enter_callback(VariableItemList*list,VariableItemListEnterCallback callback,void*context){if(list){list->enter_callback=callback;list->enter_context=context;}}
void variable_item_list_set_selected_item(VariableItemList*list,uint8_t index){if(list&&index<list->count)list->selected=index;}
uint8_t variable_item_list_get_selected_item_index(VariableItemList*list){return list?(uint8_t)list->selected:0;}
void variable_item_set_current_value_index(VariableItem*item,uint8_t index){if(item)item->current=item->value_count?index%item->value_count:0;}
void variable_item_set_values_count(VariableItem*item,uint8_t count){if(item)item->value_count=count;}
void variable_item_set_current_value_text(VariableItem*item,const char*text){if(!item)return;free(item->value);item->value=_strdup(text?text:"");}
uint8_t variable_item_get_current_value_index(VariableItem*item){return item?item->current:0;}
void* variable_item_get_context(VariableItem*item){return item?item->context:NULL;}

uint16_t icon_get_width(const Icon* icon){return icon?icon->width:0;}
uint16_t icon_get_height(const Icon* icon){return icon?icon->height:0;}
const uint8_t* icon_get_data(const Icon* icon){return icon_get_frame_data(icon,0);}
uint32_t icon_get_frame_count(const Icon* icon){return icon?icon->frame_count:0;}
const uint8_t* icon_get_frame_data(const Icon* icon,uint32_t frame){
    return icon&&icon->frames&&frame<icon->frame_count?icon->frames[frame]:NULL;
}
