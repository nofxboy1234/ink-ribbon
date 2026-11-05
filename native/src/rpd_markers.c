#include "rpd_markers.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_shaders.h"
#include "rpd_state.h"

EMSCRIPTEN_KEEPALIVE void rpd_marker_clear(void);
EMSCRIPTEN_KEEPALIVE int rpd_marker_add(int shape, float x, float y, float z, float size, int r, int g, int b);
EMSCRIPTEN_KEEPALIVE void rpd_set_player_position(float x, float y, float z);

static marker_t g_markers[MAX_MARKERS];
static int g_marker_count;

static uint8_t *marker_vertex(uint8_t *p, float x, float y, float z, float nx, float ny, float nz) {
    memcpy(p, &x, 4); memcpy(p + 4, &y, 4); memcpy(p + 8, &z, 4);
    memcpy(p + 12, &nx, 4); memcpy(p + 16, &ny, 4); memcpy(p + 20, &nz, 4);
    return p + 24;
}

static void upload_marker_shape(scene_t *s, int shape, const uint8_t *verts, int vcount, const uint32_t *idx, int icount, const char *label) {
    s->marker_vbuf[shape] = sg_make_buffer(&(sg_buffer_desc){
        .size = (size_t)vcount * 24,
        .data = { .ptr = verts, .size = (size_t)vcount * 24 },
        .label = label,
    });
    s->marker_ibuf[shape] = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .index_buffer = true },
        .size = (size_t)icount * sizeof(uint32_t),
        .data = { .ptr = idx, .size = (size_t)icount * sizeof(uint32_t) },
        .label = label,
    });
    s->marker_index_count[shape] = icount;
}

static void create_markers(scene_t *s) {
    {
        const int seg = 16, ring = 8;
        const int vc = (ring + 1) * (seg + 1);
        const int ic = ring * seg * 6;
        uint8_t *verts = (uint8_t *)malloc((size_t)vc * 24);
        uint32_t *idx = (uint32_t *)malloc((size_t)ic * sizeof(uint32_t));
        uint8_t *p = verts;
        for (int r = 0; r <= ring; r++) {
            float phi = (float)r / (float)ring * RPD_PI;
            float sp = sinf(phi), cp = cosf(phi);
            for (int c = 0; c <= seg; c++) {
                float theta = (float)c / (float)seg * 2.0f * RPD_PI;
                float nx = sp * cosf(theta), ny = cp, nz = sp * sinf(theta);
                p = marker_vertex(p, 0.5f * nx, 0.5f * ny, 0.5f * nz, nx, ny, nz);
            }
        }
        int k = 0;
        for (int r = 0; r < ring; r++) {
            for (int c = 0; c < seg; c++) {
                uint32_t a = (uint32_t)(r * (seg + 1) + c);
                uint32_t b = a + 1;
                uint32_t d = a + (uint32_t)(seg + 1);
                uint32_t e = d + 1;
                idx[k++] = a; idx[k++] = d; idx[k++] = b;
                idx[k++] = b; idx[k++] = d; idx[k++] = e;
            }
        }
        upload_marker_shape(s, MARKER_SPHERE, verts, vc, idx, ic, "marker-sphere");
        free(verts);
        free(idx);
    }
    {
        static const float n[6][3] = {
            { 1, 0, 0 }, { -1, 0, 0 }, { 0, 1, 0 }, { 0, -1, 0 }, { 0, 0, 1 }, { 0, 0, -1 },
        };
        static const float u[6][3] = {
            { 0, 0, -1 }, { 0, 0, 1 }, { 1, 0, 0 }, { 1, 0, 0 }, { 1, 0, 0 }, { 1, 0, 0 },
        };
        static const float v[6][3] = {
            { 0, 1, 0 }, { 0, 1, 0 }, { 0, 0, -1 }, { 0, 0, 1 }, { 0, 1, 0 }, { 0, -1, 0 },
        };
        uint8_t *verts = (uint8_t *)malloc(24 * 24);
        uint32_t *idx = (uint32_t *)malloc(36 * sizeof(uint32_t));
        uint8_t *p = verts;
        int k = 0;
        for (int f = 0; f < 6; f++) {
            for (int c = 0; c < 4; c++) {
                float su = (c == 0 || c == 3) ? -1.0f : 1.0f;
                float sv = (c < 2) ? -1.0f : 1.0f;
                p = marker_vertex(
                    p,
                    0.5f * (n[f][0] + su * u[f][0] + sv * v[f][0]),
                    0.5f * (n[f][1] + su * u[f][1] + sv * v[f][1]),
                    0.5f * (n[f][2] + su * u[f][2] + sv * v[f][2]),
                    n[f][0], n[f][1], n[f][2]
                );
            }
            uint32_t base = (uint32_t)(f * 4);
            idx[k++] = base; idx[k++] = base + 1; idx[k++] = base + 2;
            idx[k++] = base; idx[k++] = base + 2; idx[k++] = base + 3;
        }
        upload_marker_shape(s, MARKER_CUBE, verts, 24, idx, 36, "marker-cube");
        free(verts);
        free(idx);
    }
    {
        const int segments = 12;
        const int vc = 2 + segments * 4;
        const int ic = segments * 12;
        uint8_t *verts = (uint8_t *)malloc((size_t)vc * 24);
        uint32_t *idx = (uint32_t *)malloc((size_t)ic * sizeof(uint32_t));
        uint8_t *p = verts;
        p = marker_vertex(p, 0.0f, 0.5f, 0.0f, 0.0f, 1.0f, 0.0f);
        p = marker_vertex(p, 0.0f, -0.5f, 0.0f, 0.0f, -1.0f, 0.0f);
        for (int i = 0; i < segments; i++) {
            float a = (float)i / (float)segments * 2.0f * RPD_PI;
            p = marker_vertex(p, 0.5f * cosf(a), 0.5f, 0.5f * sinf(a), 0.0f, 1.0f, 0.0f);
        }
        for (int i = 0; i < segments; i++) {
            float a = (float)i / (float)segments * 2.0f * RPD_PI;
            p = marker_vertex(p, 0.5f * cosf(a), -0.5f, 0.5f * sinf(a), 0.0f, -1.0f, 0.0f);
        }
        for (int i = 0; i < segments; i++) {
            float a = (float)i / (float)segments * 2.0f * RPD_PI;
            p = marker_vertex(p, 0.5f * cosf(a), 0.5f, 0.5f * sinf(a), cosf(a), 0.0f, sinf(a));
            p = marker_vertex(p, 0.5f * cosf(a), -0.5f, 0.5f * sinf(a), cosf(a), 0.0f, sinf(a));
        }
        int k = 0;
        const uint32_t top_ring = 2;
        const uint32_t bottom_ring = 2 + segments;
        const uint32_t side_top = 2 + segments * 2;
        const uint32_t side_bottom = 2 + segments * 3;
        for (int i = 0; i < segments; i++) {
            uint32_t nxt = (uint32_t)((i + 1) % segments);
            uint32_t i0 = (uint32_t)i;
            idx[k++] = 0; idx[k++] = top_ring + i0; idx[k++] = top_ring + nxt;
            idx[k++] = 1; idx[k++] = bottom_ring + nxt; idx[k++] = bottom_ring + i0;
            idx[k++] = side_top + i0; idx[k++] = side_bottom + i0; idx[k++] = side_top + nxt;
            idx[k++] = side_top + nxt; idx[k++] = side_bottom + i0; idx[k++] = side_bottom + nxt;
        }
        upload_marker_shape(s, MARKER_CYLINDER, verts, vc, idx, ic, "marker-cylinder");
        free(verts);
        free(idx);
    }
    {
        static const float base[4][3] = {
            { -0.5f, -0.5f, -0.5f }, { 0.5f, -0.5f, -0.5f },
            { 0.5f, -0.5f, 0.5f }, { -0.5f, -0.5f, 0.5f },
        };
        static const float apex[3] = { 0.0f, 0.5f, 0.0f };
        uint8_t *verts = (uint8_t *)malloc(24 * 24);
        uint32_t *idx = (uint32_t *)malloc(24 * sizeof(uint32_t));
        uint8_t *p = verts;
        // Four side faces, then the base.
        for (int f = 0; f < 4; f++) {
            const float *a = base[f];
            const float *b = base[(f + 1) % 4];
            float nx = 0.0f, ny = 0.0f, nz = 0.0f;
            float ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
            float vx = apex[0] - a[0], vy = apex[1] - a[1], vz = apex[2] - a[2];
            nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx;
            float len = sqrtf(nx * nx + ny * ny + nz * nz);
            nx /= len; ny /= len; nz /= len;
            p = marker_vertex(p, a[0], a[1], a[2], nx, ny, nz);
            p = marker_vertex(p, b[0], b[1], b[2], nx, ny, nz);
            p = marker_vertex(p, apex[0], apex[1], apex[2], nx, ny, nz);
        }
        for (int f = 0; f < 4; f++) {
            p = marker_vertex(p, base[f][0], base[f][1], base[f][2], 0.0f, -1.0f, 0.0f);
        }
        int k = 0;
        for (int f = 0; f < 4; f++) {
            uint32_t b = (uint32_t)(f * 3);
            idx[k++] = b; idx[k++] = b + 1; idx[k++] = b + 2;
        }
        uint32_t b = 12;
        idx[k++] = b; idx[k++] = b + 2; idx[k++] = b + 1;
        idx[k++] = b; idx[k++] = b + 3; idx[k++] = b + 2;
        upload_marker_shape(s, MARKER_PYRAMID, verts, 16, idx, 24, "marker-pyramid");
        free(verts);
        free(idx);
    }
    // The door shape reuses the cube; its model matrix squashes it.
    s->marker_vbuf[MARKER_DOOR] = s->marker_vbuf[MARKER_CUBE];
    s->marker_ibuf[MARKER_DOOR] = s->marker_ibuf[MARKER_CUBE];
    s->marker_index_count[MARKER_DOOR] = s->marker_index_count[MARKER_CUBE];
    {
        // Unit capsule: radius 0.25, total height 1.0, centred on the origin.
        const int seg = 20, hemi = 6;
        const int rings = 2 * hemi + 2;
        const int vc = rings * (seg + 1);
        const int ic = (rings - 1) * seg * 6;
        uint8_t *verts = (uint8_t *)malloc((size_t)vc * 24);
        uint32_t *idx = (uint32_t *)malloc((size_t)ic * sizeof(uint32_t));
        uint8_t *p = verts;
        float radius = 0.25f;
        float cylinder = 0.25f;
        for (int r = 0; r < rings; r++) {
            float y, rr, ny, nr;
            if (r <= hemi) {
                float phi = (float)r / (float)hemi * RPD_PI * 0.5f;
                y = cylinder + radius * cosf(phi);
                rr = radius * sinf(phi);
                ny = cosf(phi); nr = sinf(phi);
            } else if (r == hemi + 1) {
                y = -cylinder; rr = radius; ny = 0.0f; nr = 1.0f;
            } else {
                float psi = (float)(r - hemi - 1) / (float)hemi * RPD_PI * 0.5f;
                y = -cylinder - radius * sinf(psi);
                rr = radius * cosf(psi);
                ny = -sinf(psi); nr = cosf(psi);
            }
            for (int c = 0; c <= seg; c++) {
                float theta = (float)c / (float)seg * 2.0f * RPD_PI;
                float nx = nr * cosf(theta), nz = nr * sinf(theta);
                p = marker_vertex(p, rr * cosf(theta), y, rr * sinf(theta), nx, ny, nz);
            }
        }
        int k = 0;
        for (int r = 0; r < rings - 1; r++) {
            for (int c = 0; c < seg; c++) {
                uint32_t a = (uint32_t)(r * (seg + 1) + c);
                uint32_t b = a + 1;
                uint32_t d = a + (uint32_t)(seg + 1);
                uint32_t e = d + 1;
                idx[k++] = a; idx[k++] = d; idx[k++] = b;
                idx[k++] = b; idx[k++] = d; idx[k++] = e;
            }
        }
        upload_marker_shape(s, MARKER_CAPSULE, verts, vc, idx, ic, "marker-capsule");
        free(verts);
        free(idx);
    }
}

mat4 marker_model(const marker_t *m) {
    mat4 out = { 0 };
    float sx = m->size, sy = m->size, sz = m->size;
    if (m->shape == MARKER_DOOR) {
        sx = 1.15f; sy = 2.15f; sz = 0.18f;
    }
    float c = cosf(m->rot), s = sinf(m->rot);
    out.m[0] = c * sx;
    out.m[2] = -s * sx;
    out.m[5] = sy;
    out.m[8] = s * sz;
    out.m[10] = c * sz;
    out.m[12] = m->x;
    out.m[13] = m->y;
    out.m[14] = m->z;
    out.m[15] = 1.0f;
    return out;
}

void markers_create(scene_t *s) {
    create_markers(s);
}

void markers_render(scene_t *s, mat4 view_proj, const float eye[3]) {
    if (g_marker_count <= 0) return;
    sg_apply_pipeline(s->marker_pip);
    marker_fs_params_t mf = { 0 };
    mf.camera[0] = eye[0]; mf.camera[1] = eye[1]; mf.camera[2] = eye[2];
    for (int i = 0; i < g_marker_count; i++) {
        const marker_t *m = &g_markers[i];
        if (!m->visible) continue;
        if (m->shape < 0 || m->shape >= MARKER_SHAPE_COUNT) continue;
        if (s->marker_index_count[m->shape] <= 0) continue;
        marker_vs_params_t mv = { view_proj, marker_model(m) };
        mf.color[0] = m->r; mf.color[1] = m->g; mf.color[2] = m->b; mf.color[3] = 1.0f;
        sg_apply_bindings(&(sg_bindings){
            .vertex_buffers[0] = s->marker_vbuf[m->shape],
            .index_buffer = s->marker_ibuf[m->shape],
        });
        sg_apply_uniforms(0, &(sg_range){ &mv, sizeof(mv) });
        sg_apply_uniforms(1, &(sg_range){ &mf, sizeof(mf) });
        sg_draw(0, s->marker_index_count[m->shape], 1);
    }
}

int scene_marker_count(void) {
    return g_marker_count;
}

const marker_t *scene_marker(int index) {
    if (index < 0 || index >= g_marker_count) return NULL;
    return &g_markers[index];
}

void markers_ensure_player(float x, float y, float z) {
    rpd_marker_clear();
    rpd_marker_add(MARKER_CAPSULE, x, y, z, 1.7f, 255, 121, 198);
    rpd_set_player_position(x, y, z);
}

void markers_set_player(float x, float y, float z) {
    rpd_set_player_position(x, y, z);
}

EMSCRIPTEN_KEEPALIVE void rpd_set_player_position(float x, float y, float z) {
    if (g_marker_count > 0) {
        float lift = 0.0f;
        if (g_markers[0].shape == MARKER_CAPSULE) {
            // Keep the capsule standing on the floor rather than centred on it.
            lift = 0.5f * g_markers[0].size - 0.02f;
        }
        g_markers[0].x = x;
        g_markers[0].y = y + lift;
        g_markers[0].z = z;
    }
}

EMSCRIPTEN_KEEPALIVE void rpd_marker_clear(void) {
    g_marker_count = 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_marker_add(int shape, float x, float y, float z, float size, int r, int g, int b) {
    if (g_marker_count >= MAX_MARKERS) return -1;
    if (shape < 0 || shape >= MARKER_SHAPE_COUNT) return -1;
    marker_t *m = &g_markers[g_marker_count];
    m->shape = shape;
    m->x = x; m->y = y; m->z = z;
    m->size = size;
    m->r = (float)r / 255.0f;
    m->g = (float)g / 255.0f;
    m->b = (float)b / 255.0f;
    m->rot = 0.0f;
    m->visible = true;
    return g_marker_count++;
}

EMSCRIPTEN_KEEPALIVE void rpd_marker_set_visible(int index, int visible) {
    if (index < 0 || index >= g_marker_count) return;
    g_markers[index].visible = visible != 0;
}

EMSCRIPTEN_KEEPALIVE void rpd_marker_set_position(int index, float x, float y, float z) {
    if (index < 0 || index >= g_marker_count) return;
    g_markers[index].x = x;
    g_markers[index].y = y;
    g_markers[index].z = z;
}

EMSCRIPTEN_KEEPALIVE void rpd_marker_set_rotation(int index, float radians) {
    if (index < 0 || index >= g_marker_count) return;
    g_markers[index].rot = radians;
}

EMSCRIPTEN_KEEPALIVE void rpd_marker_set_color(int index, int r, int g, int b) {
    if (index < 0 || index >= g_marker_count) return;
    g_markers[index].r = (float)r / 255.0f;
    g_markers[index].g = (float)g / 255.0f;
    g_markers[index].b = (float)b / 255.0f;
}

EMSCRIPTEN_KEEPALIVE int rpd_marker_count(void) {
    return g_marker_count;
}
