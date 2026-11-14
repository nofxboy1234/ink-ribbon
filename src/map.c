#include "map.h"

#include <math.h>

#define ARC_SEGMENTS 12
#define CORNER_RADIUS 32.0f

#define DEFAULT_ZOOM_FACTOR 0.5f
#define MIN_ZOOM_FACTOR 0.28f
#define MAX_ZOOM_FACTOR 1.09f

#define PLAYER_ACCEL 1400.0f
#define PLAYER_DECEL 1200.0f
#define PLAYER_TURN_RATE 13.0f
#define PLAYER_ARC_TURN_RATE 8.0f
#define PLAYER_ARC_MIN_DIST 36.0f
#define PLAYER_ARC_MIN_SPEED 12.0f
#define PLAYER_TARGET_ACCEPT 14.0f
#define PLAYER_BODY_RADIUS 24.0f
#define PLAYER_REVERSE_EPS 0.06f
#define PLAYER_ARRIVE_DIST 0.8f
#define ROUTE_SAMPLES 96

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

void map_build_route(const map_geometry *map, vec2 from, vec2 to,
                     vec2 out[MAP_MAX_WAYPOINTS], int *count) {
    bool clear = true;
    for (int i = 0; i <= ROUTE_SAMPLES; i++) {
        float t = (float)i / (float)ROUTE_SAMPLES;
        vec2 p = vec2_lerp(from, to, t);
        if (!map_contains(map, p)) {
            clear = false;
            break;
        }
    }
    if (clear) {
        out[0] = to;
        *count = 1;
    } else {
        out[0] = vec2_make(0.0f, 0.0f);
        out[1] = to;
        *count = 2;
    }
}

void player_init(player *p) {
    *p = (player){0};
    p->pos = vec2_make(0.0f, -8.0f);
    p->heading = 0.0f;
    p->target_heading = 0.0f;
    p->max_speed = PLAYER_RUN_SPEED;
    p->running = false;
}

static void player_set_current_target(player *p, const map_geometry *map) {
    const move_target *target = &p->targets[0];
    map_build_route(map, p->pos, target->pos, p->route, &p->route_count);
    p->route_index = 0;
    p->max_speed = target->max_speed;
    p->running = target->running;
    p->moving = true;

    vec2 delta = vec2_sub(target->pos, p->pos);
    float wanted = atan2f(delta.x, delta.y);
    float error = fabsf(wrap_angle(wanted - p->heading));
    p->use_arc = p->running &&
                 p->speed > PLAYER_ARC_MIN_SPEED &&
                 error > 0.08f &&
                 (p->target_count > 1 || error < MAP_PI - PLAYER_REVERSE_EPS);
}

void player_push_target(player *p, const map_geometry *map, vec2 target, float max_speed) {
    if (p->target_count == 0) {
        p->targets[0] = (move_target){.pos = target, .max_speed = max_speed,
                                      .running = max_speed >= PLAYER_RUN_SPEED - 0.1f};
        p->target_count = 1;
        player_set_current_target(p, map);
    } else if (p->target_count < PLAYER_MAX_TARGETS) {
        p->targets[p->target_count++] = (move_target){.pos = target, .max_speed = max_speed,
                                                       .running = max_speed >= PLAYER_RUN_SPEED - 0.1f};
    } else {
        p->targets[PLAYER_MAX_TARGETS - 1] = (move_target){.pos = target, .max_speed = max_speed,
                                                            .running = max_speed >= PLAYER_RUN_SPEED - 0.1f};
    }
}

void player_cancel_movement(player *p) {
    p->target_count = 0;
    p->route_count = 0;
    p->route_index = 0;
    p->moving = false;
    p->speed = 0.0f;
    p->running = false;
    p->use_arc = false;
}

static void player_advance_target(player *p, const map_geometry *map) {
    if (p->target_count > 1) {
        for (int i = 1; i < p->target_count; i++) {
            p->targets[i - 1] = p->targets[i];
        }
        p->target_count--;
        player_set_current_target(p, map);
    } else {
        p->target_count = 0;
        p->moving = false;
        p->speed = 0.0f;
    }
}

static bool player_can_stand(const map_geometry *map, vec2 pos) {
    if (!map_contains(map, pos)) {
        return false;
    }
    for (int i = 0; i < 8; i++) {
        float a = (float)i * (2.0f * MAP_PI / 8.0f);
        vec2 sample = vec2_make(pos.x + cosf(a) * PLAYER_BODY_RADIUS,
                                pos.y + sinf(a) * PLAYER_BODY_RADIUS);
        if (!map_contains(map, sample)) {
            return false;
        }
    }
    return true;
}

static float player_move(player *p, const map_geometry *map, vec2 delta) {
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
        if (player_can_stand(map, next)) {
            p->pos = next;
            moved += vec2_len(inc);
            continue;
        }
        vec2 slide_x = vec2_make(inc.x, 0.0f);
        vec2 slide_y = vec2_make(0.0f, inc.y);
        if (fabsf(inc.x) > 1e-5f && player_can_stand(map, vec2_add(p->pos, slide_x))) {
            p->pos = vec2_add(p->pos, slide_x);
            moved += fabsf(inc.x);
        } else if (fabsf(inc.y) > 1e-5f && player_can_stand(map, vec2_add(p->pos, slide_y))) {
            p->pos = vec2_add(p->pos, slide_y);
            moved += fabsf(inc.y);
        } else {
            break;
        }
    }
    return moved;
}

void player_step(player *p, const map_geometry *map, float dt) {
    if (!p->moving || p->target_count == 0) {
        p->speed = approachf(p->speed, 0.0f, PLAYER_DECEL * dt);
        return;
    }

    vec2 to = vec2_sub(p->route[p->route_index], p->pos);
    float dist = vec2_len(to);
    bool last_route = p->route_index == p->route_count - 1;
    bool last_target = p->target_count == 1;

    if (last_route && last_target && dist < 16.0f) {
        float ease_rate = clampf(p->speed / fmaxf(dist, 0.001f), 4.0f, 20.0f);
        float k = 1.0f - expf(-ease_rate * dt);
        float moved = player_move(p, map, vec2_scale(to, k));
        p->speed = moved / fmaxf(dt, 1e-5f);
        float remaining = vec2_len(vec2_sub(p->targets[0].pos, p->pos));
        if (remaining < 0.12f || remaining < PLAYER_BODY_RADIUS + 0.8f || moved < 0.005f) {
            p->speed = 0.0f;
            p->moving = false;
            p->target_count = 0;
        }
        return;
    }

    if (last_route && !last_target && dist < PLAYER_TARGET_ACCEPT) {
        player_advance_target(p, map);
        return;
    }

    if (dist < PLAYER_ARRIVE_DIST) {
        if (!last_route) {
            p->route_index++;
            to = vec2_sub(p->route[p->route_index], p->pos);
            dist = vec2_len(to);
            last_route = p->route_index == p->route_count - 1;
        } else {
            p->target_count = 0;
            p->moving = false;
            p->speed = 0.0f;
            return;
        }
    }

    if (dist > 0.01f) {
        p->target_heading = atan2f(to.x, to.y);
    }

    float desired;
    if (last_route && last_target) {
        desired = fminf(p->max_speed, sqrtf(2.0f * PLAYER_DECEL * dist));
    } else {
        desired = p->max_speed;
    }
    float rate = desired > p->speed ? PLAYER_ACCEL : PLAYER_DECEL;
    p->speed = approachf(p->speed, desired, rate * dt);

    if (p->running && p->use_arc && last_route && dist > PLAYER_ARC_MIN_DIST &&
        p->speed > PLAYER_ARC_MIN_SPEED) {
        float turn = wrap_angle(p->target_heading - p->heading);
        float max_turn = PLAYER_ARC_TURN_RATE * dt;
        p->heading = wrap_angle(p->heading + clampf(turn, -max_turn, max_turn));
        float step = fminf(p->speed * dt, dist);
        float moved = player_move(p, map,
                                  vec2_scale(vec2_make(sinf(p->heading), cosf(p->heading)), step));
        if (moved < 0.005f) {
            if (last_route && dist < PLAYER_BODY_RADIUS + 10.0f) {
                if (last_target) {
                    p->target_count = 0;
                    p->moving = false;
                    p->speed = 0.0f;
                } else {
                    player_advance_target(p, map);
                }
            } else {
                p->speed = 0.0f;
            }
        }
        return;
    }

    if (!p->running) {
        float step = fminf(p->speed * dt, dist);
        float moved = player_move(p, map, vec2_scale(vec2_norm(to), step));
        if (moved < 0.005f) {
            if (last_route && dist < PLAYER_BODY_RADIUS + 10.0f) {
                if (last_target) {
                    p->target_count = 0;
                    p->moving = false;
                    p->speed = 0.0f;
                } else {
                    player_advance_target(p, map);
                }
            } else {
                p->speed = 0.0f;
            }
        }
        return;
    }

    float turn = wrap_angle(p->target_heading - p->heading);
    p->heading = wrap_angle(p->heading + turn * (1.0f - expf(-PLAYER_TURN_RATE * dt)));
    float step = fminf(p->speed * dt, dist);
    float moved = player_move(p, map, vec2_scale(vec2_norm(to), step));
    if (moved < 0.005f) {
        if (last_route && dist < PLAYER_BODY_RADIUS + 10.0f) {
            if (last_target) {
                p->target_count = 0;
                p->moving = false;
                p->speed = 0.0f;
            } else {
                player_advance_target(p, map);
            }
        } else {
            p->speed = 0.0f;
        }
    }
}

void player_update(player *p, const map_geometry *map, float dt) {
    p->pulse_time = fmodf(p->pulse_time + dt, 1000.0f);
    if (p->reset_flash > 0.0f) {
        p->reset_flash = fmaxf(0.0f, p->reset_flash - dt / 1.4f);
    }
    player_step(p, map, dt);
}

void camera_init(camera *cam, float vp_w, float vp_h) {
    cam->fit_zoom = camera_fit_zoom(vp_w, vp_h);
    cam->center = vec2_make(0.0f, 80.0f);
    cam->target_center = cam->center;
    cam->zoom = cam->fit_zoom * DEFAULT_ZOOM_FACTOR;
    cam->target_zoom = cam->zoom;
    cam->user_modified = false;
}

void camera_resize(camera *cam, float vp_w, float vp_h) {
    cam->fit_zoom = camera_fit_zoom(vp_w, vp_h);
    if (!cam->user_modified) {
        cam->target_center = vec2_make(0.0f, 80.0f);
        cam->target_zoom = cam->fit_zoom * DEFAULT_ZOOM_FACTOR;
    }
    cam->target_zoom = clampf(cam->target_zoom,
                              cam->fit_zoom * MIN_ZOOM_FACTOR,
                              cam->fit_zoom * MAX_ZOOM_FACTOR);
    camera_clamp(cam);
}

void camera_update(camera *cam, float dt) {
    float k_center = 1.0f - expf(-12.0f * dt);
    float k_zoom = 1.0f - expf(-14.0f * dt);
    cam->center.x += (cam->target_center.x - cam->center.x) * k_center;
    cam->center.y += (cam->target_center.y - cam->center.y) * k_center;
    cam->zoom += (cam->target_zoom - cam->zoom) * k_zoom;
}

void camera_reset(camera *cam, vec2 player_pos) {
    cam->target_center = player_pos;
    cam->target_zoom = cam->fit_zoom * DEFAULT_ZOOM_FACTOR;
    cam->user_modified = false;
}

void camera_zoom_at(camera *cam, float vp_w, float vp_h, vec2 anchor, float factor) {
    float new_zoom = clampf(cam->zoom * factor,
                            cam->fit_zoom * MIN_ZOOM_FACTOR,
                            cam->fit_zoom * MAX_ZOOM_FACTOR);
    float wx = cam->center.x + (anchor.x - vp_w * 0.5f) / cam->zoom;
    float wy = cam->center.y - (anchor.y - vp_h * 0.5f) / cam->zoom;

    cam->target_zoom = new_zoom;
    cam->zoom = new_zoom;
    cam->target_center.x = wx - (anchor.x - vp_w * 0.5f) / new_zoom;
    cam->target_center.y = wy + (anchor.y - vp_h * 0.5f) / new_zoom;
    camera_clamp(cam);
    cam->center = cam->target_center;
    cam->user_modified = true;
}

void camera_clamp(camera *cam) {
    float mx = 180.0f;
    float my = 130.0f;
    cam->target_center.x = clampf(cam->target_center.x,
                                  MAP_WORLD_MIN_X - mx, MAP_WORLD_MAX_X + mx);
    cam->target_center.y = clampf(cam->target_center.y,
                                  MAP_WORLD_MIN_Y - my, MAP_WORLD_MAX_Y + my);
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
