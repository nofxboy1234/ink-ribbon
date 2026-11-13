#include "rpd_map.h"

#include <string.h>

#include "rpd_items.h"

static map_floor_t floors[MAP_MAX_FLOORS];
static int floor_count;
static int loaded;
static unsigned char visited[MAP_MAX_FLOORS][MAP_MAX_ROOMS];
static unsigned char discovered[MAP_MAX_FLOORS][MAP_MAX_DOORS];
static unsigned char unlocked[MAP_MAX_FLOORS][MAP_MAX_DOORS];

static uint32_t read_u32(const uint8_t **at) {
    uint32_t value = 0;
    memcpy(&value, *at, 4);
    *at += 4;
    return value;
}

static float read_f32(const uint8_t **at) {
    float value = 0.0f;
    memcpy(&value, *at, 4);
    *at += 4;
    return value;
}

int map_load(const uint8_t *data, int size) {
    loaded = 0;
    floor_count = 0;
    memset(floors, 0, sizeof(floors));
    memset(visited, 0, sizeof(visited));
    memset(discovered, 0, sizeof(discovered));
    memset(unlocked, 0, sizeof(unlocked));
    if (!data || size < 12) return -1;
    if (memcmp(data, "R2M1", 4) != 0) return -2;
    const uint8_t *at = data + 4;
    const uint8_t *end = data + size;
    if (read_u32(&at) != 2) return -3;
    uint32_t count = read_u32(&at);
    if (count > MAP_MAX_FLOORS) return -4;
    for (uint32_t f = 0; f < count; f++) {
        map_floor_t *fl = &floors[f];
        if (at + 4 > end) return -5;
        fl->used = 1;
        fl->level = read_f32(&at);
        if (at + 12 > end) return -5;
        uint32_t rooms = read_u32(&at);
        uint32_t verts = read_u32(&at);
        uint32_t tris = read_u32(&at);
        if (rooms > MAP_MAX_ROOMS || verts > MAP_MAX_VERTS || tris > MAP_MAX_TRIS) return -4;
        fl->room_count = (int)rooms;
        fl->vert_count = (int)verts;
        fl->tri_count = (int)tris;
        if (at + rooms * 12 > end) return -5;
        for (uint32_t r = 0; r < rooms; r++) {
            fl->rooms[r].start = (int)read_u32(&at);
            fl->rooms[r].count = (int)read_u32(&at);
            fl->rooms[r].state = (int)read_u32(&at);
        }
        if (at + verts * 8 > end) return -5;
        for (uint32_t v = 0; v < verts; v++) {
            fl->verts[v].x = read_f32(&at);
            fl->verts[v].z = read_f32(&at);
        }
        if (at + tris * 16 > end) return -5;
        for (uint32_t t = 0; t < tris; t++) {
            fl->tris[t].a = (int)read_u32(&at);
            fl->tris[t].b = (int)read_u32(&at);
            fl->tris[t].c = (int)read_u32(&at);
            fl->tris[t].room = (int)read_u32(&at);
        }
        if (at + 4 > end) return -5;
        uint32_t doors = read_u32(&at);
        if (doors > MAP_MAX_DOORS || at + doors * 20 > end) return -5;
        fl->door_count = (int)doors;
        for (uint32_t d = 0; d < doors; d++) {
            fl->doors[d].x = read_f32(&at);
            fl->doors[d].z = read_f32(&at);
            fl->doors[d].yaw = read_f32(&at);
            fl->doors[d].key = read_u32(&at);
            fl->doors[d].flags = (int)read_u32(&at);
        }
        if (at + 4 > end) return -5;
        uint32_t items = read_u32(&at);
        if (items > MAP_MAX_ITEMS || at + items * 24 > end) return -5;
        fl->item_count = (int)items;
        for (uint32_t i = 0; i < items; i++) {
            fl->items[i].x = read_f32(&at);
            fl->items[i].z = read_f32(&at);
            fl->items[i].id = read_u32(&at);
            fl->items[i].room = (int)read_u32(&at);
            fl->items[i].colour = read_u32(&at);
            fl->items[i].flags = (int)read_u32(&at);
        }
        if (at + 4 > end) return -5;
        uint32_t stairs = read_u32(&at);
        if (stairs > MAP_MAX_STAIRS || at + stairs * 12 > end) return -5;
        fl->stair_count = (int)stairs;
        for (uint32_t s = 0; s < stairs; s++) {
            fl->stairs[s].x = read_f32(&at);
            fl->stairs[s].z = read_f32(&at);
            fl->stairs[s].to = (int)read_u32(&at);
        }
    }
    floor_count = (int)count;
    loaded = 1;
    return 0;
}

int map_loaded(void) { return loaded; }

int map_floor_count(void) { return floor_count; }

const map_floor_t *map_get(int floor) {
    if (!loaded || floor < 0 || floor >= floor_count) return 0;
    return &floors[floor];
}

static int inventory_has(uint32_t id) {
    if (id == 0) return 0;
    int index = items_index_for_id((int)id);
    if (index < 0) return 0;
    const inventory_slot_t *slots = items_inventory();
    for (int i = 0; i < INVENTORY_SLOTS; i++) {
        if (slots[i].filled && slots[i].item == index) return 1;
    }
    return 0;
}

static int point_in_room(const map_floor_t *f, int room, float x, float z) {
    const map_room *r = &f->rooms[room];
    int inside = 0;
    for (int i = 0; i < r->count; i++) {
        const map_vec2 *a = &f->verts[r->start + i];
        const map_vec2 *b = &f->verts[r->start + (i + 1) % r->count];
        if ((a->z > z) != (b->z > z) && x < (b->x - a->x) * (z - a->z) / (b->z - a->z) + a->x) inside = !inside;
    }
    return inside;
}

void map_update(int floor, float x, float z) {
    const map_floor_t *f = map_get(floor);
    if (!f) return;
    for (int r = 0; r < f->room_count; r++) {
        if (!visited[floor][r] && point_in_room(f, r, x, z)) visited[floor][r] = 1;
    }
    for (int i = 0; i < f->item_count; i++) {
        const map_item *item = &f->items[i];
        if (item->id == 0) continue;
        int index = items_index_for_id((int)item->id);
        if (index < 0) continue;
        const item_t *entry = items_get(index);
        if (!entry || entry->state != ITEM_PRESENT) continue;
        int action = items_action_kind(index);
        if (action != RPD_ACTION_TAKE && action != RPD_ACTION_READ) continue;
        float dx = item->x - x;
        float dz = item->z - z;
        if (dx * dx + dz * dz <= 0.64f) items_act(index);
    }
    {
        int notebook = items_index_for_id(544441);
        int box = items_index_for_id(544404);
        int knife = items_index_for_id(544445);
        if (notebook >= 0 && box >= 0 && knife >= 0) {
            const item_t *nb = items_get(notebook);
            const item_t *kn = items_get(knife);
            const rpd_item_def_t *bd = items_def(box);
            if (nb && kn && bd && nb->state >= ITEM_TAKEN &&
                (kn->state == ITEM_HIDDEN || kn->state == ITEM_PRESENT)) {
                float dx = x - bd->x;
                float dz = z - bd->z;
                if (dx * dx + dz * dz <= 2.25f) items_debug_take(knife);
            }
        }
    }
    for (int d = 0; d < f->door_count; d++) {
        const map_door *door = &f->doors[d];
        float dx = door->x - x;
        float dz = door->z - z;
        if (dx * dx + dz * dz > 4.0f) continue;
        if (!discovered[floor][d]) {
            discovered[floor][d] = 1;
            unlocked[floor][d] = (unsigned char)(door->key == 0 || inventory_has(door->key));
        }
    }
}

int map_room_state(int floor, int room) {
    const map_floor_t *f = map_get(floor);
    if (!f || room < 0 || room >= f->room_count || !visited[floor][room]) return 0;
    for (int i = 0; i < f->item_count; i++) {
        const map_item *item = &f->items[i];
        if (item->room != room || item->id == 0) continue;
        int index = items_index_for_id((int)item->id);
        const item_t *entry = index >= 0 ? items_get(index) : 0;
        if (entry && entry->state == ITEM_PRESENT) return 1;
    }
    return 2;
}

int map_floor_revealed(int floor) {
    if (floor < 0) return 0;
    int id = floor == 0 ? 544458 : 544498;
    int index = items_index_for_id(id);
    const item_t *item = index >= 0 ? items_get(index) : 0;
    return item && item->state >= ITEM_TAKEN;
}

int map_door_state(int floor, int door) {
    const map_floor_t *f = map_get(floor);
    if (!f || door < 0 || door >= f->door_count) return 0;
    if (!discovered[floor][door]) return 0;
    return unlocked[floor][door] ? 2 : 1;
}

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
EMSCRIPTEN_KEEPALIVE int rpd_map_load(const unsigned char *data, int size) {
    return map_load((const uint8_t *)data, size);
}

EMSCRIPTEN_KEEPALIVE int rpd_map_floor_revealed(int floor) {
    return map_floor_revealed(floor);
}

EMSCRIPTEN_KEEPALIVE int rpd_map_door_info(int floor, float *out, int cap) {
    const map_floor_t *f = map_get(floor);
    if (!f || !out || cap < 4) return 0;
    int count = 0;
    for (int d = 0; d < f->door_count && (count + 1) * 4 <= cap; d++) {
        out[count * 4 + 0] = f->doors[d].x;
        out[count * 4 + 1] = f->doors[d].z;
        out[count * 4 + 2] = (float)f->doors[d].key;
        out[count * 4 + 3] = (float)map_door_state(floor, d);
        count++;
    }
    return count;
}
#endif
