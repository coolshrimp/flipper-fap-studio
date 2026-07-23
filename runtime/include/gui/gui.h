#pragma once

#include <gui/view_port.h>

typedef struct Gui Gui;

typedef enum {
    GuiLayerDesktop = 0,
    GuiLayerWindow,
    GuiLayerFullscreen,
    GuiLayerStatusBarLeft,
    GuiLayerStatusBarRight,
} GuiLayer;

void gui_add_view_port(Gui* gui, ViewPort* view_port, GuiLayer layer);
void gui_remove_view_port(Gui* gui, ViewPort* view_port);
