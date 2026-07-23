#pragma once

#include <gui/canvas.h>
#include <gui/icon.h>
#include <gui/view_port.h>

#define VIEW_NONE UINT32_MAX
#define VIEW_IGNORE (UINT32_MAX - 1U)

typedef struct View View;
typedef struct IconAnimation IconAnimation;
typedef void (*ViewDrawCallback)(Canvas*, void*);
typedef bool (*ViewInputCallback)(InputEvent*, void*);
typedef bool (*ViewCustomCallback)(uint32_t, void*);
typedef uint32_t (*ViewNavigationCallback)(void*);
typedef void (*ViewCallback)(void*);
typedef void (*ViewUpdateCallback)(View*, void*);

typedef enum {
    ViewOrientationHorizontal,
    ViewOrientationHorizontalFlip,
    ViewOrientationVertical,
    ViewOrientationVerticalFlip,
} ViewOrientation;

typedef enum {
    ViewModelTypeNone,
    ViewModelTypeLockFree,
    ViewModelTypeLocking,
} ViewModelType;

View* view_alloc(void);
void view_free(View* view);
void view_tie_icon_animation(View* view, IconAnimation* animation);
void view_set_draw_callback(View* view, ViewDrawCallback callback);
void view_set_input_callback(View* view, ViewInputCallback callback);
void view_set_custom_callback(View* view, ViewCustomCallback callback);
void view_set_previous_callback(View* view, ViewNavigationCallback callback);
void view_set_enter_callback(View* view, ViewCallback callback);
void view_set_exit_callback(View* view, ViewCallback callback);
void view_set_update_callback(View* view, ViewUpdateCallback callback);
void view_set_update_callback_context(View* view, void* context);
void view_set_context(View* view, void* context);
void view_set_orientation(View* view, ViewOrientation orientation);
void view_allocate_model(View* view, ViewModelType type, size_t size);
void view_free_model(View* view);
void* view_get_model(View* view);
void view_commit_model(View* view, bool update);

#define with_view_model(view, type, code, update) \
    { type = view_get_model(view); { code; } view_commit_model(view, update); }
