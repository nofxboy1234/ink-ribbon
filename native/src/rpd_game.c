#include "rpd_game.h"

#include "rpd_plan.h"

static int paused;
static int debug;

void game_reset(void) {
    paused = 0;
    debug = 0;
}

void game_set_paused(int value) { paused = value ? 1 : 0; }

int game_paused(void) { return paused; }

void game_toggle_debug(void) { debug = !debug; }

int game_debug(void) { return debug; }

void game_update(float dt, const float *view_proj, int width, int height) {
    // A zero delta freezes the walk but still refreshes the hover and the floor,
    // so the paused map stays inspectable.
    plan_update(paused ? 0.0f : dt, view_proj, width, height);
}
