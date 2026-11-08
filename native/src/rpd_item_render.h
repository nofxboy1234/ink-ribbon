#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "rpd_math.h"

void item_render_create_pipelines(void);
bool item_render_upload(const uint8_t *data, size_t size);
void item_render_tick(void);
int item_render_last_error(void);
void item_render_texture(int material, const uint8_t *rgba, int width, int height);
int item_render_material_count(void);
const char *item_render_material_albedo(int material);
int item_render_model_count(void);
void item_render_models(mat4 view_proj, const float eye[3], bool ortho, int floor,
                        bool clip, float clip_min, float clip_max);
void item_render_stats(float *out);
