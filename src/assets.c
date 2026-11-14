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

static int mip_dim(int dim, int level) {
    int value = dim >> level;
    return value > 0 ? value : 1;
}

static int mip_count(int width, int height) {
    int count = 1;
    while (count < 16 && (width > 1 || height > 1)) {
        width = width > 1 ? width / 2 : 1;
        height = height > 1 ? height / 2 : 1;
        count++;
    }
    return count;
}

static unsigned char *build_mip_chain(const unsigned char *pixels, int width, int height,
                                      int *out_count, size_t *out_size) {
    int count = mip_count(width, height);
    size_t total = 0;
    for (int i = 0; i < count; i++) {
        total += (size_t)mip_dim(width, i) * (size_t)mip_dim(height, i) * 4;
    }

    unsigned char *chain = (unsigned char *)malloc(total);
    if (!chain) {
        return NULL;
    }
    memcpy(chain, pixels, (size_t)width * (size_t)height * 4);

    size_t prev_offset = 0;
    size_t offset = (size_t)width * (size_t)height * 4;
    int prev_w = width;
    int prev_h = height;
    for (int level = 1; level < count; level++) {
        int w = mip_dim(width, level);
        int h = mip_dim(height, level);
        const unsigned char *src = chain + prev_offset;
        unsigned char *dst = chain + offset;
        for (int y = 0; y < h; y++) {
            int sy0 = y * 2;
            int sy1 = sy0 + 1 < prev_h ? sy0 + 1 : prev_h - 1;
            for (int x = 0; x < w; x++) {
                int sx0 = x * 2;
                int sx1 = sx0 + 1 < prev_w ? sx0 + 1 : prev_w - 1;
                unsigned sum_r = 0;
                unsigned sum_g = 0;
                unsigned sum_b = 0;
                unsigned sum_a = 0;
                const int sx[2] = {sx0, sx1};
                const int sy[2] = {sy0, sy1};
                for (int j = 0; j < 2; j++) {
                    for (int i = 0; i < 2; i++) {
                        const unsigned char *p = src + ((size_t)sy[j] * prev_w + sx[i]) * 4;
                        unsigned a = p[3];
                        sum_r += (unsigned)p[0] * a;
                        sum_g += (unsigned)p[1] * a;
                        sum_b += (unsigned)p[2] * a;
                        sum_a += a;
                    }
                }
                unsigned char *d = dst + ((size_t)y * w + x) * 4;
                if (sum_a > 0) {
                    d[0] = (unsigned char)(sum_r / sum_a);
                    d[1] = (unsigned char)(sum_g / sum_a);
                    d[2] = (unsigned char)(sum_b / sum_a);
                } else {
                    d[0] = 0;
                    d[1] = 0;
                    d[2] = 0;
                }
                d[3] = (unsigned char)(sum_a / 4);
            }
        }
        prev_offset = offset;
        offset += (size_t)w * h * 4;
        prev_w = w;
        prev_h = h;
    }

    *out_count = count;
    *out_size = total;
    return chain;
}

static bool load_texture(texture *tex, const char *name) {
    int width = 0;
    int height = 0;
    unsigned char *pixels = decode_png(name, &width, &height);
    if (!pixels) {
        fprintf(stderr, "assets: could not load %s\n", name);
        return false;
    }

    int mip_levels = 0;
    size_t mip_size = 0;
    unsigned char *mip_chain = build_mip_chain(pixels, width, height, &mip_levels, &mip_size);
    if (!mip_chain) {
        fprintf(stderr, "assets: could not build mip chain for %s\n", name);
        stbi_image_free(pixels);
        return false;
    }
    stbi_image_free(pixels);

    tex->image = sg_make_image(&(sg_image_desc){
        .width = width,
        .height = height,
        .num_mipmaps = mip_levels,
        .pixel_format = SG_PIXELFORMAT_RGBA8,
        .data = {
            .ptr = mip_chain,
            .size = mip_size,
        },
    });
    free(mip_chain);

    tex->view = sg_make_view(&(sg_view_desc){
        .texture.image = tex->image,
    });
    tex->sampler = sg_make_sampler(&(sg_sampler_desc){
        .min_filter = SG_FILTER_LINEAR,
        .mag_filter = SG_FILTER_LINEAR,
        .mipmap_filter = SG_FILTER_LINEAR,
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
    destroy_texture(&loaded->cursor_ring);
    destroy_texture(&loaded->tooltip);
    destroy_texture(&loaded->legend_searching);
    destroy_texture(&loaded->legend_complete);
    free(loaded);
}
