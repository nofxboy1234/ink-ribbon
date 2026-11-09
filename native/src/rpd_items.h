#pragma once

#include <stdbool.h>
#include <stdint.h>

#define INVENTORY_SLOTS 8
#define RPD_MAX_REQUIRES 8
#define RPD_MAX_REQUIRES_OPEN 8
#define RPD_MAX_CONTENTS 4
#define RPD_MAX_OPENS 12
#define RPD_MAX_EXTERNAL 2
#define RPD_MAX_HINTS 2
#define RPD_MAX_EXTERNAL_GRANTS 2

// The action a MapGenie category earns. A pickup is carried in one of the
// eight inventory slots; a key item is an ordinary pickup, so keys compete for
// the same slots as ammo and herbs. Read, use and inspect actions record a
// state on the fixture and occupy no slot; unlock and open consume nothing.
typedef enum {
    RPD_ACTION_NONE = 0,
    RPD_ACTION_TAKE,
    RPD_ACTION_UNLOCK,
    RPD_ACTION_OPEN,
    RPD_ACTION_SOLVE,
    RPD_ACTION_READ,
    RPD_ACTION_USE,
    RPD_ACTION_INSPECT,
} rpd_action_t;

typedef enum {
    ITEM_HIDDEN = 0,
    ITEM_PRESENT,
    ITEM_TAKEN,
    ITEM_OPEN,
    ITEM_UNLOCKED,
    ITEM_READ,
    ITEM_INSPECTED,
    ITEM_USED,
} item_state_t;

typedef struct {
    int id;
    const char *title;
    const char *category;
    const char *icon;
    float x, y, z;
    uint8_t floor;
    uint8_t action;
    uint8_t placement;
    uint8_t flags;
    uint8_t blocks;
    int16_t hidden_by;
    int16_t requires[RPD_MAX_REQUIRES];
    uint8_t requires_count;
    int16_t requires_open[RPD_MAX_REQUIRES_OPEN];
    uint8_t requires_open_count;
    int16_t contents[RPD_MAX_CONTENTS];
    uint8_t contents_count;
    int16_t opens[RPD_MAX_OPENS];
    uint8_t opens_count;
    int32_t external_requires[RPD_MAX_EXTERNAL];
    uint8_t external_count;
    const char *code;
    int16_t hints[RPD_MAX_HINTS];
    uint8_t hint_count;
    int32_t external_grants[RPD_MAX_EXTERNAL_GRANTS];
    uint8_t external_grant_count;
} rpd_item_def_t;

typedef struct {
    const rpd_item_def_t *def;
    int index;
    item_state_t state;
    int marker;
    int approach_node;
    float approach_x, approach_y, approach_z;
    int snap_node;
    float snap_x, snap_y, snap_z;
    float r, g, b;
} item_t;

typedef struct {
    bool filled;
    float r, g, b;
    int item;
} inventory_slot_t;

void items_reset(void);
bool items_place(int nav_count, const float *x, const float *y, const float *z,
                 const uint8_t *floor);
void items_sync_markers(void);
void items_set_approach(int index, int node, float x, float y, float z);
int items_count(void);
int items_registry_count(void);
const item_t *items_get(int index);
const rpd_item_def_t *items_def(int index);
void items_cube_position(int index, float out[3]);
int items_at_node(int node);
bool items_node_blocked(int node);
void items_block_cells(int nav_count, uint8_t *blocked);
int items_room(int index);
int items_inventory_count(void);
const inventory_slot_t *items_inventory(void);
int items_take(int index);
int items_act(int index);
int items_available(int index);
int items_hidden(int index);
int items_in_range(int index, float x, float y, float z);
int items_pick(int floor, float x, float z, float radius);
int items_index_for_id(int id);
int items_missing_requirement(int index);
int items_missing_open(int index);
int items_missing_external(int index);
int items_missing_hint(int index);
int items_enter_code(int index, const char *entry);
int items_grant_external(int id);
int items_external_carried(int id);
int items_has_code(int index);
const char *items_action_label(int index);
int items_action_kind(int index);
