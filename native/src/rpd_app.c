#define RPD_SOKOL_IMPL
#include "rpd_sokol.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_app.h"
#include "rpd_input.h"
#include "rpd_items.h"
#include "rpd_menu.h"
#include "rpd_overlay.h"
#include "rpd_plan.h"
#include "rpd_player.h"
#include "rpd_popup.h"
#include "rpd_state.h"

rpd_state_t g_rpd;

#define BLEND_DURATION 0.7f
#define RECENTER_DURATION 0.45f
#define CLAIRE_CAPSULE_TOP RPD_PLAYER_HEIGHT

static void reset_orbit_camera(void) {
    const bounds_t *b = &g_rpd.scene.bounds;
    for (int i = 0; i < 3; i++) g_rpd.camera.target[i] = 0.5f * (b->min[i] + b->max[i]);
    float dx = b->max[0] - b->min[0];
    float dy = b->max[1] - b->min[1];
    int w = sapp_width() > 0 ? sapp_width() : 1600;
    float distance;
    if (g_rpd.scene_radius < 30.0f) {
        g_rpd.camera.target[0] = 0.0f;
        g_rpd.camera.target[1] = 2.5f;
        g_rpd.camera.target[2] = 4.0f;
        g_rpd.camera.yaw = 0.0f;
        g_rpd.camera.pitch = 0.05f;
        distance = 14.0f;
    } else {
        g_rpd.camera.yaw = -0.55f;
        g_rpd.camera.pitch = 0.40f;
        g_rpd.camera.target[1] = b->min[1] + 0.40f * dy;
        distance = 3.6f * g_rpd.scene_radius * fmaxf(1.0f, 900.0f / (float)w);
    }
    g_rpd.camera.frame = camera_frame_from_distance(distance);
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
    g_rpd.camera.frame = a->from_frame + (a->to_frame - a->from_frame) * s;
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

static float blend_ease(void) {
    float t = g_rpd.ortho_blend;
    if (t < 0.0f) t = 0.0f;
    if (t > 1.0f) t = 1.0f;
    return t * t * (3.0f - 2.0f * t);
}

static mat4 camera_view_proj(float eye[3]) {
    float e = blend_ease();
    float right[3], up[3], forward[3];
    camera_basis(&g_rpd.camera, e, right, up, forward);
    float distance = camera_distance(&g_rpd.camera);
    for (int i = 0; i < 3; i++) eye[i] = g_rpd.camera.target[i] - forward[i] * distance;

    float vw = (float)(sapp_width() > 0 ? sapp_width() : 1600);
    float vh = (float)(sapp_height() > 0 ? sapp_height() : 900);
    float aspect = vw / vh;
    float half_h = 0.5f * g_rpd.camera.frame;
    float half_w = half_h * aspect;
    float near_z = 0.2f;
    float far_z = 2400.0f;
    mat4 persp = mat4_perspective(RPD_PERSPECTIVE_FOV, aspect, near_z, far_z);
    const float panel_inset = 380.0f;
    float lens_shift = panel_inset / vw;
    persp.m[8] = lens_shift;
    float ortho_shift = lens_shift * half_w;
    mat4 ortho = mat4_ortho(-half_w + ortho_shift, half_w + ortho_shift, -half_h, half_h, near_z, far_z);
    mat4 proj;
    for (int i = 0; i < 16; i++) proj.m[i] = persp.m[i] * (1.0f - e) + ortho.m[i] * e;
    mat4 view = mat4_view_basis(eye, right, up, forward);
    return mat4_mul(proj, view);
}

static void update_ortho_blend(float dt) {
    float target = g_rpd.ortho ? 1.0f : 0.0f;
    float step = dt / BLEND_DURATION;
    if (g_rpd.ortho_blend < target) g_rpd.ortho_blend = fminf(target, g_rpd.ortho_blend + step);
    else if (g_rpd.ortho_blend > target) g_rpd.ortho_blend = fmaxf(target, g_rpd.ortho_blend - step);
}

static int paper_floor(void) {
    int floor = plan_active_floor();
    if (!g_rpd.ortho && plan_moving()) {
        int moving_floor = plan_player_floor();
        if (moving_floor >= 0) floor = moving_floor;
    }
    return floor;
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
    mat4 vp = camera_view_proj(eye);
    float e = blend_ease();
    float fy = plan_level();
    bool clip = e > 0.45f;
    plan_update(raw_dt > 0.5f ? 0.5f : raw_dt, vp.m, sapp_width(), sapp_height());
    if (g_rpd.scene.loaded && g_rpd.scene.gpu_ready) {
        scene_render_floors(&g_rpd.scene, vp, eye, camera_distance(&g_rpd.camera),
                            g_rpd.scene_radius, paper_floor(), clip, fy - 0.55f, fy + 4.2f,
                            g_rpd.ortho ? fy : MARKER_FLOOR_ANY,
                            g_rpd.ortho, (float)sapp_height() / g_rpd.camera.frame);
    }
    sg_end_pass();

    if (!clip && g_rpd.scene.loaded && g_rpd.scene.gpu_ready) {
        // Glass blends over the paper and replaces its normal and depth data.
        // Rebuild the paper detail alone so its ink survives and glass adds none.
        sg_begin_pass(&g_rpd.target.data_pass);
        sg_apply_viewport(0, 0, g_rpd.target.width, g_rpd.target.height, true);
        scene_render_paper_data(&g_rpd.scene, vp, eye, paper_floor(), false,
                                fy - 0.55f, fy + 4.2f);
        sg_end_pass();
    }

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
    g_rpd.camera.frame = camera_frame_from_distance(150.0f);
    g_rpd.camera.target[1] = 10.0f;
}

void rpd_app_cleanup(void) {
    if (sdtx_ready) sdtx_shutdown();
    sg_shutdown();
    if (g_rpd.scene.data) free(g_rpd.scene.data);
}

static bool map_panning;
static bool right_click;
static bool right_dragging;
static float right_click_x, right_click_y;
EMSCRIPTEN_KEEPALIVE void rpd_set_view_mode(int mode);
EMSCRIPTEN_KEEPALIVE void rpd_reset_view(void);
EMSCRIPTEN_KEEPALIVE void rpd_recenter(void);

void rpd_app_event(const sapp_event *e) {
    if (e->type == SAPP_EVENTTYPE_KEY_DOWN && e->key_code == SAPP_KEYCODE_ESCAPE) {
        if (menu_is_open()) menu_close();
        else plan_clear_route();
        return;
    }
    if (e->type == SAPP_EVENTTYPE_KEY_DOWN && e->key_code == SAPP_KEYCODE_R) {
        rpd_reset_view();
        return;
    }
    if (e->type == SAPP_EVENTTYPE_KEY_DOWN && e->key_code == SAPP_KEYCODE_C) {
        rpd_recenter();
        return;
    }
    if (g_rpd.ortho_blend > 0.25f) {
        float s = sapp_dpi_scale();
        float mx = e->mouse_x * s;
        float my = e->mouse_y * s;
        if (e->type == SAPP_EVENTTYPE_MOUSE_MOVE) {
            if (right_click && hypotf(mx - right_click_x, my - right_click_y) > 4.0f * s) {
                right_dragging = true;
            }
            if (map_panning) plan_pan(e->mouse_dx * s, e->mouse_dy * s);
            else plan_pointer_move(mx, my);
        } else if (e->type == SAPP_EVENTTYPE_MOUSE_DOWN) {
            if (e->mouse_button == SAPP_MOUSEBUTTON_MIDDLE) map_panning = true;
            else if (e->mouse_button == SAPP_MOUSEBUTTON_LEFT) plan_pointer_down(mx, my);
            else if (e->mouse_button == SAPP_MOUSEBUTTON_RIGHT) {
                right_click = true;
                right_dragging = false;
                right_click_x = mx;
                right_click_y = my;
            }
        } else if (e->type == SAPP_EVENTTYPE_MOUSE_UP) {
            if (e->mouse_button == SAPP_MOUSEBUTTON_MIDDLE) map_panning = false;
            else if (e->mouse_button == SAPP_MOUSEBUTTON_RIGHT) {
                if (right_click && !right_dragging) menu_open(mx, my);
                right_click = false;
            }
        } else if (e->type == SAPP_EVENTTYPE_MOUSE_SCROLL) {
            plan_zoom(mx, my, e->scroll_y);
        }
        return;
    }
    input_handle_event(e);
}

EMSCRIPTEN_KEEPALIVE float rpd_player_radius(void) { return RPD_PLAYER_RADIUS; }

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
EMSCRIPTEN_KEEPALIVE void rpd_plan_add_target_node(int node) { plan_add_target_node(node); }
EMSCRIPTEN_KEEPALIVE int rpd_plan_remove_target_node(int node) { return plan_remove_target_node(node); }
EMSCRIPTEN_KEEPALIVE int rpd_plan_waypoint(int index) { return plan_waypoint_at(index); }
EMSCRIPTEN_KEEPALIVE int rpd_plan_hover(void) { return plan_hover(); }
EMSCRIPTEN_KEEPALIVE int rpd_plan_node_blocked(int node) { return plan_node_blocked(node); }
EMSCRIPTEN_KEEPALIVE void rpd_plan_pointer_move(float x, float y) { plan_pointer_move(x, y); }
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
EMSCRIPTEN_KEEPALIVE int rpd_plan_active_floor(void) { return plan_active_floor(); }
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
    const rpd_item_def_t *def = item->def;
    out[0] = def->x; out[1] = def->y; out[2] = def->z;
    out[3] = item->r; out[4] = item->g; out[5] = item->b;
    out[6] = (float)item->approach_node;
    out[7] = item->state == ITEM_TAKEN ? 1.0f : 0.0f;
    out[8] = -1.0f;
    out[9] = (float)def->floor;
    out[10] = (float)item->state;
    out[11] = (float)def->action;
    out[12] = (float)items_hidden(index);
    out[13] = (float)items_available(index);
    out[14] = (float)def->flags;
    float cube[3];
    items_cube_position(index, cube);
    out[15] = cube[0]; out[16] = cube[1]; out[17] = cube[2];
    return 1;
}

EMSCRIPTEN_KEEPALIVE const char *rpd_item_name(int index) {
    const item_t *item = items_get(index);
    return item ? item->def->title : "";
}

EMSCRIPTEN_KEEPALIVE const char *rpd_item_room(int index) {
    (void)index;
    return "";
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
    out[8] = (float)p->kind;
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

EMSCRIPTEN_KEEPALIVE void rpd_popup_close(void) {
    popup_close();
}

EMSCRIPTEN_KEEPALIVE int rpd_get_camera(float *out) {
    if (!out) return -1;
    float eye[3];
    camera_eye(&g_rpd.camera, blend_ease(), eye);
    out[0] = eye[0];
    out[1] = eye[1];
    out[2] = eye[2];
    out[3] = g_rpd.camera.yaw + RPD_PI;
    out[4] = -g_rpd.camera.pitch;
    out[5] = 1.0f;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_get_camera_model(float *out) {
    if (!out) return -1;
    out[0] = g_rpd.camera.target[0];
    out[1] = g_rpd.camera.target[1];
    out[2] = g_rpd.camera.target[2];
    out[3] = g_rpd.camera.frame;
    out[4] = g_rpd.camera.yaw;
    out[5] = g_rpd.camera.pitch;
    float right[3], up[3], forward[3];
    camera_basis(&g_rpd.camera, blend_ease(), right, up, forward);
    float down = fminf(1.0f, fmaxf(-1.0f, -forward[1]));
    out[6] = asinf(down);
    out[7] = g_rpd.ortho_blend;
    out[8] = camera_distance(&g_rpd.camera);
    return 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_debug_floors(float *out) {
    if (!out) return -1;
    int paper = paper_floor();
    out[0] = (float)paper;
    int count = 0;
    int total = scene_floor_count();
    if (!g_rpd.ortho) {
        for (int i = 0; i < total; i++) {
            if (i == paper) continue;
            out[2 + count] = (float)i;
            count++;
        }
    }
    out[1] = (float)count;
    return count;
}

EMSCRIPTEN_KEEPALIVE int rpd_set_orbit(float tx, float ty, float tz, float yaw, float pitch, float distance) {
    if (!isfinite(tx) || !isfinite(ty) || !isfinite(tz) ||
        !isfinite(yaw) || !isfinite(pitch) || !isfinite(distance)) return -1;
    g_rpd.camera.target[0] = tx;
    g_rpd.camera.target[1] = ty;
    g_rpd.camera.target[2] = tz;
    g_rpd.camera.yaw = yaw;
    g_rpd.camera.pitch = fminf(1.45f, fmaxf(0.08f, pitch));
    g_rpd.camera.frame = camera_frame_from_distance(fminf(700.0f, fmaxf(8.0f, distance)));
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
    a->from_frame = g_rpd.camera.frame;
    a->to_frame = distance < 0.0f
        ? g_rpd.camera.frame
        : camera_frame_from_distance(fminf(700.0f, fmaxf(8.0f, distance)));
    a->elapsed = 0.0f;
    a->duration = fminf(2.0f, fmaxf(0.05f, duration));
    a->active = true;
    g_rpd.input.rotating = false;
    g_rpd.input.panning = false;
    g_rpd.input.user_moved = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE void rpd_recenter(void) {
    float player[3];
    plan_player(player);
    int floor = plan_player_floor();
    if (floor < 0) floor = plan_active_floor();
    orbit_anim_t *a = &g_rpd.orbit;
    memcpy(a->from_target, g_rpd.camera.target, sizeof(a->from_target));
    a->from_frame = g_rpd.camera.frame;
    if (g_rpd.ortho) plan_set_floor(floor);
    a->to_target[0] = player[0];
    a->to_target[1] = player[1] + CLAIRE_CAPSULE_TOP;
    a->to_target[2] = player[2];
    a->to_frame = a->from_frame;
    a->elapsed = 0.0f;
    a->duration = RECENTER_DURATION;
    a->active = true;
    g_rpd.input.rotating = false;
    g_rpd.input.panning = false;
    g_rpd.input.user_moved = true;
}

EMSCRIPTEN_KEEPALIVE void rpd_set_view_mode(int mode) {
    bool ortho = mode != 0;
    if (ortho == g_rpd.ortho) return;
    g_rpd.ortho = ortho;
    menu_close();
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
    mat4 vp = camera_view_proj(eye);
    memcpy(out, vp.m, sizeof(vp.m));
    return 0;
}

EMSCRIPTEN_KEEPALIVE float rpd_debug_blend(void) {
    return g_rpd.ortho_blend;
}
