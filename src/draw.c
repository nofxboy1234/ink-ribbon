#include "draw.h"

#include "sokol_gfx.h"
#include "sokol_gl.h"
#include "sokol_fontstash.h"

#include <math.h>
#include <stdint.h>

static FONScontext *draw_fons = NULL;
static int draw_fonts[2] = {FONS_INVALID, FONS_INVALID};

void draw_fonts_init(FONScontext *fons, int regular, int medium) {
    draw_fons = fons;
    draw_fonts[DRAW_FONT_REGULAR] = regular;
    draw_fonts[DRAW_FONT_MEDIUM] = medium == FONS_INVALID ? regular : medium;
}

static void emit_color(color c) {
    sgl_c4f(c.r, c.g, c.b, c.a);
}

static void emit_vertex(vec2 p, color c) {
    emit_color(c);
    sgl_v2f(p.x, p.y);
}

void draw_rect_fill(rect r, color c) {
    sgl_begin_quads();
    emit_vertex(vec2_make(r.x, r.y), c);
    emit_vertex(vec2_make(r.x + r.w, r.y), c);
    emit_vertex(vec2_make(r.x + r.w, r.y + r.h), c);
    emit_vertex(vec2_make(r.x, r.y + r.h), c);
    sgl_end();
}

void draw_rect_gradient(rect r, color top, color bottom) {
    sgl_begin_quads();
    emit_vertex(vec2_make(r.x, r.y), top);
    emit_vertex(vec2_make(r.x + r.w, r.y), top);
    emit_vertex(vec2_make(r.x + r.w, r.y + r.h), bottom);
    emit_vertex(vec2_make(r.x, r.y + r.h), bottom);
    sgl_end();
}

void draw_rect_gradient_h(rect r, color left, color right) {
    sgl_begin_quads();
    emit_vertex(vec2_make(r.x, r.y), left);
    emit_vertex(vec2_make(r.x + r.w, r.y), right);
    emit_vertex(vec2_make(r.x + r.w, r.y + r.h), right);
    emit_vertex(vec2_make(r.x, r.y + r.h), left);
    sgl_end();
}

static void draw_arc_fan(vec2 center, float radius, float a0, float a1, int segments, color c) {
    sgl_begin_triangles();
    for (int i = 0; i < segments; i++) {
        float t0 = a0 + (a1 - a0) * (float)i / (float)segments;
        float t1 = a0 + (a1 - a0) * (float)(i + 1) / (float)segments;
        emit_vertex(center, c);
        emit_vertex(vec2_make(center.x + cosf(t0) * radius, center.y + sinf(t0) * radius), c);
        emit_vertex(vec2_make(center.x + cosf(t1) * radius, center.y + sinf(t1) * radius), c);
    }
    sgl_end();
}

void draw_rounded_rect(rect r, float radius, color fill, color border, float border_width) {
    float rad = clampf(radius, 0.0f, fminf(r.w, r.h) * 0.5f);
    if (rad < 0.5f) {
        draw_rect_fill(r, fill);
        if (border.a > 0.0f) {
            draw_polyline((vec2[]){
                {r.x, r.y}, {r.x + r.w, r.y}, {r.x + r.w, r.y + r.h}, {r.x, r.y + r.h}
            }, 4, true, border_width, border);
        }
        return;
    }

    draw_rect_fill((rect){r.x + rad, r.y, r.w - 2.0f * rad, r.h}, fill);
    draw_rect_fill((rect){r.x, r.y + rad, rad, r.h - 2.0f * rad}, fill);
    draw_rect_fill((rect){r.x + r.w - rad, r.y + rad, rad, r.h - 2.0f * rad}, fill);

    int segs = 6;
    draw_arc_fan(vec2_make(r.x + rad, r.y + rad), rad, MAP_PI, MAP_PI * 1.5f, segs, fill);
    draw_arc_fan(vec2_make(r.x + r.w - rad, r.y + rad), rad, -MAP_PI * 0.5f, 0.0f, segs, fill);
    draw_arc_fan(vec2_make(r.x + r.w - rad, r.y + r.h - rad), rad, 0.0f, MAP_PI * 0.5f, segs, fill);
    draw_arc_fan(vec2_make(r.x + rad, r.y + r.h - rad), rad, MAP_PI * 0.5f, MAP_PI, segs, fill);

    if (border.a > 0.0f) {
        vec2 pts[64];
        int n = 0;
        pts[n++] = vec2_make(r.x + rad, r.y);
        pts[n++] = vec2_make(r.x + r.w - rad, r.y);
        for (int i = 0; i <= segs; i++) {
            float a = -MAP_PI * 0.5f + (MAP_PI * 0.5f) * (float)i / (float)segs;
            pts[n++] = vec2_make(r.x + r.w - rad + cosf(a) * rad, r.y + rad + sinf(a) * rad);
        }
        pts[n++] = vec2_make(r.x + r.w, r.y + r.h - rad);
        for (int i = 0; i <= segs; i++) {
            float a = (MAP_PI * 0.5f) * (float)i / (float)segs;
            pts[n++] = vec2_make(r.x + r.w - rad + cosf(a) * rad, r.y + r.h - rad + sinf(a) * rad);
        }
        pts[n++] = vec2_make(r.x + rad, r.y + r.h);
        for (int i = 0; i <= segs; i++) {
            float a = MAP_PI * 0.5f + (MAP_PI * 0.5f) * (float)i / (float)segs;
            pts[n++] = vec2_make(r.x + rad + cosf(a) * rad, r.y + r.h - rad + sinf(a) * rad);
        }
        pts[n++] = vec2_make(r.x, r.y + rad);
        for (int i = 0; i <= segs; i++) {
            float a = MAP_PI + (MAP_PI * 0.5f) * (float)i / (float)segs;
            pts[n++] = vec2_make(r.x + rad + cosf(a) * rad, r.y + rad + sinf(a) * rad);
        }
        draw_polyline(pts, n, true, border_width, border);
    }
}

void draw_triangle_fan(vec2 pivot, color pivot_color, const vec2 *rim,
                       const color *rim_color, int count) {
    sgl_begin_triangles();
    for (int i = 0; i < count; i++) {
        int next = (i + 1) % count;
        emit_vertex(pivot, pivot_color);
        emit_vertex(rim[i], rim_color[i]);
        emit_vertex(rim[next], rim_color[next]);
    }
    sgl_end();
}

void draw_radial_glow(vec2 center, float radius, color inner, color outer, int segments) {
    if (segments < 3) {
        segments = 3;
    }
    sgl_begin_triangles();
    for (int i = 0; i < segments; i++) {
        float a0 = 2.0f * MAP_PI * (float)i / (float)segments;
        float a1 = 2.0f * MAP_PI * (float)(i + 1) / (float)segments;
        emit_vertex(center, inner);
        emit_vertex(vec2_make(center.x + cosf(a0) * radius, center.y + sinf(a0) * radius), outer);
        emit_vertex(vec2_make(center.x + cosf(a1) * radius, center.y + sinf(a1) * radius), outer);
    }
    sgl_end();
}

void draw_circle_fill(vec2 center, float radius, color c, int segments) {
    if (segments < 6) {
        segments = 6;
    }
    sgl_begin_triangles();
    for (int i = 0; i < segments; i++) {
        float a0 = 2.0f * MAP_PI * (float)i / (float)segments;
        float a1 = 2.0f * MAP_PI * (float)(i + 1) / (float)segments;
        emit_vertex(center, c);
        emit_vertex(vec2_make(center.x + cosf(a0) * radius, center.y + sinf(a0) * radius), c);
        emit_vertex(vec2_make(center.x + cosf(a1) * radius, center.y + sinf(a1) * radius), c);
    }
    sgl_end();
}

void draw_ring(vec2 center, float radius, float width, color c, int segments) {
    if (segments < 6) {
        segments = 6;
    }
    float hw = fmaxf(width, 0.6f) * 0.5f;
    sgl_begin_quads();
    for (int i = 0; i < segments; i++) {
        float a0 = 2.0f * MAP_PI * (float)i / (float)segments;
        float a1 = 2.0f * MAP_PI * (float)(i + 1) / (float)segments;
        float c0 = cosf(a0);
        float s0 = sinf(a0);
        float c1 = cosf(a1);
        float s1 = sinf(a1);
        emit_vertex(vec2_make(center.x + c0 * (radius - hw), center.y + s0 * (radius - hw)), c);
        emit_vertex(vec2_make(center.x + c0 * (radius + hw), center.y + s0 * (radius + hw)), c);
        emit_vertex(vec2_make(center.x + c1 * (radius + hw), center.y + s1 * (radius + hw)), c);
        emit_vertex(vec2_make(center.x + c1 * (radius - hw), center.y + s1 * (radius - hw)), c);
    }
    sgl_end();
}

void draw_line(vec2 a, vec2 b, float width, color c) {
    vec2 d = vec2_sub(b, a);
    float len = vec2_len(d);
    if (len < 1e-5f) {
        return;
    }
    vec2 n = vec2_make(-d.y / len, d.x / len);
    float hw = fmaxf(width, 0.6f) * 0.5f;
    n = vec2_scale(n, hw);
    sgl_begin_quads();
    emit_vertex(vec2_add(a, n), c);
    emit_vertex(vec2_add(b, n), c);
    emit_vertex(vec2_sub(b, n), c);
    emit_vertex(vec2_sub(a, n), c);
    sgl_end();
}

void draw_polyline(const vec2 *pts, int count, bool closed, float width, color c) {
    if (count < 2) {
        return;
    }
    int segs = closed ? count : count - 1;
    for (int i = 0; i < segs; i++) {
        draw_line(pts[i], pts[(i + 1) % count], width, c);
    }
    float r = fmaxf(width, 0.6f) * 0.5f;
    for (int i = 0; i < count; i++) {
        draw_circle_fill(pts[i], r, c, 10);
    }
}

void draw_chevron(vec2 center, float width, float height, float heading,
                  color top, color bottom, color outline) {
    static const float lx[6] = {-0.5f, 0.0f, 0.5f, 0.36f, 0.0f, -0.36f};
    static const float ly[6] = {-0.5f, 0.55f, -0.5f, -0.18f, 0.12f, -0.18f};

    vec2 pts[6];
    color cols[6];
    float s = sinf(heading);
    float c = cosf(heading);
    vec2 right = vec2_make(c, s);
    vec2 forward = vec2_make(s, -c);

    for (int i = 0; i < 6; i++) {
        vec2 offset = vec2_add(vec2_scale(right, lx[i] * width),
                               vec2_scale(forward, ly[i] * height));
        pts[i] = vec2_add(center, offset);
        float t = ly[i] + 0.5f;
        cols[i] = color_lerp(bottom, top, t);
    }

    static const int tris[4][3] = {
        {0, 1, 4}, {0, 4, 5}, {1, 2, 3}, {1, 3, 4},
    };
    sgl_begin_triangles();
    for (int i = 0; i < 4; i++) {
        for (int k = 0; k < 3; k++) {
            int idx = tris[i][k];
            emit_vertex(pts[idx], cols[idx]);
        }
    }
    sgl_end();

    if (outline.a > 0.0f) {
        draw_polyline(pts, 6, true, 1.0f, outline);
    }
}

float draw_text_width(draw_font font, float size, const char *text) {
    if (!draw_fons) {
        return 0.0f;
    }
    fonsSetFont(draw_fons, draw_fonts[font]);
    fonsSetSize(draw_fons, size);
    return fonsTextBounds(draw_fons, 0.0f, 0.0f, text, NULL, NULL);
}

void draw_text(draw_font font, float size, color c, int align, vec2 pos, const char *text) {
    if (!draw_fons) {
        return;
    }
    fonsSetFont(draw_fons, draw_fonts[font]);
    fonsSetSize(draw_fons, size);
    fonsSetColor(draw_fons, sfons_rgba(
        (uint8_t)clampf(c.r * 255.0f + 0.5f, 0.0f, 255.0f),
        (uint8_t)clampf(c.g * 255.0f + 0.5f, 0.0f, 255.0f),
        (uint8_t)clampf(c.b * 255.0f + 0.5f, 0.0f, 255.0f),
        (uint8_t)clampf(c.a * 255.0f + 0.5f, 0.0f, 255.0f)));
    fonsSetAlign(draw_fons, align);
    fonsDrawText(draw_fons, pos.x, pos.y, text, NULL);
}

void draw_text_flush(void) {
    if (draw_fons) {
        sfons_flush(draw_fons);
    }
}
