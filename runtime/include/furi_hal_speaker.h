#pragma once

#include <stdbool.h>
#include <stdint.h>

bool furi_hal_speaker_acquire(uint32_t timeout);
bool furi_hal_speaker_is_mine(void);
void furi_hal_speaker_release(void);
void furi_hal_speaker_start(float frequency, float volume);
void furi_hal_speaker_stop(void);
void furi_hal_speaker_set_volume(float volume);
