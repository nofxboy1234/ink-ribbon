#pragma once

#include "rpd_scene.h"

void markers_create(scene_t *s);
void markers_ensure_player(float x, float y, float z);
void markers_set_player(float x, float y, float z);
int rpd_marker_add(int shape, float x, float y, float z, float size, int r, int g, int b);
void rpd_marker_set_visible(int index, int visible);
void rpd_marker_set_color(int index, int r, int g, int b);
void rpd_marker_set_rotation(int index, float radians);
void markers_render(scene_t *s, mat4 view_proj, const float eye[3], float marker_floor,
                    bool ortho, float ortho_scale);
