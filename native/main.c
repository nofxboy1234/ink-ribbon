/*
 * Real RPD geometry viewer.
 *
 * The asset is the LOD-0 RPD terrain mesh. Each source material subdivision
 * has one flat colour; there are no textures. The clip box and flat top
 * envelopes are trimmed, but the rest of the real building shell is kept.
 */

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SOKOL_GLES3
#define SOKOL_IMPL
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_log.h"

#define RPD_VERSION 3u
#define RPD_HEADER_SIZE 100
#define RPD_PI 3.14159265358979323846f

typedef struct { float m[16]; } mat4;
typedef struct { float min[3]; float max[3]; } bounds_t;

typedef struct {
    mat4 view_proj;
} vs_params_t;

typedef struct {
    float camera[4];
    float fog[4];
} fs_params_t;

typedef struct {
    float yaw;
    float pitch;
    float distance;
    float target[3];
} camera_t;

typedef struct {
    bool loaded;
    bool pending;
    bool gpu_ready;
    uint8_t *data;
    size_t size;
    int vertex_count;
    int triangle_count;
    bounds_t bounds;
    sg_buffer vbuf;
    sg_buffer tri_ibuf;
    sg_buffer sphere_vbuf;
    sg_buffer sphere_ibuf;
    sg_pipeline sphere_pip;
    int sphere_index_count;
    sg_pipeline pip;
} scene_t;

typedef struct {
    sg_image color;
    sg_image depth;
    sg_view color_att;
    sg_view depth_att;
    sg_view tex_view;
    sg_sampler sampler;
    sg_pass pass;
    sg_pipeline pip;
    sg_buffer quad;
    int width;
    int height;
    bool dirty;
} target_t;

static struct {
    sg_pass_action pass_action;
    target_t target;
    float time;
    scene_t scene;
    camera_t camera;
    float scene_radius;
    bool dragging;
    bool panning;
    bool user_moved;
    bool fly_mode;
    float fly_pos[3];
    float fly_yaw;
    float fly_pitch;
    bool key_w, key_a, key_s, key_d, key_q, key_e;
    float last_x, last_y, touch_pinch;
    float fly_speed;
} state;

/* ------------------------------------------------------------------------- */
/* math                                                                      */
/* ------------------------------------------------------------------------- */

static mat4 mat4_mul(mat4 a, mat4 b) {
    mat4 out;
    for (int col = 0; col < 4; col++) {
        for (int row = 0; row < 4; row++) {
            out.m[col * 4 + row] =
                a.m[0 * 4 + row] * b.m[col * 4 + 0] +
                a.m[1 * 4 + row] * b.m[col * 4 + 1] +
                a.m[2 * 4 + row] * b.m[col * 4 + 2] +
                a.m[3 * 4 + row] * b.m[col * 4 + 3];
        }
    }
    return out;
}

static mat4 mat4_perspective(float fovy_rad, float aspect, float near_z, float far_z) {
    mat4 m;
    memset(&m, 0, sizeof(m));
    float f = 1.0f / tanf(fovy_rad * 0.5f);
    m.m[0] = f / aspect;
    m.m[5] = f;
    m.m[10] = (far_z + near_z) / (near_z - far_z);
    m.m[11] = -1.0f;
    m.m[14] = (2.0f * far_z * near_z) / (near_z - far_z);
    return m;
}

static mat4 mat4_look_at(float eye[3], float center[3], float up[3]) {
    float f[3] = { center[0] - eye[0], center[1] - eye[1], center[2] - eye[2] };
    float fl = sqrtf(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
    f[0] /= fl; f[1] /= fl; f[2] /= fl;
    float s[3] = { f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0] };
    float sl = sqrtf(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
    s[0] /= sl; s[1] /= sl; s[2] /= sl;
    float u[3] = { s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0] };
    mat4 m;
    memset(&m, 0, sizeof(m));
    m.m[0] = s[0]; m.m[4] = s[1]; m.m[8] = s[2];
    m.m[1] = u[0]; m.m[5] = u[1]; m.m[9] = u[2];
    m.m[2] = -f[0]; m.m[6] = -f[1]; m.m[10] = -f[2];
    m.m[12] = -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]);
    m.m[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
    m.m[14] = (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]);
    m.m[15] = 1.0f;
    return m;
}

static void camera_eye(const camera_t *cam, float eye[3]) {
    float cp = cosf(cam->pitch);
    eye[0] = cam->target[0] + cam->distance * cp * sinf(cam->yaw);
    eye[1] = cam->target[1] + cam->distance * sinf(cam->pitch);
    eye[2] = cam->target[2] + cam->distance * cp * cosf(cam->yaw);
}

static void camera_forward(float yaw, float pitch, float out[3]) {
    float cp = cosf(pitch);
    out[0] = cp * sinf(yaw);
    out[1] = sinf(pitch);
    out[2] = cp * cosf(yaw);
}

static void fly_begin(void) {
    if (state.fly_mode || !state.scene.loaded) return;
    float eye[3];
    camera_eye(&state.camera, eye);
    memcpy(state.fly_pos, eye, sizeof(eye));
    state.fly_yaw = state.camera.yaw + RPD_PI;
    state.fly_pitch = -state.camera.pitch;
    state.fly_mode = true;
    state.dragging = false;
    state.panning = false;
}

static void fly_end(void) {
    if (!state.fly_mode) return;
    float forward[3];
    camera_forward(state.fly_yaw, state.fly_pitch, forward);
    state.camera.yaw = state.fly_yaw - RPD_PI;
    while (state.camera.yaw > RPD_PI) state.camera.yaw -= 2.0f * RPD_PI;
    while (state.camera.yaw < -RPD_PI) state.camera.yaw += 2.0f * RPD_PI;
    state.camera.pitch = -state.fly_pitch;
    for (int i = 0; i < 3; i++)
        state.camera.target[i] = state.fly_pos[i] + forward[i] * state.camera.distance;
    state.fly_mode = false;
}

/* ------------------------------------------------------------------------- */
/* shaders                                                                   */
/* ------------------------------------------------------------------------- */

static const char *vs_source =
    "#version 300 es\n"
    "uniform mat4 u_view_proj;\n"
    "in vec3 position;\n"
    "in vec4 color;\n"
    "out vec3 v_world;\n"
    "out vec3 v_color;\n"
    "void main() {\n"
    "  v_world = position;\n"
    "  v_color = color.rgb;\n"
    "  gl_Position = u_view_proj * vec4(position, 1.0);\n"
    "}\n";

static const char *fs_source =
    "#version 300 es\n"
    "precision highp float;\n"
    "uniform vec4 u_camera;\n"
    "uniform vec4 u_fog;\n"
    "in vec3 v_world;\n"
    "in vec3 v_color;\n"
    "out vec4 frag_color;\n"
    "void main() {\n"
    "  if (u_fog.z > 0.5) {\n"
    "    float spec_power = 16.0;\n"
    "    float ambient_intensity = 0.25;\n"
    "    vec3 l = normalize(vec3(50.0, 100.0, -75.0));\n"
    "    vec3 n = normalize(v_world - vec3(0.0, 1.27, 8.5));\n"
    "    float n_dot_l = dot(n, l);\n"
    "    float lum = dot(v_color, vec3(0.299, 0.587, 0.114));\n"
    "    vec3 base = clamp(mix(vec3(lum), v_color, 1.7), 0.0, 1.0);\n"
    "    vec3 orb;\n"
    "    if (n_dot_l > 0.0) {\n"
    "      vec3 v = normalize(u_camera.xyz - v_world);\n"
    "      vec3 r = reflect(-l, n);\n"
    "      float spec_intensity = pow(max(dot(r, v), 0.0), spec_power) * n_dot_l;\n"
    "      orb = vec3(spec_intensity) + (n_dot_l + ambient_intensity) * base;\n"
    "    } else {\n"
    "      orb = base * ambient_intensity;\n"
    "    }\n"
    "    frag_color = vec4(pow(clamp(orb, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);\n"
    "    return;\n"
    "  }\n"
    "  vec3 n = normalize(cross(dFdx(v_world), dFdy(v_world)));\n"
    "  vec3 view = normalize(u_camera.xyz - v_world);\n"
    "  if (dot(n, view) < 0.0) n = -n;\n"
    "  float key = max(dot(n, normalize(vec3(0.42, 0.82, 0.38))), 0.0);\n"
    "  float fill = max(dot(n, normalize(vec3(-0.55, 0.35, -0.65))), 0.0);\n"
    "  float hemi = 0.5 + 0.5 * n.y;\n"
    "  float d = length(v_world - u_camera.xyz);\n"
    "  float near = 1.0 - smoothstep(u_camera.w, u_fog.x, d);\n"
    "  float fres = pow(1.0 - max(dot(n, view), 0.0), 2.0);\n"
    "  float light = 0.55 + 0.35 * key + 0.10 * hemi;\n"
    "  vec3 glass = vec3(0.95, 0.96, 0.97) * light;\n"
    "  float alpha = (0.30 + 0.35 * fres) * (0.45 + 0.55 * near);\n"
    "  frag_color = vec4(glass, alpha);\n"
    "}\n";

static const char *composite_vs_source =
    "#version 300 es\n"
    "in vec2 position;\n"
    "out vec2 v_uv;\n"
    "void main() {\n"
    "  v_uv = position * 0.5 + 0.5;\n"
    "  gl_Position = vec4(position, 0.0, 1.0);\n"
    "}\n";

static const char *composite_fs_source =
    "#version 300 es\n"
    "precision highp float;\n"
    "uniform sampler2D u_tex;\n"
    "in vec2 v_uv;\n"
    "out vec4 frag_color;\n"
    "void main() {\n"
    "  vec3 c = texture(u_tex, v_uv).rgb;\n"
    "  vec2 q = v_uv - 0.5;\n"
    "  float vig = smoothstep(0.95, 0.15, length(q));\n"
    "  vec3 bg = vec3(0.0040, 0.0045, 0.0055) * (0.20 + 0.80 * vig);\n"
    "  float lit = clamp(max(c.r, max(c.g, c.b)) * 5.0, 0.0, 1.0);\n"
    "  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;\n"
    "  vec3 col = c + bg * (1.0 - lit) + grain * 0.0025 * vig;\n"
    "  frag_color = vec4(col, 1.0);\n"
    "}\n";

/* ------------------------------------------------------------------------- */
/* render target                                                             */
/* ------------------------------------------------------------------------- */

static void destroy_target(target_t *t) {
    if (t->color.id != SG_INVALID_ID) sg_destroy_image(t->color);
    if (t->depth.id != SG_INVALID_ID) sg_destroy_image(t->depth);
    if (t->color_att.id != SG_INVALID_ID) sg_destroy_view(t->color_att);
    if (t->depth_att.id != SG_INVALID_ID) sg_destroy_view(t->depth_att);
    if (t->tex_view.id != SG_INVALID_ID) sg_destroy_view(t->tex_view);
    if (t->sampler.id != SG_INVALID_ID) sg_destroy_sampler(t->sampler);
    sg_buffer quad = t->quad;
    sg_pipeline pip = t->pip;
    memset(t, 0, sizeof(*t));
    t->quad = quad;
    t->pip = pip;
}

static void create_target(target_t *t, int width, int height) {
    destroy_target(t);
    if (width < 1) width = 1;
    if (height < 1) height = 1;
    t->width = width;
    t->height = height;
    t->color = sg_make_image(&(sg_image_desc){
        .usage = { .color_attachment = true },
        .width = width, .height = height,
        .pixel_format = SG_PIXELFORMAT_RGBA8,
        .sample_count = 1,
        .label = "rpd-color-target",
    });
    t->depth = sg_make_image(&(sg_image_desc){
        .usage = { .depth_stencil_attachment = true },
        .width = width, .height = height,
        .pixel_format = SG_PIXELFORMAT_DEPTH,
        .sample_count = 1,
        .label = "rpd-depth-target",
    });
    t->color_att = sg_make_view(&(sg_view_desc){
        .color_attachment = { .image = t->color },
        .label = "rpd-color-attachment",
    });
    t->depth_att = sg_make_view(&(sg_view_desc){
        .depth_stencil_attachment = { .image = t->depth },
        .label = "rpd-depth-attachment",
    });
    t->tex_view = sg_make_view(&(sg_view_desc){
        .texture = { .image = t->color },
        .label = "rpd-color-texture",
    });
    t->sampler = sg_make_sampler(&(sg_sampler_desc){
        .min_filter = SG_FILTER_LINEAR,
        .mag_filter = SG_FILTER_LINEAR,
        .wrap_u = SG_WRAP_CLAMP_TO_EDGE,
        .wrap_v = SG_WRAP_CLAMP_TO_EDGE,
        .label = "rpd-composite-sampler",
    });
    t->pass = (sg_pass){
        .action.colors[0] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = { 0.0f, 0.0f, 0.0f, 1.0f },
        },
        .action.depth = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = 1.0f,
        },
        .attachments.colors[0] = t->color_att,
        .attachments.depth_stencil = t->depth_att,
        .label = "rpd-offscreen-pass",
    };
    t->dirty = false;
}

static void create_composite_resources(void) {
    const float quad[] = { -1.0f, -1.0f, 3.0f, -1.0f, -1.0f, 3.0f };
    state.target.quad = sg_make_buffer(&(sg_buffer_desc){
        .data = { .ptr = quad, .size = sizeof(quad) },
        .label = "fullscreen-quad",
    });
    sg_shader_desc sd;
    memset(&sd, 0, sizeof(sd));
    sd.vertex_func.source = composite_vs_source;
    sd.vertex_func.entry = "main";
    sd.fragment_func.source = composite_fs_source;
    sd.fragment_func.entry = "main";
    sd.attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[0].glsl_name = "position";
    sd.views[0].texture.stage = SG_SHADERSTAGE_FRAGMENT;
    sd.views[0].texture.image_type = SG_IMAGETYPE_2D;
    sd.views[0].texture.sample_type = SG_IMAGESAMPLETYPE_FLOAT;
    sd.samplers[0].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.samplers[0].sampler_type = SG_SAMPLERTYPE_FILTERING;
    sd.texture_sampler_pairs[0].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.texture_sampler_pairs[0].view_slot = 0;
    sd.texture_sampler_pairs[0].sampler_slot = 0;
    sd.texture_sampler_pairs[0].glsl_name = "u_tex";
    sg_shader shd = sg_make_shader(&sd);
    state.target.pip = sg_make_pipeline(&(sg_pipeline_desc){
        .shader = shd,
        .layout = {
            .buffers[0].stride = 8,
            .attrs[0].format = SG_VERTEXFORMAT_FLOAT2,
        },
        .primitive_type = SG_PRIMITIVETYPE_TRIANGLES,
        .sample_count = sapp_sample_count(),
        .depth.compare = SG_COMPAREFUNC_ALWAYS,
        .depth.write_enabled = false,
        .label = "composite-pipeline",
    });
}

/* ------------------------------------------------------------------------- */
/* scene                                                                     */
/* ------------------------------------------------------------------------- */

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

static sg_pipeline make_sphere_pipeline(sg_shader shader) {
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
    pd.label = "sphere-pipeline";
    return sg_make_pipeline(&pd);
}

static void create_sphere(scene_t *s) {
    const int seg = 32, ring = 16;
    const float radius = 0.45f;
    const float cx = 0.0f, cy = radius + 0.82f, cz = 8.5f;
    const int vc = (ring + 1) * (seg + 1);
    const int tc = ring * seg * 2;
    uint8_t *verts = (uint8_t *)malloc((size_t)vc * 16);
    uint32_t *idx = (uint32_t *)malloc((size_t)tc * 3 * sizeof(uint32_t));
    if (!verts || !idx) { free(verts); free(idx); return; }
    for (int r = 0; r <= ring; r++) {
        float v = (float)r / (float)ring;
        float phi = v * RPD_PI;
        for (int c = 0; c <= seg; c++) {
            float u = (float)c / (float)seg;
            float theta = u * 2.0f * RPD_PI;
            float x = cx + radius * sinf(phi) * cosf(theta);
            float y = cy + radius * cosf(phi);
            float z = cz + radius * sinf(phi) * sinf(theta);
            uint8_t *p = verts + ((size_t)r * (seg + 1) + c) * 16;
            memcpy(p, &x, 4); memcpy(p + 4, &y, 4); memcpy(p + 8, &z, 4);
            p[12] = 139; p[13] = 233; p[14] = 253; p[15] = 255;
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
    s->sphere_vbuf = sg_make_buffer(&(sg_buffer_desc){
        .size = (size_t)vc * 16, .data = { .ptr = verts, .size = (size_t)vc * 16 }, .label = "spawn-sphere",
    });
    s->sphere_ibuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .index_buffer = true }, .size = (size_t)tc * 3 * sizeof(uint32_t),
        .data = { .ptr = idx, .size = (size_t)tc * 3 * sizeof(uint32_t) }, .label = "spawn-sphere-indices",
    });
    s->sphere_index_count = tc * 3;
    free(verts);
    free(idx);
}

static bool upload_scene(scene_t *s) {
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
    create_sphere(s);
    s->gpu_ready = true;
    s->loaded = true;
    return true;
fail:
    free(vbuf);
    free(ibuf);
    return false;
}

static void create_pipelines(scene_t *s) {
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
    sg_shader shd = sg_make_shader(&sd);
    s->pip = make_pipeline(shd);
    s->sphere_pip = make_sphere_pipeline(shd);

}

static void reset_camera(void) {
    state.fly_mode = false;
    const bounds_t *b = &state.scene.bounds;
    for (int i = 0; i < 3; i++) state.camera.target[i] = 0.5f * (b->min[i] + b->max[i]);
    float dx = b->max[0] - b->min[0];
    float dy = b->max[1] - b->min[1];
    float dz = b->max[2] - b->min[2];
    state.scene_radius = 0.5f * sqrtf(dx * dx + dy * dy + dz * dz);
    int w = sapp_width() > 0 ? sapp_width() : 1600;
    if (state.scene_radius < 30.0f) {
        state.camera.target[0] = 0.0f;
        state.camera.target[1] = 2.5f;
        state.camera.target[2] = 4.0f;
        state.camera.yaw = 0.0f;
        state.camera.pitch = 0.05f;
        state.camera.distance = 14.0f;
    } else {
        state.camera.yaw = -0.55f;
        state.camera.pitch = 0.62f;
        state.camera.target[1] = b->min[1] + 0.40f * dy;
        state.camera.distance = 2.2f * state.scene_radius * fmaxf(1.0f, 900.0f / (float)w);
    }
}

static void frame(void) {
    float dt = (float)sapp_frame_duration();
    if (dt < 0.0f) dt = 0.0f;
    if (dt > 0.1f) dt = 0.1f;
    state.time += dt;
    if (state.scene.pending) {
        state.scene.pending = false;
        state.scene.loaded = upload_scene(&state.scene);
        if (state.scene.loaded) reset_camera();
    }
    if (state.target.dirty || state.target.width != sapp_width() || state.target.height != sapp_height())
        create_target(&state.target, sapp_width(), sapp_height());

    sg_begin_pass(&state.target.pass);
    sg_apply_viewport(0, 0, state.target.width, state.target.height, true);

    if (state.scene.loaded && state.scene.gpu_ready) {
        float eye[3], aim[3], fog_start, fog_end;
        if (state.fly_mode) {
            float forward[3];
            camera_forward(state.fly_yaw, state.fly_pitch, forward);
            float right[3] = { -forward[2], 0.0f, forward[0] };
            float rl = sqrtf(right[0] * right[0] + right[2] * right[2]);
            if (rl > 1e-5f) { right[0] /= rl; right[2] /= rl; }
            float mx = 0.0f, my = 0.0f, mz = 0.0f;
            if (state.key_w) { mx += forward[0]; my += forward[1]; mz += forward[2]; }
            if (state.key_s) { mx -= forward[0]; my -= forward[1]; mz -= forward[2]; }
            if (state.key_d) { mx += right[0]; mz += right[2]; }
            if (state.key_a) { mx -= right[0]; mz -= right[2]; }
            if (state.key_q) my -= 1.0f;
            if (state.key_e) my += 1.0f;
            float len = sqrtf(mx * mx + my * my + mz * mz);
            if (len > 1e-5f) {
                float step = state.fly_speed * dt / len;
                state.fly_pos[0] += mx * step;
                state.fly_pos[1] += my * step;
                state.fly_pos[2] += mz * step;
            }
            memcpy(eye, state.fly_pos, sizeof(eye));
            aim[0] = eye[0] + forward[0];
            aim[1] = eye[1] + forward[1];
            aim[2] = eye[2] + forward[2];
        } else {
            camera_eye(&state.camera, eye);
            memcpy(aim, state.camera.target, sizeof(aim));
        }
        /* Fog must not depend on fly mode, otherwise pressing right-click
           visibly darkens the existing view. */
        fog_start = state.camera.distance - state.scene_radius * 0.55f;
        fog_end = state.camera.distance + state.scene_radius * 1.15f;
        float up[3] = { 0.0f, 1.0f, 0.0f };
        mat4 proj = mat4_perspective(0.62f, (float)sapp_width() / (float)sapp_height(), 0.2f, 1600.0f);
        mat4 view = mat4_look_at(eye, aim, up);
        vs_params_t vs = { .view_proj = mat4_mul(proj, view) };
        {
            fs_params_t fs = { 0 };
            fs.camera[0] = eye[0]; fs.camera[1] = eye[1]; fs.camera[2] = eye[2]; fs.camera[3] = fog_start;
            fs.fog[0] = fog_end;
            sg_apply_pipeline(state.scene.pip);
            sg_apply_bindings(&(sg_bindings){
                .vertex_buffers[0] = state.scene.vbuf,
                .index_buffer = state.scene.tri_ibuf,
            });
            sg_apply_uniforms(0, &(sg_range){ &vs, sizeof(vs) });
            sg_apply_uniforms(1, &(sg_range){ &fs, sizeof(fs) });
            sg_draw(0, state.scene.triangle_count * 3, 1);
            if (state.scene.sphere_index_count > 0) {
                sg_apply_pipeline(state.scene.sphere_pip);
                sg_apply_bindings(&(sg_bindings){
                    .vertex_buffers[0] = state.scene.sphere_vbuf,
                    .index_buffer = state.scene.sphere_ibuf,
                });
                fs.fog[2] = 1.0f;
                sg_apply_uniforms(0, &(sg_range){ &vs, sizeof(vs) });
                sg_apply_uniforms(1, &(sg_range){ &fs, sizeof(fs) });
                sg_draw(0, state.scene.sphere_index_count, 1);
            }
        }
    }
    sg_end_pass();

    sg_begin_pass(&(sg_pass){
        .action = state.pass_action,
        .swapchain = sglue_swapchain(),
    });
    sg_apply_pipeline(state.target.pip);
    sg_apply_bindings(&(sg_bindings){
        .vertex_buffers[0] = state.target.quad,
        .views[0] = state.target.tex_view,
        .samplers[0] = state.target.sampler,
    });
    sg_draw(0, 3, 1);
    sg_end_pass();
    sg_commit();
}

static void init(void) {
    state.pass_action.colors[0].load_action = SG_LOADACTION_CLEAR;
    state.pass_action.colors[0].clear_value = (sg_color){ 0.0f, 0.0f, 0.0f, 1.0f };
    sg_setup(&(sg_desc){
        .environment = sglue_environment(),
        .logger = { .func = slog_func },
    });
    create_pipelines(&state.scene);
    create_composite_resources();
    state.target.dirty = true;
    state.camera.yaw = -0.55f;
    state.camera.pitch = 0.62f;
    state.camera.distance = 150.0f;
    state.camera.target[1] = 10.0f;
    state.fly_speed = 22.0f;
}

static void cleanup(void) {
    sg_shutdown();
    if (state.scene.data) free(state.scene.data);
}

/* input handling is the same orbit/fly model as before */
static void event(const sapp_event *e) {
    switch (e->type) {
    case SAPP_EVENTTYPE_MOUSE_DOWN:
        state.user_moved = true;
        if (e->mouse_button == SAPP_MOUSEBUTTON_LEFT) state.dragging = true;
        if (e->mouse_button == SAPP_MOUSEBUTTON_RIGHT) fly_begin();
        if (e->mouse_button == SAPP_MOUSEBUTTON_MIDDLE) state.panning = true;
        state.last_x = e->mouse_x;
        state.last_y = e->mouse_y;
        break;
    case SAPP_EVENTTYPE_MOUSE_UP:
        if (e->mouse_button == SAPP_MOUSEBUTTON_LEFT) state.dragging = false;
        if (e->mouse_button == SAPP_MOUSEBUTTON_RIGHT) fly_end();
        if (e->mouse_button == SAPP_MOUSEBUTTON_MIDDLE) state.panning = false;
        break;
    case SAPP_EVENTTYPE_MOUSE_LEAVE:
        state.dragging = false;
        state.panning = false;
        fly_end();
        break;
    case SAPP_EVENTTYPE_MOUSE_MOVE: {
        float dx = e->mouse_x - state.last_x;
        float dy = e->mouse_y - state.last_y;
        state.last_x = e->mouse_x;
        state.last_y = e->mouse_y;
        if (state.fly_mode) {
            state.fly_yaw -= dx * 0.005f;
            while (state.fly_yaw > RPD_PI) state.fly_yaw -= 2.0f * RPD_PI;
            while (state.fly_yaw < -RPD_PI) state.fly_yaw += 2.0f * RPD_PI;
            state.fly_pitch = fminf(1.45f, fmaxf(-1.45f, state.fly_pitch - dy * 0.005f));
        } else if (state.dragging) {
            state.camera.yaw -= dx * 0.006f;
            state.camera.pitch = fminf(1.45f, fmaxf(0.08f, state.camera.pitch + dy * 0.006f));
        } else if (state.panning) {
            float eye[3];
            camera_eye(&state.camera, eye);
            float f[3] = { state.camera.target[0] - eye[0], state.camera.target[1] - eye[1], state.camera.target[2] - eye[2] };
            float fl = sqrtf(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
            f[0] /= fl; f[1] /= fl; f[2] /= fl;
            float right[3] = { -f[2], 0.0f, f[0] };
            float rl = sqrtf(right[0] * right[0] + right[2] * right[2]);
            right[0] /= rl; right[2] /= rl;
            float upv[3] = { right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0] };
            float scale = 2.0f * state.camera.distance * tanf(0.31f) / (float)sapp_height();
            for (int i = 0; i < 3; i++) {
                state.camera.target[i] -= right[i] * dx * scale;
                state.camera.target[i] += upv[i] * dy * scale;
            }
        }
        break;
    }
    case SAPP_EVENTTYPE_MOUSE_SCROLL:
        state.user_moved = true;
        if (state.fly_mode) {
            state.fly_speed = fminf(140.0f, fmaxf(2.0f, state.fly_speed * powf(1.22f, e->scroll_y)));
        } else {
            state.camera.distance = fminf(700.0f, fmaxf(8.0f, state.camera.distance * (1.0f - e->scroll_y * 0.08f)));
        }
        break;
    case SAPP_EVENTTYPE_TOUCHES_BEGAN:
    case SAPP_EVENTTYPE_TOUCHES_MOVED:
    case SAPP_EVENTTYPE_TOUCHES_ENDED: {
        float cx = 0.0f, cy = 0.0f;
        for (int i = 0; i < e->num_touches; i++) { cx += e->touches[i].pos_x; cy += e->touches[i].pos_y; }
        if (e->num_touches > 0) { cx /= (float)e->num_touches; cy /= (float)e->num_touches; }
        if (e->type == SAPP_EVENTTYPE_TOUCHES_BEGAN) {
            state.last_x = cx; state.last_y = cy;
            state.touch_pinch = e->num_touches >= 2 ? hypotf(e->touches[0].pos_x - e->touches[1].pos_x, e->touches[0].pos_y - e->touches[1].pos_y) : 0.0f;
            break;
        }
        if (e->num_touches == 1 && e->type != SAPP_EVENTTYPE_TOUCHES_ENDED) {
            float dx = e->touches[0].pos_x - state.last_x;
            float dy = e->touches[0].pos_y - state.last_y;
            state.camera.yaw -= dx * 0.006f;
            state.camera.pitch = fminf(1.45f, fmaxf(0.08f, state.camera.pitch + dy * 0.006f));
        } else if (e->num_touches >= 2) {
            float dist = hypotf(e->touches[0].pos_x - e->touches[1].pos_x, e->touches[0].pos_y - e->touches[1].pos_y);
            if (state.touch_pinch > 0.0f && dist > 1.0f)
                state.camera.distance = fminf(700.0f, fmaxf(8.0f, state.camera.distance * (state.touch_pinch / dist)));
            state.touch_pinch = dist;
            float dx = cx - state.last_x, dy = cy - state.last_y;
            float eye[3]; camera_eye(&state.camera, eye);
            float f[3] = { state.camera.target[0] - eye[0], state.camera.target[1] - eye[1], state.camera.target[2] - eye[2] };
            float fl = sqrtf(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
            f[0] /= fl; f[1] /= fl; f[2] /= fl;
            float right[3] = { -f[2], 0.0f, f[0] };
            float rl = sqrtf(right[0] * right[0] + right[2] * right[2]);
            right[0] /= rl; right[2] /= rl;
            float upv[3] = { right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0] };
            float scale = 2.0f * state.camera.distance * tanf(0.31f) / (float)sapp_height();
            for (int i = 0; i < 3; i++) {
                state.camera.target[i] -= right[i] * dx * scale;
                state.camera.target[i] += upv[i] * dy * scale;
            }
        }
        if (e->num_touches < 2) state.touch_pinch = 0.0f;
        state.last_x = e->num_touches > 0 ? cx : state.last_x;
        state.last_y = e->num_touches > 0 ? cy : state.last_y;
        break;
    }
    case SAPP_EVENTTYPE_KEY_DOWN:
        switch (e->key_code) {
        case SAPP_KEYCODE_W: state.key_w = true; break;
        case SAPP_KEYCODE_A: state.key_a = true; break;
        case SAPP_KEYCODE_S: state.key_s = true; break;
        case SAPP_KEYCODE_D: state.key_d = true; break;
        case SAPP_KEYCODE_Q: state.key_q = true; break;
        case SAPP_KEYCODE_E: state.key_e = true; break;
        case SAPP_KEYCODE_R:
            fly_end(); state.dragging = false; state.panning = false; state.user_moved = false; reset_camera();
            break;
        default: break;
        }
        break;
    case SAPP_EVENTTYPE_KEY_UP:
        switch (e->key_code) {
        case SAPP_KEYCODE_W: state.key_w = false; break;
        case SAPP_KEYCODE_A: state.key_a = false; break;
        case SAPP_KEYCODE_S: state.key_s = false; break;
        case SAPP_KEYCODE_D: state.key_d = false; break;
        case SAPP_KEYCODE_Q: state.key_q = false; break;
        case SAPP_KEYCODE_E: state.key_e = false; break;
        default: break;
        }
        break;
    case SAPP_EVENTTYPE_UNFOCUSED:
        state.key_w = state.key_a = state.key_s = state.key_d = false;
        state.key_q = state.key_e = false;
        state.dragging = false;
        state.panning = false;
        fly_end();
        break;
    case SAPP_EVENTTYPE_RESIZED:
        state.target.dirty = true;
        if (!state.user_moved && state.scene.loaded) reset_camera();
        break;
    default: break;
    }
}





/* Camera access for the viewer. The web client mirrors the pose into the URL
   hash so any view can be reopened or reported exactly. Both calls use fly
   mode, so the reported and restored yaw/pitch mean the same thing. */
EMSCRIPTEN_KEEPALIVE int rpd_get_camera(float *out) {
    if (!out) return -1;
    float eye[3];
    if (state.fly_mode) {
        eye[0] = state.fly_pos[0];
        eye[1] = state.fly_pos[1];
        eye[2] = state.fly_pos[2];
        out[3] = state.fly_yaw;
        out[4] = state.fly_pitch;
    } else {
        camera_eye(&state.camera, eye);
        out[3] = state.camera.yaw + RPD_PI;
        out[4] = -state.camera.pitch;
    }
    out[0] = eye[0];
    out[1] = eye[1];
    out[2] = eye[2];
    out[5] = state.fly_mode ? 1.0f : 0.0f;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_set_camera(float x, float y, float z, float yaw, float pitch) {
    state.fly_mode = true;
    state.fly_pos[0] = x;
    state.fly_pos[1] = y;
    state.fly_pos[2] = z;
    state.fly_yaw = yaw;
    state.fly_pitch = pitch;
    state.camera.yaw = yaw - RPD_PI;
    while (state.camera.yaw > RPD_PI) state.camera.yaw -= 2.0f * RPD_PI;
    while (state.camera.yaw < -RPD_PI) state.camera.yaw += 2.0f * RPD_PI;
    state.camera.pitch = -pitch;
    state.user_moved = true;
    return 0;
}


EMSCRIPTEN_KEEPALIVE int rpd_load_scene(const uint8_t *data, int size) {
    if (!data || size <= 0) return -1;
    if (state.scene.data) free(state.scene.data);
    state.scene.data = (uint8_t *)malloc((size_t)size);
    if (!state.scene.data) return -1;
    memcpy(state.scene.data, data, (size_t)size);
    state.scene.size = (size_t)size;
    state.scene.loaded = false;
    state.scene.pending = true;
    return 0;
}

static void init_cb(void) { init(); }

sapp_desc sokol_main(int argc, char *argv[]) {
    (void)argc; (void)argv;
    return (sapp_desc){
        .init_cb = init_cb,
        .frame_cb = frame,
        .cleanup_cb = cleanup,
        .event_cb = event,
        .width = 1600,
        .height = 900,
        .high_dpi = true,
        .window_title = "RPD — floors 1–3",
    };
}
