#pragma once

#include <furi.h>
#include <gui/view_port.h>

void runtime_initialize(void);
void runtime_shutdown(void);
bool runtime_dispatch_input(const char* key_name, const char* type_name);
void runtime_emit_status(const char* state, int32_t exit_code);
uint32_t runtime_message_queue_count(FuriMessageQueue* queue);
uint32_t runtime_message_queue_capacity(FuriMessageQueue* queue);
size_t runtime_stream_buffer_count(FuriStreamBuffer* stream);
size_t runtime_stream_buffer_capacity(FuriStreamBuffer* stream);
bool runtime_mutex_available(FuriMutex* mutex);
void runtime_thread_set_event_loop(FuriEventLoop* loop);
