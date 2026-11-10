#include "rpd_save.h"

#include <string.h>

#include "rpd_items.h"
#include "rpd_plan.h"

#define SAVE_MAGIC 0x52504453u

int save_size(void) { return RPD_SAVE_BYTES; }

static int write_u8(uint8_t *out, int at, int cap, uint8_t value) {
    if (at >= cap) return -1;
    out[at] = value;
    return at + 1;
}

static int write_i32(uint8_t *out, int at, int cap, int32_t value) {
    if (at + 4 > cap) return -1;
    memcpy(out + at, &value, 4);
    return at + 4;
}

static int write_f32(uint8_t *out, int at, int cap, float value) {
    if (at + 4 > cap) return -1;
    memcpy(out + at, &value, 4);
    return at + 4;
}

int save_snapshot(uint8_t *out, int cap) {
    if (!out || cap < RPD_SAVE_BYTES) return -1;
    memset(out, 0, RPD_SAVE_BYTES);
    int at = 0;
    at = write_i32(out, at, cap, (int32_t)SAVE_MAGIC);
    at = write_i32(out, at, cap, items_count());
    for (int i = 0; i < items_count(); i++) {
        const item_t *item = items_get(i);
        at = write_u8(out, at, cap, (uint8_t)item->state);
    }
    at = write_i32(out, at, cap, items_inventory_count());
    const inventory_slot_t *inv = items_inventory();
    for (int i = 0; i < INVENTORY_SLOTS; i++) {
        at = write_u8(out, at, cap, inv[i].filled ? 1 : 0);
        at = write_i32(out, at, cap, inv[i].item);
    }
    at = write_i32(out, at, cap, items_box_count());
    const inventory_slot_t *box = items_box();
    for (int i = 0; i < BOX_SLOTS; i++) {
        at = write_u8(out, at, cap, box[i].filled ? 1 : 0);
        at = write_i32(out, at, cap, box[i].item);
    }
    float player[3];
    plan_player(player);
    at = write_f32(out, at, cap, player[0]);
    at = write_f32(out, at, cap, player[1]);
    at = write_f32(out, at, cap, player[2]);
    at = write_i32(out, at, cap, plan_active_floor());
    return 0;
}

int save_restore(const uint8_t *data, int size) {
    if (!data || size < 16) return -1;
    int at = 0;
    int32_t magic = 0;
    int32_t count = 0;
    memcpy(&magic, data + at, 4); at += 4;
    if (magic != (int32_t)SAVE_MAGIC) return -2;
    memcpy(&count, data + at, 4); at += 4;
    if (count != items_count() || at + count > size) return -3;
    items_restore_states(data + at, count);
    at += count;
    int32_t invCount = 0;
    memcpy(&invCount, data + at, 4); at += 4;
    (void)invCount;
    for (int i = 0; i < INVENTORY_SLOTS; i++) {
        const uint8_t filled = data[at++];
        int32_t item = -1;
        memcpy(&item, data + at, 4); at += 4;
        items_restore_inventory(i, filled, item);
    }
    int32_t boxCount = 0;
    memcpy(&boxCount, data + at, 4); at += 4;
    (void)boxCount;
    for (int i = 0; i < BOX_SLOTS; i++) {
        const uint8_t filled = data[at++];
        int32_t item = -1;
        memcpy(&item, data + at, 4); at += 4;
        items_restore_box(i, filled, item);
    }
    float px = 0, py = 0, pz = 0;
    memcpy(&px, data + at, 4); at += 4;
    memcpy(&py, data + at, 4); at += 4;
    memcpy(&pz, data + at, 4); at += 4;
    int32_t floor = 0;
    memcpy(&floor, data + at, 4); at += 4;
    plan_set_floor(floor);
    plan_set_player(px, py, pz);
    plan_refresh_blocks();
    return 0;
}
