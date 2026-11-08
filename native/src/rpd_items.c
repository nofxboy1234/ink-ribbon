#include "rpd_items.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

#include "rpd_markers.h"

#include "rpd_item_registry.h"

#define ITEM_REACH 2.5f
#define ITEM_APPROACH_REACH 1.5f
#define ITEM_MARKER_LIFT 0.45f
#define MAX_EXTERNAL_CARRIED 32

static item_t g_items[RPD_ITEM_COUNT];
static inventory_slot_t g_inventory[INVENTORY_SLOTS];
static int g_inventory_count;
static bool g_placed;
static int32_t g_external_carried[MAX_EXTERNAL_CARRIED];
static int g_external_count;

typedef struct {
    float r, g, b;
} colour_t;

static const colour_t ACTION_COLOURS[RPD_ACTION_INSPECT + 1] = {
    { 0.55f, 0.55f, 0.55f },
    { 0.43f, 0.90f, 0.55f },
    { 0.95f, 0.62f, 0.32f },
    { 0.95f, 0.82f, 0.36f },
    { 0.72f, 0.55f, 0.98f },
    { 0.38f, 0.66f, 0.95f },
    { 0.36f, 0.85f, 0.88f },
    { 0.95f, 0.45f, 0.72f },
};

static const char *ACTION_VERBS[RPD_ACTION_INSPECT + 1] = {
    "", "TAKE", "UNLOCK", "OPEN", "SOLVE", "READ", "USE", "INSPECT",
};

static int item_in_inventory(int index) {
    for (int slot = 0; slot < INVENTORY_SLOTS; slot++) {
        if (g_inventory[slot].filled && g_inventory[slot].item == index) return slot;
    }
    return -1;
}

static bool item_is_open(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return true;
    item_state_t state = g_items[index].state;
    return state == ITEM_OPEN || state == ITEM_UNLOCKED || state == ITEM_TAKEN || state == ITEM_USED;
}

void items_reset(void) {
    memset(g_inventory, 0, sizeof(g_inventory));
    memset(g_external_carried, 0, sizeof(g_external_carried));
    g_inventory_count = 0;
    g_external_count = 0;
    g_placed = false;
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        const rpd_item_def_t *def = &RPD_ITEM_DEFS[i];
        item_t *item = &g_items[i];
        item->def = def;
        item->index = i;
        item->state = def->hidden_by >= 0 ? ITEM_HIDDEN : ITEM_PRESENT;
        item->marker = -1;
        item->approach_node = -1;
        item->approach_x = 0.0f;
        item->approach_y = 0.0f;
        item->approach_z = 0.0f;
        const colour_t *colour = &ACTION_COLOURS[def->action <= RPD_ACTION_INSPECT ? def->action : 0];
        item->r = colour->r;
        item->g = colour->g;
        item->b = colour->b;
    }
}

static float dist2(float ax, float ay, float az, float bx, float by, float bz) {
    float dx = ax - bx, dy = (ay - by) * 1.4f, dz = az - bz;
    return dx * dx + dy * dy + dz * dz;
}

bool items_place(int nav_count, const float *x, const float *y, const float *z,
                 const uint8_t *floor) {
    if (g_placed) return true;
    if (nav_count <= 0) return false;
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        const rpd_item_def_t *def = &RPD_ITEM_DEFS[i];
        int best = -1;
        float bestd = 1e30f;
        for (int n = 0; n < nav_count; n++) {
            if (floor[n] != def->floor) continue;
            float d = dist2(x[n], y[n], z[n], def->x, def->y, def->z);
            if (d < bestd) { bestd = d; best = n; }
        }
        g_items[i].approach_node = best;
        if (best >= 0) {
            g_items[i].approach_x = x[best];
            g_items[i].approach_y = y[best];
            g_items[i].approach_z = z[best];
        }
    }
    g_placed = true;
    return true;
}

void items_set_approach(int index, int node, float x, float y, float z) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return;
    g_items[index].approach_node = node;
    g_items[index].approach_x = x;
    g_items[index].approach_y = y;
    g_items[index].approach_z = z;
}

static void sync_marker(int index) {
    item_t *item = &g_items[index];
    if (item->state != ITEM_PRESENT) {
        if (item->marker >= 0) rpd_marker_set_visible(item->marker, 0);
        if (item->marker < 0) item->marker = -1;
        return;
    }
    if (item->marker >= 0) {
        rpd_marker_set_visible(item->marker, 1);
        return;
    }
    item->marker = rpd_marker_add(MARKER_SPHERE, item->def->x,
                                  item->def->y + ITEM_MARKER_LIFT, item->def->z, 0.55f,
                                  (int)(item->r * 255.0f), (int)(item->g * 255.0f),
                                  (int)(item->b * 255.0f));
}

void items_sync_markers(void) {
    if (!g_placed) return;
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        const item_t *item = &g_items[i];
        // Modelled items are drawn as meshes; the marker is the 3D stand-in
        // for the fixtures MapGenie left without a model.
        if (item->def->model != NULL && item->state == ITEM_PRESENT) continue;
        sync_marker(i);
    }
}

int items_count(void) {
    return g_placed ? RPD_ITEM_COUNT : 0;
}

int items_registry_count(void) {
    return RPD_ITEM_COUNT;
}

const item_t *items_get(int index) {
    if (!g_placed || index < 0 || index >= RPD_ITEM_COUNT) return NULL;
    return &g_items[index];
}

const rpd_item_def_t *items_def(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return NULL;
    return &RPD_ITEM_DEFS[index];
}

int items_at_node(int node) {
    if (!g_placed) return -1;
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        if (g_items[i].state != ITEM_PRESENT) continue;
        if (g_items[i].approach_node == node) return i;
    }
    return -1;
}

bool items_node_blocked(int node) {
    (void)node;
    // A marker never blocks the nav graph. Reach is checked against the item
    // coordinate, so off-nav fixtures stay interactable without editing paths.
    return false;
}

int items_room(int index) {
    (void)index;
    return -1;
}

int items_inventory_count(void) {
    return g_inventory_count;
}

const inventory_slot_t *items_inventory(void) {
    return g_inventory;
}

int items_missing_requirement(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return -1;
    const rpd_item_def_t *def = &RPD_ITEM_DEFS[index];
    for (int i = 0; i < def->requires_count; i++) {
        int required = def->requires[i];
        if (item_in_inventory(required) < 0) return required;
    }
    return -1;
}

int items_missing_open(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return -1;
    const rpd_item_def_t *def = &RPD_ITEM_DEFS[index];
    for (int i = 0; i < def->requires_open_count; i++) {
        int required = def->requires_open[i];
        if (!item_is_open(required)) return required;
    }
    return -1;
}

int items_external_carried(int id) {
    for (int i = 0; i < g_external_count; i++) {
        if (g_external_carried[i] == id) return 1;
    }
    return 0;
}

int items_grant_external(int id) {
    if (id <= 0 || items_external_carried(id)) return 0;
    bool known = false;
    for (int i = 0; i < RPD_ITEM_COUNT && !known; i++) {
        for (int e = 0; e < RPD_ITEM_DEFS[i].external_count; e++) {
            if (RPD_ITEM_DEFS[i].external_requires[e] == id) {
                known = true;
                break;
            }
        }
    }
    if (!known || g_external_count >= MAX_EXTERNAL_CARRIED) return -1;
    g_external_carried[g_external_count++] = id;
    return 0;
}

int items_missing_external(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return -1;
    const rpd_item_def_t *def = &RPD_ITEM_DEFS[index];
    for (int i = 0; i < def->external_count; i++) {
        if (!items_external_carried(def->external_requires[i])) return def->external_requires[i];
    }
    return -1;
}

int items_has_code(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return 0;
    return RPD_ITEM_DEFS[index].code != NULL;
}

int items_available(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return 0;
    const item_t *item = &g_items[index];
    if (item->state != ITEM_PRESENT || item->def->action == RPD_ACTION_NONE) return 0;
    if (items_missing_requirement(index) >= 0) return 0;
    if (items_missing_open(index) >= 0) return 0;
    if (items_missing_external(index) >= 0) return 0;
    if (item->def->code != NULL) return 0;
    if (item->def->action == RPD_ACTION_TAKE && g_inventory_count >= INVENTORY_SLOTS) return 0;
    return 1;
}

int items_hidden(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return 1;
    return g_items[index].state == ITEM_HIDDEN ? 1 : 0;
}

int items_in_range(int index, float x, float y, float z) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return 0;
    const rpd_item_def_t *def = &RPD_ITEM_DEFS[index];
    if (dist2(x, y, z, def->x, def->y, def->z) <= ITEM_REACH * ITEM_REACH) return 1;
    const item_t *item = &g_items[index];
    return item->approach_node >= 0
        && dist2(x, y, z, item->approach_x, item->approach_y, item->approach_z)
            <= ITEM_APPROACH_REACH * ITEM_APPROACH_REACH;
}

int items_pick(int floor, float x, float z, float radius) {
    int best = -1;
    float bestd = radius * radius;
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        const item_t *item = &g_items[i];
        if (item->state != ITEM_PRESENT) continue;
        if (item->def->floor != floor) continue;
        float dx = item->def->x - x;
        float dz = item->def->z - z;
        float d = dx * dx + dz * dz;
        if (d < bestd) { bestd = d; best = i; }
    }
    return best;
}

int items_index_for_id(int id) {
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        if (RPD_ITEM_DEFS[i].id == id) return i;
    }
    return -1;
}

static void reveal_contents(int index) {
    const rpd_item_def_t *def = &RPD_ITEM_DEFS[index];
    for (int i = 0; i < def->contents_count; i++) {
        int content = def->contents[i];
        if (content < 0 || content >= RPD_ITEM_COUNT) continue;
        if (g_items[content].state == ITEM_HIDDEN) {
            g_items[content].state = ITEM_PRESENT;
            g_items[content].marker = -1;
            sync_marker(content);
        }
    }
}

static int place_in_inventory(int index) {
    int slot = 0;
    while (slot < INVENTORY_SLOTS && g_inventory[slot].filled) slot++;
    if (slot >= INVENTORY_SLOTS) return -1;
    const item_t *item = &g_items[index];
    g_inventory[slot].filled = true;
    g_inventory[slot].r = item->r;
    g_inventory[slot].g = item->g;
    g_inventory[slot].b = item->b;
    g_inventory[slot].item = index;
    g_inventory_count++;
    return slot;
}

int items_take(int index) {
    return items_act(index);
}

int items_act(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return -3;
    item_t *item = &g_items[index];
    if (item->state == ITEM_HIDDEN) return -4;
    if (item->state != ITEM_PRESENT) return -3;
    const rpd_action_t action = (rpd_action_t)item->def->action;
    if (action == RPD_ACTION_NONE) return -3;
    if (items_missing_requirement(index) >= 0) return -2;
    if (items_missing_open(index) >= 0) return -2;
    if (items_missing_external(index) >= 0) return -2;
    if (item->def->code != NULL) return -5;
    if (action == RPD_ACTION_TAKE) {
        if (g_inventory_count >= INVENTORY_SLOTS) return -1;
        if (place_in_inventory(index) < 0) return -1;
        item->state = ITEM_TAKEN;
    } else if (action == RPD_ACTION_UNLOCK) {
        item->state = ITEM_UNLOCKED;
    } else if (action == RPD_ACTION_READ) {
        item->state = ITEM_READ;
    } else if (action == RPD_ACTION_INSPECT) {
        item->state = ITEM_INSPECTED;
    } else if (action == RPD_ACTION_USE) {
        item->state = ITEM_USED;
    } else {
        item->state = ITEM_OPEN;
    }
    reveal_contents(index);
    if (item->marker >= 0) rpd_marker_set_visible(item->marker, 0);
    return 0;
}

int items_enter_code(int index, const char *entry) {
    if (index < 0 || index >= RPD_ITEM_COUNT || !entry) return -3;
    item_t *item = &g_items[index];
    const rpd_item_def_t *def = item->def;
    if (item->state != ITEM_PRESENT || def->code == NULL) return -3;
    if (items_missing_requirement(index) >= 0) return -2;
    if (items_missing_open(index) >= 0) return -2;
    if (items_missing_external(index) >= 0) return -2;
    if (strcmp(def->code, entry) != 0) return -6;
    item->state = ITEM_OPEN;
    reveal_contents(index);
    if (item->marker >= 0) rpd_marker_set_visible(item->marker, 0);
    return 0;
}

const char *items_action_label(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return "";
    int action = RPD_ITEM_DEFS[index].action;
    if (action < 0 || action > RPD_ACTION_INSPECT) return "";
    return ACTION_VERBS[action];
}

int items_action_kind(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return RPD_ACTION_NONE;
    return RPD_ITEM_DEFS[index].action;
}
