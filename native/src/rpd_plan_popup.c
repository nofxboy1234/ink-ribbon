#include "rpd_plan.h"

#include <math.h>
#include <stdio.h>

#include "rpd_game.h"
#include "rpd_items.h"
#include "rpd_menu.h"
#include "rpd_plan_internal.h"
#include "rpd_popup.h"

static int pick_item_screen(float px, float py);
static void open_item_popup(int item);

static void project(float x, float y, float z, float *sx, float *sy, float *depth) {
    plan_internal_project(x, y, z, sx, sy, depth);
}

int plan_open_popup_at(float x, float z) {
    int item = items_pick(plan_internal_active_floor(), x, z, 1.0f);
    if (item >= 0) open_item_popup(item);
    return popup_is_open() ? 1 : 0;
}
void plan_pointer_move(float x, float y) {
    if (plan_internal_view_width() < 2) return;
    if (popup_is_open()) {
        popup_set_hover(popup_hit(x, y));
        plan_internal_set_hover(-1); plan_internal_set_hover_item(-1);
        return;
    }
    plan_internal_set_hover_item(pick_item_screen(x, y));
    plan_internal_set_hover(plan_internal_hover_item() >= 0 ? -1 : plan_internal_pick_cell(x, y));
    if (plan_internal_hover() >= 0 && plan_internal_node_blocked(plan_internal_hover())) plan_internal_set_hover(-1);
}

static int pick_item_screen(float px, float py) {
    int best = -1;
    float best_distance = 14.0f;
    for (int i = 0; i < items_count(); i++) {
        const item_t *item = items_get(i);
        if (!item || item->state != ITEM_PRESENT) continue;
        if (item->def->floor != plan_internal_active_floor()) continue;
        float cube[3], sx, sy, depth;
        items_cube_position(i, cube);
        plan_internal_project(cube[0], cube[1], cube[2], &sx, &sy, &depth);
        if (sx < -1e8f) continue;
        float distance = sqrtf((sx - px) * (sx - px) + (sy - py) * (sy - py));
        if (distance < best_distance) { best_distance = distance; best = i; }
    }
    return best;
}

static void open_item_popup(int item) {
    const item_t *entry = items_get(item);
    if (!entry) return;
    float cube[3], sx, sy, depth;
    items_cube_position(item, cube);
    plan_internal_project(cube[0], cube[1], cube[2], &sx, &sy, &depth);
    if (sx < -1e8f) return;
    popup_open(-1, item, sx + 26.0f, sy - 10.0f);
    popup_set_message(entry->def->title);
    const char *verb = items_action_label(item);
    if (!items_in_range(item, plan_internal_player()[0], plan_internal_player()[1], plan_internal_player()[2])) {
        popup_add_choice(POPUP_ACTION_WALK_NEXT, "WALK NEXT TO IT", true);
        return;
    }
    int missing = items_missing_requirement(item);
    int missing_open = items_missing_open(item);
    int blocker = missing >= 0 ? missing : missing_open;
    if (blocker >= 0) {
        const item_t *required = items_get(blocker);
        popup_set_message(required ? required->def->title : "LOCKED");
        char label[48];
        snprintf(label, sizeof(label), "%s - NEEDS KEY", verb);
        popup_add_choice(POPUP_ACTION_ACT, label, false);
        return;
    }
    if (items_missing_external(item) >= 0) {
        popup_set_message("OUTSIDE THE MAP");
        char label[48];
        snprintf(label, sizeof(label), "%s - NEEDS THE FILM", verb);
        popup_add_choice(POPUP_ACTION_ACT, label, false);
        return;
    }
    if (items_has_code(item)) {
        int hint = items_missing_hint(item);
        const item_t *required = hint >= 0 ? items_get(hint) : NULL;
        char label[48];
        popup_set_message(required ? required->def->title : "CODE REQUIRED");
        snprintf(label, sizeof(label), "%s - %s", verb, required ? "READ THE HINT" : "CODE REQUIRED");
        popup_add_choice(POPUP_ACTION_ACT, label, false);
        return;
    }
    if (entry->def->action == RPD_ACTION_TAKE && items_inventory_count() >= INVENTORY_SLOTS) {
        popup_set_message("INVENTORY FULL");
        popup_add_choice(POPUP_ACTION_ACT, "TAKE - INVENTORY FULL", false);
        return;
    }
    popup_add_choice(POPUP_ACTION_ACT, verb, items_available(item) != 0);
}

static void popup_execute(popup_action_t action, int data) {
    popup_t chosen = *popup_get();
    popup_close();
    if (action >= POPUP_ACTION_MENU_ADD) {
        menu_execute(action, chosen.node, data);
        return;
    }
    if (action == POPUP_ACTION_WALK_NEXT) {
        if (chosen.item >= 0) {
            const item_t *entry = items_get(chosen.item);
            int node = -1;
            if (entry) {
                node = entry->approach_node;
                if (node < 0)
                    node = plan_internal_nearest_node(entry->def->floor, entry->def->x, entry->def->y,
                                           entry->def->z, 8.0f);
            }
            plan_internal_add_waypoint(node);
        }
    } else if (action == POPUP_ACTION_TAKE || action == POPUP_ACTION_ACT) {
        items_act(chosen.item);
        plan_refresh_blocks();
    }
}

void plan_pointer_down(float x, float y) {
    if (plan_internal_view_width() < 2) return;
    plan_internal_set_hover_item(-1);
    if (popup_is_open()) {
        int hit = popup_hit(x, y);
        if (hit >= 0) {
            const popup_t *p = popup_get();
            if (p->choices[hit].enabled) popup_execute(p->choices[hit].action, p->choices[hit].data);
            return;
        }
        popup_close();
        game_set_paused(0);
        return;
    }
    int item = pick_item_screen(x, y);
    if (item >= 0) open_item_popup(item);
}

