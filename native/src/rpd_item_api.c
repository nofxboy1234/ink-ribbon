#include <emscripten/emscripten.h>

#include "rpd_items.h"
#include "rpd_save.h"
#include "rpd_doors.h"
#include "rpd_enemies.h"
#include "rpd_craft.h"
#include "rpd_game.h"
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
    const item_t *item = items_get(index);
    if (result == 0 && item && item->def && item->def->id == 544627) {
        game_set_ending(1);
    }
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_related(int index, int *out, int cap) {
    return items_related(index, out, cap);
}

EMSCRIPTEN_KEEPALIVE void rpd_item_debug_highlight(int index) {
    items_debug_highlight(index);
}

EMSCRIPTEN_KEEPALIVE int rpd_item_debug_highlighted(void) {
    return items_debug_highlighted();
}

EMSCRIPTEN_KEEPALIVE int rpd_item_debug_take(int index) {
    int result = items_debug_take(index);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_debug_open(int index) {
    int result = items_debug_open(index);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_debug_solve(int index) {
    int result = items_debug_solve(index);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_transition_target(int index) {
    const item_t *item = items_get(index);
    if (!item) return -1;
    return items_transition_target(index, item->def->x, item->def->z);
}

EMSCRIPTEN_KEEPALIVE int rpd_item_discard(int index) {
    int result = items_discard(index);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_box_store(int index) {
    int result = items_box_store(index);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_box_take(int slot) {
    int result = items_box_take(slot);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_box_count(void) {
    return items_box_count();
}

EMSCRIPTEN_KEEPALIVE int rpd_box_item(int slot) {
    const inventory_slot_t *box = items_box();
    if (slot < 0 || slot >= items_box_count() || !box[slot].filled) return -1;
    return box[slot].item;
}

EMSCRIPTEN_KEEPALIVE int rpd_save_snapshot(int *out, int cap) {
    return save_snapshot((uint8_t *)out, cap);
}

EMSCRIPTEN_KEEPALIVE int rpd_save_restore(const int *data, int size) {
    return save_restore((const uint8_t *)data, size);
}

EMSCRIPTEN_KEEPALIVE int rpd_craft_combine(int first, int second) {
    int result = craft_combine(first, second);
    plan_refresh_blocks();
    return result;
}

EMSCRIPTEN_KEEPALIVE int rpd_craft_result(int first, int second) {
    return craft_recipe_result(first, second);
}

EMSCRIPTEN_KEEPALIVE void rpd_set_debug_allowed(int value) { game_set_debug_allowed(value); }
EMSCRIPTEN_KEEPALIVE int rpd_game_health(void) { return game_health(); }
EMSCRIPTEN_KEEPALIVE int rpd_game_ending(void) { return game_ending(); }
EMSCRIPTEN_KEEPALIVE int rpd_game_shoot(int enemy, int stationary) { return game_shoot(enemy, stationary); }
EMSCRIPTEN_KEEPALIVE int rpd_game_stab(int enemy) { return game_stab(enemy); }
EMSCRIPTEN_KEEPALIVE int rpd_enemy_count(void) { return enemies_count(); }
EMSCRIPTEN_KEEPALIVE int rpd_enemy_alive(void) { return enemies_alive(); }
EMSCRIPTEN_KEEPALIVE int rpd_enemy_health(int index) { return enemies_health(index); }
EMSCRIPTEN_KEEPALIVE int rpd_enemy_hit(int index, int damage) { return enemies_hit(index, damage); }
EMSCRIPTEN_KEEPALIVE int rpd_enemy_visible(int index) { return enemies_visible(index); }

EMSCRIPTEN_KEEPALIVE void rpd_enemy_position(int index, float *out) { enemies_position(index, out); }

EMSCRIPTEN_KEEPALIVE int rpd_doors_discovered(int index) { return doors_discovered(index); }

EMSCRIPTEN_KEEPALIVE void rpd_plan_teleport_item(int index) { plan_teleport_item(index); }
EMSCRIPTEN_KEEPALIVE int rpd_doors_count(void) {
    return doors_count();
}

EMSCRIPTEN_KEEPALIVE int rpd_save_size(void) {
    return save_size();
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
