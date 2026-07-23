#pragma once
#include <gui/view.h>

typedef struct Submenu Submenu;
typedef void (*SubmenuItemCallback)(void*, uint32_t);
typedef void (*SubmenuItemCallbackEx)(void*, InputType, uint32_t);
Submenu* submenu_alloc(void);
void submenu_free(Submenu* submenu);
View* submenu_get_view(Submenu* submenu);
void submenu_add_item(
    Submenu* submenu, const char* label, uint32_t index,
    SubmenuItemCallback callback, void* context);
void submenu_add_item_ex(
    Submenu* submenu, const char* label, uint32_t index,
    SubmenuItemCallbackEx callback, void* context);
void submenu_change_item_label(Submenu* submenu, uint32_t index, const char* label);
void submenu_reset(Submenu* submenu);
uint32_t submenu_get_selected_item(Submenu* submenu);
void submenu_set_selected_item(Submenu* submenu, uint32_t index);
void submenu_set_header(Submenu* submenu, const char* header);
