#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <furi_hal_gpio.h>

typedef struct SubGhzDevice SubGhzDevice;
typedef void (*SubGhzDeviceAsyncRxCallback)(const void* data, size_t size, void* context);

typedef enum {
    FuriHalSubGhzPresetOok270Async,
    FuriHalSubGhzPresetOok650Async,
    FuriHalSubGhzPreset2FSKDev238Async,
    FuriHalSubGhzPreset2FSKDev476Async,
    FuriHalSubGhzPresetMSK99_97KbAsync,
    FuriHalSubGhzPresetGFSK9_99KbAsync,
    FuriHalSubGhzPresetCustom,
} FuriHalSubGhzPreset;

void subghz_devices_init(void);
void subghz_devices_deinit(void);
const SubGhzDevice* subghz_devices_get_by_name(const char* name);
bool subghz_devices_begin(const SubGhzDevice* device);
void subghz_devices_end(const SubGhzDevice* device);
bool subghz_devices_is_frequency_valid(const SubGhzDevice* device, uint32_t frequency);
void subghz_devices_load_preset(
    const SubGhzDevice* device,
    FuriHalSubGhzPreset preset,
    const uint8_t* preset_data);
uint32_t subghz_devices_set_frequency(const SubGhzDevice* device, uint32_t frequency);
bool subghz_devices_start_async_rx(
    const SubGhzDevice* device,
    SubGhzDeviceAsyncRxCallback callback,
    void* context);
void subghz_devices_stop_async_rx(const SubGhzDevice* device);
void subghz_devices_idle(const SubGhzDevice* device);
float subghz_devices_get_rssi(const SubGhzDevice* device);
void subghz_devices_set_async_mirror_pin(const SubGhzDevice* device, const GpioPin* pin);
