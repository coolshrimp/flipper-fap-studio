#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#define RUNTIME_WEAK

typedef struct {
    bool running;
    bool paused;
    uint8_t volume;
    uint32_t played_samples;
} RuntimeAudioBackend;

RUNTIME_WEAK void* audio_backend_alloc(void) {
    return calloc(1, sizeof(RuntimeAudioBackend));
}

RUNTIME_WEAK void audio_backend_free(void* value) {
    free(value);
}

RUNTIME_WEAK bool audio_backend_start(void* value, int output, uint8_t volume) {
    (void)output;
    RuntimeAudioBackend* backend = value;
    if(!backend) return false;
    backend->running = true;
    backend->paused = false;
    backend->volume = volume;
    backend->played_samples = 0;
    return true;
}

RUNTIME_WEAK void audio_backend_stop(void* value) {
    RuntimeAudioBackend* backend = value;
    if(backend) backend->running = false;
}

RUNTIME_WEAK bool audio_backend_write(void* value, int16_t sample) {
    (void)sample;
    RuntimeAudioBackend* backend = value;
    if(!backend || !backend->running) return false;
    if(!backend->paused) backend->played_samples++;
    return true;
}

RUNTIME_WEAK void audio_backend_set_volume(void* value, uint8_t volume) {
    RuntimeAudioBackend* backend = value;
    if(backend) backend->volume = volume;
}

RUNTIME_WEAK void audio_backend_set_paused(void* value, bool paused) {
    RuntimeAudioBackend* backend = value;
    if(backend) backend->paused = paused;
}

RUNTIME_WEAK void audio_backend_drain(void* value, uint32_t timeout_ms) {
    (void)value;
    (void)timeout_ms;
}

RUNTIME_WEAK uint32_t audio_backend_get_underflows(const void* value) {
    (void)value;
    return 0;
}

RUNTIME_WEAK uint32_t audio_backend_get_played_samples(const void* value) {
    const RuntimeAudioBackend* backend = value;
    return backend ? backend->played_samples : 0;
}

RUNTIME_WEAK void audio_backend_reset_progress(void* value) {
    RuntimeAudioBackend* backend = value;
    if(backend) backend->played_samples = 0;
}

RUNTIME_WEAK int audio_backend_get_error(const void* value) {
    return value ? 0 : 1;
}

RUNTIME_WEAK uint32_t audio_backend_get_sample_rate(int output) {
    return output == 1 ? 44100U : 22050U;
}
