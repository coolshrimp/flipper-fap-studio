#pragma once

#include <stdbool.h>
#include <stdint.h>

#define CDC_DATA_SZ 64U

typedef enum {
    CdcStateDisconnected = 0,
    CdcStateConnected = 1,
} CdcState;

typedef uint32_t CdcCtrlLine;
enum {
    CdcCtrlLineDTR = 1U,
    CdcCtrlLineRTS = 2U,
};

typedef struct {
    void (*tx_ep_callback)(void*);
    void (*rx_ep_callback)(void*);
    void (*state_callback)(void*, CdcState);
    void (*ctrl_line_callback)(void*, CdcCtrlLine);
    void (*config_callback)(void*);
} CdcCallbacks;

static const uint8_t usb_cdc_single = 0;

void furi_hal_cdc_set_callbacks(uint8_t channel, CdcCallbacks* callbacks, void* context);
void furi_hal_cdc_send(uint8_t channel, uint8_t* data, uint16_t length);
int32_t furi_hal_cdc_receive(uint8_t channel, uint8_t* data, uint16_t length);
