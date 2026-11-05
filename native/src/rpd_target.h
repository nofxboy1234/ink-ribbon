#pragma once

#include <stdbool.h>

#include "rpd_sokol.h"

typedef struct {
    sg_image color;
    sg_image normal;
    sg_image linear;
    sg_image depth;
    sg_view color_att;
    sg_view normal_att;
    sg_view linear_att;
    sg_view depth_att;
    sg_view tex_view;
    sg_view normal_tex_view;
    sg_view linear_tex_view;
    sg_sampler sampler;
    sg_pass pass;
    sg_pipeline pip;
    sg_buffer quad;
    int width;
    int height;
    bool dirty;
} target_t;

void target_destroy(target_t *t);
void target_create(target_t *t, int width, int height);
void target_create_composite(target_t *t);
void target_composite(target_t *t, const sg_pass_action *action);
