#include "assets.h"

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef MAP_ASSET_DIR
#define MAP_ASSET_DIR "assets"
#endif

static unsigned char *decode_png(const char *name, int *width, int *height) {
    char path[1024];
    int channels = 0;
    const char *env = getenv("MAP_ASSETS");

    if (env) {
        snprintf(path, sizeof(path), "%s/%s", env, name);
        unsigned char *pixels = stbi_load(path, width, height, &channels, 4);
        if (pixels) {
            return pixels;
        }
    }
    snprintf(path, sizeof(path), "assets/%s", name);
    unsigned char *pixels = stbi_load(path, width, height, &channels, 4);
    if (pixels) {
        return pixels;
    }
    snprintf(path, sizeof(path), "%s/%s", MAP_ASSET_DIR, name);
    return stbi_load(path, width, height, &channels, 4);
}

static bool load_texture(texture *tex, const char *name) {
    int width = 0;
    int height = 0;
    unsigned char *pixels = decode_png(name, &width, &height);
    if (!pixels) {
        fprintf(stderr, "assets: could not load %s\n", name);
        return false;
    }

    tex->image = sg_make_image(&(sg_image_desc){
        .width = width,
        .height = height,
        .pixel_format = SG_PIXELFORMAT_RGBA8,
        .data = {
            .ptr = pixels,
            .size = (size_t)width * (size_t)height * 4,
        },
    });
    stbi_image_free(pixels);

    tex->view = sg_make_view(&(sg_view_desc){
        .texture.image = tex->image,
    });
    tex->sampler = sg_make_sampler(&(sg_sampler_desc){
        .min_filter = SG_FILTER_LINEAR,
        .mag_filter = SG_FILTER_LINEAR,
        .wrap_u = SG_WRAP_CLAMP_TO_EDGE,
        .wrap_v = SG_WRAP_CLAMP_TO_EDGE,
    });
    tex->width = width;
    tex->height = height;
    return true;
}

static void destroy_texture(texture *tex) {
    if (tex->view.id != SG_INVALID_ID) {
        sg_destroy_view(tex->view);
    }
    if (tex->sampler.id != SG_INVALID_ID) {
        sg_destroy_sampler(tex->sampler);
    }
    if (tex->image.id != SG_INVALID_ID) {
        sg_destroy_image(tex->image);
    }
    *tex = (texture){0};
}

assets *assets_load(void) {
    assets *loaded = (assets *)calloc(1, sizeof(assets));
    if (!loaded) {
        fprintf(stderr, "assets: could not allocate asset table\n");
        return NULL;
    }

    bool ok = load_texture(&loaded->map, "map.png") &&
              load_texture(&loaded->door_service, "door_service.png") &&
              load_texture(&loaded->door_locked, "door_locked.png") &&
              load_texture(&loaded->door_locked_hover, "door_locked_hover.png") &&
              load_texture(&loaded->player_arrow, "player_arrow.png") &&
              load_texture(&loaded->player_glow, "player_glow.png") &&
              load_texture(&loaded->pulse_ring, "pulse_ring.png") &&
              load_texture(&loaded->cursor_ring, "cursor_ring.png") &&
              load_texture(&loaded->tooltip, "tooltip.png") &&
              load_texture(&loaded->legend_searching, "legend_searching.png") &&
              load_texture(&loaded->legend_complete, "legend_complete.png");
    if (!ok) {
        assets_destroy(loaded);
        return NULL;
    }
    return loaded;
}

void assets_destroy(assets *loaded) {
    if (!loaded) {
        return;
    }
    destroy_texture(&loaded->map);
    destroy_texture(&loaded->door_service);
    destroy_texture(&loaded->door_locked);
    destroy_texture(&loaded->door_locked_hover);
    destroy_texture(&loaded->player_arrow);
    destroy_texture(&loaded->player_glow);
    destroy_texture(&loaded->pulse_ring);
    destroy_texture(&loaded->cursor_ring);
    destroy_texture(&loaded->tooltip);
    destroy_texture(&loaded->legend_searching);
    destroy_texture(&loaded->legend_complete);
    free(loaded);
}
