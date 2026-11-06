#include "rpd_popup.h"

#include <stdio.h>
#include <string.h>

#define POPUP_WIDTH 300.0f
#define POPUP_ROW_HEIGHT 28.0f
#define POPUP_PAD 8.0f
#define POPUP_MESSAGE_HEIGHT 22.0f
#define POPUP_GAP 18.0f
#define POPUP_RIGHT_INSET 380.0f

static popup_t g_popup;
static int g_view_w = 1;
static int g_view_h = 1;

void popup_reset(void) {
    memset(&g_popup, 0, sizeof(g_popup));
    g_popup.phase = POPUP_CLOSED;
    g_popup.hover = -1;
    g_popup.node = -1;
    g_popup.item = -1;
}

void popup_open(int node, int item, float anchor_x, float anchor_y) {
    popup_reset();
    g_popup.phase = POPUP_CHOOSING;
    g_popup.node = node;
    g_popup.item = item;
    g_popup.anchor[0] = anchor_x;
    g_popup.anchor[1] = anchor_y;
}

void popup_add_choice(popup_action_t action, const char *label, bool enabled) {
    if (g_popup.choice_count >= POPUP_MAX_CHOICES) return;
    popup_choice_t *choice = &g_popup.choices[g_popup.choice_count++];
    choice->action = action;
    choice->enabled = enabled;
    snprintf(choice->label, sizeof(choice->label), "%s", label ? label : "");
}

void popup_set_message(const char *message) {
    snprintf(g_popup.message, sizeof(g_popup.message), "%s", message ? message : "");
}

void popup_close(void) {
    popup_reset();
}

bool popup_is_open(void) {
    return g_popup.phase == POPUP_CHOOSING;
}

void popup_set_hover(int index) {
    g_popup.hover = index;
}

void popup_set_viewport(int width, int height) {
    g_view_w = width > 1 ? width : 1;
    g_view_h = height > 1 ? height : 1;
}

void popup_layout(float *x0, float *y0, float *w, float *h) {
    float height = POPUP_PAD * 2.0f + POPUP_ROW_HEIGHT * (float)g_popup.choice_count;
    if (g_popup.message[0]) height += POPUP_MESSAGE_HEIGHT;
    float x = g_popup.anchor[0];
    float y = g_popup.anchor[1];
    float right = (float)g_view_w - POPUP_RIGHT_INSET;
    if (right < POPUP_WIDTH + POPUP_GAP * 2.0f) right = (float)g_view_w;
    if (x + POPUP_WIDTH + POPUP_GAP > right) x = g_popup.anchor[0] - POPUP_WIDTH - POPUP_GAP;
    if (x < POPUP_GAP) x = POPUP_GAP;
    if (x + POPUP_WIDTH > right) x = right - POPUP_WIDTH;
    if (y + height > (float)g_view_h - POPUP_GAP) y = (float)g_view_h - height - POPUP_GAP;
    if (y < POPUP_GAP) y = POPUP_GAP;
    *x0 = x;
    *y0 = y;
    *w = POPUP_WIDTH;
    *h = height;
}

bool popup_choice_rect(int index, float *out) {
    if (index < 0 || index >= g_popup.choice_count) return false;
    float x0, y0, w, h;
    popup_layout(&x0, &y0, &w, &h);
    float top = y0 + POPUP_PAD;
    if (g_popup.message[0]) top += POPUP_MESSAGE_HEIGHT;
    out[0] = x0 + 5.0f;
    out[1] = top + POPUP_ROW_HEIGHT * (float)index;
    out[2] = x0 + w - 5.0f;
    out[3] = out[1] + POPUP_ROW_HEIGHT;
    return true;
}

int popup_hit(float x, float y) {
    for (int i = 0; i < g_popup.choice_count; i++) {
        float rect[4];
        if (!popup_choice_rect(i, rect)) continue;
        if (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]) return i;
    }
    return -1;
}

const popup_t *popup_get(void) {
    return &g_popup;
}
