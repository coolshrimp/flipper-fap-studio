#pragma once

#include <stdint.h>

#define FURI_HAL_RANDOM_MAX UINT32_MAX
void furi_hal_random_init(void);
uint32_t furi_hal_random_get(void);
void furi_hal_random_fill_buf(uint8_t* buffer, uint32_t length);
