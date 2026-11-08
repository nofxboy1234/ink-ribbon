#include "rpd_overlay.h"

#include <math.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "rpd_items.h"
#include "rpd_plan.h"
#include "rpd_popup.h"
#include "rpd_sokol.h"
#include "rpd_shaders.h"

#define MAX_VERTS (240 * 1024)
#define MAX_LABELS 64
#define DTX_SCALE 1.6f
#define DTX_CELL (8.0f * DTX_SCALE)

typedef struct {
    float x, y;
    uint8_t r, g, b, a;
} overlay_vertex;

static sg_pipeline pip;
static sg_buffer vbuf;
static overlay_vertex *verts;
static int vcount;

static int view_w = 1, view_h = 1;
static int fps_visible = 1;
static int text_ready = 1;
static float vp[16];
static int stat_items;
static int stat_labels;
static int stat_blocked;
static int stat_clashes;
static int stat_player_label;
static int stat_popup;

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

static float dtx_width(const char *s) {
    return (float)(s ? strlen(s) : 0) * DTX_CELL;
}

static void dtx_text(const char *s, float x, float y, uint32_t color, int chip) {
    if (!text_ready || !s || !*s) return;
    float width = dtx_width(s);
    if (chip) quad(x - 4, y - 3, x + width + 4, y + DTX_CELL + 3, 0xf2f0e8d6);
    sdtx_pos(x / DTX_CELL, y / DTX_CELL);
    uint8_t *rgba = (uint8_t *)col(color);
    sdtx_color4b(rgba[0], rgba[1], rgba[2], rgba[3]);
    sdtx_puts(s);
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

void overlay_set_fps_visible(int visible) {
    fps_visible = visible != 0;
}

void overlay_set_text_ready(int ready) {
    text_ready = ready != 0;
}

void overlay_init(void) {
    verts = malloc(sizeof(overlay_vertex) * MAX_VERTS);
    vbuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .vertex_buffer = true, .write_transient = true },
        .size = sizeof(overlay_vertex) * MAX_VERTS,
        .label = "overlay-vertices",
    });
    sg_shader shd = sg_make_shader(overlay_shader_desc(sg_query_backend()));
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
}

static bool rects_overlap(const float *a, const float *b) {
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

void overlay_stats(float *out) {
    if (!out) return;
    out[0] = (float)stat_items;
    out[1] = (float)stat_labels;
    out[2] = (float)stat_blocked;
    out[3] = (float)stat_clashes;
    out[4] = (float)stat_player_label;
    out[5] = (float)stat_popup;
}

static void draw_items(void) {
    int count = items_count();
    int level = plan_active_floor();
    for (int i = 0; i < count; i++) {
        const item_t *item = items_get(i);
        if (!item || item->state != ITEM_PRESENT) continue;
        if (item->def->floor != level) continue;
        // A modelled item is already drawn in 3D; the diamond is the ortho
        // stand-in for the fixtures that have no model.
        if (item->def->model != NULL) continue;
        float sx, sy;
        project(item->def->x, item->def->y, item->def->z, &sx, &sy);
        if (sx < -1e8f) continue;
        stat_items++;
        uint8_t r = (uint8_t)(item->r * 255.0f);
        uint8_t g = (uint8_t)(item->g * 255.0f);
        uint8_t b = (uint8_t)(item->b * 255.0f);
        uint32_t color = ((uint32_t)r << 24) | ((uint32_t)g << 16) | ((uint32_t)b << 8) | 0xffu;
        float radius = 7.0f;
        push(sx, sy - radius, color);
        push(sx + radius, sy, color);
        push(sx, sy + radius, color);
        push(sx, sy - radius, color);
        push(sx, sy + radius, color);
        push(sx - radius, sy, color);
        line(sx - radius, sy, sx + radius, sy, 1.0f, 0x24221ee6);
    }
}

static void draw_popup(void) {
    const popup_t *p = popup_get();
    if (!p || p->phase != POPUP_CHOOSING) return;
    float x0, y0, w, h;
    popup_layout(&x0, &y0, &w, &h);
    quad(x0 + 5.0f, y0 + 6.0f, x0 + w + 5.0f, y0 + h + 6.0f, 0x24221e38);
    quad(x0, y0, x0 + w, y0 + h, 0xfaf7efff);
    line(x0, y0, x0 + w, y0, 2.0f, 0x24221ee6);
    line(x0 + w, y0, x0 + w, y0 + h, 2.0f, 0x24221ee6);
    line(x0, y0 + h, x0 + w, y0 + h, 2.0f, 0x24221ee6);
    line(x0, y0, x0, y0 + h, 2.0f, 0x24221ee6);
    if (p->message[0]) {
        dtx_text(p->message, x0 + 12.0f, y0 + 10.0f, 0x24221ecc, 0);
    }
    for (int i = 0; i < p->choice_count; i++) {
        float rect[4];
        if (!popup_choice_rect(i, rect)) continue;
        const popup_choice_t *choice = &p->choices[i];
        bool hot = choice->enabled && p->hover == i;
        if (hot) quad(rect[0], rect[1], rect[2], rect[3], 0x24221ee6);
        uint32_t color = choice->enabled ? (hot ? 0xf5f1e6ff : 0x24221eff) : 0x24221e66;
        dtx_text(choice->label, rect[0] + 9.0f, rect[1] + 7.0f, color, 0);
        if (i + 1 < p->choice_count) {
            line(rect[0], rect[3], rect[2], rect[3], 1.0f, 0x24221e22);
        }
    }
}

void overlay_build(const float *matrix, int width, int height, int ortho, float fps) {
    view_w = width > 1 ? width : 1;
    view_h = height > 1 ? height : 1;
    memcpy(vp, matrix, sizeof(vp));
    vcount = 0;
    stat_items = 0;
    stat_labels = 0;
    stat_blocked = 0;
    stat_clashes = 0;
    stat_player_label = 0;
    stat_popup = popup_is_open() ? 1 : 0;
    if (text_ready) {
        sdtx_canvas((float)view_w / DTX_SCALE, (float)view_h / DTX_SCALE);
        sdtx_origin(0.0f, 0.0f);
    }

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
        float popup_rect[4] = { 0, 0, 0, 0 };
        bool popup_open = popup_is_open();
        if (popup_open) {
            float w, h;
            popup_layout(&popup_rect[0], &popup_rect[1], &w, &h);
            popup_rect[2] = popup_rect[0] + w;
            popup_rect[3] = popup_rect[1] + h;
            placed[placed_count][0] = popup_rect[0];
            placed[placed_count][1] = popup_rect[1];
            placed[placed_count][2] = popup_rect[2];
            placed[placed_count][3] = popup_rect[3];
            placed_count++;
        }
        float player[3];
        plan_player(player);
        float psx, psy;
        project(player[0], player[1] + 1.15f, player[2], &psx, &psy);
        bool player_visible = psx > -1e8f && plan_player_floor() == level;
        float player_w = dtx_width("CLAIRE");
        float player_rect[4] = {
            psx + 15 - 4, psy - 5 - 3,
            psx + 15 + player_w + 4, psy - 5 + DTX_CELL + 3,
        };
        if (player_visible) {
            if (popup_open && rects_overlap(player_rect, popup_rect)) {
                player_visible = false;
                stat_blocked++;
            } else if (placed_count < MAX_LABELS) {
                memcpy(placed[placed_count], player_rect, sizeof(player_rect));
                placed_count++;
            }
        }
        int rooms = plan_room_count();
        for (int i = 0; i < rooms; i++) {
            if (plan_room_floor(i) != level) continue;
            float sx, sy;
            project(plan_room_x(i), plan_room_y(i) + 1.3f, plan_room_z(i), &sx, &sy);
            if (sx < -1e8f) continue;
            if (sx < 18 || sy < 18 || sx > view_w - 18 || sy > view_h - 18) continue;
            const char *name = plan_room_name_at(i);
            if (!name || !*name) continue;
            float w = dtx_width(name);
            float x0 = sx - w * 0.5f - 4;
            float y0 = sy - 4;
            float x1 = x0 + w + 8;
            float y1 = y0 + DTX_CELL + 8;
            float label_rect[4] = { x0, y0, x1, y1 };
            bool clash = false;
            for (int k = 0; k < placed_count; k++) {
                if (rects_overlap(label_rect, placed[k])) {
                    clash = true;
                    break;
                }
            }
            if (clash) {
                if (popup_open && rects_overlap(label_rect, popup_rect)) stat_blocked++;
                continue;
            }
            if (placed_count < MAX_LABELS) {
                memcpy(placed[placed_count], label_rect, sizeof(label_rect));
                placed_count++;
            }
            dtx_text(name, sx - w * 0.5f, sy, 0x4a4842f0, 1);
            stat_labels++;
            if (popup_open && rects_overlap(label_rect, popup_rect)) stat_clashes++;
        }
        if (player_visible) {
            dtx_text("CLAIRE", psx + 15.0f, psy - 5.0f, 0x9b3d78ff, 1);
            stat_player_label++;
            stat_labels++;
            if (popup_open && rects_overlap(player_rect, popup_rect)) stat_clashes++;
        }
    }

    if (ortho) draw_items();
    draw_popup();

    if (fps_visible) {
        char buf[32];
        if (fps >= 0.5f) snprintf(buf, sizeof(buf), "FPS %d", (int)(fps + 0.5f));
        else snprintf(buf, sizeof(buf), "FPS --");
        dtx_text(buf, (float)view_w - dtx_width(buf) - 390.0f, 16.0f, 0x4a4842f0, 1);
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
}

void overlay_draw(void) {
    if (vcount > 0) {
        sg_apply_pipeline(pip);
        sg_apply_bindings(&(sg_bindings){ .vertex_buffers[0] = vbuf });
        u_view_t view = { { (float)view_w, (float)view_h, 0.0f, 0.0f } };
        sg_apply_uniforms(UB_u_view, &(sg_range){ .ptr = &view, .size = sizeof(view) });
        sg_draw(0, vcount, 1);
    }
    if (text_ready) sdtx_draw();
}
