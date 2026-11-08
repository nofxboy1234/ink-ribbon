#pragma once

#include <stdbool.h>

#define POPUP_MAX_CHOICES 3

typedef enum {
    POPUP_CLOSED,
    POPUP_CHOOSING,
} popup_phase_t;

typedef enum {
    POPUP_ACTION_NONE,
    POPUP_ACTION_WAYPOINT,
    POPUP_ACTION_TAKE,
    POPUP_ACTION_WALK_NEXT,
    POPUP_ACTION_ACT,
} popup_action_t;

typedef struct {
    popup_action_t action;
    char label[48];
    bool enabled;
} popup_choice_t;

typedef struct {
    popup_phase_t phase;
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
void popup_add_choice(popup_action_t action, const char *label, bool enabled);
void popup_set_message(const char *message);
void popup_close(void);
bool popup_is_open(void);
void popup_set_hover(int index);
void popup_set_viewport(int width, int height);
int popup_hit(float x, float y);
void popup_layout(float *x0, float *y0, float *w, float *h);
bool popup_choice_rect(int index, float *out);
const popup_t *popup_get(void);
