#include "rpd_map.h"

#include <string.h>

static map_floor_t floors[MAP_MAX_FLOORS];
static int floor_count;
static int loaded;

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
    if (!data || size < 12) return -1;
    if (memcmp(data, "R2M1", 4) != 0) return -2;
    const uint8_t *at = data + 4;
    const uint8_t *end = data + size;
    if (read_u32(&at) != 1) return -3;
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
            fl->doors[d].state = (int)read_u32(&at);
            fl->doors[d].flags = (int)read_u32(&at);
        }
        if (at + 4 > end) return -5;
        uint32_t items = read_u32(&at);
        if (items > MAP_MAX_ITEMS || at + items * 16 > end) return -5;
        fl->item_count = (int)items;
        for (uint32_t i = 0; i < items; i++) {
            fl->items[i].x = read_f32(&at);
            fl->items[i].z = read_f32(&at);
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

const map_floor_t *map_get(int floor) {
    if (!loaded || floor < 0 || floor >= floor_count) return 0;
    return &floors[floor];
}

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
EMSCRIPTEN_KEEPALIVE int rpd_map_load(const unsigned char *data, int size) {
    return map_load((const uint8_t *)data, size);
}
#endif
