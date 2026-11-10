#pragma once

// The game clock and the debug switch live above the plan. The plan keeps the
// walking; this layer owns the pause and the frame order the later systems use.

void game_reset(void);
void game_update(float dt, const float *view_proj, int width, int height);
void game_set_paused(int paused);
int game_paused(void);
void game_toggle_debug(void);
int game_debug(void);
