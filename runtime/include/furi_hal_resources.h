#pragma once

#include <stdint.h>

/* Opaque desktop-only port identities used by source that declares GpioPin values. */
#define GPIOA ((const void*)(uintptr_t)0xA)
#define GPIOB ((const void*)(uintptr_t)0xB)
#define GPIOC ((const void*)(uintptr_t)0xC)
#define GPIOD ((const void*)(uintptr_t)0xD)

#define LL_GPIO_PIN_0  ((uint16_t)(1u << 0))
#define LL_GPIO_PIN_1  ((uint16_t)(1u << 1))
#define LL_GPIO_PIN_2  ((uint16_t)(1u << 2))
#define LL_GPIO_PIN_3  ((uint16_t)(1u << 3))
#define LL_GPIO_PIN_4  ((uint16_t)(1u << 4))
#define LL_GPIO_PIN_5  ((uint16_t)(1u << 5))
#define LL_GPIO_PIN_6  ((uint16_t)(1u << 6))
#define LL_GPIO_PIN_7  ((uint16_t)(1u << 7))
#define LL_GPIO_PIN_8  ((uint16_t)(1u << 8))
#define LL_GPIO_PIN_9  ((uint16_t)(1u << 9))
#define LL_GPIO_PIN_10 ((uint16_t)(1u << 10))
#define LL_GPIO_PIN_11 ((uint16_t)(1u << 11))
#define LL_GPIO_PIN_12 ((uint16_t)(1u << 12))
#define LL_GPIO_PIN_13 ((uint16_t)(1u << 13))
#define LL_GPIO_PIN_14 ((uint16_t)(1u << 14))
#define LL_GPIO_PIN_15 ((uint16_t)(1u << 15))
