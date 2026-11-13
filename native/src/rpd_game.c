#include "rpd_game.h"

#include "rpd_enemies.h"
#include "rpd_plan.h"

static int paused;
static int debug;
static int debug_allowed = 1;
static int health = 120;
static int running;
static int ending;

void game_reset(void) {
    paused = 0;
    debug = 0;
    health = 120;
    running = 0;
    ending = 0;
}

int game_health(void) { return health; }

void game_set_health(int value) { health = value < 0 ? 0 : value; }

void game_damage(int amount) {
    health -= amount;
    if (health < 0) health = 0;
}

int game_shoot(int enemy, int stationary) {
    // Prototype B: the shot resolves instantly. A stationary shot is reliable;
    // a moving shot halves the damage chance.
    if (enemy < 0) return -1;
    const int hit = stationary ? 1 : 0;
    if (!hit) return 0;
    return enemies_hit(enemy, 12);
}

int game_stab(int enemy) {
    if (enemy < 0) return -1;
    return enemies_hit(enemy, 18);
}

void game_set_paused(int value) { paused = value ? 1 : 0; }

int game_paused(void) { return paused; }

void game_toggle_debug(void) {
    if (!debug_allowed) return;
    debug = !debug;
}

int game_debug(void) { return debug && debug_allowed; }

void game_set_debug_allowed(int value) {
    debug_allowed = value ? 1 : 0;
    if (!debug_allowed) debug = 0;
}

void game_toggle_pause(void) { paused = !paused; }

void game_toggle_run(void) { running = !running; }

void game_set_run(int on) { running = on ? 1 : 0; }

int game_run(void) { return running; }

void game_set_ending(int value) { ending = value ? 1 : 0; }

int game_ending(void) { return ending; }

void game_update(float dt, const float *view_proj, int width, int height) {
    // A zero delta freezes the walk but still refreshes the hover and the floor,
    // so the paused map stays inspectable.
    plan_update(paused ? 0.0f : dt * (plan_move_run() ? 2.0f : 1.0f), view_proj, width, height);
}
