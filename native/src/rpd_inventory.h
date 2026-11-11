#pragma once

#include <stdbool.h>

// Internal seam between the item state machine and the inventory/box store.
// rpd_items.c owns the item states; rpd_inventory.c owns the eight carried
// slots and the global item box.
int inventory_slot_for(int index);
int inventory_place(int index);
void inventory_remove(int index);
void inventory_box_add(int index);
void items_inventory_reset(void);
void items_preload_box(void);
void items_mark_taken(int index);
