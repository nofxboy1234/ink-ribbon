#pragma once

#include <stdbool.h>

#define POPUP_MAX_CHOICES 8

typedef enum {
    POPUP_CLOSED,
    POPUP_CHOOSING,
} popup_phase_t;

typedef enum {
    POPUP_KIND_ITEM,
    POPUP_KIND_MENU,
} popup_kind_t;

typedef enum {
    POPUP_ACTION_NONE,
    POPUP_ACTION_TAKE,
    POPUP_ACTION_WALK_NEXT,
    POPUP_ACTION_ACT,
    POPUP_ACTION_MENU_ADD,
    POPUP_ACTION_MENU_REMOVE,
    POPUP_ACTION_MENU_RUN,
    POPUP_ACTION_MENU_CLEAR,
    POPUP_ACTION_MENU_TELEPORT,
    POPUP_ACTION_MENU_DEBUG_TAKE,
    POPUP_ACTION_MENU_DEBUG_OPEN,
    POPUP_ACTION_MENU_DEBUG_SOLVE,
    POPUP_ACTION_MENU_RUN_TOGGLE,
    POPUP_ACTION_MENU_GO_TO,
} popup_action_t;

typedef struct {
    popup_action_t action;
    char label[48];
    bool enabled;
    int data;
} popup_choice_t;

typedef struct {
    popup_phase_t phase;
    popup_kind_t kind;
    int node;
    int item;
    int hover;
    int choice_count;
    char message[48];
    popup_choice_t choices[POPUP_MAX_CHOICES];
    float anchor[2];
} popup_t;

void popup_reset(void);
void popup_open(int node, int item, float anchor_x, float anchor_y);
void popup_open_menu(int node, float anchor_x, float anchor_y);
void popup_add_choice(popup_action_t action, const char *label, bool enabled);
void popup_add_choice_data(popup_action_t action, const char *label, bool enabled, int data);
void popup_set_message(const char *message);
void popup_close(void);
bool popup_is_open(void);
bool popup_is_menu(void);
void popup_set_hover(int index);
void popup_set_viewport(int width, int height);
int popup_hit(float x, float y);
void popup_layout(float *x0, float *y0, float *w, float *h);
bool popup_choice_rect(int index, float *out);
const popup_t *popup_get(void);
