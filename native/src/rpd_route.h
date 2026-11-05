#include <stdint.h>

#pragma once

int route_filter_diagonals(int count, const float *x, const float *z, const uint8_t *floor,
                           const int *first, const int *adjacency, const float *cost,
                           int **out_first, int **out_adjacency, float **out_cost);

int route_find_path(int count, const float *x, const float *y, const float *z,
                    const int *first, const int *adjacency, const float *cost,
                    const uint8_t *blocked, int start, int goal, int *out, int cap);

int route_smooth(int count, const int *nodes,
                 const float *x, const float *y, const float *z,
                 float lift, float *out, int cap);
