#pragma once

#include "rpd_scene.h"

void markers_create(scene_t *s);
void markers_render(scene_t *s, mat4 view_proj, const float eye[3]);
