#pragma once

#include "rpd_scene.h"

void markers_create(scene_t *s);
void markers_ensure_player(float x, float y, float z);
void markers_set_player(float x, float y, float z);
void markers_render(scene_t *s, mat4 view_proj, const float eye[3]);
