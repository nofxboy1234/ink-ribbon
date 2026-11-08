#pragma once

#include <stdint.h>

void item_gate_refresh(int nav_count, const float *nav_x, const float *nav_z,
                       const uint8_t *nav_floor, uint8_t *blocked);
void item_gate_retarget(int nav_count, const float *nav_x, const float *nav_y,
                        const float *nav_z, const uint8_t *nav_floor,
                        const uint8_t *blocked);
int item_gate_blocked_count(int index, int nav_count, const float *nav_x,
                            const float *nav_z, const uint8_t *nav_floor,
                            const uint8_t *blocked);
