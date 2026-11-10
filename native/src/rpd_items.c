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

static void preload_box(void);

static item_t g_items[RPD_ITEM_COUNT];
static inventory_slot_t g_inventory[INVENTORY_SLOTS];
static int g_inventory_count;
static inventory_slot_t g_box[BOX_SLOTS];
static int g_box_count;
static bool g_placed;
static int32_t g_external_carried[MAX_EXTERNAL_CARRIED];
static int g_external_count;

typedef struct {
    float r, g, b;
} colour_t;

typedef struct {
    const char *category;
    float r, g, b;
} category_colour_t;

static const category_colour_t CATEGORY_COLOURS[] = {
    { "Key Item", 0.62f, 0.31f, 0.95f },
    { "Lock", 0.95f, 0.55f, 0.20f },
    { "Safe", 0.95f, 0.78f, 0.25f },
    { "Puzzle", 0.30f, 0.85f, 0.85f },
    { "File", 0.90f, 0.90f, 0.84f },
    { "Film", 0.95f, 0.45f, 0.72f },
    { "Area Map", 0.35f, 0.75f, 0.95f },
    { "Weapon", 0.90f, 0.28f, 0.28f },
    { "Weapon Upgrade", 0.95f, 0.62f, 0.25f },
    { "Knife", 0.72f, 0.72f, 0.76f },
    { "Flash Grenade", 0.45f, 0.85f, 0.45f },
    { "Hand Grenade", 0.35f, 0.75f, 0.35f },
    { "Grenade Rounds", 0.60f, 0.80f, 0.35f },
    { "Handgun Ammo", 0.95f, 0.82f, 0.30f },
    { "SMG Ammo", 0.95f, 0.70f, 0.25f },
    { "Needle Cartridges", 0.85f, 0.70f, 0.30f },
    { "High-Powered Rounds", 0.90f, 0.60f, 0.20f },
    { "Green Herb", 0.35f, 0.85f, 0.40f },
    { "Red Herb", 0.90f, 0.30f, 0.30f },
    { "Blue Herb", 0.35f, 0.55f, 0.95f },
    { "First Aid Spray", 0.95f, 0.40f, 0.55f },
    { "Gunpowder", 0.85f, 0.75f, 0.35f },
    { "High-Grade Gunpowder", 0.95f, 0.85f, 0.45f },
    { "Ink Ribbon", 0.35f, 0.35f, 0.40f },
    { "Wooden Boards", 0.65f, 0.45f, 0.25f },
    { "Item Box", 0.60f, 0.42f, 0.25f },
    { "Typewriter", 0.45f, 0.45f, 0.50f },
    { "Transition", 0.35f, 0.65f, 0.95f },
    { "Hip Pouch", 0.40f, 0.60f, 0.85f },
    { "Mr Raccoon", 0.70f, 0.70f, 0.70f },
    { "Easter Egg", 0.95f, 0.85f, 0.35f },
};

static colour_t category_colour(const char *category) {
    if (category != NULL) {
        for (size_t i = 0; i < sizeof(CATEGORY_COLOURS) / sizeof(CATEGORY_COLOURS[0]); i++) {
            if (strcmp(category, CATEGORY_COLOURS[i].category) == 0) {
                return (colour_t){ CATEGORY_COLOURS[i].r, CATEGORY_COLOURS[i].g,
                                   CATEGORY_COLOURS[i].b };
            }
        }
    }
    return (colour_t){ 0.55f, 0.55f, 0.55f };
}

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
    // A read file or inspected fixture is used up in the same sense as an
    // opened container: its requirement is satisfied for downstream gates.
    return g_items[index].state >= ITEM_TAKEN;
}

void items_reset(void) {
    memset(g_inventory, 0, sizeof(g_inventory));
    memset(g_external_carried, 0, sizeof(g_external_carried));
    g_inventory_count = 0;
    memset(g_box, 0, sizeof(g_box));
    g_box_count = 0;
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
        item->snap_node = -1;
        item->snap_x = 0.0f;
        item->snap_y = 0.0f;
        item->snap_z = 0.0f;
        colour_t colour = category_colour(def->category);
        item->r = colour.r;
        item->g = colour.g;
        item->b = colour.b;
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
        g_items[i].snap_node = best;
        if (best >= 0) {
            g_items[i].approach_x = x[best];
            g_items[i].approach_y = y[best];
            g_items[i].approach_z = z[best];
            g_items[i].snap_x = x[best];
            g_items[i].snap_y = y[best];
            g_items[i].snap_z = z[best];
        }
    }
    preload_box();
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

void items_cube_position(int index, float out[3]) {
    const item_t *item = items_get(index);
    if (!item || !out) {
        if (out) { out[0] = 0.0f; out[1] = 0.0f; out[2] = 0.0f; }
        return;
    }
    if (item->snap_node >= 0) {
        out[0] = item->snap_x;
        out[1] = item->snap_y + ITEM_MARKER_LIFT;
        out[2] = item->snap_z;
        return;
    }
    out[0] = item->def->x;
    out[1] = item->def->y + ITEM_MARKER_LIFT;
    out[2] = item->def->z;
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
    float pos[3];
    items_cube_position(index, pos);
    item->marker = rpd_marker_add(MARKER_CUBE, pos[0], pos[1], pos[2], 0.275f,
                                  (int)(item->r * 255.0f), (int)(item->g * 255.0f),
                                  (int)(item->b * 255.0f));
}

void items_sync_markers(void) {
    if (!g_placed) return;
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
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

static bool item_occupies_cell(const item_t *item) {
    return item && item->state == ITEM_PRESENT && item->snap_node >= 0;
}

bool items_node_blocked(int node) {
    if (!g_placed) return false;
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        if (item_occupies_cell(&g_items[i]) && g_items[i].snap_node == node) return true;
    }
    return false;
}

void items_block_cells(int nav_count, uint8_t *blocked) {
    if (!g_placed || !blocked) return;
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        if (!item_occupies_cell(&g_items[i])) continue;
        int node = g_items[i].snap_node;
        if (node < nav_count) blocked[node] = 1;
    }
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

static int item_known(int index) {
    const item_t *item = items_get(index);
    if (!item) return 0;
    return item->state >= ITEM_TAKEN || item_in_inventory(index) >= 0;
}

int items_missing_hint(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return -1;
    const rpd_item_def_t *def = &RPD_ITEM_DEFS[index];
    for (int i = 0; i < def->hint_count; i++) {
        int hint = def->hints[i];
        if (hint >= 0 && hint < RPD_ITEM_COUNT && !item_known(hint)) return hint;
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
    for (int i = 0; i < item->def->external_grant_count; i++) {
        items_grant_external(item->def->external_grants[i]);
    }
    if (item->marker >= 0) rpd_marker_set_visible(item->marker, 0);
    return 0;
}

int items_debug_take(int index) {
    const item_t *item = items_get(index);
    if (!item || item->state != ITEM_PRESENT) return -3;
    if (items_action_kind(index) != RPD_ACTION_TAKE) return -4;
    if (place_in_inventory(index) < 0) return -1;
    g_items[index].state = ITEM_TAKEN;
    if (g_items[index].marker >= 0) rpd_marker_set_visible(g_items[index].marker, 0);
    return 0;
}

int items_related(int index, int *out, int cap) {
    const item_t *item = items_get(index);
    if (!item || cap <= 0) return 0;
    int count = 0;
    for (int i = 0; i < item->def->opens_count && count < cap; i++) out[count++] = item->def->opens[i];
    for (int i = 0; i < RPD_ITEM_COUNT && count < cap; i++) {
        if (i == index) continue;
        const rpd_item_def_t *def = items_def(i);
        if (!def) continue;
        for (int r = 0; r < def->requires_count; r++) {
            if (def->requires[r] == index) { out[count++] = i; break; }
        }
    }
    return count;
}

static int highlighted = -1;

void items_debug_highlight(int index) {
    if (highlighted >= 0) {
        const item_t *old = items_get(highlighted);
        if (old && old->marker >= 0) rpd_marker_set_color(old->marker,
            (int)(old->r * 255.0f), (int)(old->g * 255.0f), (int)(old->b * 255.0f));
    }
    highlighted = index;
    if (index < 0) return;
    int related[8];
    int count = items_related(index, related, 8);
    for (int i = 0; i < count; i++) {
        const item_t *item = items_get(related[i]);
        if (item && item->marker >= 0) rpd_marker_set_color(item->marker, 255, 210, 60);
    }
    const item_t *self = items_get(index);
    if (self && self->marker >= 0) rpd_marker_set_color(self->marker, 255, 255, 255);
}

int items_debug_highlighted(void) { return highlighted; }

static void box_add(int index) {
    if (g_box_count >= BOX_SLOTS) return;
    inventory_slot_t *slot = &g_box[g_box_count++];
    const item_t *item = items_get(index);
    slot->filled = true;
    slot->r = item->r; slot->g = item->g; slot->b = item->b;
    slot->item = index;
}

static void inventory_remove(int index) {
    for (int i = 0; i < INVENTORY_SLOTS; i++) {
        if (g_inventory[i].filled && g_inventory[i].item == index) {
            g_inventory[i].filled = false;
            g_inventory[i].item = -1;
            g_inventory_count--;
        }
    }
}

static void preload_box(void) {
    static const int preloaded[] = { 544564, 544574, 544575 };
    for (int i = 0; i < 3; i++) {
        int index = items_index_for_id(preloaded[i]);
        if (index < 0) continue;
        item_t *item = &g_items[index];
        if (item->state != ITEM_PRESENT) continue;
        item->state = ITEM_TAKEN;
        if (item->marker >= 0) rpd_marker_set_visible(item->marker, 0);
        box_add(index);
    }
}

int items_discard(int index) {
    const item_t *item = items_get(index);
    if (!item || item->state != ITEM_TAKEN) return -3;
    if (item_in_inventory(index) < 0) return -4;
    inventory_remove(index);
    return 0;
}

int items_box_store(int index) {
    const item_t *item = items_get(index);
    if (!item || item->state != ITEM_TAKEN) return -3;
    if (item_in_inventory(index) < 0) return -4;
    if (g_box_count >= BOX_SLOTS) return -1;
    inventory_remove(index);
    box_add(index);
    return 0;
}

int items_box_take(int slot) {
    if (slot < 0 || slot >= g_box_count || !g_box[slot].filled) return -3;
    if (g_inventory_count >= INVENTORY_SLOTS) return -1;
    const item_t *item = items_get(g_box[slot].item);
    if (!item) return -3;
    int index = g_box[slot].item;
    g_box[slot].filled = false;
    for (int i = slot; i < g_box_count - 1; i++) g_box[i] = g_box[i + 1];
    g_box[--g_box_count].filled = false;
    place_in_inventory(index);
    return 0;
}

int items_box_count(void) { return g_box_count; }

const inventory_slot_t *items_box(void) { return g_box; }

void items_restore_states(const uint8_t *states, int count) {
    if (!states) return;
    for (int i = 0; i < count && i < items_count(); i++) {
        g_items[i].state = (item_state_t)states[i];
        if (g_items[i].marker >= 0) {
            rpd_marker_set_visible(g_items[i].marker, g_items[i].state == ITEM_PRESENT ? 1 : 0);
        }
    }
}

void items_restore_inventory(int slot, int filled, int item) {
    if (slot < 0 || slot >= INVENTORY_SLOTS) return;
    g_inventory[slot].filled = filled != 0;
    g_inventory[slot].item = item;
    if (g_inventory[slot].filled && item >= 0) {
        const item_t *entry = items_get(item);
        if (entry) {
            g_inventory[slot].r = entry->r;
            g_inventory[slot].g = entry->g;
            g_inventory[slot].b = entry->b;
        }
    }
    g_inventory_count = 0;
    for (int i = 0; i < INVENTORY_SLOTS; i++) if (g_inventory[i].filled) g_inventory_count++;
}

void items_restore_box(int slot, int filled, int item) {
    if (slot < 0 || slot >= BOX_SLOTS) return;
    g_box[slot].filled = filled != 0;
    g_box[slot].item = item;
    if (g_box[slot].filled && item >= 0) {
        const item_t *entry = items_get(item);
        if (entry) {
            g_box[slot].r = entry->r;
            g_box[slot].g = entry->g;
            g_box[slot].b = entry->b;
        }
    }
    g_box_count = 0;
    for (int i = 0; i < BOX_SLOTS; i++) if (g_box[i].filled) g_box_count++;
}

int items_enter_code(int index, const char *entry) {
    if (index < 0 || index >= RPD_ITEM_COUNT || !entry) return -3;
    item_t *item = &g_items[index];
    const rpd_item_def_t *def = item->def;
    if (item->state != ITEM_PRESENT || def->code == NULL) return -3;
    if (items_missing_requirement(index) >= 0) return -2;
    if (items_missing_open(index) >= 0) return -2;
    if (items_missing_external(index) >= 0) return -2;
    if (items_missing_hint(index) >= 0) return -7;
    if (strcmp(def->code, entry) != 0) return -6;
    item->state = ITEM_OPEN;
    reveal_contents(index);
    if (item->marker >= 0) rpd_marker_set_visible(item->marker, 0);
    return 0;
}

const char *items_action_label(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return "";
    if (RPD_ITEM_DEFS[index].external_grant_count > 0) return "FETCH FILM";
    int action = RPD_ITEM_DEFS[index].action;
    if (action < 0 || action > RPD_ACTION_INSPECT) return "";
    return ACTION_VERBS[action];
}

int items_action_kind(int index) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return RPD_ACTION_NONE;
    return RPD_ITEM_DEFS[index].action;
}
