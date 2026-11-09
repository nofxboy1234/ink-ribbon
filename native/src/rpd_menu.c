#include "rpd_menu.h"

#include "rpd_plan.h"

void menu_open(float x, float y) {
    popup_close();
    int node = plan_pick_node(x, y);
    int has = node >= 0 && plan_has_waypoint(node);
    int idle = !plan_moving();
    popup_open_menu(node, x, y);
    popup_add_choice(POPUP_ACTION_MENU_ADD, "Add waypoint", idle && node >= 0 && !has);
    popup_add_choice(POPUP_ACTION_MENU_REMOVE, "Remove waypoint", idle && has);
    popup_add_choice(POPUP_ACTION_MENU_RUN, "Run route", idle && plan_route_count() >= 2);
    popup_add_choice(POPUP_ACTION_MENU_CLEAR, "Clear all", plan_count() > 0);
}

void menu_close(void) { popup_close(); }

int menu_is_open(void) { return popup_is_menu() ? 1 : 0; }

void menu_execute(popup_action_t action, int node) {
    if (action == POPUP_ACTION_MENU_ADD) plan_add_target_node(node);
    else if (action == POPUP_ACTION_MENU_REMOVE) plan_remove_target_node(node);
    else if (action == POPUP_ACTION_MENU_RUN) plan_start_move();
    else if (action == POPUP_ACTION_MENU_CLEAR) plan_clear_route();
}
