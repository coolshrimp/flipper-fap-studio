#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    volatile uint32_t ICR;
} I2C_TypeDef;

static I2C_TypeDef runtime_i2c3;
#define I2C3 (&runtime_i2c3)

#define LL_I2C_OWNADDRESS1_7BIT 0U
#define LL_I2C_ACK 0U
#define I2C_ICR_ADDRCF (1U << 0)
#define I2C_ICR_NACKCF (1U << 1)
#define I2C_ICR_STOPCF (1U << 2)
#define I2C_ICR_BERRCF (1U << 3)
#define I2C_ICR_ARLOCF (1U << 4)
#define I2C_ICR_OVRCF (1U << 5)

#define RUNTIME_I2C_NOOP(name) static inline void name(I2C_TypeDef* i2c) { (void)i2c; }
RUNTIME_I2C_NOOP(LL_I2C_Disable)
RUNTIME_I2C_NOOP(LL_I2C_DisableOwnAddress1)
RUNTIME_I2C_NOOP(LL_I2C_EnableOwnAddress1)
RUNTIME_I2C_NOOP(LL_I2C_DisableOwnAddress2)
RUNTIME_I2C_NOOP(LL_I2C_DisableGeneralCall)
RUNTIME_I2C_NOOP(LL_I2C_EnableClockStretching)
RUNTIME_I2C_NOOP(LL_I2C_DisableIT_TX)
RUNTIME_I2C_NOOP(LL_I2C_DisableIT_RX)
RUNTIME_I2C_NOOP(LL_I2C_DisableIT_ADDR)
RUNTIME_I2C_NOOP(LL_I2C_DisableIT_NACK)
RUNTIME_I2C_NOOP(LL_I2C_DisableIT_STOP)
RUNTIME_I2C_NOOP(LL_I2C_DisableIT_ERR)
RUNTIME_I2C_NOOP(LL_I2C_Enable)
RUNTIME_I2C_NOOP(LL_I2C_ClearFlag_ADDR)
RUNTIME_I2C_NOOP(LL_I2C_ClearFlag_ARLO)
RUNTIME_I2C_NOOP(LL_I2C_ClearFlag_BERR)
RUNTIME_I2C_NOOP(LL_I2C_ClearFlag_NACK)
RUNTIME_I2C_NOOP(LL_I2C_ClearFlag_OVR)
RUNTIME_I2C_NOOP(LL_I2C_ClearFlag_STOP)
#undef RUNTIME_I2C_NOOP

static inline void LL_I2C_SetOwnAddress1(I2C_TypeDef* i2c, uint32_t address, uint32_t mode) {
    (void)i2c; (void)address; (void)mode;
}
static inline void LL_I2C_AcknowledgeNextData(I2C_TypeDef* i2c, uint32_t ack) {
    (void)i2c; (void)ack;
}
static inline bool LL_I2C_IsActiveFlag_ADDR(I2C_TypeDef* i2c) { (void)i2c; return false; }
static inline bool LL_I2C_IsActiveFlag_ARLO(I2C_TypeDef* i2c) { (void)i2c; return false; }
static inline bool LL_I2C_IsActiveFlag_BERR(I2C_TypeDef* i2c) { (void)i2c; return false; }
static inline bool LL_I2C_IsActiveFlag_NACK(I2C_TypeDef* i2c) { (void)i2c; return false; }
static inline bool LL_I2C_IsActiveFlag_OVR(I2C_TypeDef* i2c) { (void)i2c; return false; }
static inline bool LL_I2C_IsActiveFlag_RXNE(I2C_TypeDef* i2c) { (void)i2c; return false; }
static inline bool LL_I2C_IsActiveFlag_STOP(I2C_TypeDef* i2c) { (void)i2c; return false; }
static inline bool LL_I2C_IsActiveFlag_TXIS(I2C_TypeDef* i2c) { (void)i2c; return false; }
static inline uint8_t LL_I2C_ReceiveData8(I2C_TypeDef* i2c) { (void)i2c; return 0; }
static inline void LL_I2C_TransmitData8(I2C_TypeDef* i2c, uint8_t data) {
    (void)i2c; (void)data;
}
