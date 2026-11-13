#include "rpd_route.h"

#include "rpd_player.h"
#include "rpd_walls_gen.h"

#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#define CELL_HASH 8192
#define ROUTE_CURVE_RADIUS 1.20f
#define ROUTE_CURVE_STEPS 12
#define ROUTE_SAMPLE_STEP 0.08f

typedef struct {
    int key;
    int node;
} cell_slot_t;

static cell_slot_t cell_slots[CELL_HASH];
static const uint8_t *route_blocked;
static const uint8_t *route_floor;

static bool edge_block_clear(int a, int b, const float *x, const float *z);

void route_set_blocked(const uint8_t *blocked) {
    route_blocked = blocked;
}

static int cell_key(int floor, int ix, int iz) {
    return ((floor * 4096 + ix + 2048) * 4096 + iz + 2048);
}

static unsigned cell_hash(int key) {
    unsigned h = (unsigned)key;
    h ^= h >> 16;
    h *= 0x7feb352du;
    h ^= h >> 15;
    return h & (CELL_HASH - 1);
}

static void cell_clear(void) {
    for (int i = 0; i < CELL_HASH; i++) cell_slots[i].key = -1;
}

static void cell_insert(int key, int node) {
    unsigned h = cell_hash(key);
    for (int n = 0; n < CELL_HASH; n++) {
        unsigned i = (h + (unsigned)n) & (CELL_HASH - 1);
        if (cell_slots[i].key < 0) {
            cell_slots[i].key = key;
            cell_slots[i].node = node;
            return;
        }
    }
}

static int cell_find(int key) {
    unsigned h = cell_hash(key);
    for (int n = 0; n < CELL_HASH; n++) {
        unsigned i = (h + (unsigned)n) & (CELL_HASH - 1);
        if (cell_slots[i].key < 0) return -1;
        if (cell_slots[i].key == key) return cell_slots[i].node;
    }
    return -1;
}

void route_set_cells(int count, const float *x, const float *z, const uint8_t *floor) {
    route_floor = floor;
    cell_clear();
    for (int i = 0; i < count; i++) {
        cell_insert(cell_key(floor[i], (int)floorf(x[i]), (int)floorf(z[i])), i);
    }
}

int route_filter_diagonals(int count, const float *x, const float *z, const uint8_t *floor,
                           const int *first, const int *adjacency, const float *cost,
                           int **out_first, int **out_adjacency, float **out_cost) {
    int edges = count > 0 ? first[count] : 0;
    int *kept_adjacency = (int *)malloc(sizeof(int) * (size_t)(edges > 0 ? edges : 1));
    float *kept_cost = (float *)malloc(sizeof(float) * (size_t)(edges > 0 ? edges : 1));
    int *kept_first = (int *)malloc(sizeof(int) * (size_t)(count + 1));
    if (!kept_adjacency || !kept_cost || !kept_first) {
        free(kept_adjacency);
        free(kept_cost);
        free(kept_first);
        return -1;
    }

    route_set_cells(count, x, z, floor);

    int kept = 0;
    kept_first[0] = 0;
    for (int i = 0; i < count; i++) {
        int ix = (int)floorf(x[i]);
        int iz = (int)floorf(z[i]);
        for (int e = first[i]; e < first[i + 1]; e++) {
            int j = adjacency[e];
            if (j < 0 || j >= count) continue;
            int jx = (int)floorf(x[j]);
            int jz = (int)floorf(z[j]);
            if (ix != jx && iz != jz) {
                bool side_a = cell_find(cell_key(floor[i], ix, jz)) >= 0;
                bool side_b = cell_find(cell_key(floor[i], jx, iz)) >= 0;
                if (!side_a || !side_b) continue;
            }
            kept_adjacency[kept] = j;
            kept_cost[kept] = cost[e];
            kept++;
        }
        kept_first[i + 1] = kept;
    }

    *out_first = kept_first;
    *out_adjacency = kept_adjacency;
    *out_cost = kept_cost;
    return kept;
}

static float *astar_g, *astar_f;
static int *astar_from, *astar_heap, *astar_pos;
static uint8_t *astar_state;
static int astar_capacity;

static float node_distance2(const float *x, const float *y, const float *z, int a, int b) {
    float dx = x[a] - x[b];
    float dy = (y[a] - y[b]) * 1.4f;
    float dz = z[a] - z[b];
    return dx * dx + dy * dy + dz * dz;
}

static void astar_ensure(int count) {
    if (astar_capacity >= count) return;
    free(astar_g); free(astar_f); free(astar_from); free(astar_heap);
    free(astar_pos); free(astar_state);
    astar_g = malloc(sizeof(float) * (size_t)count);
    astar_f = malloc(sizeof(float) * (size_t)count);
    astar_from = malloc(sizeof(int) * (size_t)count);
    astar_heap = malloc(sizeof(int) * (size_t)(count + 1));
    astar_pos = malloc(sizeof(int) * (size_t)count);
    astar_state = malloc(sizeof(uint8_t) * (size_t)count);
    astar_capacity = count;
}

static int heap_pop(void) {
    int top = astar_heap[1];
    astar_heap[1] = astar_heap[astar_heap[0]--];
    if (astar_heap[0] > 0) {
        int i = 1;
        while (1) {
            int l = i * 2, r = l + 1, m = i;
            if (l <= astar_heap[0] && astar_f[astar_heap[l]] < astar_f[astar_heap[m]]) m = l;
            if (r <= astar_heap[0] && astar_f[astar_heap[r]] < astar_f[astar_heap[m]]) m = r;
            if (m == i) break;
            int t = astar_heap[i]; astar_heap[i] = astar_heap[m]; astar_heap[m] = t;
            astar_pos[astar_heap[i]] = i; astar_pos[astar_heap[m]] = m;
            i = m;
        }
    }
    return top;
}

static void heap_push(int node) {
    int i = ++astar_heap[0];
    astar_heap[i] = node;
    astar_pos[node] = i;
    while (i > 1) {
        int p = i / 2;
        if (astar_f[astar_heap[p]] <= astar_f[astar_heap[i]]) break;
        int t = astar_heap[p]; astar_heap[p] = astar_heap[i]; astar_heap[i] = t;
        astar_pos[astar_heap[p]] = p; astar_pos[astar_heap[i]] = i;
        i = p;
    }
}

static void heap_update(int node) {
    int i = astar_pos[node];
    if (i <= 0) return;
    while (i > 1) {
        int p = i / 2;
        if (astar_f[astar_heap[p]] <= astar_f[astar_heap[i]]) break;
        int t = astar_heap[p]; astar_heap[p] = astar_heap[i]; astar_heap[i] = t;
        astar_pos[astar_heap[p]] = p; astar_pos[astar_heap[i]] = i;
        i = p;
    }
}

int route_find_path(int count, const float *x, const float *y, const float *z,
                    const int *first, const int *adjacency, const float *cost,
                    const uint8_t *blocked, int start, int goal, int *out, int cap) {
    if (start < 0 || goal < 0 || start >= count || goal >= count) return 0;
    if (blocked && blocked[goal]) return 0;
    if (start == goal) { out[0] = start; return 1; }
    astar_ensure(count);
    for (int i = 0; i < count; i++) {
        astar_g[i] = 1e30f; astar_f[i] = 1e30f; astar_from[i] = -1; astar_state[i] = 0;
    }
    astar_heap[0] = 0;
    astar_g[start] = 0;
    astar_f[start] = sqrtf(node_distance2(x, y, z, start, goal));
    heap_push(start);
    while (astar_heap[0] > 0) {
        int cur = heap_pop();
        if (astar_state[cur] == 2) continue;
        astar_state[cur] = 2;
        if (cur == goal) break;
        for (int e = first[cur]; e < first[cur + 1]; e++) {
            int nxt = adjacency[e];
            if (blocked && blocked[nxt]) continue;
            if (astar_state[nxt] == 2) continue;
            if (!edge_block_clear(cur, nxt, x, z)) continue;
            float tentative = astar_g[cur] + cost[e];
            if (tentative >= astar_g[nxt]) continue;
            astar_g[nxt] = tentative;
            astar_from[nxt] = cur;
            astar_f[nxt] = tentative + sqrtf(node_distance2(x, y, z, nxt, goal));
            if (astar_state[nxt] == 0) {
                astar_state[nxt] = 1;
                heap_push(nxt);
            } else {
                heap_update(nxt);
            }
        }
    }
    if (astar_from[goal] < 0) return 0;
    static int path[8192];
    int n = 0;
    int cur = goal;
    while (cur >= 0 && n < 8192) {
        path[n++] = cur;
        if (cur == start) break;
        cur = astar_from[cur];
    }
    if (n == 0 || path[n - 1] != start) return 0;
    if (n > cap) n = cap;
    for (int i = 0; i < n; i++) out[i] = path[n - 1 - i];
    return n;
}

static void push_point(float *out, int cap, int *written, float x, float y, float z) {
    if (*written >= cap) return;
    out[*written * 3 + 0] = x;
    out[*written * 3 + 1] = y;
    out[*written * 3 + 2] = z;
    (*written)++;
}

static bool cell_open(int floor, int ix, int iz) {
    int node = cell_find(cell_key(floor, ix, iz));
    if (node < 0) return false;
    return route_blocked == NULL || route_blocked[node] == 0;
}

/* Distance from the body at (x, y, z) to the nearest rendered wall face on the
 * same floor. Door leaves and wall caps are in the table too; the vertical
 * band filters out the caps above Claire's head. */
static float wall_distance_at(int floor, float x, float y, float z) {
    int gx = (int)floorf((x - RPD_WALL_GRID_MIN_X) / RPD_WALL_GRID_CELL);
    int gz = (int)floorf((z - RPD_WALL_GRID_MIN_Z) / RPD_WALL_GRID_CELL);
    if (gx < 0 || gz < 0 || gx >= RPD_WALL_GRID_COLS || gz >= RPD_WALL_GRID_ROWS) return 1e30f;
    float best = 1e30f;
    for (int ix = gx - 1; ix <= gx + 1; ix++) {
        if (ix < 0 || ix >= RPD_WALL_GRID_COLS) continue;
        for (int iz = gz - 1; iz <= gz + 1; iz++) {
            if (iz < 0 || iz >= RPD_WALL_GRID_ROWS) continue;
            unsigned int at = rpd_wall_grid_start[ix * RPD_WALL_GRID_ROWS + iz];
            unsigned int end = rpd_wall_grid_start[ix * RPD_WALL_GRID_ROWS + iz + 1];
            for (unsigned int k = at; k < end; k++) {
                const rpd_wall_t *w = &rpd_walls[rpd_wall_grid_items[k]];
                if (w->floor != floor) continue;
                if (!(w->y1 > y + 1e-4f && w->y0 < y + RPD_PLAYER_HEIGHT)) continue;
                float dx = fmaxf(fmaxf(w->x0 - x, 0.0f), x - w->x1);
                float dz = fmaxf(fmaxf(w->z0 - z, 0.0f), z - w->z1);
                float d = sqrtf(dx * dx + dz * dz);
                if (d < best) best = d;
            }
        }
    }
    return best;
}

static bool wall_clear_at(int floor, float x, float y, float z, float radius) {
    return wall_distance_at(floor, x, y, z) >= radius;
}

/* A route point is legal only when the whole body disc stays on walkable cells
 * and clear of the rendered paper walls. */
static bool cell_walkable_at(int floor, float x, float y, float z) {
    if (!cell_open(floor, (int)floorf(x), (int)floorf(z))) return false;
    if (!wall_clear_at(floor, x, y, z, RPD_ROUTE_RADIUS)) return false;
    const float r = RPD_ROUTE_RADIUS;
    int ix0 = (int)floorf(x - r), ix1 = (int)floorf(x + r);
    int iz0 = (int)floorf(z - r), iz1 = (int)floorf(z + r);
    for (int ix = ix0; ix <= ix1; ix++) {
        for (int iz = iz0; iz <= iz1; iz++) {
            float cx = fminf(fmaxf(x, (float)ix), (float)ix + 1.0f);
            float cz = fminf(fmaxf(z, (float)iz), (float)iz + 1.0f);
            float dx = cx - x, dz = cz - z;
            if (dx * dx + dz * dz > r * r) continue;
            if (!cell_open(floor, ix, iz)) return false;
        }
    }
    return true;
}

/* A* only skips edges whose body would overlap a blocked cell. Absent cells
 * stay out of this test so portal gaps and door thresholds keep connecting.
 * The rendered walls are enforced in the pull and the corner rounding, where a
 * rejected shortcut falls back to the graph path instead of erasing the edge. */
static bool edge_block_clear(int a, int b, const float *x, const float *z) {
    if (!route_blocked || !route_floor) return true;
    int floor = route_floor[a];
    float dx = x[b] - x[a], dz = z[b] - z[a];
    float length = sqrtf(dx * dx + dz * dz);
    int steps = (int)ceilf(length / ROUTE_SAMPLE_STEP);
    if (steps < 1) steps = 1;
    const float r = RPD_ROUTE_RADIUS;
    for (int s = 0; s <= steps; s++) {
        float t = (float)s / (float)steps;
        float px = x[a] + dx * t;
        float pz = z[a] + dz * t;
        for (int gx = (int)floorf(px - r); gx <= (int)floorf(px + r); gx++) {
            for (int gz = (int)floorf(pz - r); gz <= (int)floorf(pz + r); gz++) {
                float cx = fminf(fmaxf(px, (float)gx), (float)gx + 1.0f);
                float cz = fminf(fmaxf(pz, (float)gz), (float)gz + 1.0f);
                float ddx = cx - px, ddz = cz - pz;
                if (ddx * ddx + ddz * ddz > r * r) continue;
                int node = cell_find(cell_key(floor, gx, gz));
                if (node >= 0 && route_blocked[node]) return false;
            }
        }
    }
    return true;
}

static bool floor_point_walkable(int floor, float ax, float ay, float az,
                                 float bx, float by, float bz, float *check) {
    float dx = bx - ax;
    float dy = by - ay;
    float dz = bz - az;
    float length = sqrtf(dx * dx + dz * dz);
    int steps = (int)ceilf(length / ROUTE_SAMPLE_STEP);
    if (steps < 1) steps = 1;
    for (int s = 0; s <= steps; s++) {
        float t = (float)s / (float)steps;
        if (!cell_walkable_at(floor, ax + dx * t, ay + dy * t, az + dz * t)) {
            *check = t;
            return false;
        }
    }
    return true;
}

static bool segment_walkable(int a, int b,
                             const float *x, const float *y, const float *z,
                             const uint8_t *floor, const uint8_t *kind) {
    if (floor[a] != floor[b] || kind[a] != 0 || kind[b] != 0) return false;
    float check = 0.0f;
    return floor_point_walkable(floor[a], x[a], y[a], z[a], x[b], y[b], z[b], &check);
}

int route_pull(int count, const int *nodes,
               const float *x, const float *y, const float *z,
               const uint8_t *floor, const uint8_t *kind,
               int *out, int cap) {
    if (count <= 0 || cap <= 0) return 0;
    int written = 0;
    out[written++] = nodes[0];
    int anchor = 0;
    while (anchor < count - 1 && written < cap) {
        int best = anchor + 1;
        if (segment_walkable(nodes[anchor], nodes[best], x, y, z, floor, kind)) {
            for (int j = anchor + 2; j < count; j++) {
                if (!segment_walkable(nodes[anchor], nodes[j], x, y, z, floor, kind)) break;
                best = j;
            }
        }
        out[written++] = nodes[best];
        anchor = best;
    }
    return written;
}

int route_smooth(int count, const int *nodes,
                 const float *x, const float *y, const float *z,
                 const uint8_t *floor, const uint8_t *kind,
                 float lift, float *out, int cap) {
    int written = 0;
    if (count <= 0) return 0;
    int first_node = nodes[0];
    push_point(out, cap, &written, x[first_node], y[first_node] + lift, z[first_node]);
    if (count == 1) return written;

    float curve[3 * (ROUTE_CURVE_STEPS + 1)];
    for (int i = 1; i < count - 1; i++) {
        int a = nodes[i - 1], c = nodes[i], b = nodes[i + 1];
        float ax = x[a] - x[c], az = z[a] - z[c];
        float bx = x[b] - x[c], bz = z[b] - z[c];
        float al = sqrtf(ax * ax + az * az);
        float bl = sqrtf(bx * bx + bz * bz);
        if (al < 1e-5f || bl < 1e-5f) {
            push_point(out, cap, &written, x[c], y[c] + lift, z[c]);
            continue;
        }
        bool flat = floor[a] == floor[c] && floor[c] == floor[b] &&
                    kind[a] == 0 && kind[c] == 0 && kind[b] == 0;
        float dot = (ax * bx + az * bz) / (al * bl);
        float turn = 1.0f + dot;
        if (turn < 0.0f) turn = 0.0f;
        float radius = fminf(ROUTE_CURVE_RADIUS * fminf(turn, 1.0f), fminf(al, bl) * 0.45f);
        if (radius < 0.25f) {
            push_point(out, cap, &written, x[c], y[c] + lift, z[c]);
            continue;
        }
        float p0x = x[c] + ax / al * radius;
        float p0z = z[c] + az / al * radius;
        float p2x = x[c] + bx / bl * radius;
        float p2z = z[c] + bz / bl * radius;
        float py = y[c] + lift;
        bool rounded = flat;
        if (rounded) {
            for (int step = 0; step <= ROUTE_CURVE_STEPS; step++) {
                float t = (float)step / (float)ROUTE_CURVE_STEPS;
                float u = 1.0f - t;
                curve[step * 3 + 0] = u * u * p0x + 2.0f * u * t * x[c] + t * t * p2x;
                curve[step * 3 + 1] = py;
                curve[step * 3 + 2] = u * u * p0z + 2.0f * u * t * z[c] + t * t * p2z;
            }
            for (int step = 1; step <= ROUTE_CURVE_STEPS && rounded; step++) {
                float check;
                if (!floor_point_walkable(floor[c],
                                          curve[(step - 1) * 3], curve[(step - 1) * 3 + 1],
                                          curve[(step - 1) * 3 + 2],
                                          curve[step * 3], curve[step * 3 + 1],
                                          curve[step * 3 + 2], &check)) {
                    rounded = false;
                }
            }
        }
        if (!rounded) {
            push_point(out, cap, &written, p0x, py, p0z);
            push_point(out, cap, &written, x[c], py, z[c]);
            push_point(out, cap, &written, p2x, py, p2z);
            continue;
        }
        push_point(out, cap, &written, p0x, py, p0z);
        for (int step = 1; step <= ROUTE_CURVE_STEPS; step++) {
            push_point(out, cap, &written, curve[step * 3], curve[step * 3 + 1], curve[step * 3 + 2]);
        }
    }
    int last = nodes[count - 1];
    push_point(out, cap, &written, x[last], y[last] + lift, z[last]);
    return written;
}
