#pragma once

#include <stdbool.h>
#include <stdint.h>

#define ITEM_COUNT 9
#define INVENTORY_SLOTS 8

typedef struct {
    float x, y, z;
    float r, g, b;
    int node;
    int room;
    int marker;
    uint8_t floor;
    bool taken;
    const char *name;
} item_t;

typedef struct {
    bool filled;
    float r, g, b;
    int item;
} inventory_slot_t;

void items_reset(void);
bool items_place(int nav_count, const float *x, const float *y, const float *z,
                 const uint8_t *floor, const uint8_t *kind,
                 const int *first, const int *adjacency,
                 int room_count, const float *rx, const float *rz,
                 const uint8_t *rfloor, const float *spawn);
void items_sync_markers(void);
int items_count(void);
const item_t *items_get(int index);
int items_at_node(int node);
bool items_node_blocked(int node);
int items_room(int index);
int items_inventory_count(void);
const inventory_slot_t *items_inventory(void);
int items_take(int index);
