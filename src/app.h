#ifndef APP_H
#define APP_H

#include <stdbool.h>
#include <math.h>

#define MAP_PI 3.14159265358979323846f

typedef struct {
    float x, y;
} vec2;

typedef struct {
    float r, g, b, a;
} color;

typedef struct {
    float x, y, w, h;
} rect;

#define MAP_POLY_MAX 80
#define MAP_MAX_WAYPOINTS 3
#define PLAYER_MAX_TARGETS 12
#define WAYPOINT_CELL_SIZE 18.0f
#define PLAYER_WALK_SPEED 125.0f
#define PLAYER_RUN_SPEED 250.0f

typedef struct {
    vec2 pos;
    float max_speed;
} move_target;
#define MAP_DOOR_COUNT 2
#define MAP_WORLD_MIN_X (-360.0f)
#define MAP_WORLD_MAX_X (360.0f)
#define MAP_WORLD_MIN_Y (-90.0f)
#define MAP_WORLD_MAX_Y (250.0f)
#define MAP_WORLD_W (MAP_WORLD_MAX_X - MAP_WORLD_MIN_X)
#define MAP_WORLD_H (MAP_WORLD_MAX_Y - MAP_WORLD_MIN_Y)

typedef enum {
    DOOR_SERVICE = 0,
    DOOR_LOCKED,
} door_index;

typedef struct {
    vec2 center;
    float width;
    float height;
    bool hoverable;
} map_door;

typedef struct {
    vec2 poly[MAP_POLY_MAX];
    int poly_count;
    map_door doors[MAP_DOOR_COUNT];
} map_geometry;

typedef struct {
    vec2 center;
    vec2 target_center;
    float zoom;
    float target_zoom;
    float fit_zoom;
    bool user_modified;
} camera;

typedef struct {
    vec2 pos;
    float heading;
    float target_heading;
    vec2 route[MAP_MAX_WAYPOINTS];
    int route_count;
    int route_index;
    move_target targets[PLAYER_MAX_TARGETS];
    int target_count;
    float speed;
    float max_speed;
    bool moving;
    bool use_arc;
    float pulse_time;
    float reset_flash;
} player;

typedef enum {
    PAN_IDLE = 0,
    PAN_ACTIVE,
} pan_state;

typedef struct {
    map_geometry map;
    camera cam;
    player player;
    float width;
    float height;
    float vp_h;
    vec2 mouse;
    bool mouse_inside;
    float last_click_time;
    vec2 last_click_pos;
    int last_click_button;
    bool left_down;
    bool left_moved;
    vec2 left_start;
    bool right_down;
    bool right_moved;
    vec2 right_start;
    pan_state pan;
    vec2 pan_start;
    vec2 pan_center;
    float door_hover[MAP_DOOR_COUNT];
    float tooltip;
    float time;
    float fps;
    float fps_display;
    float fps_timer;
} app_state;

static inline vec2 vec2_make(float x, float y) {
    return (vec2){x, y};
}

static inline vec2 vec2_add(vec2 a, vec2 b) {
    return (vec2){a.x + b.x, a.y + b.y};
}

static inline vec2 vec2_sub(vec2 a, vec2 b) {
    return (vec2){a.x - b.x, a.y - b.y};
}

static inline vec2 vec2_scale(vec2 v, float s) {
    return (vec2){v.x * s, v.y * s};
}

static inline float vec2_len(vec2 v) {
    return sqrtf(v.x * v.x + v.y * v.y);
}

static inline vec2 vec2_norm(vec2 v) {
    float l = vec2_len(v);
    return l > 1e-6f ? vec2_scale(v, 1.0f / l) : vec2_make(0.0f, 0.0f);
}

static inline vec2 vec2_lerp(vec2 a, vec2 b, float t) {
    return (vec2){a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t};
}

static inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static inline float lerpf(float a, float b, float t) {
    return a + (b - a) * t;
}

static inline float smoothstepf(float t) {
    t = clampf(t, 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

static inline float wrap_angle(float a) {
    while (a > MAP_PI) {
        a -= 2.0f * MAP_PI;
    }
    while (a < -MAP_PI) {
        a += 2.0f * MAP_PI;
    }
    return a;
}

static inline float approachf(float value, float target, float max_delta) {
    if (value < target) {
        value += max_delta;
        return value > target ? target : value;
    }
    value -= max_delta;
    return value < target ? target : value;
}

static inline color color_make(float r, float g, float b, float a) {
    return (color){r, g, b, a};
}

static inline color color_hex(unsigned int hex, float a) {
    return (color){
        (float)((hex >> 16) & 0xff) / 255.0f,
        (float)((hex >> 8) & 0xff) / 255.0f,
        (float)(hex & 0xff) / 255.0f,
        a,
    };
}

static inline color color_lerp(color a, color b, float t) {
    return (color){
        a.r + (b.r - a.r) * t,
        a.g + (b.g - a.g) * t,
        a.b + (b.b - a.b) * t,
        a.a + (b.a - a.a) * t,
    };
}

static inline color color_alpha(color c, float a) {
    c.a = a;
    return c;
}

#endif
