#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    SceneManagerEventTypeCustom,
    SceneManagerEventTypeBack,
    SceneManagerEventTypeTick,
} SceneManagerEventType;

typedef struct {
    SceneManagerEventType type;
    uint32_t event;
} SceneManagerEvent;

typedef void (*AppSceneOnEnterCallback)(void*);
typedef bool (*AppSceneOnEventCallback)(void*, SceneManagerEvent);
typedef void (*AppSceneOnExitCallback)(void*);

typedef struct {
    const AppSceneOnEnterCallback* on_enter_handlers;
    const AppSceneOnEventCallback* on_event_handlers;
    const AppSceneOnExitCallback* on_exit_handlers;
    const uint32_t scene_num;
} SceneManagerHandlers;

typedef struct SceneManager SceneManager;
SceneManager* scene_manager_alloc(const SceneManagerHandlers* handlers, void* context);
void scene_manager_free(SceneManager* manager);
void scene_manager_set_scene_state(SceneManager* manager, uint32_t scene, uint32_t state);
uint32_t scene_manager_get_scene_state(const SceneManager* manager, uint32_t scene);
bool scene_manager_handle_custom_event(SceneManager* manager, uint32_t event);
bool scene_manager_handle_back_event(SceneManager* manager);
void scene_manager_handle_tick_event(SceneManager* manager);
void scene_manager_next_scene(SceneManager* manager, uint32_t scene);
bool scene_manager_previous_scene(SceneManager* manager);
bool scene_manager_has_previous_scene(const SceneManager* manager, uint32_t scene);
bool scene_manager_search_and_switch_to_previous_scene(SceneManager* manager, uint32_t scene);
bool scene_manager_search_and_switch_to_previous_scene_one_of(
    SceneManager* manager, const uint32_t* scenes, size_t count);
bool scene_manager_search_and_switch_to_another_scene(SceneManager* manager, uint32_t scene);
uint32_t scene_manager_get_current_scene(SceneManager* manager);
void scene_manager_stop(SceneManager* manager);
