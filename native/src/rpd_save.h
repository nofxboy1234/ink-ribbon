#pragma once

#include <stdint.h>

// A save is a flat byte image of the state the acceptance run needs to resume:
// the item states, the inventory, the box, the external grants, the player, the
// floor, the health and the enemies. The client owns the slots and the storage.
#define RPD_SAVE_BYTES 8192

int save_snapshot(uint8_t *out, int cap);
int save_restore(const uint8_t *data, int size);
int save_size(void);
