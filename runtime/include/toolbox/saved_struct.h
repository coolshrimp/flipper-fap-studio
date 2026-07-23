#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool saved_struct_load(
    const char* path,
    void* data,
    size_t data_size,
    uint8_t magic,
    uint8_t version);
bool saved_struct_save(
    const char* path,
    const void* data,
    size_t data_size,
    uint8_t magic,
    uint8_t version);
