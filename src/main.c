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
#include "assets.h"
#include "map.h"
#include "draw.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static app_state app;
static sg_pass_action pass_action;
static assets *g_assets = NULL;
static FONScontext *g_fons = NULL;
static sgl_pipeline alpha_pipeline;
static bool debug_enabled = false;
static int debug_last_hover = -1;

static FILE *frame_log_file = NULL;
static int frame_log_rows = 0;

#define MAP_TEXTURE_MIN_X (-388.0f)
#define MAP_TEXTURE_MAX_X (388.0f)
#define MAP_TEXTURE_MIN_Y (-118.0f)
#define MAP_TEXTURE_MAX_Y (278.0f)

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
    bool can_hover = app.mouse_inside;
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
            debug_log("[dbg] hover locked=%d mouse=(%.1f,%.1f)\n",
                      hovering, app.mouse.x, app.mouse.y);
            debug_last_hover = hovering;
        }
    }
}

static void on_event(const sapp_event *ev) {
    switch (ev->type) {
    case SAPP_EVENTTYPE_MOUSE_MOVE:
        app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
        app.mouse_inside = ev->mouse_x >= 0.0f && ev->mouse_x < app.width &&
                           ev->mouse_y >= 0.0f && ev->mouse_y < app.height;
        break;
    case SAPP_EVENTTYPE_MOUSE_DOWN:
        if (ev->mouse_button == SAPP_MOUSEBUTTON_RIGHT) {
            app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
            app.run_latched = !app.run_latched;
            debug_log("[dbg] run latch=%d\n", app.run_latched ? 1 : 0);
        }
        break;
    case SAPP_EVENTTYPE_MOUSE_SCROLL:
        if (mouse_in_viewport() && ev->scroll_y != 0.0f) {
            app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
            float factor = expf(ev->scroll_y * 0.12f);
            camera_zoom(&app.cam, factor);
            debug_log("[dbg] zoom=%.3f center=(%.1f,%.1f)\n",
                      app.cam.zoom, app.cam.center.x, app.cam.center.y);
        }
        break;
    case SAPP_EVENTTYPE_KEY_DOWN:
        switch (ev->key_code) {
        case SAPP_KEYCODE_W: app.key_w = true; break;
        case SAPP_KEYCODE_A: app.key_a = true; break;
        case SAPP_KEYCODE_S: app.key_s = true; break;
        case SAPP_KEYCODE_D: app.key_d = true; break;
        case SAPP_KEYCODE_ESCAPE:
            sapp_quit();
            break;
        case SAPP_KEYCODE_R:
            if (!ev->key_repeat) {
                camera_reset(&app.cam, app.player.pos);
                app.cam.target_center = app.player.pos;
                app.cam.center = app.player.pos;
                app.player.reset_flash = 1.0f;
                debug_log("[dbg] reset fit=%.3f target_zoom=%.3f center=(%.1f,%.1f)\n",
                          app.cam.fit_zoom, app.cam.target_zoom,
                          app.cam.target_center.x, app.cam.target_center.y);
            }
            break;
        default:
            break;
        }
        break;
    case SAPP_EVENTTYPE_KEY_UP:
        switch (ev->key_code) {
        case SAPP_KEYCODE_W: app.key_w = false; break;
        case SAPP_KEYCODE_A: app.key_a = false; break;
        case SAPP_KEYCODE_S: app.key_s = false; break;
        case SAPP_KEYCODE_D: app.key_d = false; break;
        default:
            break;
        }
        break;
    case SAPP_EVENTTYPE_MOUSE_ENTER:
        app.mouse_inside = true;
        app.mouse = vec2_make(ev->mouse_x, ev->mouse_y);
        break;
    case SAPP_EVENTTYPE_MOUSE_LEAVE:
        app.mouse_inside = false;
        break;
    case SAPP_EVENTTYPE_UNFOCUSED:
        app.key_w = false;
        app.key_a = false;
        app.key_s = false;
        app.key_d = false;
        break;
    case SAPP_EVENTTYPE_RESIZED:
        break;
    default:
        break;
    }
}

static void draw_map(void) {
    vec2 center = map_world_to_screen(&app.cam, app.width, app.vp_h,
                                      vec2_make((MAP_TEXTURE_MIN_X + MAP_TEXTURE_MAX_X) * 0.5f,
                                                (MAP_TEXTURE_MIN_Y + MAP_TEXTURE_MAX_Y) * 0.5f));
    draw_sprite(&g_assets->map, center,
                (MAP_TEXTURE_MAX_X - MAP_TEXTURE_MIN_X) * app.cam.zoom,
                (MAP_TEXTURE_MAX_Y - MAP_TEXTURE_MIN_Y) * app.cam.zoom,
                0.0f, color_make(1.0f, 1.0f, 1.0f, 1.0f));
}

static void draw_doors(void) {
    const float door_w = 80.0f;
    const float door_h = 22.0f;
    float zoom = app.cam.zoom;
    for (int i = 0; i < MAP_DOOR_COUNT; i++) {
        vec2 c = map_world_to_screen(&app.cam, app.width, app.vp_h, app.map.doors[i].center);
        if (i == DOOR_LOCKED) {
            float hover = clampf(app.door_hover[i], 0.0f, 1.0f);
            draw_sprite(&g_assets->door_locked, c, door_w * zoom, door_h * zoom, 0.0f,
                        color_make(1.0f, 1.0f, 1.0f, 1.0f - hover));
            draw_sprite(&g_assets->door_locked_hover, c, door_w * zoom, door_h * zoom, 0.0f,
                        color_make(1.0f, 1.0f, 1.0f, hover));
        } else {
            draw_sprite(&g_assets->door_service, c, door_w * zoom, door_h * zoom, 0.0f,
                        color_make(1.0f, 1.0f, 1.0f, 1.0f));
        }
    }
}

static void draw_player_pulse(void) {
    const player *p = &app.player;
    vec2 ps = map_world_to_screen(&app.cam, app.width, app.vp_h, p->pos);
    float phase = fmodf(app.time / 2.2f, 1.0f);
    float expand = smoothstepf(phase);
    float puddle_size = 36.0f + 30.0f * expand + p->reset_flash * 8.0f;
    float puddle_alpha = clampf(0.42f * powf(1.0f - phase, 1.4f) + p->reset_flash * 0.22f,
                                0.0f, 1.0f);
    float base_alpha = clampf(0.16f + p->reset_flash * 0.12f, 0.0f, 1.0f);

    draw_sprite(&g_assets->player_glow, ps, 32.0f, 32.0f, 0.0f,
                color_make(1.0f, 1.0f, 1.0f, base_alpha));
    draw_sprite(&g_assets->player_glow, ps, puddle_size, puddle_size, 0.0f,
                color_make(1.0f, 1.0f, 1.0f, puddle_alpha));
}

static void draw_player_arrow(void) {
    const player *p = &app.player;
    vec2 ps = map_world_to_screen(&app.cam, app.width, app.vp_h, p->pos);
    draw_sprite(&g_assets->player_arrow, ps, 58.0f, 48.0f,
                p->heading, color_make(1.0f, 1.0f, 1.0f, 1.0f));
}

static void draw_cursor(void) {
    if (!mouse_in_viewport()) {
        return;
    }
    vec2 m = app.mouse;
    color guide_start = color_hex(0xbebbad, 0.34f);
    color guide_end = color_hex(0xbebbad, 0.02f);

    draw_tapered_line(m, vec2_make(0.0f, m.y), 2.0f, 0.35f, guide_start, guide_end);
    draw_tapered_line(m, vec2_make(app.width, m.y), 2.0f, 0.35f, guide_start, guide_end);
    draw_tapered_line(m, vec2_make(m.x, 0.0f), 2.0f, 0.35f, guide_start, guide_end);
    draw_tapered_line(m, vec2_make(m.x, app.vp_h), 2.0f, 0.35f, guide_start, guide_end);

    draw_sprite(&g_assets->cursor_ring, m, 30.0f, 30.0f, 0.0f,
                color_make(1.0f, 1.0f, 1.0f, 1.0f));
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

    draw_sprite(&g_assets->tooltip, vec2_make(px + pw * 0.5f, py + ph * 0.5f),
                pw, ph, 0.0f, color_make(1.0f, 1.0f, 1.0f, t));
    draw_text(DRAW_FONT_REGULAR, 18.0f, color_hex(0xe2ddd0, 0.98f * t),
              FONS_ALIGN_LEFT | FONS_ALIGN_MIDDLE,
              vec2_make(px + 12.0f, py + 15.0f), "Locked Door");
}

static void draw_fps(void) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%d FPS", (int)lroundf(app.fps_display));
    vec2 p = vec2_make(app.width - 18.0f, 14.0f);
    draw_text(DRAW_FONT_REGULAR, 14.0f, color_make(0.0f, 0.0f, 0.0f, 0.55f),
              FONS_ALIGN_RIGHT | FONS_ALIGN_TOP,
              vec2_add(p, vec2_make(1.0f, 1.0f)), buf);
    draw_text(DRAW_FONT_REGULAR, 14.0f, color_hex(0x4ce16f, 0.95f),
              FONS_ALIGN_RIGHT | FONS_ALIGN_TOP, p, buf);
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

    draw_sprite(&g_assets->legend_searching, vec2_make(x + square * 0.5f, y),
                square, square, 0.0f, color_make(1.0f, 1.0f, 1.0f, 1.0f));
    draw_text(DRAW_FONT_REGULAR, 16.0f, color_hex(0xcfc9ba, 0.86f),
              FONS_ALIGN_LEFT | FONS_ALIGN_MIDDLE,
              vec2_make(x + square + gap, y), label_a);
    x += square + gap + wa + group_gap;
    draw_sprite(&g_assets->legend_complete, vec2_make(x + square * 0.5f, y),
                square, square, 0.0f, color_make(1.0f, 1.0f, 1.0f, 1.0f));
    draw_text(DRAW_FONT_REGULAR, 16.0f, color_hex(0xcfc9ba, 0.86f),
              FONS_ALIGN_LEFT | FONS_ALIGN_MIDDLE,
              vec2_make(x + square + gap, y), label_b);

    draw_text(DRAW_FONT_REGULAR, 11.0f, color_hex(0xcfc9ba, 0.42f),
              FONS_ALIGN_CENTER | FONS_ALIGN_MIDDLE,
              vec2_make(app.width * 0.5f, app.vp_h + 100.0f),
              "WASD MOVE    RMB WALK/RUN    SCROLL ZOOM    R RESET");
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

    draw_dot_grid();
    draw_map();
    draw_doors();
    draw_player_pulse();
    draw_cursor();
    draw_player_arrow();
    draw_tooltip();

    sgl_scissor_rect(0, 0, (int)w, (int)app.height, true);

    draw_vignette();
    draw_status();
    draw_fps();
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
    float body_radius = 20.0f / app.cam.zoom + 1.0f;
    float dx = (app.key_d ? 1.0f : 0.0f) - (app.key_a ? 1.0f : 0.0f);
    float dy = (app.key_w ? 1.0f : 0.0f) - (app.key_s ? 1.0f : 0.0f);
    move_input input = {
        .dir = vec2_norm(vec2_make(dx, dy)),
        .active = dx != 0.0f || dy != 0.0f,
        .running = app.run_latched,
    };
    player_update(&app.player, &app.map, input, body_radius, dt);
    app.cam.target_center = app.player.pos;
    app.cam.center = app.player.pos;
    update_hover(dt);
}

static void init(void) {
    debug_enabled = getenv("MAP_DEBUG") != NULL;
    const char *frame_log_path = getenv("MAP_FRAMELOG");
    if (frame_log_path) {
        frame_log_file = fopen(frame_log_path, "w");
        if (frame_log_file) {
            fprintf(frame_log_file, "dt,x,y,heading,speed,run,w,a,s,d\n");
        }
    }

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

    g_assets = assets_load();
    if (!g_assets) {
        fprintf(stderr, "could not load image assets\n");
        exit(1);
    }

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
    unsigned char *regular_data = load_font("Roboto-Regular.ttf", &regular_size);
    if (!regular_data) {
        fprintf(stderr, "could not load Roboto-Regular.ttf\n");
        sapp_quit();
        return;
    }
    int font_regular = fonsAddFontMem(g_fons, "regular", regular_data, regular_size, 1);
    if (font_regular == FONS_INVALID) {
        fprintf(stderr, "could not add regular font\n");
        sapp_quit();
        return;
    }
    draw_fonts_init(g_fons, font_regular, FONS_INVALID);

    map_init(&app.map);
    player_init(&app.player);
    app.width = (float)sapp_width();
    app.height = (float)sapp_height();
    app.vp_h = fmaxf(140.0f, app.height - 156.0f);
    camera_init(&app.cam, app.width, app.vp_h);
    app.mouse = vec2_make(app.width * 0.5f, app.vp_h * 0.5f);
    app.mouse_inside = false;
    app.key_w = false;
    app.key_a = false;
    app.key_s = false;
    app.key_d = false;
    app.run_latched = false;
    app.cam.center = app.player.pos;
    app.cam.target_center = app.player.pos;
    app.time = 0.0f;
    app.tooltip = 0.0f;
    app.fps = 60.0f;
    app.fps_display = 60.0f;
    app.fps_timer = 0.0f;

    pass_action = (sg_pass_action){
        .colors[0] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = {0.012f, 0.014f, 0.016f, 1.0f},
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
    float raw_dt = (float)sapp_frame_duration();
    if (raw_dt > 0.0f && raw_dt < 0.5f) {
        float sample = 1.0f / raw_dt;
        app.fps += (sample - app.fps) * (1.0f - expf(-5.0f * raw_dt));
        app.fps_timer += raw_dt;
        if (app.fps_timer >= 0.2f) {
            app.fps_display = app.fps;
            app.fps_timer = 0.0f;
        }
    }
    float dt = clampf(raw_dt, 0.0f, 0.05f);
    update(dt);
    if (frame_log_file) {
        fprintf(frame_log_file, "%.6f,%.3f,%.3f,%.5f,%.3f,%d,%d,%d,%d,%d\n",
                raw_dt, app.player.pos.x, app.player.pos.y,
                app.player.heading, app.player.speed, app.run_latched ? 1 : 0,
                app.key_w ? 1 : 0, app.key_a ? 1 : 0, app.key_s ? 1 : 0,
                app.key_d ? 1 : 0);
        if ((++frame_log_rows % 10) == 0) {
            fflush(frame_log_file);
        }
    }
    render();
}

static void cleanup(void) {
    // Restore the active cursor before sokol_app's automatic cursor cleanup.
    sapp_set_mouse_cursor(SAPP_MOUSECURSOR_DEFAULT);
    if (frame_log_file) {
        fclose(frame_log_file);
        frame_log_file = NULL;
    }
    if (g_fons) {
        sfons_destroy(g_fons);
        g_fons = NULL;
    }
    assets_destroy(g_assets);
    g_assets = NULL;
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
