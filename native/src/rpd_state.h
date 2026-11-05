#pragma once

#include "rpd_input.h"
#include "rpd_map.h"
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
    bool glass_style;
    bool map_mode;
    bool ortho;
    float ortho_blend;
    float ortho_center[2];
    float ortho_scale;
    float ortho_floor_y;
    float ortho_viewport[2];
    bool ortho_saved;
    float saved_target[3];
    float saved_yaw;
    float saved_pitch;
    float saved_distance;
    map_t map;
    input_t input;
} rpd_state_t;

extern rpd_state_t g_rpd;
