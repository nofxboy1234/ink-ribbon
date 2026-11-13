#include "rpd_overlay.h"
#include "rpd_map.h"

#include <math.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "rpd_game.h"
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
static int stat_hover_item;
static int stat_labels;
static int stat_blocked;
static int stat_clashes;
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

static void tri(float x0, float y0, float x1, float y1, float x2, float y2, uint32_t c) {
    push(x0, y0, c); push(x1, y1, c); push(x2, y2, c);
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
    out[0] = (float)stat_hover_item;
    out[1] = (float)stat_labels;
    out[2] = (float)stat_blocked;
    out[3] = (float)stat_clashes;
    out[4] = 0.0f;
    out[5] = (float)stat_popup;
}

static void draw_item_hover(void) {
    int index = plan_hover_item();
    if (index < 0) return;
    const item_t *item = items_get(index);
    if (!item || item->state != ITEM_PRESENT) return;
    float pos[3], sx, sy;
    items_cube_position(index, pos);
    project(pos[0], pos[1], pos[2], &sx, &sy);
    if (sx < -1e8f) return;
    const char *name = item->def->title;
    float width = dtx_width(name);
    float x = sx - width * 0.5f;
    float y = sy - 30.0f;
    if (x < 6.0f) x = 6.0f;
    if (x + width + 8.0f > (float)view_w - 6.0f) x = (float)view_w - width - 14.0f;
    if (y < 6.0f) y = sy + 14.0f;
    dtx_text(name, x, y, 0x24221eff, 1);
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

static void draw_debug_frame(void) {
    if (!game_debug() || view_w <= 404) return;
    const float inset = 380.0f;
    const float pad = 6.0f;
    const float thick = 3.0f;
    const uint32_t color = 0xFF8A00FF;
    float x0 = pad, y0 = pad;
    float x1 = (float)view_w - inset - pad;
    float y1 = (float)view_h - pad;
    quad(x0, y0, x1, y0 + thick, color);
    quad(x0, y1 - thick, x1, y1, color);
    quad(x0, y0, x0 + thick, y1, color);
    quad(x1 - thick, y0, x1, y1, color);
}

static float ring_time;

static void draw_player_ring(int ortho) {
    float player[3];
    plan_player(player);
    const float y = player[1] + 0.85f;
    if (ortho && fabsf(y - plan_level()) > 2.6f) return;
    float sx, sy;
    project(player[0], y, player[2], &sx, &sy);
    if (sx < -1e8f) return;
    const float phase = fmodf(ring_time, 1.2f) / 1.2f;
    const float radius = 10.0f + phase * 28.0f;
    const uint32_t color = 0x50fa7b00u | (uint32_t)((1.0f - phase) * 220.0f);
    const int segments = 40;
    for (int i = 0; i < segments; i++) {
        const float a0 = (float)i * 6.2831853f / (float)segments;
        const float a1 = (float)(i + 1) * 6.2831853f / (float)segments;
        line(sx + cosf(a0) * radius, sy + sinf(a0) * radius,
             sx + cosf(a1) * radius, sy + sinf(a1) * radius, 2.5f, color);
    }
}

static uint32_t room_fill(int state) {
    if (state == 1) return 0x4f1416ff;
    if (state == 2) return 0x1b2c3aff;
    return 0x0d0b09ff;
}

static uint32_t room_edge(int state) {
    if (state == 1) return 0xd8b4a6ff;
    if (state == 2) return 0xb8d0e0ff;
    return 0xd0cabcff;
}

static void draw_map(void) {
    if (!map_loaded()) return;
    const map_floor_t *f = map_get(plan_active_floor());
    if (!f) return;
    float current[3];
    plan_player(current);
    map_update(plan_player_floor(), current[0], current[2]);
    quad(0.0f, 0.0f, (float)view_w, (float)view_h, 0x080706ff);
    float sy0 = f->level;
    for (int t = 0; t < f->tri_count; t++) {
        const map_tri *tr = &f->tris[t];
        float ax, ay, bx, by, cx, cy;
        project(f->verts[tr->a].x, sy0, f->verts[tr->a].z, &ax, &ay);
        project(f->verts[tr->b].x, sy0, f->verts[tr->b].z, &bx, &by);
        project(f->verts[tr->c].x, sy0, f->verts[tr->c].z, &cx, &cy);
        if (ax < -1e8f || bx < -1e8f || cx < -1e8f) continue;
        tri(ax, ay, bx, by, cx, cy, room_fill(map_room_state(plan_active_floor(), tr->room)));
    }
    for (int r = 0; r < f->room_count; r++) {
        const map_room *room = &f->rooms[r];
        uint32_t edge = room_edge(map_room_state(plan_active_floor(), r));
        for (int i = 0; i < room->count; i++) {
            const map_vec2 *a = &f->verts[room->start + i];
            const map_vec2 *b = &f->verts[room->start + (i + 1) % room->count];
            float ax, ay, bx, by;
            project(a->x, sy0, a->z, &ax, &ay);
            project(b->x, sy0, b->z, &bx, &by);
            if (ax < -1e8f || bx < -1e8f) continue;
            line(ax, ay, bx, by, 1.1f, edge);
        }
    }
    for (int d = 0; d < f->door_count; d++) {
        const map_door *door = &f->doors[d];
        float half = 0.55f;
        float dx = cosf(door->yaw) * half;
        float dz = sinf(door->yaw) * half;
        float ax, ay, bx, by;
        project(door->x - dx, sy0, door->z - dz, &ax, &ay);
        project(door->x + dx, sy0, door->z + dz, &bx, &by);
        if (ax < -1e8f || bx < -1e8f) continue;
        int state = map_door_state(plan_active_floor(), d);
        uint32_t colour = state == 1 ? 0xd23c3cff : state == 2 ? 0x3c78c8ff : 0xf0ead8ff;
        line(ax, ay, bx, by, 2.4f, colour);
    }
    for (int i = 0; i < f->item_count; i++) {
        const map_item *item = &f->items[i];
        float sx, sy;
        project(item->x, sy0, item->z, &sx, &sy);
        if (sx < -1e8f) continue;
        uint32_t colour = 0xff000000u | (item->colour & 0xffffffu);
        float size = (item->flags & 1) ? 3.5f : 2.0f;
        quad(sx - size, sy - size, sx + size, sy + size, colour);
    }
    for (int i = 0; i < f->stair_count; i++) {
        const map_stair *stair = &f->stairs[i];
        float sx, sy;
        project(stair->x, sy0, stair->z, &sx, &sy);
        if (sx < -1e8f) continue;
        line(sx - 3.0f, sy, sx + 3.0f, sy, 2.0f, 0xbfb8a8ff);
        line(sx, sy - 3.0f, sx, sy + 3.0f, 2.0f, 0xbfb8a8ff);
    }
    float player[3];
    plan_player(player);
    if (plan_player_floor() == plan_active_floor()) {
        float px, py;
        project(player[0], sy0, player[2], &px, &py);
        if (px > -1e8f) {
            const float phase = fmodf(ring_time, 1.4f) / 1.4f;
            uint32_t alpha = (uint32_t)((1.0f - phase) * 170.0f);
            uint32_t pulse = 0xffd54a00u | alpha;
            float radius = 8.0f + phase * 20.0f;
            for (int i = 0; i < 24; i++) {
                float a0 = (float)i * 6.2831853f / 24.0f;
                float a1 = (float)(i + 1) * 6.2831853f / 24.0f;
                line(px + cosf(a0) * radius, py + sinf(a0) * radius,
                     px + cosf(a1) * radius, py + sinf(a1) * radius, 1.5f, pulse);
            }
            tri(px, py - 8.0f, px + 5.0f, py + 5.0f, px - 5.0f, py + 5.0f, 0xffd54aff);
            tri(px, py - 5.0f, px + 3.0f, py + 4.0f, px - 3.0f, py + 4.0f, 0x1a1710ff);
        }
    }
    float cx = (float)view_w * 0.5f - 190.0f;
    float cy = (float)view_h * 0.5f;
    for (int i = 0; i < 32; i++) {
        float a0 = (float)i * 6.2831853f / 32.0f;
        float a1 = (float)(i + 1) * 6.2831853f / 32.0f;
        line(cx + cosf(a0) * 9.0f, cy + sinf(a0) * 9.0f,
             cx + cosf(a1) * 9.0f, cy + sinf(a1) * 9.0f, 1.2f, 0xe8e2d4cc);
    }
    for (int i = 0; i < 4; i++) {
        float a = (float)i * 6.2831853f / 4.0f + 0.785398f;
        line(cx + cosf(a) * 15.0f, cy + sinf(a) * 15.0f,
             cx + cosf(a) * 23.0f, cy + sinf(a) * 23.0f, 1.1f, 0xe8e2d466);
    }
}

void overlay_build(const float *matrix, int width, int height, int ortho, float fps) {
    ring_time += (float)sapp_frame_duration();
    view_w = width > 1 ? width : 1;
    view_h = height > 1 ? height : 1;
    memcpy(vp, matrix, sizeof(vp));
    vcount = 0;
    draw_map();
    stat_hover_item = ortho ? plan_hover_item() : -1;
    stat_labels = 0;
    stat_blocked = 0;
    stat_clashes = 0;
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
        draw_item_hover();
    }

    draw_popup();

    if (fps_visible) {
        char buf[32];
        if (fps >= 0.5f) snprintf(buf, sizeof(buf), "FPS %d", (int)(fps + 0.5f));
        else snprintf(buf, sizeof(buf), "FPS --");
        dtx_text(buf, (float)view_w - dtx_width(buf) - 390.0f, 16.0f, 0x4a4842f0, 1);
    }
    draw_debug_frame();
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
