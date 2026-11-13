#pragma once

#include <stdint.h>

#define MAP_MAX_FLOORS 3
#define MAP_MAX_ROOMS 160
#define MAP_MAX_VERTS 4096
#define MAP_MAX_TRIS 8192
#define MAP_MAX_DOORS 128
#define MAP_MAX_ITEMS 512
#define MAP_MAX_STAIRS 64

typedef struct { float x, z; } map_vec2;
typedef struct { int start, count, state; } map_room;
typedef struct { int a, b, c, room; } map_tri;
typedef struct { float x, z, yaw; uint32_t key; int flags; } map_door;
typedef struct { float x, z; uint32_t id; int room; uint32_t colour; int flags; } map_item;
typedef struct { float x, z; int to; } map_stair;

typedef struct {
    int used;
    float level;
    int room_count, vert_count, tri_count;
    map_room rooms[MAP_MAX_ROOMS];
    map_vec2 verts[MAP_MAX_VERTS];
    map_tri tris[MAP_MAX_TRIS];
    int door_count;
    map_door doors[MAP_MAX_DOORS];
    int item_count;
    map_item items[MAP_MAX_ITEMS];
    int stair_count;
    map_stair stairs[MAP_MAX_STAIRS];
} map_floor_t;

int map_load(const uint8_t *data, int size);
int map_loaded(void);
int map_floor_count(void);
const map_floor_t *map_get(int floor);
void map_update(int floor, float x, float z);
int map_room_state(int floor, int room);
int map_door_state(int floor, int door);
int map_floor_revealed(int floor);
int map_room_state_at(int floor, float x, float z);
int map_room_index_at(int floor, float x, float z);
void map_mark_visited(int floor, float x, float z);
