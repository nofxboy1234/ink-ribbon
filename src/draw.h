#ifndef DRAW_H
#define DRAW_H

#include "app.h"
#include "assets.h"
#include "fontstash.h"

typedef enum {
    DRAW_FONT_REGULAR = 0,
    DRAW_FONT_MEDIUM = 1,
} draw_font;

void draw_fonts_init(FONScontext *fons, int regular, int medium);

void draw_rect_fill(rect r, color c);
void draw_rect_gradient(rect r, color top, color bottom);
void draw_rect_gradient_h(rect r, color left, color right);
void draw_line(vec2 a, vec2 b, float width, color c);
void draw_circle_outline(vec2 center, float radius, float width, color c);
void draw_sprite(const texture *tex, vec2 center, float width, float height,
                 float rotation, color tint);

float draw_text_width(draw_font font, float size, const char *text);
void draw_text(draw_font font, float size, color c, int align, vec2 pos, const char *text);
void draw_text_flush(void);

#endif
