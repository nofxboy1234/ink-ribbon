#include "rpd_save.h"

#include <string.h>

#include "rpd_enemies.h"
#include "rpd_game.h"
#include "rpd_items.h"
#include "rpd_markers.h"
#include "rpd_plan.h"

// Bumped when the image layout changes, so an older slot fails the magic check
// instead of being read with the new field order.
#define SAVE_MAGIC 0x52504454u

int save_size(void) { return RPD_SAVE_BYTES; }

static int write_u8(uint8_t *out, int at, int cap, uint8_t value) {
    if (at < 0 || at >= cap) return -1;
    out[at] = value;
    return at + 1;
}

static int write_i32(uint8_t *out, int at, int cap, int32_t value) {
    if (at < 0 || at + 4 > cap) return -1;
    memcpy(out + at, &value, 4);
    return at + 4;
}

static int write_f32(uint8_t *out, int at, int cap, float value) {
    if (at < 0 || at + 4 > cap) return -1;
    memcpy(out + at, &value, 4);
    return at + 4;
}

typedef struct {
    const uint8_t *data;
    int size;
    int at;
} save_reader_t;

static int read_u8(save_reader_t *r, uint8_t *out) {
    if (r->at >= r->size) return -1;
    *out = r->data[r->at++];
    return 0;
}

static int read_i32(save_reader_t *r, int32_t *out) {
    if (r->at + 4 > r->size) return -1;
    memcpy(out, r->data + r->at, 4);
    r->at += 4;
    return 0;
}

static int read_f32(save_reader_t *r, float *out) {
    if (r->at + 4 > r->size) return -1;
    memcpy(out, r->data + r->at, 4);
    r->at += 4;
    return 0;
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
    at = write_i32(out, at, cap, game_health());
    at = write_i32(out, at, cap, enemies_count());
    for (int i = 0; i < enemies_count(); i++) {
        enemy_state_t enemy;
        if (enemies_state(i, &enemy) != 0) return -1;
        at = write_f32(out, at, cap, enemy.x);
        at = write_f32(out, at, cap, enemy.y);
        at = write_f32(out, at, cap, enemy.z);
        at = write_i32(out, at, cap, enemy.floor);
        at = write_i32(out, at, cap, enemy.health);
        at = write_u8(out, at, cap, enemy.alive ? 1 : 0);
    }
    return at < 0 ? -1 : 0;
}

int save_restore(const uint8_t *data, int size) {
    if (!data) return -1;
    save_reader_t r = { data, size, 0 };
    int32_t magic = 0;
    if (read_i32(&r, &magic) != 0) return -1;
    if (magic != (int32_t)SAVE_MAGIC) return -2;
    int32_t count = 0;
    if (read_i32(&r, &count) != 0) return -3;
    if (count != items_count() || r.at + count > r.size) return -3;
    items_restore_states(data + r.at, count);
    r.at += count;
    int32_t invCount = 0;
    if (read_i32(&r, &invCount) != 0) return -3;
    (void)invCount;
    for (int i = 0; i < INVENTORY_SLOTS; i++) {
        uint8_t filled = 0;
        int32_t item = -1;
        if (read_u8(&r, &filled) != 0 || read_i32(&r, &item) != 0) return -3;
        items_restore_inventory(i, filled, item);
    }
    int32_t boxCount = 0;
    if (read_i32(&r, &boxCount) != 0) return -3;
    (void)boxCount;
    for (int i = 0; i < BOX_SLOTS; i++) {
        uint8_t filled = 0;
        int32_t item = -1;
        if (read_u8(&r, &filled) != 0 || read_i32(&r, &item) != 0) return -3;
        items_restore_box(i, filled, item);
    }
    float px = 0, py = 0, pz = 0;
    int32_t floor = 0;
    int32_t health = 0;
    if (read_f32(&r, &px) != 0 || read_f32(&r, &py) != 0 || read_f32(&r, &pz) != 0) return -3;
    if (read_i32(&r, &floor) != 0 || read_i32(&r, &health) != 0) return -3;
    int32_t enemyCount = 0;
    if (read_i32(&r, &enemyCount) != 0) return -3;
    if (enemyCount != enemies_count()) return -3;
    for (int i = 0; i < enemyCount; i++) {
        enemy_state_t enemy;
        uint8_t alive = 0;
        if (read_f32(&r, &enemy.x) != 0 || read_f32(&r, &enemy.y) != 0 ||
            read_f32(&r, &enemy.z) != 0 || read_i32(&r, &enemy.floor) != 0 ||
            read_i32(&r, &enemy.health) != 0 || read_u8(&r, &alive) != 0) return -3;
        enemy.alive = alive ? 1 : 0;
        enemies_set_state(i, &enemy);
    }
    plan_set_floor(floor);
    plan_set_player(px, py, pz);
    plan_refresh_blocks();
    game_set_health(health);
    // markers_ensure_player clears the shared pool, so invalidate every
    // producer's cached index and rebuild the item markers after the player.
    enemies_reset_markers();
    items_reset_markers();
    markers_ensure_player(px, py, pz);
    items_sync_markers();
    return 0;
}
