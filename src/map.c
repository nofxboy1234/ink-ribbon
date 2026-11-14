#include "map.h"

#include <math.h>

#define ARC_SEGMENTS 12
#define CORNER_RADIUS 32.0f

#define DEFAULT_ZOOM_FACTOR 0.5f
#define MIN_ZOOM_FACTOR 0.28f
#define MAX_ZOOM_FACTOR 1.09f

#define PLAYER_ACCEL 1400.0f
#define PLAYER_DECEL 1200.0f

static void add_point(map_geometry *map, float x, float y) {
    if (map->poly_count < MAP_POLY_MAX) {
        map->poly[map->poly_count++] = vec2_make(x, y);
    }
}

static float camera_fit_zoom(float vp_w, float vp_h) {
    float fit_w = (vp_w - 400.0f) / MAP_WORLD_W;
    float fit_h = (vp_h - 200.0f) / MAP_WORLD_H;
    return clampf(fminf(fit_w, fit_h), 0.25f, 6.0f);
}

static bool point_near_segment(vec2 p, vec2 a, vec2 b, float eps) {
    vec2 ab = vec2_sub(b, a);
    vec2 ap = vec2_sub(p, a);
    float len2 = ab.x * ab.x + ab.y * ab.y;
    if (len2 < 1e-9f) {
        return vec2_len(ap) <= eps;
    }
    float t = clampf((ap.x * ab.x + ap.y * ab.y) / len2, 0.0f, 1.0f);
    vec2 closest = vec2_add(a, vec2_scale(ab, t));
    return vec2_len(vec2_sub(p, closest)) <= eps;
}

void map_init(map_geometry *map) {
    map->poly_count = 0;
    add_point(map, -120.0f, 250.0f);
    add_point(map, 120.0f, 250.0f);
    add_point(map, 120.0f, 90.0f);
    add_point(map, 360.0f, 90.0f);
    add_point(map, 360.0f, -90.0f + CORNER_RADIUS);

    for (int i = 1; i <= ARC_SEGMENTS; i++) {
        float a = -(float)i * (MAP_PI * 0.5f) / (float)ARC_SEGMENTS;
        add_point(map, (360.0f - CORNER_RADIUS) + CORNER_RADIUS * cosf(a), (-90.0f + CORNER_RADIUS) + CORNER_RADIUS * sinf(a));
    }

    add_point(map, -360.0f + CORNER_RADIUS, -90.0f);

    for (int i = 1; i <= ARC_SEGMENTS; i++) {
        float a = -MAP_PI * 0.5f - (float)i * (MAP_PI * 0.5f) / (float)ARC_SEGMENTS;
        add_point(map, (-360.0f + CORNER_RADIUS) + CORNER_RADIUS * cosf(a), (-90.0f + CORNER_RADIUS) + CORNER_RADIUS * sinf(a));
    }

    add_point(map, -360.0f, 90.0f);
    add_point(map, -120.0f, 90.0f);

    map->doors[DOOR_SERVICE] = (map_door){
        .center = {0.0f, 250.0f},
        .width = 58.0f,
        .height = 10.0f,
        .hoverable = false,
    };
    map->doors[DOOR_LOCKED] = (map_door){
        .center = {0.0f, -90.0f},
        .width = 58.0f,
        .height = 12.0f,
        .hoverable = true,
    };
}

bool map_contains(const map_geometry *map, vec2 p) {
    bool inside = false;
    for (int i = 0, j = map->poly_count - 1; i < map->poly_count; j = i++) {
        vec2 a = map->poly[i];
        vec2 b = map->poly[j];
        if (point_near_segment(p, a, b, 0.01f)) {
            return true;
        }
        if (((a.y > p.y) != (b.y > p.y)) &&
            (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) {
            inside = !inside;
        }
    }
    return inside;
}

bool map_door_hit(const map_geometry *map, int door, vec2 p, float pad) {
    const map_door *d = &map->doors[door];
    return fabsf(p.x - d->center.x) <= d->width * 0.5f + pad &&
           fabsf(p.y - d->center.y) <= d->height * 0.5f + pad;
}

void player_init(player *p) {
    *p = (player){0};
    p->pos = vec2_make(0.0f, -8.0f);
    p->heading = 0.0f;
}

static bool player_can_stand(const map_geometry *map, vec2 pos, float body_radius) {
    if (!map_contains(map, pos)) {
        return false;
    }
    for (int i = 0; i < 8; i++) {
        float a = (float)i * (2.0f * MAP_PI / 8.0f);
        vec2 sample = vec2_make(pos.x + cosf(a) * body_radius,
                                pos.y + sinf(a) * body_radius);
        if (!map_contains(map, sample)) {
            return false;
        }
    }
    return true;
}

static float player_move(player *p, const map_geometry *map, vec2 delta, float body_radius) {
    float len = vec2_len(delta);
    if (len < 1e-5f) {
        return 0.0f;
    }
    int steps = (int)ceilf(len);
    if (steps < 1) {
        steps = 1;
    }
    vec2 inc = vec2_scale(delta, 1.0f / (float)steps);
    float moved = 0.0f;
    for (int i = 0; i < steps; i++) {
        vec2 next = vec2_add(p->pos, inc);
        if (player_can_stand(map, next, body_radius)) {
            p->pos = next;
            moved += vec2_len(inc);
            continue;
        }
        vec2 slide_x = vec2_make(inc.x, 0.0f);
        vec2 slide_y = vec2_make(0.0f, inc.y);
        if (fabsf(inc.x) > 1e-5f && player_can_stand(map, vec2_add(p->pos, slide_x), body_radius)) {
            p->pos = vec2_add(p->pos, slide_x);
            moved += fabsf(inc.x);
        } else if (fabsf(inc.y) > 1e-5f && player_can_stand(map, vec2_add(p->pos, slide_y), body_radius)) {
            p->pos = vec2_add(p->pos, slide_y);
            moved += fabsf(inc.y);
        } else {
            break;
        }
    }
    return moved;
}

void player_update(player *p, const map_geometry *map, move_input input,
                   float body_radius, float dt) {
    p->pulse_time = fmodf(p->pulse_time + dt, 1000.0f);
    if (p->reset_flash > 0.0f) {
        p->reset_flash = fmaxf(0.0f, p->reset_flash - dt / 1.4f);
    }

    float target_speed = input.active
                             ? (input.running ? PLAYER_RUN_SPEED : PLAYER_WALK_SPEED)
                             : 0.0f;
    float rate = target_speed > p->speed ? PLAYER_ACCEL : PLAYER_DECEL;
    p->speed = approachf(p->speed, target_speed, rate * dt);

    if (!input.active) {
        return;
    }

    if (input.running) {
        float wanted = atan2f(input.dir.x, input.dir.y);
        float turn = wrap_angle(wanted - p->heading);
        float max_turn = PLAYER_RUN_TURN_RATE * dt;
        p->heading = wrap_angle(p->heading + clampf(turn, -max_turn, max_turn));
        player_move(p, map,
                    vec2_scale(vec2_make(sinf(p->heading), cosf(p->heading)),
                               p->speed * dt),
                    body_radius);
    } else {
        player_move(p, map, vec2_scale(input.dir, p->speed * dt), body_radius);
    }
}

void camera_init(camera *cam, float vp_w, float vp_h) {
    cam->fit_zoom = camera_fit_zoom(vp_w, vp_h);
    cam->center = vec2_make(0.0f, -8.0f);
    cam->target_center = cam->center;
    cam->zoom = cam->fit_zoom * DEFAULT_ZOOM_FACTOR;
    cam->target_zoom = cam->zoom;
    cam->user_modified = false;
}

void camera_resize(camera *cam, float vp_w, float vp_h) {
    cam->fit_zoom = camera_fit_zoom(vp_w, vp_h);
    if (!cam->user_modified) {
        cam->target_zoom = cam->fit_zoom * DEFAULT_ZOOM_FACTOR;
    }
    cam->target_zoom = clampf(cam->target_zoom,
                              cam->fit_zoom * MIN_ZOOM_FACTOR,
                              cam->fit_zoom * MAX_ZOOM_FACTOR);
}

void camera_update(camera *cam, float dt) {
    cam->center = cam->target_center;
    float k_zoom = 1.0f - expf(-14.0f * dt);
    cam->zoom += (cam->target_zoom - cam->zoom) * k_zoom;
}

void camera_reset(camera *cam, vec2 player_pos) {
    cam->target_center = player_pos;
    cam->target_zoom = cam->fit_zoom * DEFAULT_ZOOM_FACTOR;
    cam->user_modified = false;
}

void camera_zoom(camera *cam, float factor) {
    float new_zoom = clampf(cam->zoom * factor,
                            cam->fit_zoom * MIN_ZOOM_FACTOR,
                            cam->fit_zoom * MAX_ZOOM_FACTOR);
    cam->zoom = new_zoom;
    cam->target_zoom = new_zoom;
    cam->user_modified = true;
}

vec2 map_world_to_screen(const camera *cam, float vp_w, float vp_h, vec2 world) {
    return vec2_make(
        vp_w * 0.5f + (world.x - cam->center.x) * cam->zoom,
        vp_h * 0.5f - (world.y - cam->center.y) * cam->zoom);
}

vec2 map_screen_to_world(const camera *cam, float vp_w, float vp_h, vec2 screen) {
    return vec2_make(
        cam->center.x + (screen.x - vp_w * 0.5f) / cam->zoom,
        cam->center.y - (screen.y - vp_h * 0.5f) / cam->zoom);
}
