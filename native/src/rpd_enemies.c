#include "rpd_enemies.h"

#include <math.h>

#include "rpd_markers.h"

#define MAX_ENEMIES 8
#define ENEMY_SIGHT 9.0f

typedef struct {
    int kind;      /* 0 zombie, 1 dog, 2 mr x */
    int floor;
    float x, y, z;
    float home_x, home_z;
    int health;
    int max_health;
    int state;     /* 0 idle, 1 chase, 2 downed */
    int marker;
} enemy_t;

static enemy_t enemies[MAX_ENEMIES] = {
    { 0, 0, 2.5f, 0.0f, -3.0f, 2.5f, -3.0f, 100, 100, 0, -1 },
    { 0, 0, 12.0f, 0.0f, -12.0f, 12.0f, -12.0f, 100, 100, 0, -1 },
    { 1, 0, -10.0f, 0.0f, 8.0f, -10.0f, 8.0f, 45, 45, 0, -1 },
    { 0, 1, 16.0f, 5.0f, -18.0f, 16.0f, -18.0f, 100, 100, 0, -1 },
    { 1, 1, 16.0f, 5.0f, -12.0f, 16.0f, -12.0f, 45, 45, 0, -1 },
    { 0, 2, 0.0f, 10.0f, 0.0f, 0.0f, 0.0f, 100, 100, 0, -1 },
    { 2, 0, -20.0f, 0.0f, -20.0f, -20.0f, -20.0f, 999, 999, 0, -1 },
    { 1, 2, -6.0f, 10.0f, 4.0f, -6.0f, 4.0f, 45, 45, 0, -1 },
};

static int count = MAX_ENEMIES;

void enemies_reset(void) {
    count = MAX_ENEMIES;
    for (int i = 0; i < count; i++) {
        enemy_t *e = &enemies[i];
        e->x = e->home_x;
        e->z = e->home_z;
        e->health = e->max_health;
        e->state = 0;
        e->marker = -1;
    }
}

static void ensure_marker(enemy_t *e) {
    if (e->marker >= 0) return;
    if (e->kind == 0) {
        e->marker = rpd_marker_add(MARKER_CAPSULE, e->x, e->y + 0.85f, e->z, 1.7f, 220, 45, 45);
    } else if (e->kind == 1) {
        e->marker = rpd_marker_add(MARKER_CAPSULE, e->x, e->y + 0.35f, e->z, 1.2f, 55, 110, 230);
        if (e->marker >= 0) rpd_marker_set_rotation(e->marker, 1.5707963f);
    } else {
        e->marker = rpd_marker_add(MARKER_CAPSULE, e->x, e->y + 1.4f, e->z, 3.2f, 235, 210, 60);
    }
}

void enemies_reset_markers(void) {
    for (int i = 0; i < count; i++) enemies[i].marker = -1;
}

void enemies_update(int player_acted, float player_x, float player_y, float player_z, int floor) {
    for (int i = 0; i < count; i++) {
        enemy_t *e = &enemies[i];
        ensure_marker(e);
        if (e->marker < 0) continue;
        const int same_floor = e->floor == floor;
        const float dx = player_x - e->x;
        const float dz = player_z - e->z;
        const float distance = sqrtf(dx * dx + dz * dz);
        const int visible = e->state != 2 && same_floor && distance <= ENEMY_SIGHT;
        rpd_marker_set_visible(e->marker, visible ? 1 : 0);
        if (!visible || !player_acted) continue;
        if (e->kind != 2 && distance > 1.5f) {
            const float step = (e->kind == 1 ? 0.22f : 0.08f) * (e->kind == 2 ? 0.14f : 1.0f);
            const float len = fmaxf(distance, 0.001f);
            e->x += dx / len * step;
            e->z += dz / len * step;
        }
        rpd_marker_set_position(e->marker, e->x, e->y + (e->kind == 2 ? 1.4f : 0.85f), e->z);
    }
}

int enemies_state(int index, enemy_state_t *out) {
    if (index < 0 || index >= count || !out) return -1;
    const enemy_t *e = &enemies[index];
    out->x = e->x;
    out->y = e->y;
    out->z = e->z;
    out->floor = e->floor;
    out->health = e->health;
    out->alive = e->state != 2;
    return 0;
}

void enemies_set_state(int index, const enemy_state_t *state) {
    if (index < 0 || index >= count || !state) return;
    enemy_t *e = &enemies[index];
    e->x = state->x;
    e->y = state->y;
    e->z = state->z;
    e->floor = state->floor;
    e->health = state->health;
    // An enemy is live only when the save says alive and has health, so the two
    // flags cannot disagree about visibility.
    e->state = state->alive && state->health > 0 ? 0 : 2;
}

int enemies_count(void) { return count; }

void enemies_position(int index, float *out) {
    if (!out || index < 0 || index >= count) return;
    out[0] = enemies[index].x; out[1] = enemies[index].y; out[2] = enemies[index].z;
}

int enemies_alive(void) {
    int alive = 0;
    for (int i = 0; i < count; i++) if (enemies[i].health > 0) alive++;
    return alive;
}

int enemies_hit(int index, int damage) {
    if (index < 0 || index >= count) return -1;
    enemy_t *e = &enemies[index];
    if (e->health <= 0) return -1;
    e->health -= damage;
    if (e->health <= 0) {
        e->state = 2;
        rpd_marker_set_visible(e->marker, 0);
    }
    return e->health;
}

int enemies_health(int index) {
    if (index < 0 || index >= count) return -1;
    return enemies[index].health;
}

int enemies_visible(int index) {
    if (index < 0 || index >= count) return 0;
    return enemies[index].state != 2;
}
