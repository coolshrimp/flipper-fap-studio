#pragma once
#include <gui/elements.h>
#include <gui/icon.h>
#include <gui/modules/widget_elements/widget_element.h>
#include <gui/view.h>

typedef struct Widget Widget;
Widget* widget_alloc(void);
void widget_free(Widget* widget);
void widget_reset(Widget* widget);
View* widget_get_view(Widget* widget);
void widget_add_string_multiline_element(
    Widget*, uint8_t, uint8_t, Align, Align, Font, const char*);
void widget_add_string_element(
    Widget*, uint8_t, uint8_t, Align, Align, Font, const char*);
void widget_add_text_box_element(
    Widget*, uint8_t, uint8_t, uint8_t, uint8_t, Align, Align, const char*, bool);
void widget_add_text_scroll_element(
    Widget*, uint8_t, uint8_t, uint8_t, uint8_t, const char*);
void widget_add_button_element(
    Widget*, GuiButtonType, const char*, ButtonCallback, void*);
void widget_add_icon_element(Widget*, uint8_t, uint8_t, const Icon*);
void widget_add_rect_element(
    Widget*, uint8_t, uint8_t, uint8_t, uint8_t, uint8_t, bool);
void widget_add_circle_element(Widget*, uint8_t, uint8_t, uint8_t, bool);
void widget_add_line_element(Widget*, uint8_t, uint8_t, uint8_t, uint8_t);
#define widget_add_frame_element(widget, x, y, width, height, radius) \
    widget_add_rect_element(widget, x, y, width, height, radius, false)
