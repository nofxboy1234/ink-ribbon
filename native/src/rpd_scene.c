#include "rpd_scene.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_shaders.h"
#include "rpd_state.h"

#define RPD_VERSION 3u
#define RPD_HEADER_SIZE 100

static marker_t g_markers[MAX_MARKERS];
static int g_marker_count;

static sg_pipeline make_pipeline(sg_shader shader) {
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = 16;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.layout.attrs[1].format = SG_VERTEXFORMAT_UBYTE4N;
    pd.primitive_type = SG_PRIMITIVETYPE_TRIANGLES;
    pd.index_type = SG_INDEXTYPE_UINT32;
    pd.cull_mode = SG_CULLMODE_NONE;
    pd.face_winding = SG_FACEWINDING_CCW;
    pd.sample_count = 1;
    pd.depth.compare = SG_COMPAREFUNC_ALWAYS;
    pd.depth.write_enabled = false;
    pd.colors[0].blend.enabled = true;
    pd.colors[0].blend.src_factor_rgb = SG_BLENDFACTOR_SRC_ALPHA;
    pd.colors[0].blend.dst_factor_rgb = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    pd.colors[0].blend.op_rgb = SG_BLENDOP_ADD;
    pd.colors[0].blend.src_factor_alpha = SG_BLENDFACTOR_ONE;
    pd.colors[0].blend.dst_factor_alpha = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    pd.colors[0].blend.op_alpha = SG_BLENDOP_ADD;
    return sg_make_pipeline(&pd);
}

static sg_pipeline make_solid_pipeline(sg_shader shader) {
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = 16;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.layout.attrs[1].format = SG_VERTEXFORMAT_UBYTE4N;
    pd.primitive_type = SG_PRIMITIVETYPE_TRIANGLES;
    pd.index_type = SG_INDEXTYPE_UINT32;
    pd.cull_mode = SG_CULLMODE_NONE;
    pd.face_winding = SG_FACEWINDING_CCW;
    pd.sample_count = 1;
    pd.depth.compare = SG_COMPAREFUNC_LESS_EQUAL;
    pd.depth.write_enabled = true;
    pd.label = "solid-pipeline";
    return sg_make_pipeline(&pd);
}

static sg_pipeline make_marker_pipeline(sg_shader shader) {
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = 24;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.layout.attrs[1].format = SG_VERTEXFORMAT_FLOAT3;
    pd.primitive_type = SG_PRIMITIVETYPE_TRIANGLES;
    pd.index_type = SG_INDEXTYPE_UINT32;
    pd.cull_mode = SG_CULLMODE_NONE;
    pd.face_winding = SG_FACEWINDING_CCW;
    pd.sample_count = 1;
    pd.depth.compare = SG_COMPAREFUNC_LESS_EQUAL;
    pd.depth.write_enabled = true;
    pd.label = "marker-pipeline";
    return sg_make_pipeline(&pd);
}

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

bool scene_upload(scene_t *s) {
    if (!s->data || s->size < RPD_HEADER_SIZE) return false;
    const uint8_t *p = s->data;
    if (memcmp(p, "RPDW", 4) != 0) return false;
    if (*(const uint32_t *)(p + 4) != RPD_VERSION) return false;
    uint32_t chunk_count = *(const uint32_t *)(p + 8);
    uint32_t total_v = *(const uint32_t *)(p + 12);
    uint32_t total_t = *(const uint32_t *)(p + 16);
    uint32_t floor_count = *(const uint32_t *)(p + 20);
    if (floor_count != 3 || total_v == 0 || total_t == 0) return false;
    const float *hb = (const float *)(p + 28);
    s->bounds.min[0] = hb[0]; s->bounds.min[1] = hb[1]; s->bounds.min[2] = hb[2];
    s->bounds.max[0] = hb[3]; s->bounds.max[1] = hb[4]; s->bounds.max[2] = hb[5];

    size_t vbytes = (size_t)total_v * 16;
    size_t ibytes = (size_t)total_t * 3 * sizeof(uint32_t);
    uint8_t *vbuf = (uint8_t *)malloc(vbytes);
    uint32_t *ibuf = (uint32_t *)malloc(ibytes);
    if (!vbuf || !ibuf) { free(vbuf); free(ibuf); return false; }

    size_t off = RPD_HEADER_SIZE;
    size_t vbase = 0;
    size_t ibase = 0;
    for (uint32_t c = 0; c < chunk_count; c++) {
        if (off + 32 > s->size) goto fail;
        const uint32_t nv = *(const uint32_t *)(p + off + 0);
        const uint32_t ni = *(const uint32_t *)(p + off + 4);
        const uint32_t fl = *(const uint32_t *)(p + off + 8);
        (void)fl;
        const float ox = *(const float *)(p + off + 16);
        const float oy = *(const float *)(p + off + 20);
        const float oz = *(const float *)(p + off + 24);
        const float scale = *(const float *)(p + off + 28);
        off += 32;
        if (vbase + nv > total_v || ibase + ni > (size_t)total_t * 3) goto fail;
        if (off + (size_t)nv * 6 + (size_t)nv * 3 + (size_t)ni * 2 > s->size) goto fail;
        const uint16_t *q = (const uint16_t *)(p + off);
        off += (size_t)nv * 6;
        const uint8_t *col = p + off;
        off += (size_t)nv * 3;
        const uint16_t *idx = (const uint16_t *)(p + off);
        off += (size_t)ni * 2;
        for (uint32_t i = 0; i < nv; i++) {
            float x = ox + (float)q[i * 3 + 0] * scale;
            float y = oy + (float)q[i * 3 + 1] * scale;
            float z = oz + (float)q[i * 3 + 2] * scale;
            uint8_t *v = vbuf + (vbase + i) * 16;
            memcpy(v, &x, 4); memcpy(v + 4, &y, 4); memcpy(v + 8, &z, 4);
            v[12] = col[i * 3 + 0];
            v[13] = col[i * 3 + 1];
            v[14] = col[i * 3 + 2];
            v[15] = 255;
        }
        for (uint32_t i = 0; i < ni; i++) ibuf[ibase + i] = (uint32_t)(vbase + idx[i]);
        vbase += nv;
        ibase += ni;
        off = (off + 3) & ~(size_t)3;
    }
    if (vbase != total_v || ibase != (size_t)total_t * 3) goto fail;

    s->vertex_count = (int)total_v;
    s->triangle_count = (int)total_t;
    s->vbuf = sg_make_buffer(&(sg_buffer_desc){
        .size = vbytes,
        .data = { .ptr = vbuf, .size = vbytes },
        .label = "rpd-vertices",
    });
    s->tri_ibuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .index_buffer = true },
        .size = ibytes,
        .data = { .ptr = ibuf, .size = ibytes },
        .label = "rpd-triangles",
    });
    free(vbuf);
    free(ibuf);
    if (sg_query_buffer_state(s->vbuf) != SG_RESOURCESTATE_VALID ||
        sg_query_buffer_state(s->tri_ibuf) != SG_RESOURCESTATE_VALID) return false;
    create_markers(s);
    s->gpu_ready = true;
    s->loaded = true;
    return true;
fail:
    free(vbuf);
    free(ibuf);
    return false;
}

void scene_create_pipelines(scene_t *s) {
    sg_shader_desc sd;
    memset(&sd, 0, sizeof(sd));
    sd.vertex_func.source = vs_source;
    sd.vertex_func.entry = "main";
    sd.fragment_func.source = fs_source;
    sd.fragment_func.entry = "main";
    sd.attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[0].glsl_name = "position";
    sd.attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[1].glsl_name = "color";
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
    sd.uniform_blocks[0].size = sizeof(vs_params_t);
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view_proj";
    sd.uniform_blocks[1].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.uniform_blocks[1].size = sizeof(fs_params_t);
    sd.uniform_blocks[1].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[1].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[0].glsl_name = "u_camera";
    sd.uniform_blocks[1].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[1].glsl_name = "u_fog";
    sd.uniform_blocks[1].glsl_uniforms[2].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[2].glsl_name = "u_clip";
    sg_shader glass_shd = sg_make_shader(&sd);
    s->pip = make_pipeline(glass_shd);

    memset(&sd, 0, sizeof(sd));
    sd.vertex_func.source = vs_source;
    sd.vertex_func.entry = "main";
    sd.fragment_func.source = solid_fs_source;
    sd.fragment_func.entry = "main";
    sd.attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[0].glsl_name = "position";
    sd.attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[1].glsl_name = "color";
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
    sd.uniform_blocks[0].size = sizeof(vs_params_t);
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view_proj";
    sd.uniform_blocks[1].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.uniform_blocks[1].size = sizeof(fs_params_t);
    sd.uniform_blocks[1].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[1].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[0].glsl_name = "u_camera";
    sd.uniform_blocks[1].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[1].glsl_name = "u_fog";
    sd.uniform_blocks[1].glsl_uniforms[2].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[2].glsl_name = "u_clip";
    sg_shader solid_shd = sg_make_shader(&sd);
    s->solid_pip = make_solid_pipeline(solid_shd);

    memset(&sd, 0, sizeof(sd));
    sd.vertex_func.source = marker_vs_source;
    sd.vertex_func.entry = "main";
    sd.fragment_func.source = marker_fs_source;
    sd.fragment_func.entry = "main";
    sd.attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[0].glsl_name = "position";
    sd.attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[1].glsl_name = "normal";
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
    sd.uniform_blocks[0].size = sizeof(marker_vs_params_t);
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view_proj";
    sd.uniform_blocks[0].glsl_uniforms[1].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[1].glsl_name = "u_model";
    sd.uniform_blocks[1].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.uniform_blocks[1].size = sizeof(marker_fs_params_t);
    sd.uniform_blocks[1].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[1].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[0].glsl_name = "u_camera";
    sd.uniform_blocks[1].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[1].glsl_name = "u_color";
    sg_shader marker_shd = sg_make_shader(&sd);
    s->marker_pip = make_marker_pipeline(marker_shd);
}

void scene_render(scene_t *s, const camera_t *cam, float scene_radius, bool glass_style) {
    float eye[3], aim[3];
    camera_eye(cam, eye);
    memcpy(aim, cam->target, sizeof(aim));
    float camera_distance = cam->distance;
    float fog_start = camera_distance - scene_radius * 0.55f;
    float fog_end = camera_distance + scene_radius * 1.15f;
    float up[3] = { 0.0f, 1.0f, 0.0f };
    mat4 proj = mat4_perspective(0.62f, (float)sapp_width() / (float)sapp_height(), 0.2f, 1600.0f);
    mat4 view = mat4_look_at(eye, aim, up);
    vs_params_t vs = { .view_proj = mat4_mul(proj, view) };
    fs_params_t fs = { 0 };
    fs.camera[0] = eye[0]; fs.camera[1] = eye[1]; fs.camera[2] = eye[2]; fs.camera[3] = fog_start;
    fs.fog[0] = fog_end;
    sg_apply_pipeline(glass_style ? s->pip : s->solid_pip);
    sg_apply_bindings(&(sg_bindings){
        .vertex_buffers[0] = s->vbuf,
        .index_buffer = s->tri_ibuf,
    });
    sg_apply_uniforms(0, &(sg_range){ &vs, sizeof(vs) });
    sg_apply_uniforms(1, &(sg_range){ &fs, sizeof(fs) });
    sg_draw(0, s->triangle_count * 3, 1);
    if (g_marker_count > 0) {
        sg_apply_pipeline(s->marker_pip);
        marker_fs_params_t mf = { 0 };
        mf.camera[0] = eye[0]; mf.camera[1] = eye[1]; mf.camera[2] = eye[2];
        for (int i = 0; i < g_marker_count; i++) {
            const marker_t *m = &g_markers[i];
            if (!m->visible) continue;
            if (m->shape < 0 || m->shape >= MARKER_SHAPE_COUNT) continue;
            if (s->marker_index_count[m->shape] <= 0) continue;
            marker_vs_params_t mv = { vs.view_proj, marker_model(m) };
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
}

int scene_marker_count(void) {
    return g_marker_count;
}

const marker_t *scene_marker(int index) {
    if (index < 0 || index >= g_marker_count) return NULL;
    return &g_markers[index];
}

EMSCRIPTEN_KEEPALIVE int rpd_load_scene(const uint8_t *data, int size) {
    if (!data || size <= 0) return -1;
    if (g_rpd.scene.data) free(g_rpd.scene.data);
    g_rpd.scene.data = (uint8_t *)malloc((size_t)size);
    if (!g_rpd.scene.data) return -1;
    memcpy(g_rpd.scene.data, data, (size_t)size);
    g_rpd.scene.size = (size_t)size;
    g_rpd.scene.loaded = false;
    g_rpd.scene.pending = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE void rpd_set_player_position(float x, float y, float z) {
    if (g_marker_count > 0) {
        g_markers[0].x = x;
        g_markers[0].y = y;
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
