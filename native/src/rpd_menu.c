#include "rpd_menu.h"

#include "rpd_game.h"
#include "rpd_items.h"
#include "rpd_plan.h"

static int menu_item = -1;

void menu_open(float x, float y) {
    popup_close();
    game_set_paused(1);
    menu_item = -1;
    if (game_debug()) {
        int item = plan_hover_item();
        const item_t *entry = item >= 0 ? items_get(item) : 0;
        if (entry && entry->state == ITEM_PRESENT && items_action_kind(item) == RPD_ACTION_TAKE) {
            menu_item = item;
            popup_open_menu(-1, x, y);
            popup_add_choice(POPUP_ACTION_MENU_DEBUG_TAKE, "Debug take", 1);
            return;
        }
    }
    int node = plan_pick_node(x, y);
    int has = node >= 0 && plan_has_waypoint(node);
    int idle = !plan_moving();
    popup_open_menu(node, x, y);
    popup_add_choice(POPUP_ACTION_MENU_ADD, "Add waypoint", idle && node >= 0 && !has);
    popup_add_choice(POPUP_ACTION_MENU_REMOVE, "Remove waypoint", idle && has);
    popup_add_choice(POPUP_ACTION_MENU_RUN, "Run route", idle && plan_route_count() >= 2);
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

void menu_execute(popup_action_t action, int node) {
    if (action == POPUP_ACTION_MENU_DEBUG_TAKE) {
        if (menu_item >= 0) items_debug_take(menu_item);
        menu_item = -1;
    } else if (action == POPUP_ACTION_MENU_TELEPORT) {
        plan_teleport_node(node);
    } else if (action == POPUP_ACTION_MENU_ADD) plan_add_target_node(node);
    else if (action == POPUP_ACTION_MENU_REMOVE) plan_remove_target_node(node);
    else if (action == POPUP_ACTION_MENU_RUN) plan_start_move();
    else if (action == POPUP_ACTION_MENU_CLEAR) plan_clear_route();
    game_set_paused(0);
}
