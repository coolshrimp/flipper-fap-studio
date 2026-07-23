#pragma once
#include <gui/view_port.h>

typedef enum {
    GuiButtonTypeLeft,
    GuiButtonTypeCenter,
    GuiButtonTypeRight,
} GuiButtonType;
typedef void (*ButtonCallback)(GuiButtonType result, InputType type, void* context);
typedef struct WidgetElement WidgetElement;
