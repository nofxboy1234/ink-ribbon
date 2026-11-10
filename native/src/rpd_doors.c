#include "rpd_doors.h"

#include <math.h>

#include "rpd_items.h"
#include "rpd_markers.h"

#define DOOR_PERIOD 3.1f

static float door_open[64];
static int door_marker[64];
static int door_item[64];
static int door_count;

void doors_reset(void) {
    door_count = 0;
    for (int i = 0; i < 64; i++) {
        door_open[i] = 0.0f;
        door_marker[i] = -1;
        door_item[i] = -1;
    }
    for (int i = 0; i < items_count() && door_count < 64; i++) {
        const item_t *item = items_get(i);
        if (!item || !item->def) continue;
        const char *category = item->def->category;
        if (!category || (category[0] != 'L' && category[1] != 'o')) continue;
        door_item[door_count] = i;
        door_marker[door_count] = item->marker;
        door_count++;
    }
}

void doors_sync(void) {
    for (int i = 0; i < door_count; i++) {
        const item_t *item = items_get(door_item[i]);
        if (!item || item->marker < 0) continue;
        float target = item->state == ITEM_OPEN ? 1.0f : 0.0f;
        if (door_open[i] < target) {
            door_open[i] = fminf(1.0f, door_open[i] + 0.05f);
        } else if (door_open[i] > target) {
            door_open[i] = fmaxf(0.0f, door_open[i] - 0.05f);
        }
        if (item->state == ITEM_OPEN) {
            rpd_marker_set_color(item->marker, 90, 200, 255);
        } else if (item->state == ITEM_UNLOCKED) {
            rpd_marker_set_color(item->marker, 60, 120, 230);
        } else {
            rpd_marker_set_color(item->marker, 220, 50, 50);
        }
        rpd_marker_set_rotation(item->marker, door_open[i] * 1.5707963f);
    }
}

int doors_count(void) { return door_count; }
