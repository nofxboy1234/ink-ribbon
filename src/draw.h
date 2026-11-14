#ifndef DRAW_H
#define DRAW_H

#include "app.h"
#include "fontstash.h"

typedef enum {
    DRAW_FONT_REGULAR = 0,
    DRAW_FONT_MEDIUM = 1,
} draw_font;

void draw_fonts_init(FONScontext *fons, int regular, int medium);

void draw_rect_fill(rect r, color c);
void draw_rect_gradient(rect r, color top, color bottom);
void draw_rect_gradient_h(rect r, color left, color right);
void draw_rounded_rect(rect r, float radius, color fill, color border, float border_width);
void draw_triangle_fan(vec2 pivot, color pivot_color, const vec2 *rim,
                       const color *rim_color, int count);
void draw_radial_glow(vec2 center, float radius, color inner, color outer, int segments);
void draw_circle_fill(vec2 center, float radius, color c, int segments);
void draw_ring(vec2 center, float radius, float width, color c, int segments);
void draw_line(vec2 a, vec2 b, float width, color c);
void draw_polyline(const vec2 *pts, int count, bool closed, float width, color c);
void draw_chevron(vec2 center, float width, float height, float heading,
                  color top, color bottom, color outline);

float draw_text_width(draw_font font, float size, const char *text);
void draw_text(draw_font font, float size, color c, int align, vec2 pos, const char *text);
void draw_text_flush(void);

#endif
