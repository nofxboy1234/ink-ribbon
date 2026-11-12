#pragma once

#include "rpd_input.h"
#include "rpd_math.h"
#include "rpd_scene.h"
#include "rpd_sokol.h"
#include "rpd_target.h"

typedef struct {
    sg_pass_action pass_action;
    target_t target;
    scene_t scene;
    camera_t camera;
    orbit_anim_t orbit;
    float scene_radius;
    bool map_mode;
    input_t input;
} rpd_state_t;

extern rpd_state_t g_rpd;
