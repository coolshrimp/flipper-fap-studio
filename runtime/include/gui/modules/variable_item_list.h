#pragma once
#include <gui/view.h>

typedef struct VariableItemList VariableItemList;
typedef struct VariableItem VariableItem;
typedef void (*VariableItemChangeCallback)(VariableItem*);
typedef void (*VariableItemListEnterCallback)(void*, uint32_t);
VariableItemList* variable_item_list_alloc(void);
void variable_item_list_free(VariableItemList* list);
void variable_item_list_reset(VariableItemList* list);
View* variable_item_list_get_view(VariableItemList* list);
VariableItem* variable_item_list_add(
    VariableItemList*, const char*, uint8_t, VariableItemChangeCallback, void*);
void variable_item_list_set_enter_callback(
    VariableItemList*, VariableItemListEnterCallback, void*);
void variable_item_list_set_selected_item(VariableItemList*, uint8_t);
uint8_t variable_item_list_get_selected_item_index(VariableItemList*);
void variable_item_set_current_value_index(VariableItem*, uint8_t);
void variable_item_set_values_count(VariableItem*, uint8_t);
void variable_item_set_current_value_text(VariableItem*, const char*);
uint8_t variable_item_get_current_value_index(VariableItem*);
void* variable_item_get_context(VariableItem*);
