#include "rpd_plan.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_markers.h"
#include "rpd_popup.h"
#include "rpd_route.h"

#define MAX_WAYPOINTS 32
#define MAX_ROUTE 8192

static int nav_count;
static float *nav_x, *nav_y, *nav_z;
static uint8_t *nav_floor, *nav_kind;
static int *nav_first, *nav_adj;
static float *nav_cost;
static uint8_t *nav_blocked;

static int floor_count;
static float floor_levels[8];
static float floor_bounds[8][4];
static int active_floor;

static int room_count;
static float *room_x, *room_y, *room_z;
static uint8_t *room_floor;
static int *room_offset;
static char *room_names;

static float player[3];
static float spawn[3];
static int player_node = -1;
static int waypoints[MAX_WAYPOINTS];
static int waypoint_count;
static float route[MAX_ROUTE * 3];
static int route_count;
static float move_pts[MAX_ROUTE * 3];
static int move_count;
static int moving;
static int move_index;
static float move_t;
static int hover = -1;

static float view_proj[16];
static int view_w, view_h;
static float map_cx, map_cz, map_scale = 8.0f;
static int fitted_floor = -1;

static float dist2(float ax, float ay, float az, float bx, float by, float bz) {
    float dx = ax - bx, dy = (ay - by) * 1.4f, dz = az - bz;
    return dx * dx + dy * dy + dz * dz;
}

static int nearest_node_on(int floor, float x, float y, float z, float maxd) {
    int best = -1;
    float bestd = maxd * maxd;
    for (int i = 0; i < nav_count; i++) {
        if (nav_floor[i] != floor) continue;
        float d = dist2(nav_x[i], nav_y[i], nav_z[i], x, y, z);
        if (d < bestd) { bestd = d; best = i; }
    }
    return best;
}

static int nearest_room(void) {
    if (room_count <= 0) return -1;
    int floor = player_node >= 0 ? nav_floor[player_node] : active_floor;
    int best = -1;
    float bestd = 1e30f;
    for (int i = 0; i < room_count; i++) {
        if (room_floor[i] != floor) continue;
        float d = dist2(room_x[i], room_y[i], room_z[i], player[0], player[1], player[2]);
        if (d < bestd) { bestd = d; best = i; }
    }
    if (best < 0) {
        for (int i = 0; i < room_count; i++) {
            float d = dist2(room_x[i], room_y[i], room_z[i], player[0], player[1], player[2]);
            if (d < bestd) { bestd = d; best = i; }
        }
    }
    return best;
}

static void project(float x, float y, float z, float *sx, float *sy, float *depth) {
    float cx = view_proj[0] * x + view_proj[4] * y + view_proj[8] * z + view_proj[12];
    float cy = view_proj[1] * x + view_proj[5] * y + view_proj[9] * z + view_proj[13];
    float cw = view_proj[3] * x + view_proj[7] * y + view_proj[11] * z + view_proj[15];
    if (cw <= 0.0001f || view_w < 2 || view_h < 2) {
        *sx = -1e9f; *sy = -1e9f; if (depth) *depth = 1e9f;
        return;
    }
    *sx = (cx / cw * 0.5f + 0.5f) * (float)view_w;
    *sy = (1.0f - (cy / cw * 0.5f + 0.5f)) * (float)view_h;
    if (depth) *depth = cw;
}

static int point_in_cell(float px, float py, int node, float *depth) {
    const float half = 0.5f;
    float xs[4], ys[4];
    int k = 0;
    for (int i = 0; i < 4; i++) {
        float dx = (i == 0 || i == 3) ? -half : half;
        float dz = (i < 2) ? -half : half;
        float sx, sy, d;
        project(nav_x[node] + dx, nav_y[node] + 0.02f, nav_z[node] + dz, &sx, &sy, &d);
        if (sx < -1e8f) return 0;
        xs[k] = sx; ys[k] = sy; k++;
    }
    int inside = 1;
    for (int i = 0, j = 3; i < 4; j = i++) {
        float cross = (xs[i] - xs[j]) * (py - ys[j]) - (ys[i] - ys[j]) * (px - xs[j]);
        if (cross < 0) { inside = 0; break; }
    }
    if (!inside) {
        inside = 1;
        for (int i = 0, j = 3; i < 4; j = i++) {
            float cross = (xs[i] - xs[j]) * (py - ys[j]) - (ys[i] - ys[j]) * (px - xs[j]);
            if (cross > 0) { inside = 0; break; }
        }
    }
    if (!inside) return 0;
    float csx, csy;
    project(nav_x[node], nav_y[node] + 0.02f, nav_z[node], &csx, &csy, depth);
    return 1;
}

static int pick_cell(float px, float py) {
    int best = -1;
    float bestd = 1e30f;
    for (int i = 0; i < nav_count; i++) {
        if (nav_floor[i] != active_floor) continue;
        float d;
        if (!point_in_cell(px, py, i, &d)) continue;
        if (d < bestd) { bestd = d; best = i; }
    }
    return best;
}

static void fit_camera(void) {
    if (view_w < 2 || view_h < 2) return;
    float minx, minz, maxx, maxz;
    if (active_floor >= 0 && active_floor < floor_count) {
        minx = floor_bounds[active_floor][0]; minz = floor_bounds[active_floor][1];
        maxx = floor_bounds[active_floor][2]; maxz = floor_bounds[active_floor][3];
    } else {
        minx = minz = 1e30f; maxx = maxz = -1e30f;
        for (int i = 0; i < nav_count; i++) {
            if (nav_floor[i] != active_floor) continue;
            if (nav_x[i] < minx) minx = nav_x[i];
            if (nav_x[i] > maxx) maxx = nav_x[i];
            if (nav_z[i] < minz) minz = nav_z[i];
            if (nav_z[i] > maxz) maxz = nav_z[i];
        }
        if (maxx < minx) { minx = -10; maxx = 10; minz = -10; maxz = 10; }
    }
    float spanx = fmaxf(4.0f, maxx - minx);
    float spanz = fmaxf(4.0f, maxz - minz);
    int right = view_w > 900 ? 380 : 40;
    int left = 42, top = 150, bottom = 70;
    int plot_w = view_w - right - left - 24;
    int plot_h = view_h - top - bottom;
    if (plot_w < 120) plot_w = 120;
    if (plot_h < 120) plot_h = 120;
    map_scale = fminf((float)plot_w / spanx, (float)plot_h / spanz);
    if (map_scale < 1.0f) map_scale = 1.0f;
    float cx = 0.5f * (minx + maxx);
    float cz = 0.5f * (minz + maxz);
    float plot_cx = (float)(left + plot_w / 2);
    float plot_cy = (float)(top + plot_h / 2);
    map_cx = cx - (plot_cx - view_w * 0.5f) / map_scale;
    map_cz = cz - (plot_cy - view_h * 0.5f) / map_scale;
    fitted_floor = active_floor;
}

static void add_waypoint_node(int node);

static int *route_scratch_nodes;
static int route_scratch_capacity;

static void ensure_route_scratch(int count) {
    if (route_scratch_capacity >= count) return;
    free(route_scratch_nodes);
    route_scratch_nodes = (int *)malloc(sizeof(int) * (size_t)count);
    route_scratch_capacity = count;
}

static void recompute_route(void) {
    route_count = 0;
    int start = nearest_node_on(active_floor, player[0], player[1], player[2], 4.0f);
    if (start < 0) start = player_node;
    if (start < 0) return;
    int path[MAX_ROUTE];
    int path_count = 0;
    for (int w = 0; w < waypoint_count; w++) {
        int n = route_find_path(nav_count, nav_x, nav_y, nav_z, nav_first, nav_adj, nav_cost,
                                nav_blocked, start, waypoints[w], path, MAX_ROUTE);
        if (n <= 0) continue;
        for (int i = 0; i < n; i++) {
            if (path_count > 0 && i == 0) continue;
            if (path_count >= MAX_ROUTE) break;
            if (path_count == 0) ensure_route_scratch(MAX_ROUTE);
            route_scratch_nodes[path_count++] = path[i];
        }
        start = waypoints[w];
    }
    if (path_count <= 0) return;
    route_count = route_smooth(path_count, route_scratch_nodes, nav_x, nav_y, nav_z, 0.08f, route, MAX_ROUTE);
}

void plan_set_floors(int count, const float *levels, const float *bounds) {
    floor_count = count > 8 ? 8 : count;
    for (int i = 0; i < floor_count; i++) {
        floor_levels[i] = levels[i];
        for (int b = 0; b < 4; b++) floor_bounds[i][b] = bounds[i * 4 + b];
    }
    if (active_floor >= floor_count) active_floor = 0;
    fitted_floor = -1;
}

void plan_set_graph(int count, const float *x, const float *y, const float *z,
                    const uint8_t *floor, const uint8_t *kind, const int *first,
                    const int *adjacency, const float *adjacency_cost) {
    free(nav_x); free(nav_y); free(nav_z); free(nav_floor); free(nav_kind);
    free(nav_first); free(nav_adj); free(nav_cost); free(nav_blocked);
    nav_count = count;
    nav_x = malloc(sizeof(float) * count);
    nav_y = malloc(sizeof(float) * count);
    nav_z = malloc(sizeof(float) * count);
    nav_floor = malloc(sizeof(uint8_t) * count);
    nav_kind = malloc(sizeof(uint8_t) * count);
    nav_first = malloc(sizeof(int) * (count + 1));
    memcpy(nav_x, x, sizeof(float) * count);
    memcpy(nav_y, y, sizeof(float) * count);
    memcpy(nav_z, z, sizeof(float) * count);
    memcpy(nav_floor, floor, sizeof(uint8_t) * count);
    memcpy(nav_kind, kind, sizeof(uint8_t) * count);
    nav_blocked = calloc((size_t)count, sizeof(uint8_t));
    int filtered_edges = route_filter_diagonals(count, nav_x, nav_z, nav_floor,
                                                first, adjacency, adjacency_cost,
                                                &nav_first, &nav_adj, &nav_cost);
    if (filtered_edges < 0) {
        nav_first = malloc(sizeof(int) * (size_t)(count + 1));
        memcpy(nav_first, first, sizeof(int) * (size_t)(count + 1));
        int edges = nav_first[count];
        nav_adj = malloc(sizeof(int) * (size_t)edges);
        nav_cost = malloc(sizeof(float) * (size_t)edges);
        memcpy(nav_adj, adjacency, sizeof(int) * (size_t)edges);
        memcpy(nav_cost, adjacency_cost, sizeof(float) * (size_t)edges);
    }
    player_node = -1;
    fitted_floor = -1;
}

void plan_set_rooms(int count, const float *x, const float *y, const float *z,
                    const uint8_t *floor, const char *names, int names_len, const int *offsets) {
    free(room_x); free(room_y); free(room_z); free(room_floor); free(room_offset); free(room_names);
    room_count = count;
    room_x = malloc(sizeof(float) * count);
    room_y = malloc(sizeof(float) * count);
    room_z = malloc(sizeof(float) * count);
    room_floor = malloc(sizeof(uint8_t) * count);
    room_offset = malloc(sizeof(int) * count);
    room_names = malloc((size_t)names_len + 1);
    memcpy(room_x, x, sizeof(float) * count);
    memcpy(room_y, y, sizeof(float) * count);
    memcpy(room_z, z, sizeof(float) * count);
    memcpy(room_floor, floor, sizeof(uint8_t) * count);
    memcpy(room_offset, offsets, sizeof(int) * count);
    memcpy(room_names, names, (size_t)names_len);
    room_names[names_len] = 0;
}

void plan_set_spawn(float x, float y, float z) {
    spawn[0] = x; spawn[1] = y; spawn[2] = z;
    int node = nearest_node_on(0, x, y, z, 12.0f);
    if (node >= 0) {
        player[0] = nav_x[node]; player[1] = nav_y[node]; player[2] = nav_z[node];
        player_node = node;
    } else {
        player[0] = x; player[1] = y; player[2] = z;
        player_node = -1;
    }
    waypoint_count = 0; route_count = 0; moving = 0; hover = -1;
    popup_close();
    markers_ensure_player(player[0], player[1], player[2]);
}

void plan_set_floor(int index) {
    if (index < 0) index = 0;
    if (floor_count > 0 && index >= floor_count) index = floor_count - 1;
    active_floor = index;
    fitted_floor = -1;
    hover = -1;
    popup_close();
    if (view_w > 1 && view_h > 1) fit_camera();
}

void plan_reset(void) {
    plan_set_spawn(spawn[0], spawn[1], spawn[2]);
    plan_set_floor(active_floor);
}

void plan_update(float dt, const float *vp, int width, int height) {
    memcpy(view_proj, vp, sizeof(view_proj));
    view_w = width;
    view_h = height;
    popup_set_viewport(view_w, view_h);
    if (fitted_floor != active_floor) fit_camera();
    if (!moving) {
        return;
    }
    float remaining = 3.5f * dt;
    while (remaining > 0.0001f && move_index + 1 < move_count) {
        int a = move_index * 3;
        int b = (move_index + 1) * 3;
        float dx = move_pts[b] - move_pts[a];
        float dy = move_pts[b + 1] - move_pts[a + 1];
        float dz = move_pts[b + 2] - move_pts[a + 2];
        float len = sqrtf(dx * dx + dy * dy + dz * dz);
        if (len < 0.0001f) { move_index++; continue; }
        if (move_t + remaining / len <= 1.0f) {
            move_t += remaining / len;
            remaining = 0;
        } else {
            remaining -= (1.0f - move_t) * len;
            move_t = 0;
            move_index++;
        }
        if (move_index + 1 < move_count) {
            float t = move_t;
            player[0] = move_pts[a] + dx * t;
            player[1] = move_pts[a + 1] + dy * t;
            player[2] = move_pts[a + 2] + dz * t;
        }
    }
    if (move_index + 1 >= move_count) {
        moving = 0;
        player[0] = move_pts[(move_count - 1) * 3];
        player[1] = move_pts[(move_count - 1) * 3 + 1];
        player[2] = move_pts[(move_count - 1) * 3 + 2];
    }
    player_node = nearest_node_on(active_floor, player[0], player[1], player[2], 3.0f);
    markers_set_player(player[0], player[1], player[2]);
}

void plan_pointer_move(float x, float y) {
    if (view_w < 2) return;
    if (popup_is_open()) {
        popup_set_hover(popup_hit(x, y));
        hover = -1;
        return;
    }
    hover = pick_cell(x, y);
}

static void open_node_popup(int node) {
    float sx, sy, depth;
    project(nav_x[node], nav_y[node] + 0.06f, nav_z[node], &sx, &sy, &depth);
    if (sx < -1e8f) return;
    popup_open(node, -1, sx + 26.0f, sy - 10.0f);
    popup_set_message("");
    popup_add_choice(POPUP_ACTION_WAYPOINT, "ADD WAYPOINT", true);
}

static void popup_execute(popup_action_t action) {
    popup_t chosen = *popup_get();
    popup_close();
    if (action == POPUP_ACTION_WAYPOINT) add_waypoint_node(chosen.node);
}

void plan_pointer_down(float x, float y) {
    if (view_w < 2) return;
    static double last_player_click = -1.0;
    double now = emscripten_get_now();
    if (popup_is_open()) {
        int hit = popup_hit(x, y);
        if (hit >= 0) {
            const popup_t *p = popup_get();
            if (p->choices[hit].enabled) popup_execute(p->choices[hit].action);
            return;
        }
    }
    float sx, sy, depth;
    project(player[0], player[1] + 0.9f, player[2], &sx, &sy, &depth);
    float distance = sqrtf((sx - x) * (sx - x) + (sy - y) * (sy - y));
    bool near_player = distance < 46.0f;
    if (near_player && last_player_click > 0.0 && now - last_player_click < 420.0) {
        plan_start_move();
        popup_close();
        last_player_click = -1.0;
        return;
    }
    if (near_player) {
        last_player_click = now;
        popup_close();
        return;
    }
    if (popup_is_open()) {
        popup_close();
        return;
    }
    int node = pick_cell(x, y);
    if (node >= 0) open_node_popup(node);
    last_player_click = -1.0;
}

void plan_set_player(float x, float y, float z) {
    player[0] = x; player[1] = y; player[2] = z;
    player_node = nearest_node_on(active_floor, x, y, z, 3.0f);
    markers_set_player(x, y, z);
    recompute_route();
}

static void add_waypoint_node(int node) {
    if (node < 0 || node >= nav_count) return;
    if (waypoint_count == 0 || waypoints[waypoint_count - 1] != node) {
        if (waypoint_count < MAX_WAYPOINTS) waypoints[waypoint_count++] = node;
        recompute_route();
    }
}

void plan_add_target(float x, float y, float z) {
    add_waypoint_node(nearest_node_on(active_floor, x, y, z, 4.0f));
}

void plan_start_move(void) {
    popup_close();
    if (route_count < 2) return;
    memcpy(move_pts, route, sizeof(float) * 3 * (size_t)route_count);
    move_count = route_count;
    move_index = 0;
    move_t = 0;
    moving = 1;
}

void plan_pan(float dx, float dy) {
    map_cx -= dx / map_scale;
    map_cz -= dy / map_scale;
}

void plan_zoom(float x, float y, float amount) {
    float wx = map_cx + (x - view_w * 0.5f) / map_scale;
    float wz = map_cz + (y - view_h * 0.5f) / map_scale;
    float next = map_scale * powf(1.1f, amount);
    if (next < 2.5f) next = 2.5f;
    if (next > 42.0f) next = 42.0f;
    map_scale = next;
    map_cx = wx - (x - view_w * 0.5f) / map_scale;
    map_cz = wz - (y - view_h * 0.5f) / map_scale;
}

int plan_active_floor(void) { return active_floor; }
float plan_level(void) { return (active_floor >= 0 && active_floor < floor_count) ? floor_levels[active_floor] : 0.0f; }
float plan_map_cx(void) { return map_cx; }
float plan_map_cz(void) { return map_cz; }
float plan_map_scale(void) { return map_scale; }
int plan_count(void) { return waypoint_count; }
int plan_moving(void) { return moving; }
int plan_hover(void) { return hover; }
int plan_waypoint_count(void) { return waypoint_count; }
const int *plan_waypoints(void) { return waypoints; }
int plan_route_count(void) { return route_count; }
int plan_move_index(void) { return move_index; }
int plan_move_count(void) { return move_count; }
float plan_move_t(void) { return move_t; }
const float *plan_route(void) { return route; }
int plan_room_count(void) { return room_count; }
const char *plan_room_name_at(int index) {
    if (index < 0 || index >= room_count) return "";
    return room_names + room_offset[index];
}
float plan_room_x(int index) { return (index >= 0 && index < room_count) ? room_x[index] : 0.0f; }
float plan_room_y(int index) { return (index >= 0 && index < room_count) ? room_y[index] : 0.0f; }
float plan_room_z(int index) { return (index >= 0 && index < room_count) ? room_z[index] : 0.0f; }
int plan_room_floor(int index) { return (index >= 0 && index < room_count) ? room_floor[index] : 0; }
float plan_node_x(int node) { return (node >= 0 && node < nav_count) ? nav_x[node] : 0.0f; }
float plan_node_y(int node) { return (node >= 0 && node < nav_count) ? nav_y[node] : 0.0f; }
float plan_node_z(int node) { return (node >= 0 && node < nav_count) ? nav_z[node] : 0.0f; }
const char *plan_room_name(void) {
    int i = nearest_room();
    return i >= 0 ? room_names + room_offset[i] : "RPD";
}
void plan_player(float out[3]) {
    out[0] = player[0]; out[1] = player[1]; out[2] = player[2];
}
