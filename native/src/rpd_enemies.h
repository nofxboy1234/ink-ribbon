#pragma once

// Simplified RE2 enemies. They only act while the player moves or acts, so the
// game reads as a real-time / turn-based hybrid. The markers are capsules:
// zombies red, dogs blue and horizontal, Mr X yellow and larger.
void enemies_reset(void);
void enemies_update(int player_acted, float player_x, float player_y, float player_z, int floor);
int enemies_count(void);
int enemies_alive(void);
int enemies_hit(int index, int damage);
int enemies_health(int index);
int enemies_visible(int index);
