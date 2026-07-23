#pragma once

#include <gui/canvas.h>

void elements_multiline_text(Canvas* canvas, int32_t x, int32_t y, const char* text);
void elements_button_left(Canvas* canvas, const char* text);
void elements_button_center(Canvas* canvas, const char* text);
void elements_button_right(Canvas* canvas, const char* text);
void elements_scrollbar(Canvas* canvas, uint32_t position, uint32_t total);
