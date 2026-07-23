#include "host_runtime.h"

#include <furi.h>
#include <stdio.h>
#include <string.h>
#include <windows.h>

#ifndef FLIPPER_RUNTIME_ENTRY
#error "FLIPPER_RUNTIME_ENTRY must name the FAP entry point"
#endif

extern int32_t FLIPPER_RUNTIME_ENTRY(void* context);

static DWORD WINAPI runtime_input_thread(void* context) {
    UNUSED(context);
    char line[128];
    while(fgets(line, sizeof(line), stdin)) {
        char key[24] = {0};
        char type[24] = {0};
        if(sscanf(line, "INPUT %23s %23s", key, type) == 2) {
            runtime_dispatch_input(key, type);
        }
    }
    return 0;
}
int main(void) {
    runtime_initialize();
    HANDLE input_thread = CreateThread(NULL, 0, runtime_input_thread, NULL, 0, NULL);
    runtime_emit_status("running", 0);
    const int32_t result = FLIPPER_RUNTIME_ENTRY(NULL);
    runtime_emit_status("exited", result);
    runtime_shutdown();
    if(input_thread) CloseHandle(input_thread);
    return (int)result;
}
