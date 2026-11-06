#define RPD_SOKOL_IMPL
#include "rpd_sokol.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_app.h"
#include "rpd_input.h"
#include "rpd_items.h"
#include "rpd_overlay.h"
#include "rpd_plan.h"
#include "rpd_popup.h"
#include "rpd_state.h"

rpd_state_t g_rpd;

#define ORTHO_PITCH 1.45f
#define BLEND_DURATION 0.7f

static void reset_orbit_camera(void) {
    const bounds_t *b = &g_rpd.scene.bounds;
    for (int i = 0; i < 3; i++) g_rpd.camera.target[i] = 0.5f * (b->min[i] + b->max[i]);
    float dx = b->max[0] - b->min[0];
    float dy = b->max[1] - b->min[1];
    int w = sapp_width() > 0 ? sapp_width() : 1600;
    if (g_rpd.scene_radius < 30.0f) {
        g_rpd.camera.target[0] = 0.0f;
        g_rpd.camera.target[1] = 2.5f;
        g_rpd.camera.target[2] = 4.0f;
        g_rpd.camera.yaw = 0.0f;
        g_rpd.camera.pitch = 0.05f;
        g_rpd.camera.distance = 14.0f;
    } else {
        g_rpd.camera.yaw = -0.55f;
        g_rpd.camera.pitch = 0.40f;
        g_rpd.camera.target[1] = b->min[1] + 0.40f * dy;
        g_rpd.camera.distance = 3.6f * g_rpd.scene_radius * fmaxf(1.0f, 900.0f / (float)w);
    }
}

void camera_cancel_animation(void) {
    g_rpd.orbit.active = false;
}

void camera_update_animation(float dt) {
    orbit_anim_t *a = &g_rpd.orbit;
    if (!a->active) return;
    a->elapsed += dt;
    float t = fminf(1.0f, a->elapsed / a->duration);
    float s = t * t * (3.0f - 2.0f * t);
    for (int i = 0; i < 3; i++)
        g_rpd.camera.target[i] = a->from_target[i] + (a->to_target[i] - a->from_target[i]) * s;
    g_rpd.camera.distance = a->from_distance + (a->to_distance - a->from_distance) * s;
    if (t >= 1.0f) a->active = false;
}

void camera_reset(void) {
    camera_cancel_animation();
    g_rpd.input.rotating = false;
    g_rpd.input.panning = false;
    const bounds_t *b = &g_rpd.scene.bounds;
    float dx = b->max[0] - b->min[0];
    float dy = b->max[1] - b->min[1];
    float dz = b->max[2] - b->min[2];
    g_rpd.scene_radius = 0.5f * sqrtf(dx * dx + dy * dy + dz * dz);
    reset_orbit_camera();
}

static mat4 perspective_view_proj(float eye[3]) {
    camera_eye(&g_rpd.camera, eye);
    mat4 proj = mat4_perspective(0.62f, (float)sapp_width() / (float)sapp_height(), 0.2f, 1600.0f);
    // Lens shift so the building sits in the free area left of the side panel.
    proj.m[8] = 0.26f;
    mat4 view = mat4_look_at(eye, g_rpd.camera.target, (float[3]){ 0.0f, 1.0f, 0.0f });
    return mat4_mul(proj, view);
}

static mat4 ortho_view_proj(float eye[3]) {
    float vw = (float)(sapp_width() > 0 ? sapp_width() : 1600);
    float vh = (float)(sapp_height() > 0 ? sapp_height() : 900);
    float scale = plan_map_scale() > 0.5f ? plan_map_scale() : 8.0f;
    float half_w = vw / (2.0f * scale);
    float half_h = vh / (2.0f * scale);
    float cx = plan_map_cx();
    float cz = plan_map_cz();
    float fy = plan_level();
    eye[0] = cx;
    eye[1] = fy + 80.0f;
    eye[2] = cz;
    float aim[3] = { cx, fy, cz };
    float up[3] = { 0.0f, 0.0f, -1.0f };
    mat4 proj = mat4_ortho(-half_w, half_w, -half_h, half_h, 0.1f, 200.0f);
    mat4 view = mat4_look_at(eye, aim, up);
    return mat4_mul(proj, view);
}

static float blend_ease(void) {
    float t = g_rpd.ortho_blend;
    if (t < 0.0f) t = 0.0f;
    if (t > 1.0f) t = 1.0f;
    return t * t * (3.0f - 2.0f * t);
}

static mat4 blended_view_proj(float eye[3]) {
    float persp_eye[3];
    mat4 persp = perspective_view_proj(persp_eye);
    float ortho_eye[3];
    mat4 ortho = ortho_view_proj(ortho_eye);
    float e = blend_ease();
    if (e <= 0.0001f) {
        memcpy(eye, persp_eye, sizeof(persp_eye));
        return persp;
    }
    if (e >= 0.9999f) {
        memcpy(eye, ortho_eye, sizeof(ortho_eye));
        return ortho;
    }
    mat4 out;
    for (int i = 0; i < 16; i++) out.m[i] = persp.m[i] * (1.0f - e) + ortho.m[i] * e;
    for (int i = 0; i < 3; i++) eye[i] = persp_eye[i] * (1.0f - e) + ortho_eye[i] * e;
    return out;
}

static void update_ortho_blend(float dt) {
    float target = g_rpd.ortho ? 1.0f : 0.0f;
    float step = dt / BLEND_DURATION;
    if (g_rpd.ortho_blend < target) g_rpd.ortho_blend = fminf(target, g_rpd.ortho_blend + step);
    else if (g_rpd.ortho_blend > target) g_rpd.ortho_blend = fmaxf(target, g_rpd.ortho_blend - step);
    if (!g_rpd.ortho && g_rpd.ortho_blend <= 0.001f) {
        if (g_rpd.ortho_saved) {
            memcpy(g_rpd.camera.target, g_rpd.saved_target, sizeof(g_rpd.saved_target));
            g_rpd.camera.yaw = g_rpd.saved_yaw;
            g_rpd.camera.pitch = g_rpd.saved_pitch;
            g_rpd.camera.distance = g_rpd.saved_distance;
            g_rpd.ortho_saved = false;
        }
        return;
    }
    float e = blend_ease();
    if (!g_rpd.ortho_saved) return;
    float cx = plan_map_cx();
    float cz = plan_map_cz();
    float fy = plan_level();
    g_rpd.camera.target[0] = g_rpd.saved_target[0] + (cx - g_rpd.saved_target[0]) * e;
    g_rpd.camera.target[1] = g_rpd.saved_target[1] + (fy + 0.9f - g_rpd.saved_target[1]) * e;
    g_rpd.camera.target[2] = g_rpd.saved_target[2] + (cz - g_rpd.saved_target[2]) * e;
    g_rpd.camera.yaw = g_rpd.saved_yaw + (0.0f - g_rpd.saved_yaw) * e;
    g_rpd.camera.pitch = g_rpd.saved_pitch + (ORTHO_PITCH - g_rpd.saved_pitch) * e;
    float ortho_distance = fmaxf(90.0f, g_rpd.scene_radius * 1.6f);
    g_rpd.camera.distance = g_rpd.saved_distance + (ortho_distance - g_rpd.saved_distance) * e;
}

static bool sdtx_ready;

static void ensure_sdtx(void) {
    if (sdtx_ready) return;
    sg_swapchain sc = sglue_swapchain();
    if (sc.invalid || sc.color_format == SG_PIXELFORMAT_NONE) return;
    sdtx_setup(&(sdtx_desc_t){
        .fonts = { [0] = sdtx_font_kc853() },
        .logger.func = slog_func,
        .context = {
            .color_format = sc.color_format,
            .depth_format = sc.depth_format,
            .sample_count = sc.sample_count,
        },
    });
    sdtx_ready = true;
    overlay_set_text_ready(1);
}

void rpd_app_frame(void) {
    float raw_dt = (float)sapp_frame_duration();
    if (raw_dt < 0.0f) raw_dt = 0.0f;
    static float fps_accum;
    static int fps_frames;
    static float fps_value;
    fps_accum += raw_dt;
    fps_frames++;
    if (fps_accum >= 0.5f) {
        fps_value = (float)fps_frames / fps_accum;
        fps_accum = 0.0f;
        fps_frames = 0;
    }
    float dt = raw_dt > 0.1f ? 0.1f : raw_dt;
    ensure_sdtx();
    camera_update_animation(dt);
    update_ortho_blend(dt);
    if (g_rpd.scene.pending) {
        g_rpd.scene.pending = false;
        g_rpd.scene.loaded = scene_upload(&g_rpd.scene);
        if (g_rpd.scene.loaded) camera_reset();
    }
    if (g_rpd.target.dirty || g_rpd.target.width != sapp_width() || g_rpd.target.height != sapp_height())
        target_create(&g_rpd.target, sapp_width(), sapp_height());

    sg_begin_pass(&g_rpd.target.pass);
    sg_apply_viewport(0, 0, g_rpd.target.width, g_rpd.target.height, true);

    float eye[3];
    mat4 vp = blended_view_proj(eye);
    float e = blend_ease();
    float fy = plan_level();
    plan_update(raw_dt > 0.5f ? 0.5f : raw_dt, vp.m, sapp_width(), sapp_height());
    if (g_rpd.scene.loaded && g_rpd.scene.gpu_ready) {
        bool clip = e > 0.45f;
        scene_render_matrix(&g_rpd.scene, vp, eye, clip, fy - 0.55f, fy + 4.2f);
    }
    sg_end_pass();

    overlay_build(vp.m, sapp_width(), sapp_height(), e > 0.5f, fps_value);
    overlay_upload();
    target_composite(&g_rpd.target, &g_rpd.pass_action);
    sg_commit();
}

void rpd_app_init(void) {
    g_rpd.pass_action.colors[0].load_action = SG_LOADACTION_CLEAR;
    g_rpd.pass_action.colors[0].clear_value = (sg_color){ 0.0f, 0.0f, 0.0f, 1.0f };
    sg_setup(&(sg_desc){
        .environment = sglue_environment(),
        .logger = { .func = slog_func },
    });
    scene_create_pipelines(&g_rpd.scene);
    overlay_init();
    target_create_composite(&g_rpd.target);
    g_rpd.target.dirty = true;
    g_rpd.camera.yaw = -0.55f;
    g_rpd.camera.pitch = 0.40f;
    g_rpd.camera.distance = 150.0f;
    g_rpd.camera.target[1] = 10.0f;
    g_rpd.ortho_scale = 8.0f;
    g_rpd.ortho_floor_y = 0.0f;
}

void rpd_app_cleanup(void) {
    if (sdtx_ready) sdtx_shutdown();
    sg_shutdown();
    if (g_rpd.scene.data) free(g_rpd.scene.data);
}

static bool map_panning;
EMSCRIPTEN_KEEPALIVE void rpd_set_view_mode(int mode);
EMSCRIPTEN_KEEPALIVE void rpd_reset_view(void);

void rpd_app_event(const sapp_event *e) {
    if (e->type == SAPP_EVENTTYPE_KEY_DOWN && e->key_code == SAPP_KEYCODE_ESCAPE) {
        plan_clear_route();
        return;
    }
    if (e->type == SAPP_EVENTTYPE_KEY_DOWN && e->key_code == SAPP_KEYCODE_R) {
        rpd_reset_view();
        return;
    }
    if (g_rpd.ortho_blend > 0.25f) {
        float s = sapp_dpi_scale();
        float mx = e->mouse_x * s;
        float my = e->mouse_y * s;
        if (e->type == SAPP_EVENTTYPE_MOUSE_MOVE) {
            if (map_panning) plan_pan(e->mouse_dx * s, e->mouse_dy * s);
            else plan_pointer_move(mx, my);
        } else if (e->type == SAPP_EVENTTYPE_MOUSE_DOWN) {
            if (e->mouse_button == SAPP_MOUSEBUTTON_MIDDLE) map_panning = true;
            else if (e->mouse_button == SAPP_MOUSEBUTTON_LEFT) plan_pointer_down(mx, my);
        } else if (e->type == SAPP_EVENTTYPE_MOUSE_UP) {
            if (e->mouse_button == SAPP_MOUSEBUTTON_MIDDLE) map_panning = false;
        } else if (e->type == SAPP_EVENTTYPE_MOUSE_SCROLL) {
            plan_zoom(mx, my, e->scroll_y);
        }
        return;
    }
    input_handle_event(e);
}

EMSCRIPTEN_KEEPALIVE void rpd_plan_set_floors(int count, float *levels, float *bounds) {
    plan_set_floors(count, levels, bounds);
}

EMSCRIPTEN_KEEPALIVE void rpd_plan_set_graph(int count, float *x, float *y, float *z,
    uint8_t *floor, uint8_t *kind, int *first, int *adj, float *cost) {
    plan_set_graph(count, x, y, z, floor, kind, first, adj, cost);
}

EMSCRIPTEN_KEEPALIVE void rpd_plan_set_rooms(int count, float *x, float *y, float *z,
    uint8_t *floor, char *names, int names_len, int *offsets) {
    plan_set_rooms(count, x, y, z, floor, names, names_len, offsets);
}

EMSCRIPTEN_KEEPALIVE void rpd_plan_set_spawn(float x, float y, float z) { plan_set_spawn(x, y, z); }
EMSCRIPTEN_KEEPALIVE void rpd_plan_set_player(float x, float y, float z) { plan_set_player(x, y, z); }
EMSCRIPTEN_KEEPALIVE void rpd_plan_set_floor(int index) { plan_set_floor(index); }
EMSCRIPTEN_KEEPALIVE void rpd_plan_start_move(void) { plan_start_move(); }
EMSCRIPTEN_KEEPALIVE void rpd_plan_add_target(float x, float y, float z) { plan_add_target(x, y, z); }
EMSCRIPTEN_KEEPALIVE void rpd_set_fps_visible(int visible) { overlay_set_fps_visible(visible); }
EMSCRIPTEN_KEEPALIVE int rpd_plan_camera(float *out) {
    if (!out) return -1;
    out[0] = plan_map_cx(); out[1] = plan_map_cz(); out[2] = plan_map_scale();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int rpd_plan_route_count(void) { return plan_route_count(); }
EMSCRIPTEN_KEEPALIVE int rpd_plan_route(float *out, int cap) {
    int n = plan_route_count();
    if (n > cap) n = cap;
    if (!out || n <= 0) return 0;
    memcpy(out, plan_route(), sizeof(float) * 3 * (size_t)n);
    return n;
}
EMSCRIPTEN_KEEPALIVE int rpd_plan_move_state(float *out) {
    if (!out) return -1;
    out[0] = (float)plan_move_index(); out[1] = (float)plan_move_count(); out[2] = plan_move_t();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int rpd_plan_count(void) { return plan_count(); }
EMSCRIPTEN_KEEPALIVE int rpd_plan_moving(void) { return plan_moving(); }
EMSCRIPTEN_KEEPALIVE const char *rpd_plan_room(void) { return plan_room_name(); }
EMSCRIPTEN_KEEPALIVE void rpd_plan_reset(void) { plan_reset(); }
EMSCRIPTEN_KEEPALIVE void rpd_plan_clear_route(void) { plan_clear_route(); }
EMSCRIPTEN_KEEPALIVE int rpd_plan_open_popup(float x, float z) { return plan_open_popup_at(x, z); }
EMSCRIPTEN_KEEPALIVE int rpd_overlay_stats(float *out) {
    if (!out) return -1;
    overlay_stats(out);
    return 0;
}
EMSCRIPTEN_KEEPALIVE int rpd_plan_player(float *out) {
    if (!out) return -1;
    float p[3]; plan_player(p);
    out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
    return 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_item_count(void) { return items_count(); }

EMSCRIPTEN_KEEPALIVE int rpd_item(int index, float *out) {
    const item_t *item = items_get(index);
    if (!item || !out) return 0;
    out[0] = item->x; out[1] = item->y; out[2] = item->z;
    out[3] = item->r; out[4] = item->g; out[5] = item->b;
    out[6] = (float)item->node;
    out[7] = item->taken ? 1.0f : 0.0f;
    out[8] = (float)item->room;
    out[9] = (float)item->floor;
    return 1;
}

EMSCRIPTEN_KEEPALIVE const char *rpd_item_name(int index) {
    const item_t *item = items_get(index);
    return item ? item->name : "";
}

EMSCRIPTEN_KEEPALIVE const char *rpd_item_room(int index) {
    return plan_room_name_at(items_room(index));
}

EMSCRIPTEN_KEEPALIVE int rpd_inventory_count(void) { return items_inventory_count(); }

EMSCRIPTEN_KEEPALIVE int rpd_inventory(float *out, int cap) {
    const inventory_slot_t *slots = items_inventory();
    int count = INVENTORY_SLOTS < cap ? INVENTORY_SLOTS : cap;
    if (!out) return 0;
    for (int i = 0; i < count; i++) {
        out[i * 4 + 0] = slots[i].filled ? 1.0f : 0.0f;
        out[i * 4 + 1] = slots[i].r;
        out[i * 4 + 2] = slots[i].g;
        out[i * 4 + 3] = slots[i].b;
    }
    return count;
}

EMSCRIPTEN_KEEPALIVE int rpd_popup_state(float *out) {
    if (!out) return -1;
    const popup_t *p = popup_get();
    out[0] = (float)p->phase;
    out[1] = (float)p->node;
    out[2] = (float)p->item;
    out[3] = (float)p->hover;
    out[4] = p->anchor[0];
    out[5] = p->anchor[1];
    out[6] = (float)p->choice_count;
    out[7] = p->phase == POPUP_CHOOSING ? 1.0f : 0.0f;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_popup_choice(int index, float *out) {
    if (!out) return 0;
    const popup_t *p = popup_get();
    if (index < 0 || index >= p->choice_count) return 0;
    float rect[4];
    if (!popup_choice_rect(index, rect)) return 0;
    out[0] = rect[0]; out[1] = rect[1]; out[2] = rect[2]; out[3] = rect[3];
    out[4] = p->choices[index].enabled ? 1.0f : 0.0f;
    out[5] = (float)p->choices[index].action;
    return 1;
}

EMSCRIPTEN_KEEPALIVE const char *rpd_popup_label(int index) {
    const popup_t *p = popup_get();
    if (index < 0 || index >= p->choice_count) return "";
    return p->choices[index].label;
}

EMSCRIPTEN_KEEPALIVE const char *rpd_popup_message(void) {
    return popup_get()->message;
}

EMSCRIPTEN_KEEPALIVE int rpd_get_camera(float *out) {
    if (!out) return -1;
    float eye[3];
    camera_eye(&g_rpd.camera, eye);
    out[0] = eye[0];
    out[1] = eye[1];
    out[2] = eye[2];
    out[3] = g_rpd.camera.yaw + RPD_PI;
    out[4] = -g_rpd.camera.pitch;
    out[5] = 1.0f;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_set_orbit(float tx, float ty, float tz, float yaw, float pitch, float distance) {
    if (!isfinite(tx) || !isfinite(ty) || !isfinite(tz) ||
        !isfinite(yaw) || !isfinite(pitch) || !isfinite(distance)) return -1;
    g_rpd.camera.target[0] = tx;
    g_rpd.camera.target[1] = ty;
    g_rpd.camera.target[2] = tz;
    g_rpd.camera.yaw = yaw;
    g_rpd.camera.pitch = fminf(1.45f, fmaxf(0.08f, pitch));
    g_rpd.camera.distance = fminf(700.0f, fmaxf(8.0f, distance));
    camera_cancel_animation();
    g_rpd.input.rotating = false;
    g_rpd.input.panning = false;
    g_rpd.input.user_moved = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_animate_orbit(float tx, float ty, float tz,
                                           float distance, float duration) {
    if (!isfinite(tx) || !isfinite(ty) || !isfinite(tz) ||
        !isfinite(distance) || !isfinite(duration)) return -1;
    orbit_anim_t *a = &g_rpd.orbit;
    memcpy(a->from_target, g_rpd.camera.target, sizeof(a->from_target));
    a->to_target[0] = tx;
    a->to_target[1] = ty;
    a->to_target[2] = tz;
    a->from_distance = g_rpd.camera.distance;
    a->to_distance = distance < 0.0f
        ? g_rpd.camera.distance
        : fminf(700.0f, fmaxf(8.0f, distance));
    a->elapsed = 0.0f;
    a->duration = fminf(2.0f, fmaxf(0.05f, duration));
    a->active = true;
    g_rpd.input.rotating = false;
    g_rpd.input.panning = false;
    g_rpd.input.user_moved = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE void rpd_set_view_mode(int mode) {
    bool ortho = mode != 0;
    if (ortho == g_rpd.ortho) return;
    if (ortho) {
        memcpy(g_rpd.saved_target, g_rpd.camera.target, sizeof(g_rpd.saved_target));
        g_rpd.saved_yaw = g_rpd.camera.yaw;
        g_rpd.saved_pitch = g_rpd.camera.pitch;
        g_rpd.saved_distance = g_rpd.camera.distance;
        g_rpd.ortho_saved = true;
    }
    g_rpd.ortho = ortho;
    camera_cancel_animation();
}

EMSCRIPTEN_KEEPALIVE void rpd_reset_view(void) {
    camera_cancel_animation();
    g_rpd.input.rotating = false;
    g_rpd.input.panning = false;
    if (g_rpd.ortho) {
        plan_fit_camera();
        return;
    }
    g_rpd.input.user_moved = false;
    camera_reset();
}

EMSCRIPTEN_KEEPALIVE int rpd_get_view_proj(float *out) {
    if (!out) return -1;
    float eye[3];
    mat4 vp = blended_view_proj(eye);
    memcpy(out, vp.m, sizeof(vp.m));
    return 0;
}

EMSCRIPTEN_KEEPALIVE float rpd_debug_blend(void) {
    return g_rpd.ortho_blend;
}
