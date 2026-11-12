#pragma once

// Simplified RE2 enemies. They only act while the player moves or acts, so the
// game reads as a real-time / turn-based hybrid. The markers are capsules:
// zombies red, dogs blue and horizontal, Mr X yellow and larger.
typedef struct {
    float x, y, z;
    int floor;
    int health;
    int alive;
} enemy_state_t;

void enemies_reset(void);
void enemies_reset_markers(void);
int enemies_state(int index, enemy_state_t *out);
void enemies_set_state(int index, const enemy_state_t *state);
void enemies_update(int player_acted, float player_x, float player_y, float player_z, int floor);
int enemies_count(void);
int enemies_alive(void);
int enemies_hit(int index, int damage);
int enemies_health(int index);
int enemies_visible(int index);
void enemies_position(int index, float *out);
