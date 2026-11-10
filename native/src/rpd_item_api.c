#include <emscripten/emscripten.h>

#include "rpd_items.h"
#include "rpd_plan.h"
#include "rpd_sokol.h"

EMSCRIPTEN_KEEPALIVE const char *rpd_item_icon(int index) {
    const item_t *item = items_get(index);
    return item ? item->def->icon : "";
}

EMSCRIPTEN_KEEPALIVE const char *rpd_item_action(int index) {
    return items_action_label(index);
}

EMSCRIPTEN_KEEPALIVE const char *rpd_item_hint(int index) {
    int missing = items_missing_requirement(index);
    if (missing < 0) missing = items_missing_open(index);
    if (missing >= 0) {
        const item_t *required = items_get(missing);
        if (required) return required->def->title;
    }
    if (items_missing_external(index) >= 0) return "OUTSIDE THE MAP";
    int hint = items_missing_hint(index);
    if (hint >= 0) {
        const item_t *required = items_get(hint);
        return required ? required->def->title : "HINT";
    }
    if (items_has_code(index)) return "CODE REQUIRED";
    if (items_hidden(index)) return "HIDDEN";
    if (items_inventory_count() >= INVENTORY_SLOTS && items_action_kind(index) == RPD_ACTION_TAKE)
        return "INVENTORY FULL";
    return "";
}

EMSCRIPTEN_KEEPALIVE int rpd_item_act(int index) {
    int result = items_act(index);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_debug_take(int index) {
    int result = items_debug_take(index);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_enter_code(int index, const char *code) {
    int result = items_enter_code(index, code);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_grant_external(int id) {
    int result = items_grant_external(id);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_has_code(int index) {
    return items_has_code(index);
}

EMSCRIPTEN_KEEPALIVE int rpd_plan_item_blocked(int index) {
    return plan_item_blocked_count(index);
}

EMSCRIPTEN_KEEPALIVE int rpd_item_index_for_id(int id) {
    return items_index_for_id(id);
}

EMSCRIPTEN_KEEPALIVE int rpd_item_available(int index) {
    return items_available(index);
}

EMSCRIPTEN_KEEPALIVE int rpd_inventory_item(int slot) {
    const inventory_slot_t *slots = items_inventory();
    if (slot < 0 || slot >= INVENTORY_SLOTS || !slots[slot].filled) return -1;
    return slots[slot].item;
}
