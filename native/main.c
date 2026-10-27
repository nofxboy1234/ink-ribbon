/*
 * RPD wireframe renderer.
 *
 * The scene is a single indexed triangle mesh produced by tools/build_scene.py
 * from the RE2 RT RPD floor 1-3 terrain meshes. It is drawn as a black-filled
 * cutaway with pale wireframe edges, then depth-faded toward the background.
 */

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define SOKOL_GLES3
#define SOKOL_IMPL
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_log.h"

#define RPD_VERSION 2u
#define MAX_FLOORS 3
#define RPD_HEADER_SIZE 124
#define RPD_PI 3.14159265358979323846f

typedef struct {
    float m[16];
} mat4;

typedef struct {
    float min[3];
    float max[3];
} bounds_t;

typedef struct {
    uint32_t tri_start;
    uint32_t tri_count;
    uint32_t edge_start;
    uint32_t edge_count;
    float y_min;
    float y_max;
} floor_t;

typedef struct {
    mat4 view_proj;
    float y_offset;
    float line_bias;
    float pad0;
    float pad1;
} vs_params_t;

typedef struct {
    float camera[4]; /* xyz + fog_start */
    float fog[4];    /* fog_end, fill_mode, time, pad */
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
    uint8_t *data;
    size_t size;
    int vertex_count;
    int triangle_count;
    int edge_count;
    bounds_t bounds;
    floor_t floors[MAX_FLOORS];
    int floor_count;
    float floor_offset[MAX_FLOORS];
    sg_buffer vbuf;
    sg_buffer tri_ibuf;
    sg_buffer line_ibuf;
    sg_pipeline fill_pip;
    sg_pipeline line_pip;
    bool gpu_ready;
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
} bloom_t;

static struct {
    sg_pass_action pass_action;
    bloom_t bloom;
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
    bool key_w;
    bool key_a;
    bool key_s;
    bool key_d;
    bool key_q;
    bool key_e;
    bool key_shift;
    float last_x;
    float last_y;
    float touch_pinch;
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
    f[0] /= fl;
    f[1] /= fl;
    f[2] /= fl;
    float s[3] = { f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0] };
    float sl = sqrtf(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
    s[0] /= sl;
    s[1] /= sl;
    s[2] /= sl;
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

/* Right-click starts a free-fly camera. Its eye and orientation are seeded
   from the current orbit camera so the view does not jump. Releasing the
   button turns the current view back into an orbit around a point ahead. */
static void fly_begin(void) {
    if (state.fly_mode || !state.scene.loaded) return;
    float eye[3];
    camera_eye(&state.camera, eye);
    state.fly_pos[0] = eye[0];
    state.fly_pos[1] = eye[1];
    state.fly_pos[2] = eye[2];
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
    for (int i = 0; i < 3; i++) {
        state.camera.target[i] = state.fly_pos[i] + forward[i] * state.camera.distance;
    }
    state.fly_mode = false;
}

/* ------------------------------------------------------------------------- */
/* shaders                                                                   */
/* ------------------------------------------------------------------------- */

static const char *vs_source =
    "#version 300 es\n"
    "uniform mat4 u_view_proj;\n"
    "uniform vec4 u_offsets;\n"
    "in vec3 position;\n"
    "out vec3 v_world;\n"
    "void main() {\n"
    "  vec3 p = position + vec3(0.0, u_offsets.x, 0.0);\n"
    "  v_world = p;\n"
    "  vec4 clip = u_view_proj * vec4(p, 1.0);\n"
    "  clip.z -= u_offsets.y * clip.w;\n"
    "  gl_Position = clip;\n"
    "}\n";

static const char *fs_source =
    "#version 300 es\n"
    "precision highp float;\n"
    "uniform vec4 u_camera;\n"
    "uniform vec4 u_fog;\n"
    "in vec3 v_world;\n"
    "out vec4 frag_color;\n"
    "void main() {\n"
    "  vec3 n = normalize(cross(dFdx(v_world), dFdy(v_world)));\n"
    "  float d = length(v_world - u_camera.xyz);\n"
    "  float fade = 1.0 - smoothstep(u_camera.w, u_fog.x, d);\n"
    "  fade = 0.16 + 0.84 * fade;\n"
    "  vec3 line_col = vec3(0.82, 0.86, 0.93) * fade;\n"
    "  float ndl = abs(dot(n, normalize(vec3(0.35, 0.9, 0.25))));\n"
    "  vec3 fill_col = vec3(0.17, 0.185, 0.215) * (0.35 + 0.65 * ndl) * fade;\n"
    "  vec3 col = (u_fog.y > 0.5) ? fill_col : line_col;\n"
    "  frag_color = vec4(col, 1.0);\n"
    "}\n";

/* ------------------------------------------------------------------------- */
/* composite / bloom                                                         */
/* ------------------------------------------------------------------------- */

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
    "uniform vec4 u_params;\n"
    "in vec2 v_uv;\n"
    "out vec4 frag_color;\n"
    "void main() {\n"
    "  vec2 t = u_params.xy;\n"
    "  vec3 c = texture(u_tex, v_uv).rgb;\n"
    "  vec3 g = texture(u_tex, v_uv + vec2(-t.x, -t.y)).rgb;\n"
    "  g += texture(u_tex, v_uv + vec2(0.0, -t.y)).rgb;\n"
    "  g += texture(u_tex, v_uv + vec2(t.x, -t.y)).rgb;\n"
    "  g += texture(u_tex, v_uv + vec2(-t.x, 0.0)).rgb;\n"
    "  g += c;\n"
    "  g += texture(u_tex, v_uv + vec2(t.x, 0.0)).rgb;\n"
    "  g += texture(u_tex, v_uv + vec2(-t.x, t.y)).rgb;\n"
    "  g += texture(u_tex, v_uv + vec2(0.0, t.y)).rgb;\n"
    "  g += texture(u_tex, v_uv + vec2(t.x, t.y)).rgb;\n"
    "  g /= 9.0;\n"
    "  g = max(g - vec3(0.24), 0.0) * 1.25;\n"
    "  vec2 q = v_uv - 0.5;\n"
    "  float vig = smoothstep(0.92, 0.18, length(q));\n"
    "  vec3 bg = vec3(0.0032, 0.0037, 0.0048) * (0.22 + 0.78 * vig);\n"
    "  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;\n"
    "  float lit = clamp(max(c.r, max(c.g, c.b)) * 7.0, 0.0, 1.0);\n"
    "  vec3 col = c + g + bg * (1.0 - lit) + grain * 0.0035 * vig;\n"
    "  frag_color = vec4(col, 1.0);\n"
    "}\n";

static void destroy_bloom(bloom_t *b) {
    if (b->color.id != SG_INVALID_ID) sg_destroy_image(b->color);
    if (b->depth.id != SG_INVALID_ID) sg_destroy_image(b->depth);
    if (b->color_att.id != SG_INVALID_ID) sg_destroy_view(b->color_att);
    if (b->depth_att.id != SG_INVALID_ID) sg_destroy_view(b->depth_att);
    if (b->tex_view.id != SG_INVALID_ID) sg_destroy_view(b->tex_view);
    if (b->sampler.id != SG_INVALID_ID) sg_destroy_sampler(b->sampler);
    sg_buffer quad = b->quad;
    sg_pipeline pip = b->pip;
    memset(b, 0, sizeof(*b));
    b->quad = quad;
    b->pip = pip;
}

static void create_bloom(bloom_t *b, int width, int height) {
    destroy_bloom(b);
    if (width < 1) width = 1;
    if (height < 1) height = 1;
    b->width = width;
    b->height = height;
    b->color = sg_make_image(&(sg_image_desc){
        .usage = { .color_attachment = true },
        .width = width,
        .height = height,
        .pixel_format = SG_PIXELFORMAT_RGBA8,
        .sample_count = 1,
        .label = "rpd-color-target",
    });
    b->depth = sg_make_image(&(sg_image_desc){
        .usage = { .depth_stencil_attachment = true },
        .width = width,
        .height = height,
        .pixel_format = SG_PIXELFORMAT_DEPTH,
        .sample_count = 1,
        .label = "rpd-depth-target",
    });
    b->color_att = sg_make_view(&(sg_view_desc){
        .color_attachment = { .image = b->color },
        .label = "rpd-color-attachment",
    });
    b->depth_att = sg_make_view(&(sg_view_desc){
        .depth_stencil_attachment = { .image = b->depth },
        .label = "rpd-depth-attachment",
    });
    b->tex_view = sg_make_view(&(sg_view_desc){
        .texture = { .image = b->color },
        .label = "rpd-color-texture",
    });
    b->sampler = sg_make_sampler(&(sg_sampler_desc){
        .min_filter = SG_FILTER_LINEAR,
        .mag_filter = SG_FILTER_LINEAR,
        .wrap_u = SG_WRAP_CLAMP_TO_EDGE,
        .wrap_v = SG_WRAP_CLAMP_TO_EDGE,
        .label = "rpd-composite-sampler",
    });
    b->pass = (sg_pass){
        .action.colors[0] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = { 0.0f, 0.0f, 0.0f, 1.0f },
        },
        .action.depth = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = 1.0f,
        },
        .attachments.colors[0] = b->color_att,
        .attachments.depth_stencil = b->depth_att,
        .label = "rpd-offscreen-pass",
    };
    b->dirty = false;
}

static void create_composite_resources(void) {
    const float quad[] = { -1.0f, -1.0f, 3.0f, -1.0f, -1.0f, 3.0f };
    state.bloom.quad = sg_make_buffer(&(sg_buffer_desc){
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
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.uniform_blocks[0].size = 16;
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_params";
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
    state.bloom.pip = sg_make_pipeline(&(sg_pipeline_desc){
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

static sg_pipeline make_pipeline(sg_shader shader, sg_primitive_type prim, bool lines) {
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = 12;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.primitive_type = prim;
    pd.index_type = SG_INDEXTYPE_UINT32;
    pd.cull_mode = SG_CULLMODE_NONE;
    pd.face_winding = SG_FACEWINDING_CCW;
    pd.sample_count = 1;
    pd.depth.compare = SG_COMPAREFUNC_LESS_EQUAL;
    pd.depth.write_enabled = !lines;
    if (lines) {
        pd.depth.bias = 0.0f;
    }
    return sg_make_pipeline(&pd);
}

static bool upload_scene(scene_t *s) {
    if (!s->data || s->size < RPD_HEADER_SIZE) return false;
    const uint8_t *p = s->data;
    if (memcmp(p, "RPDW", 4) != 0) return false;
    uint32_t version = *(const uint32_t *)(p + 4);
    if (version != RPD_VERSION) return false;
    uint32_t vertex_count = *(const uint32_t *)(p + 8);
    uint32_t triangle_count = *(const uint32_t *)(p + 12);
    uint32_t edge_count = *(const uint32_t *)(p + 16);
    uint32_t floor_count = *(const uint32_t *)(p + 20);
    if (floor_count > MAX_FLOORS) return false;
    const float *header_bounds = (const float *)(p + 28);
    const uint8_t *positions = p + RPD_HEADER_SIZE;
    const uint8_t *indices = positions + (size_t)vertex_count * 12;
    const uint8_t *line_indices = indices + (size_t)triangle_count * 12;
    if ((size_t)(line_indices - p) + (size_t)edge_count * 8 > s->size) return false;
    if (vertex_count == 0 || triangle_count == 0 || edge_count == 0) return false;

    s->vertex_count = (int)vertex_count;
    s->triangle_count = (int)triangle_count;
    s->edge_count = (int)edge_count;
    s->floor_count = (int)floor_count;
    for (int i = 0; i < 3; i++) {
        s->bounds.min[i] = header_bounds[i];
        s->bounds.max[i] = header_bounds[3 + i];
    }
    for (uint32_t i = 0; i < floor_count; i++) {
        const uint8_t *f = p + 52 + i * 24;
        s->floors[i].tri_start = *(const uint32_t *)(f + 0);
        s->floors[i].tri_count = *(const uint32_t *)(f + 4);
        s->floors[i].edge_start = *(const uint32_t *)(f + 8);
        s->floors[i].edge_count = *(const uint32_t *)(f + 12);
        s->floors[i].y_min = *(const float *)(f + 16);
        s->floors[i].y_max = *(const float *)(f + 20);
    }
    for (int i = 0; i < MAX_FLOORS; i++) s->floor_offset[i] = 0.0f;

    s->vbuf = sg_make_buffer(&(sg_buffer_desc){
        .size = (size_t)vertex_count * 12,
        .data = { .ptr = positions, .size = (size_t)vertex_count * 12 },
        .label = "rpd-vertices",
    });
    s->tri_ibuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .index_buffer = true },
        .size = (size_t)triangle_count * 12,
        .data = { .ptr = indices, .size = (size_t)triangle_count * 12 },
        .label = "rpd-triangles",
    });
    s->line_ibuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .index_buffer = true },
        .size = (size_t)edge_count * 8,
        .data = { .ptr = line_indices, .size = (size_t)edge_count * 8 },
        .label = "rpd-lines",
    });

    if (sg_query_buffer_state(s->vbuf) != SG_RESOURCESTATE_VALID ||
        sg_query_buffer_state(s->tri_ibuf) != SG_RESOURCESTATE_VALID ||
        sg_query_buffer_state(s->line_ibuf) != SG_RESOURCESTATE_VALID) {
        return false;
    }

    s->gpu_ready = true;
    s->loaded = true;
    return true;
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
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
    sd.uniform_blocks[0].size = sizeof(vs_params_t);
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view_proj";
    sd.uniform_blocks[0].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[0].glsl_uniforms[1].glsl_name = "u_offsets";
    sd.uniform_blocks[1].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.uniform_blocks[1].size = sizeof(fs_params_t);
    sd.uniform_blocks[1].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[1].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[0].glsl_name = "u_camera";
    sd.uniform_blocks[1].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[1].glsl_name = "u_fog";
    sg_shader shd = sg_make_shader(&sd);
    s->fill_pip = make_pipeline(shd, SG_PRIMITIVETYPE_TRIANGLES, false);
    s->line_pip = make_pipeline(shd, SG_PRIMITIVETYPE_LINES, true);
}

static void reset_camera(void) {
    state.fly_mode = false;
    const bounds_t *b = &state.scene.bounds;
    const scene_t *s = &state.scene;
    float mn[3] = { b->min[0], b->min[1], b->min[2] };
    float mx[3] = { b->max[0], b->max[1], b->max[2] };
    for (int i = 0; i < s->floor_count; i++) {
        if (!s->floors[i].tri_count) continue;
        mn[1] = fminf(mn[1], s->floors[i].y_min + s->floor_offset[i]);
        mx[1] = fmaxf(mx[1], s->floors[i].y_max + s->floor_offset[i]);
    }
    for (int i = 0; i < 3; i++) state.camera.target[i] = 0.5f * (mn[i] + mx[i]);
    float dx = mx[0] - mn[0];
    float dy = mx[1] - mn[1];
    float dz = mx[2] - mn[2];
    state.scene_radius = 0.5f * sqrtf(dx * dx + dy * dy + dz * dz);
    state.camera.yaw = -0.55f;
    state.camera.pitch = 0.72f;

    state.camera.target[1] = mn[1] + 0.34f * (mx[1] - mn[1]);
    int w = sapp_width() > 0 ? sapp_width() : 1600;
    state.camera.distance = 133.0f * fmaxf(1.0f, 900.0f / (float)w);
}

static void frame(void) {
    float dt = (float)sapp_frame_duration();
    if (dt < 0.0f) dt = 0.0f;
    if (dt > 0.1f) dt = 0.1f;
    state.time += dt;
    if (state.scene.pending) {
        state.scene.pending = false;
        if (!upload_scene(&state.scene)) {
            state.scene.loaded = false;
        } else {
            reset_camera();
        }
    }

    if (state.bloom.dirty || state.bloom.width != sapp_width() || state.bloom.height != sapp_height()) {
        create_bloom(&state.bloom, sapp_width(), sapp_height());
    }

    sg_begin_pass(&state.bloom.pass);
    sg_apply_viewport(0, 0, state.bloom.width, state.bloom.height, true);

    if (state.scene.loaded && state.scene.gpu_ready) {
        float eye[3];
        float aim[3];
        float fog_start;
        float fog_end;
        if (state.fly_mode) {
            float forward[3];
            camera_forward(state.fly_yaw, state.fly_pitch, forward);
            float right[3] = { -forward[2], 0.0f, forward[0] };
            float rl = sqrtf(right[0] * right[0] + right[2] * right[2]);
            if (rl > 1e-5f) {
                right[0] /= rl;
                right[2] /= rl;
            }
            float mx = 0.0f;
            float my = 0.0f;
            float mz = 0.0f;
            if (state.key_w) { mx += forward[0]; my += forward[1]; mz += forward[2]; }
            if (state.key_s) { mx -= forward[0]; my -= forward[1]; mz -= forward[2]; }
            if (state.key_d) { mx += right[0]; mz += right[2]; }
            if (state.key_a) { mx -= right[0]; mz -= right[2]; }
            if (state.key_q) my += 1.0f;
            if (state.key_e) my -= 1.0f;
            float len = sqrtf(mx * mx + my * my + mz * mz);
            if (len > 1e-5f) {
                float speed = 22.0f * (state.key_shift ? 3.0f : 1.0f);
                float step = speed * dt / len;
                state.fly_pos[0] += mx * step;
                state.fly_pos[1] += my * step;
                state.fly_pos[2] += mz * step;
            }
            eye[0] = state.fly_pos[0];
            eye[1] = state.fly_pos[1];
            eye[2] = state.fly_pos[2];
            aim[0] = eye[0] + forward[0];
            aim[1] = eye[1] + forward[1];
            aim[2] = eye[2] + forward[2];
            fog_start = state.scene_radius * 0.55f;
            fog_end = state.scene_radius * 2.9f;
        } else {
            camera_eye(&state.camera, eye);
            aim[0] = state.camera.target[0];
            aim[1] = state.camera.target[1];
            aim[2] = state.camera.target[2];
            fog_start = state.camera.distance - state.scene_radius * 0.55f;
            fog_end = state.camera.distance + state.scene_radius * 1.15f;
        }
        float up[3] = { 0.0f, 1.0f, 0.0f };
        mat4 proj = mat4_perspective(0.62f, (float)sapp_width() / (float)sapp_height(), 0.5f, 1200.0f);
        mat4 view = mat4_look_at(eye, aim, up);
        mat4 vp = mat4_mul(proj, view);

        const scene_t *s = &state.scene;
        for (int floor = 0; floor < s->floor_count; floor++) {
            const floor_t *f = &s->floors[floor];
            if (!f->tri_count) continue;
            vs_params_t vs = { 0 };
            vs.view_proj = vp;
            vs.y_offset = s->floor_offset[floor];
            vs.line_bias = 0.0f;
            fs_params_t fs = { 0 };
            fs.camera[0] = eye[0];
            fs.camera[1] = eye[1];
            fs.camera[2] = eye[2];
            fs.camera[3] = fog_start;
            fs.fog[0] = fog_end;
            fs.fog[1] = 1.0f;
            sg_apply_pipeline(s->fill_pip);
            sg_apply_bindings(&(sg_bindings){
                .vertex_buffers[0] = s->vbuf,
                .index_buffer = s->tri_ibuf,
                .index_buffer_offset = (int)(f->tri_start * 12),
            });
            sg_apply_uniforms(0, &(sg_range){ &vs, sizeof(vs) });
            sg_apply_uniforms(1, &(sg_range){ &fs, sizeof(fs) });
            sg_draw(0, (int)(f->tri_count * 3), 1);

            vs.line_bias = 0.00012f;
            fs.fog[1] = 0.0f;
            sg_apply_pipeline(s->line_pip);
            sg_apply_bindings(&(sg_bindings){
                .vertex_buffers[0] = s->vbuf,
                .index_buffer = s->line_ibuf,
                .index_buffer_offset = (int)(f->edge_start * 8),
            });
            sg_apply_uniforms(0, &(sg_range){ &vs, sizeof(vs) });
            sg_apply_uniforms(1, &(sg_range){ &fs, sizeof(fs) });
            sg_draw(0, (int)(f->edge_count * 2), 1);
        }
    }

    sg_end_pass();

    sg_begin_pass(&(sg_pass){
        .action = state.pass_action,
        .swapchain = sglue_swapchain(),
    });
    sg_apply_pipeline(state.bloom.pip);
    sg_apply_bindings(&(sg_bindings){
        .vertex_buffers[0] = state.bloom.quad,
        .views[0] = state.bloom.tex_view,
        .samplers[0] = state.bloom.sampler,
    });
    float params[4] = {
        1.6f / (float)state.bloom.width,
        1.6f / (float)state.bloom.height,
        state.time,
        0.0f,
    };
    sg_apply_uniforms(0, &(sg_range){ params, sizeof(params) });
    sg_draw(0, 3, 1);
    sg_end_pass();
    sg_commit();
}

static void init(void) {
    state.pass_action.colors[0].load_action = SG_LOADACTION_CLEAR;
    state.pass_action.colors[0].clear_value = (sg_color){ 0.0f, 0.0f, 0.0f, 1.0f };
    state.pass_action.depth.load_action = SG_LOADACTION_CLEAR;
    state.pass_action.depth.clear_value = 1.0f;

    sg_setup(&(sg_desc){
        .environment = sglue_environment(),
        .logger = { .func = slog_func },
    });
    create_pipelines(&state.scene);
    create_composite_resources();
    state.bloom.dirty = true;
    state.camera.yaw = -0.55f;
    state.camera.pitch = 0.72f;
    state.camera.distance = 133.0f;
    state.camera.target[1] = 12.0f;
}

static void cleanup(void) {
    sg_shutdown();
    if (state.scene.data) free(state.scene.data);
}

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
        if (!state.fly_mode) {
            state.camera.distance = fminf(700.0f, fmaxf(8.0f, state.camera.distance * (1.0f - e->scroll_y * 0.08f)));
        }
        break;
    case SAPP_EVENTTYPE_TOUCHES_BEGAN:
    case SAPP_EVENTTYPE_TOUCHES_MOVED:
    case SAPP_EVENTTYPE_TOUCHES_ENDED: {
        float cx = 0.0f, cy = 0.0f;
        for (int i = 0; i < e->num_touches; i++) {
            cx += e->touches[i].pos_x;
            cy += e->touches[i].pos_y;
        }
        if (e->num_touches > 0) {
            cx /= (float)e->num_touches;
            cy /= (float)e->num_touches;
        }
        if (e->type == SAPP_EVENTTYPE_TOUCHES_BEGAN) {
            state.last_x = cx;
            state.last_y = cy;
            state.touch_pinch = e->num_touches >= 2
                ? hypotf(e->touches[0].pos_x - e->touches[1].pos_x,
                         e->touches[0].pos_y - e->touches[1].pos_y)
                : 0.0f;
            break;
        }
        if (e->num_touches == 1 && e->type != SAPP_EVENTTYPE_TOUCHES_ENDED) {
            float dx = e->touches[0].pos_x - state.last_x;
            float dy = e->touches[0].pos_y - state.last_y;
            state.camera.yaw -= dx * 0.006f;
            state.camera.pitch = fminf(1.45f, fmaxf(0.08f, state.camera.pitch + dy * 0.006f));
        } else if (e->num_touches >= 2) {
            float dist = hypotf(e->touches[0].pos_x - e->touches[1].pos_x,
                                e->touches[0].pos_y - e->touches[1].pos_y);
            if (state.touch_pinch > 0.0f && dist > 1.0f) {
                state.camera.distance = fminf(700.0f, fmaxf(8.0f, state.camera.distance * (state.touch_pinch / dist)));
            }
            state.touch_pinch = dist;
            float dx = cx - state.last_x;
            float dy = cy - state.last_y;
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
        case SAPP_KEYCODE_LEFT_SHIFT:
        case SAPP_KEYCODE_RIGHT_SHIFT: state.key_shift = true; break;
        case SAPP_KEYCODE_R:
            fly_end();
            state.dragging = false;
            state.panning = false;
            state.user_moved = false;
            reset_camera();
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
        case SAPP_KEYCODE_LEFT_SHIFT:
        case SAPP_KEYCODE_RIGHT_SHIFT: state.key_shift = false; break;
        default: break;
        }
        break;
    case SAPP_EVENTTYPE_UNFOCUSED:
        state.key_w = state.key_a = state.key_s = state.key_d = false;
        state.key_q = state.key_e = state.key_shift = false;
        state.dragging = false;
        state.panning = false;
        fly_end();
        break;
    case SAPP_EVENTTYPE_RESIZED:
        state.bloom.dirty = true;
        if (!state.user_moved && state.scene.loaded) reset_camera();
        break;
    default:
        break;
    }
}

static void init_cb(void) {
    init();
}

sapp_desc sokol_main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;
    return (sapp_desc){
        .init_cb = init_cb,
        .frame_cb = frame,
        .cleanup_cb = cleanup,
        .event_cb = event,
        .width = 0,
        .height = 0,
        .high_dpi = true,
        .sample_count = 4,
        .window_title = "RPD",
        .logger = { .func = slog_func },
    };
}

/* ------------------------------------------------------------------------- */
/* JS bridge                                                                 */
/* ------------------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE int rpd_load_scene(const uint8_t *data, int size) {
    scene_t *s = &state.scene;
    if (s->data) free(s->data);
    s->data = (uint8_t *)malloc((size_t)size);
    if (!s->data) return -1;
    memcpy(s->data, data, (size_t)size);
    s->size = (size_t)size;
    s->pending = true;
    s->loaded = false;
    return 0;
}
