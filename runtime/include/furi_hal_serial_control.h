#pragma once

#include <furi_hal_serial.h>

typedef enum {
    FuriHalSerialIdUsart = 0,
    FuriHalSerialIdLpuart,
} FuriHalSerialId;

FuriHalSerialHandle* furi_hal_serial_control_acquire(FuriHalSerialId id);
void furi_hal_serial_control_release(FuriHalSerialHandle* handle);
