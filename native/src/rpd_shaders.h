#pragma once

#include "rpd_math.h"

typedef struct {
    mat4 view_proj;
} vs_params_t;

typedef struct {
    float camera[4];
    float fog[4];
    float clip[4];
} fs_params_t;

typedef struct {
    mat4 view_proj;
    mat4 model;
} marker_vs_params_t;

typedef struct {
    float camera[4];
    float color[4];
} marker_fs_params_t;

typedef struct {
    float camera[4];
    float viewport[4];
} map_params_t;

extern const char *vs_source;
extern const char *solid_fs_source;
extern const char *marker_vs_source;
extern const char *marker_fs_source;
extern const char *composite_vs_source;
extern const char *composite_fs_source;
