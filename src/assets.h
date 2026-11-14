#ifndef ASSETS_H
#define ASSETS_H

#ifndef SOKOL_GFX_INCLUDED
#include "sokol_gfx.h"
#endif

typedef struct {
    sg_image image;
    sg_view view;
    sg_sampler sampler;
    int width;
    int height;
} texture;

typedef struct {
    texture map;
    texture door_service;
    texture door_locked;
    texture door_locked_hover;
    texture player_arrow;
    texture player_glow;
    texture cursor_ring;
    texture tooltip;
    texture legend_searching;
    texture legend_complete;
} assets;

assets *assets_load(void);
void assets_destroy(assets *loaded);

#endif
