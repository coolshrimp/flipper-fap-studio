#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <gui/icon.h>

typedef struct Canvas Canvas;

typedef enum {
    ColorWhite = 0,
    ColorBlack = 1,
    ColorXOR = 2,
} Color;

typedef enum {
    FontPrimary = 0,
    FontSecondary,
    FontKeyboard,
    FontBigNumbers,
    FontBatteryPercent,
} Font;

typedef enum {
    AlignLeft = 0,
    AlignRight,
    AlignCenter,
    AlignTop,
    AlignBottom,
} Align;

typedef Align AlignHorizontal;
typedef Align AlignVertical;

void canvas_clear(Canvas* canvas);
void canvas_set_color(Canvas* canvas, Color color);
void canvas_set_font(Canvas* canvas, Font font);
void canvas_set_custom_u8g2_font(Canvas* canvas, const uint8_t* font);
void canvas_invert_color(Canvas* canvas);
void canvas_draw_dot(Canvas* canvas, int32_t x, int32_t y);
void canvas_draw_line(
    Canvas* canvas,
    int32_t x1,
    int32_t y1,
    int32_t x2,
    int32_t y2);
void canvas_draw_box(Canvas* canvas, int32_t x, int32_t y, int32_t width, int32_t height);
void canvas_draw_frame(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height);
void canvas_draw_rbox(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height,
    int32_t radius);
void canvas_draw_rframe(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height,
    int32_t radius);
void canvas_draw_circle(Canvas* canvas, int32_t x, int32_t y, int32_t radius);
void canvas_draw_disc(Canvas* canvas, int32_t x, int32_t y, int32_t radius);
void canvas_draw_str(Canvas* canvas, int32_t x, int32_t y, const char* text);
void canvas_draw_str_aligned(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    AlignHorizontal horizontal,
    AlignVertical vertical,
    const char* text);
void canvas_draw_xbm(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height,
    const uint8_t* bitmap);
void canvas_draw_icon(Canvas* canvas, int32_t x, int32_t y, const Icon* icon);
void canvas_draw_icon_ex(
    Canvas* canvas,
    int32_t x,
    int32_t y,
    const Icon* icon,
    IconRotation rotation);
size_t canvas_width(Canvas* canvas);
size_t canvas_height(Canvas* canvas);
size_t canvas_string_width(Canvas* canvas, const char* text);
