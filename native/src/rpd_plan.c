#include "rpd_plan.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_item_gate.h"
#include "rpd_items.h"
#include "rpd_nearest.h"
#include "rpd_markers.h"
#include "rpd_popup.h"
#include "rpd_route.h"
#include "rpd_state.h"

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
static int hover_item = -1;
static float view_proj[16];
static int view_w, view_h;

static int nearest_node_on(int floor, float x, float y, float z, float maxd) {
    return nearest_floor_node(nav_count, nav_x, nav_y, nav_z, nav_floor, nav_blocked,
                              floor, x, y, z, maxd);
}

static int nearest_room(void) {
    int floor = player_node >= 0 ? nav_floor[player_node] : active_floor;
    return nearest_room_index(room_count, room_x, room_y, room_z, room_floor, floor,
                              player[0], player[1], player[2]);
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
    float scale = fminf((float)plot_w / spanx, (float)plot_h / spanz);
    if (scale < 1.0f) scale = 1.0f;
    g_rpd.camera.frame = (float)view_h / scale;
    g_rpd.camera.target[0] = 0.5f * (minx + maxx);
    g_rpd.camera.target[1] = plan_level();
    g_rpd.camera.target[2] = 0.5f * (minz + maxz);
}

static void add_waypoint_node(int node); static void open_node_popup(int node);
static void open_item_popup(int item); static int pick_item_screen(float px, float py);

static int *route_scratch_nodes;
static int route_scratch_capacity;
static int *route_pull_nodes;
static int route_pull_capacity;
static int route_path_nodes[MAX_ROUTE];
static void ensure_route_scratch(int count) {
    if (route_scratch_capacity >= count) return;
    free(route_scratch_nodes);
    route_scratch_nodes = (int *)malloc(sizeof(int) * (size_t)count);
    route_scratch_capacity = count;
}
static void ensure_pull_scratch(int count) {
    if (route_pull_capacity >= count) return;
    free(route_pull_nodes);
    route_pull_nodes = (int *)malloc(sizeof(int) * (size_t)count);
    route_pull_capacity = count;
}
static void recompute_route(void) {
    route_count = 0;
    int start = nearest_node_on(active_floor, player[0], player[1], player[2], 4.0f);
    if (start < 0) start = player_node;
    if (start < 0) return;
    int *path = route_path_nodes;
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
    ensure_pull_scratch(path_count);
    int pulled = route_pull(path_count, route_scratch_nodes, nav_x, nav_y, nav_z,
                            nav_floor, nav_kind, route_pull_nodes, MAX_ROUTE);
    if (pulled <= 0) return;
    route_count = route_smooth(pulled, route_pull_nodes, nav_x, nav_y, nav_z,
                               nav_floor, nav_kind, 0.08f, route, MAX_ROUTE);
}
void plan_refresh_blocks(void) {
    if (!nav_blocked || nav_count <= 0) return;
    item_gate_refresh(nav_count, nav_x, nav_z, nav_floor, nav_blocked);
    item_gate_retarget(nav_count, nav_x, nav_y, nav_z, nav_floor, nav_blocked);
    if (waypoint_count > 0) recompute_route();
}

int plan_item_blocked_count(int index) {
    return item_gate_blocked_count(index, nav_count, nav_x, nav_z, nav_floor, nav_blocked);
}

void plan_set_floors(int count, const float *levels, const float *bounds) {
    floor_count = count > 8 ? 8 : count;
    for (int i = 0; i < floor_count; i++) {
        floor_levels[i] = levels[i]; for (int b = 0; b < 4; b++) floor_bounds[i][b] = bounds[i * 4 + b];
    }
    if (active_floor >= floor_count) active_floor = 0;
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
    route_set_cells(count, nav_x, nav_z, nav_floor);
    items_reset();
    player_node = -1;
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
        player[0] = nav_x[node]; player[1] = nav_y[node]; player[2] = nav_z[node]; player_node = node;
    } else {
        player[0] = x; player[1] = y; player[2] = z; player_node = -1;
    }
    waypoint_count = 0; route_count = 0; moving = 0; hover = -1; hover_item = -1;
    popup_close();
    markers_ensure_player(player[0], player[1], player[2]);
    items_place(nav_count, nav_x, nav_y, nav_z, nav_floor);
    items_sync_markers();
    plan_refresh_blocks();
}

void plan_set_floor(int index) {
    if (index < 0) index = 0;
    if (floor_count > 0 && index >= floor_count) index = floor_count - 1;
    active_floor = index; hover = -1; hover_item = -1;
    popup_close();
    if (g_rpd.ortho && view_w > 1 && view_h > 1) fit_camera();
}

void plan_clear_route(void) {
    moving = 0; waypoint_count = 0; route_count = 0;
    move_count = 0; move_index = 0; move_t = 0;
    popup_close();
}

int plan_open_popup_at(float x, float z) {
    int item = items_pick(active_floor, x, z, 1.0f);
    if (item >= 0) open_item_popup(item);
    else {
        int node = nearest_node_on(active_floor, x, plan_level(), z, 4.0f);
        if (node >= 0) open_node_popup(node);
    }
    return popup_is_open() ? 1 : 0;
}
void plan_fit_camera(void) { if (view_w > 1 && view_h > 1) fit_camera(); }

void plan_reset(void) { plan_set_spawn(spawn[0], spawn[1], spawn[2]); plan_set_floor(active_floor); }

void plan_update(float dt, const float *vp, int width, int height) {
    memcpy(view_proj, vp, sizeof(view_proj));
    view_w = width;
    view_h = height;
    popup_set_viewport(view_w, view_h);
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
        route_count = waypoint_count = 0;
        move_count = move_index = 0; move_t = 0;
    }
    player_node = nearest_node_on(active_floor, player[0], player[1], player[2], 3.0f);
    markers_set_player(player[0], player[1], player[2]);
}

void plan_pointer_move(float x, float y) {
    if (view_w < 2) return;
    if (popup_is_open()) {
        popup_set_hover(popup_hit(x, y));
        hover = -1; hover_item = -1;
        return;
    }
    hover_item = pick_item_screen(x, y);
    hover = hover_item >= 0 ? -1 : pick_cell(x, y);
}

static int pick_item_screen(float px, float py) {
    int best = -1;
    float best_distance = 14.0f;
    for (int i = 0; i < items_count(); i++) {
        const item_t *item = items_get(i);
        if (!item || item->state != ITEM_PRESENT) continue;
        if (item->def->floor != active_floor) continue;
        float cube[3], sx, sy, depth;
        items_cube_position(i, cube);
        project(cube[0], cube[1], cube[2], &sx, &sy, &depth);
        if (sx < -1e8f) continue;
        float distance = sqrtf((sx - px) * (sx - px) + (sy - py) * (sy - py));
        if (distance < best_distance) { best_distance = distance; best = i; }
    }
    return best;
}

static void open_item_popup(int item) {
    const item_t *entry = items_get(item);
    if (!entry) return;
    float cube[3], sx, sy, depth;
    items_cube_position(item, cube);
    project(cube[0], cube[1], cube[2], &sx, &sy, &depth);
    if (sx < -1e8f) return;
    popup_open(-1, item, sx + 26.0f, sy - 10.0f);
    popup_set_message(entry->def->title);
    const char *verb = items_action_label(item);
    if (!items_in_range(item, player[0], player[1], player[2])) {
        popup_add_choice(POPUP_ACTION_WALK_NEXT, "WALK NEXT TO IT", true);
        return;
    }
    int missing = items_missing_requirement(item);
    int missing_open = items_missing_open(item);
    int blocker = missing >= 0 ? missing : missing_open;
    if (blocker >= 0) {
        const item_t *required = items_get(blocker);
        popup_set_message(required ? required->def->title : "LOCKED");
        char label[48];
        snprintf(label, sizeof(label), "%s - NEEDS KEY", verb);
        popup_add_choice(POPUP_ACTION_ACT, label, false);
        return;
    }
    if (items_missing_external(item) >= 0) {
        popup_set_message("OUTSIDE THE MAP");
        char label[48];
        snprintf(label, sizeof(label), "%s - NEEDS THE FILM", verb);
        popup_add_choice(POPUP_ACTION_ACT, label, false);
        return;
    }
    if (items_has_code(item)) {
        int hint = items_missing_hint(item);
        const item_t *required = hint >= 0 ? items_get(hint) : NULL;
        char label[48];
        popup_set_message(required ? required->def->title : "CODE REQUIRED");
        snprintf(label, sizeof(label), "%s - %s", verb, required ? "READ THE HINT" : "CODE REQUIRED");
        popup_add_choice(POPUP_ACTION_ACT, label, false);
        return;
    }
    if (entry->def->action == RPD_ACTION_TAKE && items_inventory_count() >= INVENTORY_SLOTS) {
        popup_set_message("INVENTORY FULL");
        popup_add_choice(POPUP_ACTION_ACT, "TAKE - INVENTORY FULL", false);
        return;
    }
    popup_add_choice(POPUP_ACTION_ACT, verb, items_available(item) != 0);
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
    if (action == POPUP_ACTION_WAYPOINT) {
        add_waypoint_node(chosen.node);
    } else if (action == POPUP_ACTION_WALK_NEXT) {
        if (chosen.item >= 0) {
            const item_t *entry = items_get(chosen.item);
            int node = -1;
            if (entry) {
                node = entry->approach_node;
                if (node < 0)
                    node = nearest_node_on(entry->def->floor, entry->def->x, entry->def->y,
                                           entry->def->z, 8.0f);
            }
            add_waypoint_node(node);
        }
    } else if (action == POPUP_ACTION_TAKE || action == POPUP_ACTION_ACT) {
        items_act(chosen.item);
        plan_refresh_blocks();
    }
}

void plan_pointer_down(float x, float y) {
    if (view_w < 2) return;
    static double last_player_click = -1.0; double now = emscripten_get_now();
    hover_item = -1;
    if (popup_is_open()) {
        int hit = popup_hit(x, y);
        if (hit >= 0) {
            const popup_t *p = popup_get();
            if (p->choices[hit].enabled) popup_execute(p->choices[hit].action);
            return;
        }
        popup_close();
        return;
    }
    int item = pick_item_screen(x, y);
    if (item >= 0) {
        open_item_popup(item);
        last_player_click = -1.0;
        return;
    }
    int node = pick_cell(x, y);
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

void plan_add_target_node(int node) { add_waypoint_node(node); }

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
    float vh = (float)(view_h > 1 ? view_h : 900);
    camera_pan_ortho(&g_rpd.camera, dx, dy, vh);
    g_rpd.orbit.active = false;
}

void plan_zoom(float x, float y, float amount) {
    (void)x;
    (void)y;
    camera_zoom(&g_rpd.camera, amount);
    g_rpd.orbit.active = false;
}

int plan_active_floor(void) { return active_floor; }
float plan_level(void) { return (active_floor >= 0 && active_floor < floor_count) ? floor_levels[active_floor] : 0.0f; }
float plan_map_cx(void) { return g_rpd.camera.target[0]; }
float plan_map_cz(void) { return g_rpd.camera.target[2]; }
float plan_map_scale(void) {
    float vh = (float)(view_h > 1 ? view_h : 900);
    return vh / fmaxf(0.01f, g_rpd.camera.frame);
}
int plan_count(void) { return waypoint_count; }
int plan_moving(void) { return moving; }
int plan_hover(void) { return hover; }
int plan_hover_item(void) { return hover_item; }
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
int plan_player_floor(void) {
    int best = -1; float bestd = 25.0f;
    for (int i = 0; i < nav_count; i++) {
        float d = nearest_dist2(nav_x[i], nav_y[i], nav_z[i], player[0], player[1], player[2]); if (d < bestd) bestd = d, best = i;
    }
    return best >= 0 ? nav_floor[best] : -1;
}
