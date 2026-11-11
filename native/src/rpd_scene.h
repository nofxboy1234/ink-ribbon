#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "rpd_math.h"
#include "rpd_sokol.h"

#define MAX_MARKERS 320
#define MAX_SCENE_FLOORS 8

enum {
    MARKER_SPHERE,
    MARKER_CUBE,
    MARKER_PYRAMID,
    MARKER_CYLINDER,
    MARKER_DOOR,
    MARKER_CAPSULE,
    MARKER_SHAPE_COUNT,
};

typedef struct {
    float x, y, z, size;
    float r, g, b;
    float rot;
    int shape;
    bool visible;
} marker_t;

typedef struct {
    int first_index;
    int index_count;
} scene_floor_range_t;

typedef struct {
    bool loaded;
    bool pending;
    bool gpu_ready;
    uint8_t *data;
    size_t size;
    int vertex_count;
    int triangle_count;
    int floor_count;
    scene_floor_range_t floors[MAX_SCENE_FLOORS];
    bounds_t bounds;
    sg_buffer vbuf;
    sg_buffer tri_ibuf;
    sg_buffer marker_vbuf[MARKER_SHAPE_COUNT];
    sg_buffer marker_ibuf[MARKER_SHAPE_COUNT];
    int marker_index_count[MARKER_SHAPE_COUNT];
    sg_pipeline marker_pip;
    sg_pipeline solid_pip;
    sg_pipeline paper_data_pip;
    sg_pipeline glass_pip;
} scene_t;

#define MARKER_FLOOR_ANY (-1.0e30f)

void scene_create_pipelines(scene_t *s);
bool scene_upload(scene_t *s);
void scene_render_floors(scene_t *s, mat4 view_proj, const float eye[3],
                         float camera_distance, float scene_radius, int paper_floor,
                         bool clip, float clip_min, float clip_max, float marker_floor,
                         bool ortho, float ortho_scale);
void scene_render_paper_data(scene_t *s, mat4 view_proj, const float eye[3],
                             int paper_floor, bool clip, float clip_min, float clip_max);
int scene_floor_count(void);
mat4 marker_model(const marker_t *m);
int scene_marker_count(void);
const marker_t *scene_marker(int index);
