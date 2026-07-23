#pragma once

#include <gui/canvas.h>

typedef struct ViewPort ViewPort;

typedef enum {
    InputKeyUp = 0,
    InputKeyDown,
    InputKeyRight,
    InputKeyLeft,
    InputKeyOk,
    InputKeyBack,
} InputKey;

typedef enum {
    InputTypePress = 0,
    InputTypeRelease,
    InputTypeShort,
    InputTypeLong,
    InputTypeRepeat,
} InputType;

typedef struct {
    InputKey key;
    InputType type;
    uint32_t sequence;
} InputEvent;

typedef void (*ViewPortDrawCallback)(Canvas* canvas, void* context);
typedef void (*ViewPortInputCallback)(InputEvent* event, void* context);

ViewPort* view_port_alloc(void);
void view_port_free(ViewPort* view_port);
void view_port_draw_callback_set(
    ViewPort* view_port,
    ViewPortDrawCallback callback,
    void* context);
void view_port_input_callback_set(
    ViewPort* view_port,
    ViewPortInputCallback callback,
    void* context);
void view_port_update(ViewPort* view_port);
void view_port_enabled_set(ViewPort* view_port, bool enabled);
const char* input_get_key_name(InputKey key);
const char* input_get_type_name(InputType type);
