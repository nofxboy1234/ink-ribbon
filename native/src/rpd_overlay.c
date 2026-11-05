#include "rpd_overlay.h"

#include <math.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "rpd_font.h"
#include "rpd_plan.h"
#include "rpd_sokol.h"

#define MAX_VERTS (240 * 1024)
#define MAX_TEXT_VERTS (24 * 1024)
#define MAX_LABELS 64
#define FONT_COLS 16
#define FONT_ROWS 6
#define FONT_CELL_W 6
#define FONT_CELL_H 8
#define FONT_ATLAS_W (FONT_COLS * FONT_CELL_W)
#define FONT_ATLAS_H (FONT_ROWS * FONT_CELL_H)

typedef struct {
    float x, y;
    uint8_t r, g, b, a;
} overlay_vertex;

typedef struct {
    float x, y, u, v;
    uint8_t r, g, b, a;
} text_vertex;

static sg_pipeline pip;
static sg_pipeline text_pip;
static sg_buffer vbuf;
static sg_buffer text_vbuf;
static sg_image font_image;
static sg_view font_view;
static sg_sampler font_sampler;
static overlay_vertex *verts;
static text_vertex *text_verts;
static int vcount;
static int text_count;

static int view_w = 1, view_h = 1;
static float vp[16];

static const uint8_t *col(uint32_t c) {
    static uint8_t out[4];
    out[0] = (c >> 24) & 0xff; out[1] = (c >> 16) & 0xff; out[2] = (c >> 8) & 0xff; out[3] = c & 0xff;
    return out;
}

static void push(float x, float y, uint32_t c) {
    if (vcount >= MAX_VERTS) return;
    uint8_t *rgb = (uint8_t *)col(c);
    verts[vcount].x = x; verts[vcount].y = y;
    verts[vcount].r = rgb[0]; verts[vcount].g = rgb[1]; verts[vcount].b = rgb[2]; verts[vcount].a = rgb[3];
    vcount++;
}

static void quad(float x0, float y0, float x1, float y1, uint32_t c) {
    push(x0, y0, c); push(x1, y0, c); push(x1, y1, c);
    push(x0, y0, c); push(x1, y1, c); push(x0, y1, c);
}

static void line(float x0, float y0, float x1, float y1, float width, uint32_t c) {
    float dx = x1 - x0, dy = y1 - y0;
    float len = sqrtf(dx * dx + dy * dy);
    if (len < 0.001f) return;
    float nx = -dy / len * width * 0.5f;
    float ny = dx / len * width * 0.5f;
    push(x0 + nx, y0 + ny, c); push(x1 + nx, y1 + ny, c); push(x1 - nx, y1 - ny, c);
    push(x0 + nx, y0 + ny, c); push(x1 - nx, y1 - ny, c); push(x0 - nx, y0 - ny, c);
}

static void project(float x, float y, float z, float *sx, float *sy) {
    float cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    float cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    float cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0.0001f) { *sx = -1e9f; *sy = -1e9f; return; }
    *sx = (cx / cw * 0.5f + 0.5f) * (float)view_w;
    *sy = (1.0f - (cy / cw * 0.5f + 0.5f)) * (float)view_h;
}

static float text_width(const char *s, float scale) {
    int n = 0;
    while (s[n]) n++;
    return (float)n * 6.0f * scale - scale;
}

static void text(const char *s, float x, float y, float scale, uint32_t color, int chip) {
    if (!s || !*s) return;
    char upper[96];
    int n = 0;
    while (s[n] && n < 95) {
        char c = s[n];
        if (c >= 'a' && c <= 'z') c = (char)(c - 32);
        upper[n] = c;
        n++;
    }
    upper[n] = 0;
    float w = text_width(upper, scale);
    if (chip) {
        quad(x - 4, y - 3, x + w + 4, y + RPD_FONT_H * scale + 3, 0xf2f0e8d6);
    }
    for (int i = 0; i < n; i++) {
        unsigned ch = (unsigned char)upper[i];
        if (ch < RPD_FONT_FIRST || ch > RPD_FONT_LAST) { x += 6.0f * scale; continue; }
        int glyph = (int)ch - RPD_FONT_FIRST;
        int cell = glyph;
        int cx = (cell % FONT_COLS) * FONT_CELL_W;
        int cy = (cell / FONT_COLS) * FONT_CELL_H;
        float u0 = (float)(cx + 1) / FONT_ATLAS_W;
        float v0 = (float)(cy + 1) / FONT_ATLAS_H;
        float u1 = (float)(cx + 1 + RPD_FONT_W) / FONT_ATLAS_W;
        float v1 = (float)(cy + 1 + RPD_FONT_H) / FONT_ATLAS_H;
        float x1 = x + RPD_FONT_W * scale;
        float y1 = y + RPD_FONT_H * scale;
        uint8_t rgb[4] = { (uint8_t)((color >> 24) & 0xff), (uint8_t)((color >> 16) & 0xff), (uint8_t)((color >> 8) & 0xff), (uint8_t)(color & 0xff) };
        if (text_count + 6 <= MAX_TEXT_VERTS) {
            text_verts[text_count++] = (text_vertex){ x, y, u0, v0, rgb[0], rgb[1], rgb[2], rgb[3] };
            text_verts[text_count++] = (text_vertex){ x1, y, u1, v0, rgb[0], rgb[1], rgb[2], rgb[3] };
            text_verts[text_count++] = (text_vertex){ x1, y1, u1, v1, rgb[0], rgb[1], rgb[2], rgb[3] };
            text_verts[text_count++] = (text_vertex){ x, y, u0, v0, rgb[0], rgb[1], rgb[2], rgb[3] };
            text_verts[text_count++] = (text_vertex){ x1, y1, u1, v1, rgb[0], rgb[1], rgb[2], rgb[3] };
            text_verts[text_count++] = (text_vertex){ x, y1, u0, v1, rgb[0], rgb[1], rgb[2], rgb[3] };
        }
        x += 6.0f * scale;
    }
}

static void draw_cell(int node, uint32_t fill, uint32_t stroke) {
    const float half = 0.5f;
    float xs[5], ys[5];
    for (int i = 0; i < 4; i++) {
        float dx = (i == 0 || i == 3) ? -half : half;
        float dz = (i < 2) ? -half : half;
        project(plan_node_x(node) + dx, plan_node_y(node) + 0.03f, plan_node_z(node) + dz, &xs[i], &ys[i]);
        if (xs[i] < -1e8f) return;
    }
    xs[4] = xs[0]; ys[4] = ys[0];
    for (int i = 0; i < 4; i++) {
        push(xs[i], ys[i], fill); push(xs[i + 1], ys[i + 1], fill); push(xs[0], ys[0], fill);
    }
    for (int i = 0; i < 4; i++) line(xs[i], ys[i], xs[i + 1], ys[i + 1], 1.5f, stroke);
}

void overlay_init(void) {
    verts = malloc(sizeof(overlay_vertex) * MAX_VERTS);
    text_verts = malloc(sizeof(text_vertex) * MAX_TEXT_VERTS);
    uint8_t atlas[FONT_ATLAS_W * FONT_ATLAS_H];
    memset(atlas, 0, sizeof(atlas));
    for (int glyph = 0; glyph < 95; glyph++) {
        int cx = (glyph % FONT_COLS) * FONT_CELL_W + 1;
        int cy = (glyph / FONT_COLS) * FONT_CELL_H + 1;
        for (int row = 0; row < RPD_FONT_H; row++) {
            uint8_t bits = rpd_font_bits[glyph][row];
            for (int c = 0; c < RPD_FONT_W; c++) {
                if (bits & (1 << c)) atlas[(cy + row) * FONT_ATLAS_W + cx + c] = 255;
            }
        }
    }
    font_image = sg_make_image(&(sg_image_desc){
        .width = FONT_ATLAS_W,
        .height = FONT_ATLAS_H,
        .pixel_format = SG_PIXELFORMAT_R8,
        .data = { .ptr = atlas, .size = sizeof(atlas) },
        .label = "rpd-font-atlas",
    });
    font_view = sg_make_view(&(sg_view_desc){ .texture = { .image = font_image }, .label = "rpd-font-view" });
    font_sampler = sg_make_sampler(&(sg_sampler_desc){
        .min_filter = SG_FILTER_LINEAR,
        .mag_filter = SG_FILTER_LINEAR,
        .label = "rpd-font-sampler",
    });
    text_vbuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .vertex_buffer = true, .write_transient = true },
        .size = sizeof(text_vertex) * MAX_TEXT_VERTS,
        .label = "overlay-text-vertices",
    });
    vbuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .vertex_buffer = true, .write_transient = true },
        .size = sizeof(overlay_vertex) * MAX_VERTS,
        .label = "overlay-vertices",
    });
    sg_shader shd = sg_make_shader(&(sg_shader_desc){
        .vertex_func.source =
            "#version 300 es\n"
            "precision highp float;\n"
            "layout(location=0) in vec2 pos;\n"
            "layout(location=1) in vec4 color;\n"
            "uniform vec4 u_view;\n"
            "out vec4 v_color;\n"
            "void main(){ gl_Position=vec4(pos.x/u_view.x*2.0-1.0, 1.0-pos.y/u_view.y*2.0, 0.0, 1.0); v_color=color; }\n",
        .fragment_func.source =
            "#version 300 es\n"
            "precision highp float;\n"
            "in vec4 v_color;\n"
            "out vec4 frag_color;\n"
            "void main(){ frag_color=v_color; }\n",
        .attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT,
        .attrs[0].glsl_name = "pos",
        .attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT,
        .attrs[1].glsl_name = "color",
        .uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX,
        .uniform_blocks[0].size = 16,
        .uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140,
        .uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4,
        .uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view",
        .label = "overlay-shader",
    });
    pip = sg_make_pipeline(&(sg_pipeline_desc){
        .shader = shd,
        .layout = {
            .attrs = {
                [0] = { .format = SG_VERTEXFORMAT_FLOAT2 },
                [1] = { .format = SG_VERTEXFORMAT_UBYTE4N, .offset = 8 },
            },
        },
        .colors[0].blend = {
            .enabled = true,
            .src_factor_rgb = SG_BLENDFACTOR_SRC_ALPHA,
            .dst_factor_rgb = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
            .src_factor_alpha = SG_BLENDFACTOR_ONE,
            .dst_factor_alpha = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
        },
        .label = "overlay-pipeline",
    });
    sg_shader text_shd = sg_make_shader(&(sg_shader_desc){
        .vertex_func.source =
            "#version 300 es\n"
            "precision highp float;\n"
            "layout(location=0) in vec2 pos;\n"
            "layout(location=1) in vec2 uv;\n"
            "layout(location=2) in vec4 color;\n"
            "uniform vec4 u_view;\n"
            "out vec2 v_uv; out vec4 v_color;\n"
            "void main(){ gl_Position=vec4(pos.x/u_view.x*2.0-1.0, 1.0-pos.y/u_view.y*2.0, 0.0, 1.0); v_uv=uv; v_color=color; }\n",
        .fragment_func.source =
            "#version 300 es\n"
            "precision highp float;\n"
            "uniform sampler2D u_font;\n"
            "in vec2 v_uv; in vec4 v_color; out vec4 frag_color;\n"
            "void main(){ float a=texture(u_font, v_uv).r; if(a<0.5) discard; frag_color=vec4(v_color.rgb, v_color.a); }\n",
        .attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT,
        .attrs[0].glsl_name = "pos",
        .attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT,
        .attrs[1].glsl_name = "uv",
        .attrs[2].base_type = SG_SHADERATTRBASETYPE_FLOAT,
        .attrs[2].glsl_name = "color",
        .uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX,
        .uniform_blocks[0].size = 16,
        .uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140,
        .uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4,
        .uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view",
        .views[0].texture.stage = SG_SHADERSTAGE_FRAGMENT,
        .views[0].texture.image_type = SG_IMAGETYPE_2D,
        .views[0].texture.sample_type = SG_IMAGESAMPLETYPE_FLOAT,
        .samplers[0].stage = SG_SHADERSTAGE_FRAGMENT,
        .samplers[0].sampler_type = SG_SAMPLERTYPE_FILTERING,
        .texture_sampler_pairs[0].stage = SG_SHADERSTAGE_FRAGMENT,
        .texture_sampler_pairs[0].view_slot = 0,
        .texture_sampler_pairs[0].sampler_slot = 0,
        .texture_sampler_pairs[0].glsl_name = "u_font",
        .label = "overlay-text-shader",
    });
    text_pip = sg_make_pipeline(&(sg_pipeline_desc){
        .shader = text_shd,
        .layout = {
            .attrs = {
                [0] = { .format = SG_VERTEXFORMAT_FLOAT2 },
                [1] = { .format = SG_VERTEXFORMAT_FLOAT2, .offset = 8 },
                [2] = { .format = SG_VERTEXFORMAT_UBYTE4N, .offset = 16 },
            },
        },
        .colors[0].blend = {
            .enabled = true,
            .src_factor_rgb = SG_BLENDFACTOR_SRC_ALPHA,
            .dst_factor_rgb = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
            .src_factor_alpha = SG_BLENDFACTOR_ONE,
            .dst_factor_alpha = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
        },
        .label = "overlay-text-pipeline",
    });
}

void overlay_build(const float *matrix, int width, int height, int ortho) {
    view_w = width > 1 ? width : 1;
    view_h = height > 1 ? height : 1;
    memcpy(vp, matrix, sizeof(vp));
    vcount = 0;
    text_count = 0;

    int level = plan_active_floor();
    float fy = plan_level();
    int hover = plan_hover();
    if (ortho && hover >= 0) {
        draw_cell(hover, 0x39ff1438, 0x39ff14e6);
    }
    int wc = plan_waypoint_count();
    const int *wp = plan_waypoints();
    for (int i = 0; ortho && i < wc; i++) {
        draw_cell(wp[i], 0x22d3ee66, 0x22d3eef2);
    }
    int rc = plan_route_count();
    const float *route = plan_route();
    for (int pass = 0; pass < 2; pass++) {
        float width_px = pass == 0 ? 7.0f : 2.0f;
        uint32_t color = pass == 0 ? 0x39ff1428 : 0x39ff14ee;
        for (int i = 0; i + 1 < rc; i++) {
            int a = i * 3, b = (i + 1) * 3;
            if (ortho && fabsf(route[a + 1] - (fy + 0.08f)) > 0.45f) continue;
            float ax, ay, bx, by;
            project(route[a], route[a + 1], route[a + 2], &ax, &ay);
            project(route[b], route[b + 1], route[b + 2], &bx, &by);
            if (ax < -1e8f || bx < -1e8f) continue;
            line(ax, ay, bx, by, width_px, color);
        }
    }

    if (ortho) {
        float placed[MAX_LABELS][4];
        int placed_count = 0;
        int rooms = plan_room_count();
        for (int i = 0; i < rooms; i++) {
            if (plan_room_floor(i) != level) continue;
            float sx, sy;
            project(plan_room_x(i), plan_room_y(i) + 1.3f, plan_room_z(i), &sx, &sy);
            if (sx < -1e8f) continue;
            if (sx < 18 || sy < 18 || sx > view_w - 18 || sy > view_h - 18) continue;
            const char *name = plan_room_name_at(i);
            if (!name || !*name) continue;
            float w = text_width(name, 1.25f);
            float x0 = sx - w * 0.5f - 4;
            float y0 = sy - 3;
            float x1 = x0 + w + 8;
            float y1 = y0 + RPD_FONT_H * 1.25f + 6;
            bool clash = false;
            for (int k = 0; k < placed_count; k++) {
                if (x0 < placed[k][2] && x1 > placed[k][0] && y0 < placed[k][3] && y1 > placed[k][1]) {
                    clash = true;
                    break;
                }
            }
            if (clash) continue;
            if (placed_count < MAX_LABELS) {
                placed[placed_count][0] = x0; placed[placed_count][1] = y0;
                placed[placed_count][2] = x1; placed[placed_count][3] = y1;
                placed_count++;
            }
            text(name, sx - w * 0.5f, sy, 1.25f, 0x4a4842f0, 1);
        }
    }

    if (ortho) {
        float p[3];
        plan_player(p);
        float sx, sy;
        project(p[0], p[1] + 1.15f, p[2], &sx, &sy);
        if (sx > -1e8f) text("CLAIRE", sx + 12, sy - 4, 1.15f, 0x9b3d78ff, 1);
    }

    if (vcount <= 0) return;
}

void overlay_upload(void) {
    if (vcount <= 0) return;
    size_t used = (size_t)vcount * sizeof(overlay_vertex);
    sg_write_buffer_transient(&(sg_write_buffer_desc){
        .src = { .data = { .ptr = verts, .size = used }, .offset = 0 },
        .dst = { .buffer = vbuf, .offset = 0 },
        .size = used,
    });
    if (text_count > 0) {
        size_t text_used = (size_t)text_count * sizeof(text_vertex);
        sg_write_buffer_transient(&(sg_write_buffer_desc){
            .src = { .data = { .ptr = text_verts, .size = text_used }, .offset = 0 },
            .dst = { .buffer = text_vbuf, .offset = 0 },
            .size = text_used,
        });
    }
}

void overlay_draw(void) {
    if (vcount <= 0) return;
    sg_apply_pipeline(pip);
    sg_apply_bindings(&(sg_bindings){ .vertex_buffers[0] = vbuf });
    float view[4] = { (float)view_w, (float)view_h, 0.0f, 0.0f };
    sg_apply_uniforms(0, &(sg_range){ .ptr = view, .size = sizeof(view) });
    if (vcount > 0) sg_draw(0, vcount, 1);
    if (text_count > 0) {
        sg_apply_pipeline(text_pip);
        sg_apply_bindings(&(sg_bindings){
            .vertex_buffers[0] = text_vbuf,
            .views[0] = font_view,
            .samplers[0] = font_sampler,
        });
        sg_apply_uniforms(0, &(sg_range){ .ptr = view, .size = sizeof(view) });
        sg_draw(0, text_count, 1);
    }
}
