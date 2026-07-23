#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    const void* port;
    uint16_t pin;
} GpioPin;

typedef enum {
    GpioModeInput,
    GpioModeOutputPushPull,
    GpioModeOutputOpenDrain,
    GpioModeAltFunctionPushPull,
    GpioModeAltFunctionOpenDrain,
    GpioModeAnalog,
    GpioModeInterruptRise,
    GpioModeInterruptFall,
    GpioModeInterruptRiseFall,
    GpioModeEventRise,
    GpioModeEventFall,
    GpioModeEventRiseFall,
} GpioMode;

typedef enum {
    GpioPullNo,
    GpioPullUp,
    GpioPullDown,
} GpioPull;

typedef enum {
    GpioSpeedLow,
    GpioSpeedMedium,
    GpioSpeedHigh,
    GpioSpeedVeryHigh,
} GpioSpeed;

extern const GpioPin gpio_speaker;

void furi_hal_gpio_init(
    const GpioPin* pin,
    GpioMode mode,
    GpioPull pull,
    GpioSpeed speed);
void furi_hal_gpio_write(const GpioPin* pin, bool state);
bool furi_hal_gpio_read(const GpioPin* pin);
