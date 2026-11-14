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

void draw_tapered_line(vec2 from, vec2 to, float start_width, float end_width,
                       color start, color end) {
    vec2 d = vec2_sub(to, from);
    float len = vec2_len(d);
    if (len < 1e-5f) {
        return;
    }
    vec2 n = vec2_make(-d.y / len, d.x / len);
    float hw0 = fmaxf(start_width, 0.2f) * 0.5f;
    float hw1 = fmaxf(end_width, 0.2f) * 0.5f;
    sgl_begin_quads();
    emit_vertex(vec2_add(from, vec2_scale(n, hw0)), start);
    emit_vertex(vec2_add(to, vec2_scale(n, hw1)), end);
    emit_vertex(vec2_sub(to, vec2_scale(n, hw1)), end);
    emit_vertex(vec2_sub(from, vec2_scale(n, hw0)), start);
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

static void sprite_vertex(vec2 center, vec2 right, vec2 forward,
                          float x, float y, float u, float v, color tint) {
    sgl_v2f_t2f_c4f(center.x + right.x * x + forward.x * y,
                    center.y + right.y * x + forward.y * y,
                    u, v, tint.r, tint.g, tint.b, tint.a);
}

void draw_sprite(const texture *tex, vec2 center, float width, float height,
                 float rotation, color tint) {
    if (!tex || width <= 0.0f || height <= 0.0f || tint.a <= 0.0f) {
        return;
    }
    float hw = width * 0.5f;
    float hh = height * 0.5f;
    float s = sinf(rotation);
    float c = cosf(rotation);
    vec2 right = vec2_make(c, s);
    vec2 forward = vec2_make(s, -c);

    sgl_enable_texture();
    sgl_texture(tex->view, tex->sampler);
    sgl_begin_quads();
    sprite_vertex(center, right, forward, -hw, hh, 0.0f, 0.0f, tint);
    sprite_vertex(center, right, forward, hw, hh, 1.0f, 0.0f, tint);
    sprite_vertex(center, right, forward, hw, -hh, 1.0f, 1.0f, tint);
    sprite_vertex(center, right, forward, -hw, -hh, 0.0f, 1.0f, tint);
    sgl_end();
    sgl_disable_texture();
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
