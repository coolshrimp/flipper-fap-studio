#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t unused;
} FuriHalI2cBusHandle;

extern FuriHalI2cBusHandle furi_hal_i2c_handle_external;

void furi_hal_i2c_acquire(FuriHalI2cBusHandle* handle);
void furi_hal_i2c_release(FuriHalI2cBusHandle* handle);
bool furi_hal_i2c_is_device_ready(
    FuriHalI2cBusHandle* handle,
    uint8_t address,
    uint32_t timeout);
bool furi_hal_i2c_tx(
    FuriHalI2cBusHandle* handle,
    uint8_t address,
    const uint8_t* data,
    size_t size,
    uint32_t timeout);
bool furi_hal_i2c_rx(
    FuriHalI2cBusHandle* handle,
    uint8_t address,
    uint8_t* data,
    size_t size,
    uint32_t timeout);

uint8_t furi_hal_power_get_pct(void);
float furi_hal_power_get_usb_voltage(void);
bool furi_hal_power_is_otg_enabled(void);
bool furi_hal_power_enable_otg(void);
void furi_hal_power_disable_otg(void);
void furi_hal_power_insomnia_enter(void);
void furi_hal_power_insomnia_exit(void);

void furi_hal_usb_unlock(void);
bool furi_hal_usb_set_config(const void* config, void* context);
