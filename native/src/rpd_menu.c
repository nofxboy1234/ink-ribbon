#include "rpd_menu.h"

#include <stdio.h>

#include "rpd_game.h"
#include "rpd_items.h"
#include "rpd_plan.h"

static int menu_item = -1;

void menu_open(float x, float y) {
    popup_close();
    game_set_paused(1);
    menu_item = -1;
    {
        int item = plan_hover_item();
        const item_t *entry = item >= 0 ? items_get(item) : 0;
        if (entry && entry->state == ITEM_PRESENT && items_transition_target(item, entry->def->x, entry->def->z) >= 0) {
            menu_item = item;
            popup_open_menu(-1, x, y);
            popup_add_choice(POPUP_ACTION_MENU_GO_TO, "Go", 1);
            popup_add_choice(POPUP_ACTION_MENU_ADD, "Add waypoint", 1);
            return;
        }
    }
    if (game_debug()) {
        int item = plan_hover_item();
        const item_t *entry = item >= 0 ? items_get(item) : 0;
        if (entry && entry->state == ITEM_PRESENT) {
            menu_item = item;
            popup_open_menu(-1, x, y);
            const int action = items_action_kind(item);
            if (action == RPD_ACTION_TAKE) {
                popup_add_choice(POPUP_ACTION_MENU_DEBUG_TAKE, "Debug take", 1);
            }
            if (action == RPD_ACTION_OPEN || action == RPD_ACTION_USE) {
                popup_add_choice(POPUP_ACTION_MENU_DEBUG_OPEN, "Debug open", 1);
            }
            if (action == RPD_ACTION_SOLVE) {
                popup_add_choice(POPUP_ACTION_MENU_DEBUG_SOLVE, "Debug solve", 1);
            }
            int related[5];
            int count = items_related(item, related, 5);
            for (int i = 0; i < count; i++) {
                const item_t *link = items_get(related[i]);
                if (!link) continue;
                char label[80];
                snprintf(label, sizeof(label), "Go to %s", link->def->title);
                popup_add_choice_data(POPUP_ACTION_MENU_GO_TO, label, 1, related[i]);
            }
            return;
        }
    }
    int node = plan_pick_node(x, y);
    int has = node >= 0 && plan_has_waypoint(node);
    int idle = !plan_moving();
    popup_open_menu(node, x, y);
    popup_add_choice(POPUP_ACTION_MENU_ADD, "Add waypoint", idle && node >= 0 && !has);
    popup_add_choice(POPUP_ACTION_MENU_REMOVE, "Remove waypoint", idle && has);
    popup_add_choice(POPUP_ACTION_MENU_RUN, "Execute route", idle && plan_route_count() >= 2);
    popup_add_choice(POPUP_ACTION_MENU_RUN_TOGGLE, game_run() ? "Walk" : "Run", 1);
    popup_add_choice(POPUP_ACTION_MENU_CLEAR, "Clear all", plan_count() > 0);
    if (game_debug()) {
        popup_add_choice(POPUP_ACTION_MENU_TELEPORT, "Teleport here", idle && node >= 0);
    }
}

void menu_close(void) {
    game_set_paused(0);
    menu_item = -1;
    popup_close();
}

int menu_is_open(void) { return popup_is_menu() ? 1 : 0; }

void menu_execute(popup_action_t action, int node, int data) {
    if (action == POPUP_ACTION_MENU_DEBUG_TAKE) {
        if (menu_item >= 0) items_debug_take(menu_item);
        menu_item = -1;
    } else if (action == POPUP_ACTION_MENU_DEBUG_OPEN) {
        if (menu_item >= 0) items_debug_open(menu_item);
        menu_item = -1;
    } else if (action == POPUP_ACTION_MENU_DEBUG_SOLVE) {
        if (menu_item >= 0) items_debug_solve(menu_item);
        menu_item = -1;
    } else if (action == POPUP_ACTION_MENU_GO_TO) {
        if (data >= 0) {
            const item_t *item = items_get(data);
            plan_teleport_item(data);
            (void)item;
        } else if (menu_item >= 0) {
            const item_t *item = items_get(menu_item);
            if (item) plan_teleport_item(items_transition_target(menu_item, item->def->x, item->def->z));
        }
    } else if (action == POPUP_ACTION_MENU_TELEPORT) {
        plan_teleport_node(node);
    } else if (action == POPUP_ACTION_MENU_ADD) plan_add_target_node(node);
    else if (action == POPUP_ACTION_MENU_REMOVE) plan_remove_target_node(node);
    else if (action == POPUP_ACTION_MENU_RUN) plan_start_move();
    else if (action == POPUP_ACTION_MENU_RUN_TOGGLE) game_toggle_run();
    else if (action == POPUP_ACTION_MENU_CLEAR) plan_clear_route();
    game_set_paused(0);
}
