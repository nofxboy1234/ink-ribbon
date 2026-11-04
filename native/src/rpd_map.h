#pragma once

#include "rpd_scene.h"

typedef struct {
    sg_pipeline pip;
    sg_buffer vbuf;
    int vertex_count;
    float camera[4];
    float viewport[4];
} map_t;

void map_create_pipeline(map_t *m);
void map_render(map_t *m, scene_t *s);
