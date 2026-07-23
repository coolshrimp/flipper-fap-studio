#pragma once

#include <stdint.h>

typedef struct Icon {
    uint16_t width;
    uint16_t height;
    uint16_t frame_count;
    const uint8_t* const* frames;
} Icon;

typedef enum {
    IconRotation0 = 0,
    IconRotation90,
    IconRotation180,
    IconRotation270,
} IconRotation;

uint16_t icon_get_width(const Icon* icon);
uint16_t icon_get_height(const Icon* icon);
const uint8_t* icon_get_data(const Icon* icon);
uint32_t icon_get_frame_count(const Icon* icon);
const uint8_t* icon_get_frame_data(const Icon* icon, uint32_t frame);
