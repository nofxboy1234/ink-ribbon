#include "rpd_item_gate.h"

#include <string.h>

#include "rpd_items.h"
#include "rpd_nearest.h"
#include "rpd_item_registry.h"

static int item_blocks_route(int index) {
    const item_t *item = items_get(index);
    if (!item || !item->def->blocks) return 0;
    item_state_t state = item->state;
    return state != ITEM_OPEN && state != ITEM_UNLOCKED && state != ITEM_TAKEN && state != ITEM_USED;
}

void item_gate_refresh(int nav_count, const float *nav_x, const float *nav_z,
                       const uint8_t *nav_floor, uint8_t *blocked) {
    memset(blocked, 0, (size_t)nav_count);
    float radius = RPD_ITEM_BLOCK_RADIUS;
    for (int i = 0; i < items_count(); i++) {
        if (!item_blocks_route(i)) continue;
        const rpd_item_def_t *def = items_def(i);
        for (int n = 0; n < nav_count; n++) {
            if (nav_floor[n] != def->floor) continue;
            float dx = nav_x[n] - def->x;
            float dz = nav_z[n] - def->z;
            if (dx * dx + dz * dz <= radius * radius) blocked[n] = 1;
        }
    }
}

void item_gate_retarget(int nav_count, const float *nav_x, const float *nav_y,
                        const float *nav_z, const uint8_t *nav_floor,
                        const uint8_t *blocked) {
    for (int i = 0; i < items_count(); i++) {
        const item_t *item = items_get(i);
        if (!item || !item->def->blocks) continue;
        if (item->approach_node >= 0 && !blocked[item->approach_node]) continue;
        int node = nearest_floor_node(nav_count, nav_x, nav_y, nav_z, nav_floor, blocked,
                                      item->def->floor, item->def->x, item->def->y,
                                      item->def->z, 8.0f);
        if (node >= 0) items_set_approach(i, node, nav_x[node], nav_y[node], nav_z[node]);
    }
}

int item_gate_blocked_count(int index, int nav_count, const float *nav_x,
                            const float *nav_z, const uint8_t *nav_floor,
                            const uint8_t *blocked) {
    if (index < 0 || index >= RPD_ITEM_COUNT) return 0;
    const rpd_item_def_t *def = &RPD_ITEM_DEFS[index];
    float radius = RPD_ITEM_BLOCK_RADIUS;
    int count = 0;
    for (int n = 0; n < nav_count; n++) {
        if (!blocked[n] || nav_floor[n] != def->floor) continue;
        float dx = nav_x[n] - def->x;
        float dz = nav_z[n] - def->z;
        if (dx * dx + dz * dz <= radius * radius) count += 1;
    }
    return count;
}
