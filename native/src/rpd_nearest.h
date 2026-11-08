#pragma once

#include <stdint.h>

float nearest_dist2(float ax, float ay, float az, float bx, float by, float bz);
int nearest_floor_node(int count, const float *x, const float *y, const float *z,
                       const uint8_t *floor, const uint8_t *blocked, int floor_index,
                       float px, float py, float pz, float max_distance);
int nearest_room_index(int count, const float *x, const float *y, const float *z,
                       const uint8_t *floor, int player_floor,
                       float px, float py, float pz);
