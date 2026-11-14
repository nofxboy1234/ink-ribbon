#include "map.h"

#include <math.h>

#define ARC_SEGMENTS 12
#define CORNER_RADIUS 32.0f

#define PLAYER_MAX_SPEED 250.0f
#define PLAYER_ACCEL 1400.0f
#define PLAYER_DECEL 1200.0f
#define PLAYER_TURN_RATE 13.0f
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
        .width = 62.0f,
        .height = 6.0f,
        .fill = color_hex(0xb0ada8, 0.9f),
        .hoverable = false,
    };
    map->doors[DOOR_LOCKED] = (map_door){
        .center = {0.0f, -90.0f},
        .width = 62.0f,
        .height = 7.0f,
        .fill = color_hex(0x7c1b1b, 1.0f),
        .hoverable = true,
    };
    map->label_pos = vec2_make(0.0f, 64.0f);
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
}

void player_set_target(player *p, const map_geometry *map, vec2 target) {
    map_build_route(map, p->pos, target, p->route, &p->route_count);
    p->route_index = 0;
    p->moving = p->route_count > 0;
}

void player_update(player *p, float dt) {
    p->pulse_time = fmodf(p->pulse_time + dt, 1000.0f);
    if (p->reset_flash > 0.0f) {
        p->reset_flash = fmaxf(0.0f, p->reset_flash - dt / 1.4f);
    }

    if (!p->moving) {
        p->speed = approachf(p->speed, 0.0f, PLAYER_DECEL * dt);
        return;
    }

    vec2 to = vec2_sub(p->route[p->route_index], p->pos);
    float dist = vec2_len(to);

    if (p->route_index == p->route_count - 1 && dist < 16.0f) {
        float k = 1.0f - expf(-12.0f * dt);
        float step = dist * k;
        p->pos = vec2_add(p->pos, vec2_scale(to, k));
        p->speed = step / fmaxf(dt, 1e-5f);
        if (dist < 0.12f) {
            p->pos = p->route[p->route_count - 1];
            p->speed = 0.0f;
            p->moving = false;
        }
        return;
    }

    if (dist < PLAYER_ARRIVE_DIST) {
        p->route_index++;
        if (p->route_index >= p->route_count) {
            p->moving = false;
            p->speed = 0.0f;
            p->pos = p->route[p->route_count - 1];
            return;
        }
        to = vec2_sub(p->route[p->route_index], p->pos);
        dist = vec2_len(to);
    }

    if (dist > 0.01f) {
        p->target_heading = atan2f(to.x, to.y);
    }

    float turn = wrap_angle(p->target_heading - p->heading);
    p->heading = wrap_angle(p->heading + turn * (1.0f - expf(-PLAYER_TURN_RATE * dt)));

    float desired = fminf(PLAYER_MAX_SPEED, sqrtf(2.0f * PLAYER_DECEL * dist));
    float rate = desired > p->speed ? PLAYER_ACCEL : PLAYER_DECEL;
    p->speed = approachf(p->speed, desired, rate * dt);

    float step = fminf(p->speed * dt, dist);
    p->pos = vec2_add(p->pos, vec2_scale(vec2_norm(to), step));
}

void camera_init(camera *cam, float vp_w, float vp_h) {
    cam->fit_zoom = camera_fit_zoom(vp_w, vp_h);
    cam->center = vec2_make(0.0f, 80.0f);
    cam->target_center = cam->center;
    cam->zoom = cam->fit_zoom;
    cam->target_zoom = cam->fit_zoom;
    cam->user_modified = false;
}

void camera_resize(camera *cam, float vp_w, float vp_h) {
    cam->fit_zoom = camera_fit_zoom(vp_w, vp_h);
    if (!cam->user_modified) {
        cam->target_center = vec2_make(0.0f, 80.0f);
        cam->target_zoom = cam->fit_zoom;
    }
    cam->target_zoom = clampf(cam->target_zoom, cam->fit_zoom * 0.5f, cam->fit_zoom * 4.0f);
    camera_clamp(cam);
}

void camera_update(camera *cam, float dt) {
    float k_center = 1.0f - expf(-12.0f * dt);
    float k_zoom = 1.0f - expf(-14.0f * dt);
    cam->center.x += (cam->target_center.x - cam->center.x) * k_center;
    cam->center.y += (cam->target_center.y - cam->center.y) * k_center;
    cam->zoom += (cam->target_zoom - cam->zoom) * k_zoom;
}

void camera_reset(camera *cam, float vp_w, vec2 player_pos) {
    float margin = 48.0f / cam->fit_zoom;
    float limit = fmaxf(0.0f, vp_w / (2.0f * cam->fit_zoom) - MAP_WORLD_W * 0.5f - margin);
    cam->target_center.x = clampf(player_pos.x, -limit, limit);
    cam->target_center.y = 80.0f;
    cam->target_zoom = cam->fit_zoom;
    cam->user_modified = false;
}

void camera_zoom_at(camera *cam, float vp_w, float vp_h, vec2 anchor, float factor) {
    float new_zoom = clampf(cam->target_zoom * factor, cam->fit_zoom * 0.5f, cam->fit_zoom * 4.0f);
    float wx = cam->target_center.x + (anchor.x - vp_w * 0.5f) / cam->target_zoom;
    float wy = cam->target_center.y - (anchor.y - vp_h * 0.5f) / cam->target_zoom;

    cam->target_zoom = new_zoom;
    cam->target_center.x = wx - (anchor.x - vp_w * 0.5f) / new_zoom;
    cam->target_center.y = wy + (anchor.y - vp_h * 0.5f) / new_zoom;
    cam->user_modified = true;
    camera_clamp(cam);
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
