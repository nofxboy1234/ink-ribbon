#define RPD_SOKOL_IMPL
#include "rpd_sokol.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_app.h"
#include "rpd_input.h"
#include "rpd_state.h"

rpd_state_t g_rpd;

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
        g_rpd.camera.pitch = 0.62f;
        g_rpd.camera.target[1] = b->min[1] + 0.40f * dy;
        g_rpd.camera.distance = 2.2f * g_rpd.scene_radius * fmaxf(1.0f, 900.0f / (float)w);
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

static mat4 current_view_proj(void) {
    float eye[3];
    camera_eye(&g_rpd.camera, eye);
    mat4 proj = mat4_perspective(0.62f, (float)sapp_width() / (float)sapp_height(), 0.2f, 1600.0f);
    mat4 view = mat4_look_at(eye, g_rpd.camera.target, (float[3]){ 0.0f, 1.0f, 0.0f });
    return mat4_mul(proj, view);
}

void rpd_app_frame(void) {
    float dt = (float)sapp_frame_duration();
    if (dt < 0.0f) dt = 0.0f;
    if (dt > 0.1f) dt = 0.1f;
    camera_update_animation(dt);
    if (g_rpd.scene.pending) {
        g_rpd.scene.pending = false;
        g_rpd.scene.loaded = scene_upload(&g_rpd.scene);
        if (g_rpd.scene.loaded) camera_reset();
    }
    if (g_rpd.target.dirty || g_rpd.target.width != sapp_width() || g_rpd.target.height != sapp_height())
        target_create(&g_rpd.target, sapp_width(), sapp_height());

    sg_begin_pass(&g_rpd.target.pass);
    sg_apply_viewport(0, 0, g_rpd.target.width, g_rpd.target.height, true);

    if (g_rpd.map_mode) {
        map_render(&g_rpd.map, &g_rpd.scene);
    } else if (g_rpd.scene.loaded && g_rpd.scene.gpu_ready) {
        scene_render(&g_rpd.scene, &g_rpd.camera, g_rpd.scene_radius, g_rpd.glass_style);
    }
    sg_end_pass();

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
    target_create_composite(&g_rpd.target);
    map_create_pipeline(&g_rpd.map);
    g_rpd.target.dirty = true;
    g_rpd.camera.yaw = -0.55f;
    g_rpd.camera.pitch = 0.62f;
    g_rpd.camera.distance = 150.0f;
    g_rpd.camera.target[1] = 10.0f;
    g_rpd.glass_style = false;
}

void rpd_app_cleanup(void) {
    sg_shutdown();
    if (g_rpd.scene.data) free(g_rpd.scene.data);
}

void rpd_app_event(const sapp_event *e) {
    input_handle_event(e);
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

EMSCRIPTEN_KEEPALIVE void rpd_set_render_style(int style) {
    g_rpd.glass_style = style != 0;
}

EMSCRIPTEN_KEEPALIVE void rpd_set_view_mode(int mode) {
    g_rpd.map_mode = mode != 0;
}

EMSCRIPTEN_KEEPALIVE int rpd_get_view_proj(float *out) {
    if (!out) return -1;
    mat4 vp = current_view_proj();
    memcpy(out, vp.m, sizeof(vp.m));
    return 0;
}
