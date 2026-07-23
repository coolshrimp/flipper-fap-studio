#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint16_t year;
    uint8_t month;
    uint8_t day;
    uint8_t hour;
    uint8_t minute;
    uint8_t second;
    uint8_t weekday;
} DateTime;

typedef enum {
    FuriHalRtcFlagDebug = 0,
    FuriHalRtcFlagFactoryReset,
    FuriHalRtcFlagLock,
    FuriHalRtcFlagC2Update,
    FuriHalRtcFlagHandOrient,
    FuriHalRtcFlagLegacySleep,
    FuriHalRtcFlagStealthMode,
} FuriHalRtcFlag;

void furi_hal_rtc_get_datetime(DateTime* datetime);
bool furi_hal_rtc_is_flag_set(FuriHalRtcFlag flag);
