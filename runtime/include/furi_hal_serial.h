#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct FuriHalSerialHandle FuriHalSerialHandle;

typedef enum {
    FuriHalSerialRxEventData = 1,
    FuriHalSerialRxEventIdle = 2,
} FuriHalSerialRxEvent;

typedef void (*FuriHalSerialDmaRxCallback)(
    FuriHalSerialHandle* handle,
    FuriHalSerialRxEvent event,
    size_t data_len,
    void* context);

void furi_hal_serial_init(FuriHalSerialHandle* handle, uint32_t baud);
void furi_hal_serial_deinit(FuriHalSerialHandle* handle);
void furi_hal_serial_set_br(FuriHalSerialHandle* handle, uint32_t baud);
void furi_hal_serial_tx(
    FuriHalSerialHandle* handle,
    const uint8_t* data,
    size_t size);
void furi_hal_serial_tx_wait_complete(FuriHalSerialHandle* handle);
void furi_hal_serial_dma_rx_start(
    FuriHalSerialHandle* handle,
    FuriHalSerialDmaRxCallback callback,
    void* context,
    bool report_errors);
void furi_hal_serial_dma_rx_stop(FuriHalSerialHandle* handle);
size_t furi_hal_serial_dma_rx(
    FuriHalSerialHandle* handle,
    uint8_t* data,
    size_t size);
