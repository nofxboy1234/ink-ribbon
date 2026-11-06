#include "rpd_items.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_markers.h"

typedef struct {
    int node;
    float distance;
} item_candidate_t;

static item_t g_items[ITEM_COUNT];
static inventory_slot_t g_inventory[INVENTORY_SLOTS];
static int g_inventory_count;
static bool g_placed;

static const unsigned char ITEM_COLOURS[ITEM_COUNT][3] = {
    { 255, 85, 85 },
    { 80, 250, 123 },
    { 98, 114, 164 },
    { 139, 233, 253 },
    { 189, 147, 249 },
    { 255, 121, 198 },
    { 241, 250, 140 },
    { 255, 184, 108 },
    { 248, 248, 242 },
};

static const char *ITEM_NAMES[ITEM_COUNT] = {
    "RED SPHERE",
    "GREEN SPHERE",
    "BLUE SPHERE",
    "CYAN SPHERE",
    "PURPLE SPHERE",
    "PINK SPHERE",
    "YELLOW SPHERE",
    "ORANGE SPHERE",
    "WHITE SPHERE",
};

static int compare_candidate(const void *a, const void *b) {
    const item_candidate_t *ca = (const item_candidate_t *)a;
    const item_candidate_t *cb = (const item_candidate_t *)b;
    if (ca->distance < cb->distance) return -1;
    if (ca->distance > cb->distance) return 1;
    return ca->node - cb->node;
}

static int node_degree(const int *first, int node) {
    return first[node + 1] - first[node];
}

void items_reset(void) {
    memset(g_items, 0, sizeof(g_items));
    memset(g_inventory, 0, sizeof(g_inventory));
    g_inventory_count = 0;
    g_placed = false;
    for (int i = 0; i < ITEM_COUNT; i++) {
        g_items[i].node = -1;
        g_items[i].room = -1;
        g_items[i].marker = -1;
    }
}

bool items_place(int nav_count, const float *x, const float *y, const float *z,
                 const uint8_t *floor, const uint8_t *kind,
                 const int *first, const int *adjacency,
                 int room_count, const float *rx, const float *rz,
                 const uint8_t *rfloor, const float *spawn) {
    (void)adjacency;
    if (g_placed) return true;
    if (nav_count <= 0 || room_count <= 0) return false;

    int room_order[64];
    int room_total = room_count < 64 ? room_count : 64;
    int picked_rooms = 0;
    for (int i = 0; i < room_count; i++) {
        if (rfloor[i] != 0) continue;
        float dx = rx[i] - spawn[0];
        float dz = rz[i] - spawn[2];
        float distance = dx * dx + dz * dz;
        int at = picked_rooms;
        while (at > 0) {
            int prev = room_order[at - 1];
            float pdx = rx[prev] - spawn[0];
            float pdz = rz[prev] - spawn[2];
            if (pdx * pdx + pdz * pdz <= distance) break;
            room_order[at] = prev;
            at--;
        }
        if (at < room_total) {
            room_order[at] = i;
            picked_rooms++;
            if (picked_rooms > room_total) picked_rooms = room_total;
            if (picked_rooms > 3) picked_rooms = 3;
        }
    }
    if (picked_rooms < 3) return false;

    unsigned char *used = (unsigned char *)calloc((size_t)nav_count, sizeof(unsigned char));
    item_candidate_t *candidates = (item_candidate_t *)malloc(sizeof(item_candidate_t) * (size_t)nav_count);
    if (!used || !candidates) {
        free(used);
        free(candidates);
        return false;
    }

    int spawn_node = -1;
    float spawn_best = 1e30f;
    for (int i = 0; i < nav_count; i++) {
        if (floor[i] != 0) continue;
        float dx = x[i] - spawn[0];
        float dz = z[i] - spawn[2];
        float d = dx * dx + dz * dz;
        if (d < spawn_best) { spawn_best = d; spawn_node = i; }
    }
    if (spawn_node >= 0) used[spawn_node] = 1;

    int item_index = 0;
    for (int r = 0; r < 3 && item_index < ITEM_COUNT; r++) {
        int room = room_order[r];
        int count = 0;
        for (int i = 0; i < nav_count; i++) {
            if (floor[i] != 0 || kind[i] != 0 || used[i]) continue;
            float dx = x[i] - rx[room];
            float dz = z[i] - rz[room];
            candidates[count].node = i;
            candidates[count].distance = dx * dx + dz * dz;
            count++;
        }
        qsort(candidates, (size_t)count, sizeof(item_candidate_t), compare_candidate);

        int placed_in_room = 0;
        for (int pass = 0; pass < 3 && placed_in_room < 3; pass++) {
            float separation = pass == 0 ? 2.0f : (pass == 1 ? 1.1f : 0.0f);
            int min_degree = pass == 0 ? 3 : 2;
            for (int c = 0; c < count && placed_in_room < 3; c++) {
                int node = candidates[c].node;
                if (used[node]) continue;
                if (node_degree(first, node) < min_degree) continue;
                bool too_close = false;
                for (int p = 0; p < item_index; p++) {
                    if (g_items[p].room != room) continue;
                    float dx = x[node] - g_items[p].x;
                    float dz = z[node] - g_items[p].z;
                    if (dx * dx + dz * dz < separation * separation) {
                        too_close = true;
                        break;
                    }
                }
                if (too_close) continue;
                used[node] = 1;
                item_t *item = &g_items[item_index];
                item->x = x[node];
                item->y = y[node] + 0.48f;
                item->z = z[node];
                item->node = node;
                item->room = room;
                item->floor = floor[node];
                item->marker = -1;
                item->taken = false;
                item->name = ITEM_NAMES[item_index];
                item->r = (float)ITEM_COLOURS[item_index][0] / 255.0f;
                item->g = (float)ITEM_COLOURS[item_index][1] / 255.0f;
                item->b = (float)ITEM_COLOURS[item_index][2] / 255.0f;
                item_index++;
                placed_in_room++;
            }
        }
    }

    free(used);
    free(candidates);
    if (item_index < ITEM_COUNT) return false;
    g_placed = true;
    return true;
}

void items_sync_markers(void) {
    if (!g_placed) return;
    for (int i = 0; i < ITEM_COUNT; i++) {
        item_t *item = &g_items[i];
        if (item->taken) {
            if (item->marker >= 0) rpd_marker_set_visible(item->marker, 0);
            continue;
        }
        item->marker = rpd_marker_add(MARKER_SPHERE, item->x, item->y, item->z, 0.9f,
                                      ITEM_COLOURS[i][0], ITEM_COLOURS[i][1], ITEM_COLOURS[i][2]);
    }
}

int items_count(void) { return g_placed ? ITEM_COUNT : 0; }

const item_t *items_get(int index) {
    if (index < 0 || index >= ITEM_COUNT) return NULL;
    return &g_items[index];
}

int items_at_node(int node) {
    if (!g_placed) return -1;
    for (int i = 0; i < ITEM_COUNT; i++) {
        if (!g_items[i].taken && g_items[i].node == node) return i;
    }
    return -1;
}

bool items_node_blocked(int node) {
    return items_at_node(node) >= 0;
}

int items_room(int index) {
    if (index < 0 || index >= ITEM_COUNT) return -1;
    return g_items[index].room;
}

int items_inventory_count(void) { return g_inventory_count; }

const inventory_slot_t *items_inventory(void) { return g_inventory; }

int items_take(int index) {
    if (index < 0 || index >= ITEM_COUNT || g_items[index].taken) return -2;
    if (g_inventory_count >= INVENTORY_SLOTS) return -1;
    int slot = 0;
    while (slot < INVENTORY_SLOTS && g_inventory[slot].filled) slot++;
    if (slot >= INVENTORY_SLOTS) return -1;
    item_t *item = &g_items[index];
    g_inventory[slot].filled = true;
    g_inventory[slot].r = item->r;
    g_inventory[slot].g = item->g;
    g_inventory[slot].b = item->b;
    g_inventory[slot].item = index;
    g_inventory_count++;
    item->taken = true;
    if (item->marker >= 0) rpd_marker_set_visible(item->marker, 0);
    return 0;
}
