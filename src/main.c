#define SOKOL_IMPL
#ifndef SOKOL_GLCORE
#define SOKOL_GLCORE
#endif

#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_gl.h"
#include "sokol_log.h"

#define FONTSTASH_IMPLEMENTATION
#include "fontstash.h"
#include "sokol_fontstash.h"
#undef FONTSTASH_IMPLEMENTATION

#include "app.h"
#include "map.h"
#include "draw.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static app_state app;
static sg_pass_action pass_action;
static FONScontext *g_fons = NULL;
static sgl_pipeline alpha_pipeline;
static bool debug_enabled = false;
static int debug_last_hover = -1;

static unsigned char *read_file(const char *path, int *out_size) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0) {
        fclose(f);
        return NULL;
    }
    unsigned char *data = (unsigned char *)malloc((size_t)size);
    if (!data || fread(data, 1, (size_t)size, f) != (size_t)size) {
        free(data);
        fclose(f);
        return NULL;
    }
    fclose(f);
    *out_size = (int)size;
    return data;
}

static unsigned char *load_font(const char *name, int *out_size) {
    char path[1024];
    const char *env = getenv("MAP_ASSETS");
    if (env) {
        snprintf(path, sizeof(path), "%s/fonts/%s", env, name);
        unsigned char *data = read_file(path, out_size);
        if (data) {
            return data;
        }
    }
    snprintf(path, sizeof(path), "assets/fonts/%s", name);
    unsigned char *data = read_file(path, out_size);
    if (data) {
        return data;
    }
    snprintf(path, sizeof(path), "%s/fonts/%s", MAP_ASSET_DIR, name);
    return read_file(path, out_size);
}

static void debug_log(const char *fmt, ...) {
    if (!debug_enabled) {
        return;
    }
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
}

static bool mouse_in_viewport(void) {
    return app.mouse_inside && app.mouse.y >= 0.0f && app.mouse.y < app.vp_h;
}

static void update_layout(void) {
    int fbw = sapp_width();
    int fbh = sapp_height();
    if ((float)fbw == app.width && (float)fbh == app.height) {
        return;
    }
    app.width = (float)fbw;
    app.height = (float)fbh;
    app.vp_h = fmaxf(140.0f, app.height - 156.0f);
    camera_resize(&app.cam, app.width, app.vp_h);
    debug_log("[dbg] resize viewport=%.0fx%.0f fit=%.3f zoom=%.3f target_zoom=%.3f\n",
              app.width, app.vp_h, app.cam.fit_zoom, app.cam.zoom, app.cam.target_zoom);
}

static void update_hover(float dt) {
    vec2 world = map_screen_to_world(&app.cam, app.width, app.vp_h, app.mouse);
    bool can_hover = mouse_in_viewport() && app.drag != DRAG_ACTIVE;
    float pad = 5.0f / app.cam.zoom;

    for (int i = 0; i < MAP_DOOR_COUNT; i++) {
        bool over = can_hover && app.map.doors[i].hoverable &&
                    map_door_hit(&app.map, i, world, pad);
        float target = over ? 1.0f : 0.0f;
        float k = 1.0f - expf(-18.0f * dt);
        app.door_hover[i] += (target - app.door_hover[i]) * k;
    }

    bool over = can_hover && map_door_hit(&app.map, DOOR_LOCKED, world, pad);
    app.tooltip = clampf(app.tooltip + (over ? dt : -dt) / 0.12f, 0.0f, 1.0f);

    if (debug_enabled) {
        int hovering = over ? 1 : 0;
        if (hovering != debug_last_hover) {
            debug_log("[dbg] hover locked=%d mouse=(%.1f,%.1f)\n", hovering, app.mouse.x, app.mouse.y);
            debug_last_hover = hovering;
        }
    }
}

static void handle_click(void) {
    if (!mouse_in_viewport()) {
        return;
    }
    vec2 world = map_screen_to_world(&app.cam, app.width, app.vp_h, app.mouse);
    bool inside = map_contains(&app.map, world);
    float pad = 3.0f / app.cam.zoom;
    bool on_door = map_door_hit(&app.map, DOOR_LOCKED, world, pad) ||
                   map_door_hit(&app.map, DOOR_SERVICE, world, pad);

    debug_log("[dbg] click screen=(%.1f,%.1f) world=(%.1f,%.1f) inside=%d on_door=%d\n",
              app.mouse.x, app.mouse.y, world.x, world.y, inside ? 1 : 0, on_door ? 1 : 0);

    if (inside && !on_door) {
        player_set_target(&app.player, &app.map, world);
        debug_log("[dbg] move target=(%.1f,%.1f) route=%d\n",
                  world.x, world.y, app.player.route_count);
    }
}

static void on_event(const sapp_event *ev) {
    switch (ev->type) {
    case SAPP_EVENTTYPE_MOUSE_MOVE: {
        app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
        app.mouse_inside = ev->mouse_x >= 0.0f && ev->mouse_x < app.width &&
                           ev->mouse_y >= 0.0f && ev->mouse_y < app.height;
        if (app.drag != DRAG_NONE) {
            vec2 delta = vec2_sub(app.mouse, app.drag_start);
            if (app.drag == DRAG_PENDING && vec2_len(delta) > 4.0f) {
                app.drag = DRAG_ACTIVE;
            }
            if (app.drag == DRAG_ACTIVE) {
                app.cam.target_center = vec2_sub(app.drag_center, vec2_scale(delta, 1.0f / app.cam.zoom));
                camera_clamp(&app.cam);
            }
        }
        break;
    }
    case SAPP_EVENTTYPE_MOUSE_DOWN:
        if (ev->mouse_button == SAPP_MOUSEBUTTON_LEFT && mouse_in_viewport()) {
            app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
            app.drag = DRAG_PENDING;
            app.drag_start = app.mouse;
            app.drag_center = app.cam.target_center;
        }
        break;
    case SAPP_EVENTTYPE_MOUSE_UP:
        if (ev->mouse_button == SAPP_MOUSEBUTTON_LEFT) {
            app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
            if (app.drag == DRAG_PENDING) {
                handle_click();
            } else if (app.drag == DRAG_ACTIVE) {
                debug_log("[dbg] drag end player=(%.1f,%.1f) cam_target=(%.1f,%.1f)\n",
                          app.player.pos.x, app.player.pos.y,
                          app.cam.target_center.x, app.cam.target_center.y);
            }
            app.drag = DRAG_NONE;
        }
        break;
    case SAPP_EVENTTYPE_MOUSE_SCROLL:
        if (mouse_in_viewport() && ev->scroll_y != 0.0f) {
            app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
            float factor = expf(ev->scroll_y * 0.12f);
            camera_zoom_at(&app.cam, app.width, app.vp_h, app.mouse, factor);
            debug_log("[dbg] zoom=%.3f target_zoom=%.3f target_center=(%.1f,%.1f) anchor=(%.1f,%.1f)\n",
                      app.cam.zoom, app.cam.target_zoom, app.cam.target_center.x,
                      app.cam.target_center.y, app.mouse.x, app.mouse.y);
        }
        break;
    case SAPP_EVENTTYPE_KEY_DOWN:
        if (ev->key_code == SAPP_KEYCODE_R && !ev->key_repeat) {
            camera_reset(&app.cam, app.width, app.player.pos);
            app.player.reset_flash = 1.0f;
            debug_log("[dbg] reset fit=%.3f target_zoom=%.3f target_center=(%.1f,%.1f)\n",
                      app.cam.fit_zoom, app.cam.target_zoom,
                      app.cam.target_center.x, app.cam.target_center.y);
        }
        break;
    case SAPP_EVENTTYPE_MOUSE_ENTER:
        app.mouse_inside = true;
        app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
        break;
    case SAPP_EVENTTYPE_MOUSE_LEAVE:
        app.mouse_inside = false;
        app.drag = DRAG_NONE;
        break;
    case SAPP_EVENTTYPE_RESIZED:
        break;
    default:
        break;
    }
}

static void draw_map_geometry(void) {
    vec2 spts[MAP_POLY_MAX];
    vec2 wpts[MAP_POLY_MAX];
    color rim_colors[MAP_POLY_MAX];
    int n = app.map.poly_count;
    float zoom = app.cam.zoom;

    color fill_top = color_hex(0x1b3341, 0.94f);
    color fill_bottom = color_hex(0x13232d, 0.94f);
    color outline = color_hex(0xb5ad97, 0.75f);

    for (int i = 0; i < n; i++) {
        wpts[i] = app.map.poly[i];
        spts[i] = map_world_to_screen(&app.cam, app.width, app.vp_h, wpts[i]);
        float t = (wpts[i].y - MAP_WORLD_MIN_Y) / MAP_WORLD_H;
        rim_colors[i] = color_lerp(fill_bottom, fill_top, clampf(t, 0.0f, 1.0f));
    }

    vec2 pivot = map_world_to_screen(&app.cam, app.width, app.vp_h, vec2_make(0.0f, 0.0f));
    float pivot_t = (0.0f - MAP_WORLD_MIN_Y) / MAP_WORLD_H;
    color pivot_color = color_lerp(fill_bottom, fill_top, pivot_t);

    vec2 shadow_pts[MAP_POLY_MAX];
    color shadow_colors[MAP_POLY_MAX];
    for (int i = 0; i < n; i++) {
        shadow_pts[i] = vec2_add(spts[i], vec2_make(0.0f, 10.0f));
        shadow_colors[i] = color_make(0.0f, 0.0f, 0.0f, 0.16f);
    }
    draw_triangle_fan(vec2_add(pivot, vec2_make(0.0f, 10.0f)), shadow_colors[0], shadow_pts, shadow_colors, n);

    for (int i = 0; i < n; i++) {
        shadow_pts[i] = vec2_add(spts[i], vec2_make(0.0f, 5.0f));
        shadow_colors[i] = color_make(0.0f, 0.0f, 0.0f, 0.10f);
    }
    draw_triangle_fan(vec2_add(pivot, vec2_make(0.0f, 5.0f)), shadow_colors[0], shadow_pts, shadow_colors, n);

    draw_polyline(spts, n, true, 14.0f, color_alpha(outline, 0.035f));
    draw_polyline(spts, n, true, 6.0f, color_alpha(outline, 0.055f));
    draw_triangle_fan(pivot, pivot_color, spts, rim_colors, n);
    draw_polyline(spts, n, true, 1.35f, outline);

    for (int i = 0; i < MAP_DOOR_COUNT; i++) {
        const map_door *door = &app.map.doors[i];
        vec2 c = map_world_to_screen(&app.cam, app.width, app.vp_h, door->center);
        float dw = door->width * zoom;
        float dh = door->height * zoom;
        float hover = app.door_hover[i];
        if (hover > 0.01f) {
            draw_radial_glow(c, 12.0f, color_hex(0x9c2323, 0.10f * hover),
                             color_hex(0x9c2323, 0.0f), 32);
        }
        color fill = door->fill;
        if (hover > 0.0f) {
            fill = color_lerp(fill, color_hex(0xb22e2e, 1.0f), hover * 0.75f);
        }
        draw_rect_fill((rect){c.x - dw * 0.5f, c.y - dh * 0.5f, dw, dh}, fill);
    }

    float label_size = roundf(clampf(17.0f * zoom, 10.0f, 30.0f) * 0.5f) * 2.0f;
    vec2 label = map_world_to_screen(&app.cam, app.width, app.vp_h, app.map.label_pos);
    draw_text(DRAW_FONT_MEDIUM, label_size, color_make(0.0f, 0.0f, 0.0f, 0.45f),
              FONS_ALIGN_CENTER | FONS_ALIGN_MIDDLE,
              vec2_add(label, vec2_make(1.0f, 1.5f)), "Entrance");
    draw_text(DRAW_FONT_MEDIUM, label_size, color_hex(0xe2ddcc, 0.93f),
              FONS_ALIGN_CENTER | FONS_ALIGN_MIDDLE, label, "Entrance");
}

static void draw_player_pulse(void) {
    const player *p = &app.player;
    const camera *cam = &app.cam;
    vec2 ps = map_world_to_screen(cam, app.width, app.vp_h, p->pos);
    float period = 2.4f;

    for (int i = 0; i < 2; i++) {
        float phase = fmodf(p->pulse_time + (float)i * (period * 0.5f), period) / period;
        float eased = 1.0f - (1.0f - phase) * (1.0f - phase);
        float radius = (10.0f + 38.0f * eased) * cam->zoom;
        float alpha = (1.0f - phase) * (1.0f - phase) * 0.26f;
        draw_ring(ps, radius, 1.1f, color_hex(0xedbf4f, alpha), 48);
    }

    float breathe = 0.16f + 0.04f * sinf(app.time * 2.4f) + p->reset_flash * 0.18f;
    draw_radial_glow(ps, 38.0f * cam->zoom, color_hex(0xedbf4f, breathe),
                     color_hex(0xedbf4f, 0.0f), 40);

    if (p->reset_flash > 0.0f) {
        float t = 1.0f - p->reset_flash;
        float radius = (10.0f + 70.0f * t) * cam->zoom;
        draw_ring(ps, radius, 1.4f, color_hex(0xf4d472, 0.45f * p->reset_flash), 48);
    }
}

static void draw_player_arrow(void) {
    const player *p = &app.player;
    const camera *cam = &app.cam;
    vec2 ps = map_world_to_screen(cam, app.width, app.vp_h, p->pos);
    draw_chevron(ps, 26.0f * cam->zoom, 20.0f * cam->zoom, p->heading,
                 color_hex(0xf9dd87, 1.0f), color_hex(0xd9a63a, 1.0f),
                 color_hex(0x6d541b, 0.95f));
}

static void draw_cursor(void) {
    if (!mouse_in_viewport()) {
        return;
    }
    vec2 m = app.mouse;
    float hover = app.door_hover[DOOR_LOCKED];
    color guide = color_hex(0xbebbad, 0.10f);

    draw_line(vec2_make(0.0f, m.y), vec2_make(app.width, m.y), 1.0f, guide);
    draw_line(vec2_make(m.x, 0.0f), vec2_make(m.x, app.vp_h), 1.0f, guide);

    vec2 ps = map_world_to_screen(&app.cam, app.width, app.vp_h, app.player.pos);
    float near = 1.0f - smoothstepf(clampf((vec2_len(vec2_sub(m, ps)) - 14.0f) / 26.0f, 0.0f, 1.0f));
    float cursor_alpha = 1.0f - 0.85f * near;

    float radius = 10.0f + hover * 1.6f;
    draw_circle_fill(m, radius + 2.5f, color_make(0.0f, 0.0f, 0.0f, 0.16f * cursor_alpha), 40);
    draw_circle_fill(m, radius - 1.4f, color_hex(0x04070a, 0.55f * cursor_alpha), 36);
    draw_ring(m, radius, 1.35f, color_hex(0xc8c3b2, 0.92f * cursor_alpha), 44);
}

static void draw_tooltip(void) {
    float t = smoothstepf(app.tooltip);
    if (t <= 0.001f) {
        return;
    }
    vec2 m = app.mouse;
    float pw = 250.0f;
    float ph = 30.0f;
    float slide = (1.0f - t) * 6.0f;
    float px = m.x + 22.0f + slide;
    if (px + pw > app.width - 8.0f) {
        px = m.x - 22.0f - pw - slide;
    }
    px = clampf(px, 8.0f, app.width - pw - 8.0f);
    float py = clampf(m.y - ph * 0.5f, 8.0f, app.vp_h - ph - 8.0f);

    draw_rounded_rect((rect){px, py, pw, ph}, 2.0f,
                      color_hex(0x04070a, 0.78f * t),
                      color_hex(0xbeb8a6, 0.35f * t), 1.2f);
    draw_text(DRAW_FONT_REGULAR, 16.0f, color_hex(0xded9c8, 0.95f * t),
              FONS_ALIGN_LEFT | FONS_ALIGN_MIDDLE,
              vec2_make(px + 12.0f, py + ph * 0.5f), "Locked Door");
}

static void draw_status(void) {
    float y = app.vp_h + 48.0f;
    const char *label_a = "Currently Searching";
    const char *label_b = "Search Completed";
    float square = 12.0f;
    float gap = 9.0f;
    float group_gap = 30.0f;
    float wa = draw_text_width(DRAW_FONT_REGULAR, 16.0f, label_a);
    float wb = draw_text_width(DRAW_FONT_REGULAR, 16.0f, label_b);
    float total = square + gap + wa + group_gap + square + gap + wb;
    float x = (app.width - total) * 0.5f;

    draw_rect_fill((rect){x, y - square * 0.5f, square, square}, color_hex(0x7a1f1f, 0.95f));
    draw_text(DRAW_FONT_REGULAR, 16.0f, color_hex(0xcfc9ba, 0.86f),
              FONS_ALIGN_LEFT | FONS_ALIGN_MIDDLE,
              vec2_make(x + square + gap, y), label_a);
    x += square + gap + wa + group_gap;
    draw_rect_fill((rect){x, y - square * 0.5f, square, square}, color_hex(0x284b5c, 0.95f));
    draw_text(DRAW_FONT_REGULAR, 16.0f, color_hex(0xcfc9ba, 0.86f),
              FONS_ALIGN_LEFT | FONS_ALIGN_MIDDLE,
              vec2_make(x + square + gap, y), label_b);

    draw_text(DRAW_FONT_REGULAR, 11.0f, color_hex(0xcfc9ba, 0.42f),
              FONS_ALIGN_CENTER | FONS_ALIGN_MIDDLE,
              vec2_make(app.width * 0.5f, app.vp_h + 100.0f),
              "DRAG TO PAN    SCROLL TO ZOOM    CLICK ENTRANCE TO MOVE    R RESET");
}

static void draw_vignette(void) {
    float edge = 110.0f;
    color dark = color_make(0.0f, 0.0f, 0.0f, 0.22f);
    color clear = color_make(0.0f, 0.0f, 0.0f, 0.0f);
    draw_rect_gradient((rect){0.0f, 0.0f, app.width, edge}, dark, clear);
    draw_rect_gradient((rect){0.0f, app.height - edge, app.width, edge}, clear, dark);
    draw_rect_gradient_h((rect){0.0f, 0.0f, edge, app.height}, dark, clear);
    draw_rect_gradient_h((rect){app.width - edge, 0.0f, edge, app.height}, clear, dark);
}

static void draw_dot_grid(void) {
    const float spacing = 55.0f;
    vec2 a = map_screen_to_world(&app.cam, app.width, app.vp_h, vec2_make(0.0f, 0.0f));
    vec2 b = map_screen_to_world(&app.cam, app.width, app.vp_h,
                                 vec2_make(app.width, app.vp_h));
    float minx = fminf(a.x, b.x);
    float maxx = fmaxf(a.x, b.x);
    float miny = fminf(a.y, b.y);
    float maxy = fmaxf(a.y, b.y);
    int i0 = (int)floorf(minx / spacing);
    int i1 = (int)ceilf(maxx / spacing);
    int j0 = (int)floorf(miny / spacing);
    int j1 = (int)ceilf(maxy / spacing);
    float size = 2.0f;
    color dot = color_hex(0xb8b8ac, 0.05f);

    for (int i = i0; i <= i1; i++) {
        for (int j = j0; j <= j1; j++) {
            vec2 p = map_world_to_screen(&app.cam, app.width, app.vp_h,
                                         vec2_make((float)i * spacing, (float)j * spacing));
            if (p.x < -size || p.x > app.width + size ||
                p.y < -size || p.y > app.vp_h + size) {
                continue;
            }
            draw_rect_fill((rect){p.x - size * 0.5f, p.y - size * 0.5f, size, size}, dot);
        }
    }
}

static void render(void) {
    float w = app.width;
    float vh = app.vp_h;

    sgl_defaults();
    sgl_load_pipeline(alpha_pipeline);
    sgl_matrix_mode_projection();
    sgl_load_identity();
    sgl_ortho(0.0f, w, app.height, 0.0f, -1.0f, 1.0f);
    sgl_matrix_mode_modelview();
    sgl_load_identity();

    sgl_scissor_rect(0, 0, (int)w, (int)vh, true);

    fonsClearState(g_fons);

    vec2 map_center = map_world_to_screen(&app.cam, w, vh, vec2_make(0.0f, 80.0f));
    draw_radial_glow(map_center, fminf(w, vh) * 0.72f,
                     color_make(0.090f, 0.170f, 0.210f, 0.30f),
                     color_make(0.090f, 0.170f, 0.210f, 0.0f), 64);

    draw_dot_grid();

    draw_map_geometry();
    draw_player_pulse();
    draw_cursor();
    draw_player_arrow();
    draw_tooltip();

    sgl_scissor_rect(0, 0, (int)w, (int)app.height, true);

    draw_vignette();
    draw_status();
    draw_text_flush();

    sg_begin_pass(&(sg_pass){
        .action = pass_action,
        .swapchain = sglue_swapchain(),
    });
    sgl_draw();
    sg_end_pass();
    sg_commit();
}

static void update(float dt) {
    update_layout();
    app.time += dt;
    camera_update(&app.cam, dt);
    player_update(&app.player, dt);
    update_hover(dt);
}

static void init(void) {
    debug_enabled = getenv("MAP_DEBUG") != NULL;

    sg_setup(&(sg_desc){
        .environment = sglue_environment(),
        .logger.func = slog_func,
    });
    sgl_setup(&(sgl_desc_t){
        .logger.func = slog_func,
    });
    alpha_pipeline = sgl_make_pipeline(&(sg_pipeline_desc){
        .colors[0] = {
            .blend = {
                .enabled = true,
                .src_factor_rgb = SG_BLENDFACTOR_SRC_ALPHA,
                .dst_factor_rgb = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
                .src_factor_alpha = SG_BLENDFACTOR_ONE,
                .dst_factor_alpha = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
            },
        },
    });

    g_fons = sfons_create(&(sfons_desc_t){
        .width = 1024,
        .height = 1024,
    });
    if (!g_fons) {
        fprintf(stderr, "could not create fontstash context\n");
        sapp_quit();
        return;
    }

    int regular_size = 0;
    unsigned char *regular_data = load_font("NotoSans-Regular.ttf", &regular_size);
    if (!regular_data) {
        fprintf(stderr, "could not load NotoSans-Regular.ttf\n");
        sapp_quit();
        return;
    }
    int font_regular = fonsAddFontMem(g_fons, "regular", regular_data, regular_size, 1);
    if (font_regular == FONS_INVALID) {
        fprintf(stderr, "could not add regular font\n");
        sapp_quit();
        return;
    }

    int medium_size = 0;
    unsigned char *medium_data = load_font("NotoSans-Medium.ttf", &medium_size);
    int font_medium = FONS_INVALID;
    if (medium_data) {
        font_medium = fonsAddFontMem(g_fons, "medium", medium_data, medium_size, 1);
    }
    draw_fonts_init(g_fons, font_regular, font_medium);

    map_init(&app.map);
    player_init(&app.player);
    app.width = (float)sapp_width();
    app.height = (float)sapp_height();
    app.vp_h = fmaxf(140.0f, app.height - 156.0f);
    camera_init(&app.cam, app.width, app.vp_h);
    app.mouse = vec2_make(app.width * 0.58f, app.vp_h * 0.62f);
    app.mouse_inside = true;
    app.drag = DRAG_NONE;
    app.time = 0.0f;
    app.tooltip = 0.0f;

    pass_action = (sg_pass_action){
        .colors[0] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = {0.0196f, 0.0235f, 0.0275f, 1.0f},
        },
    };

    static const unsigned char transparent_cursor[16] = {0};
    sapp_bind_mouse_cursor_image(SAPP_MOUSECURSOR_CUSTOM_0, &(sapp_image_desc){
        .width = 2,
        .height = 2,
        .cursor_hotspot_x = 0,
        .cursor_hotspot_y = 0,
        .pixels = {.ptr = transparent_cursor, .size = sizeof(transparent_cursor)},
    });
    sapp_set_mouse_cursor(SAPP_MOUSECURSOR_CUSTOM_0);

    debug_log("[dbg] init viewport=%.0fx%.0f fit=%.3f\n",
              app.width, app.vp_h, app.cam.fit_zoom);
}

static void frame(void) {
    float dt = clampf((float)sapp_frame_duration(), 0.0f, 0.05f);
    update(dt);
    render();
}

static void cleanup(void) {
    if (g_fons) {
        sfons_destroy(g_fons);
        g_fons = NULL;
    }
    sgl_destroy_pipeline(alpha_pipeline);
    sgl_shutdown();
    sg_shutdown();
}

sapp_desc sokol_main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;
    return (sapp_desc){
        .init_cb = init,
        .frame_cb = frame,
        .event_cb = on_event,
        .cleanup_cb = cleanup,
        .width = 1440,
        .height = 900,
        .window_title = "R.P.D. Entrance Map",
        .logger.func = slog_func,
    };
}
