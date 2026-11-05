#include "rpd_route.h"

#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#define CELL_HASH 8192
#define ROUTE_CORNER_RADIUS 0.40f
#define ROUTE_CURVE_STEPS 6

typedef struct {
    int key;
    int node;
} cell_slot_t;

static cell_slot_t cell_slots[CELL_HASH];

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

    cell_clear();
    for (int i = 0; i < count; i++) {
        cell_insert(cell_key(floor[i], (int)lroundf(x[i]), (int)lroundf(z[i])), i);
    }

    int kept = 0;
    kept_first[0] = 0;
    for (int i = 0; i < count; i++) {
        int ix = (int)lroundf(x[i]);
        int iz = (int)lroundf(z[i]);
        for (int e = first[i]; e < first[i + 1]; e++) {
            int j = adjacency[e];
            if (j < 0 || j >= count) continue;
            int jx = (int)lroundf(x[j]);
            int jz = (int)lroundf(z[j]);
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
    int path[8192];
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

int route_smooth(int count, const int *nodes,
                 const float *x, const float *y, const float *z,
                 float lift, float *out, int cap) {
    int written = 0;
    if (count <= 0) return 0;
    int first_node = nodes[0];
    push_point(out, cap, &written, x[first_node], y[first_node] + lift, z[first_node]);
    if (count == 1) return written;

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
        float radius = fminf(ROUTE_CORNER_RADIUS, fminf(al, bl) * 0.4f);
        float p0x = x[c] + ax / al * radius;
        float p0z = z[c] + az / al * radius;
        float p2x = x[c] + bx / bl * radius;
        float p2z = z[c] + bz / bl * radius;
        float py = y[c] + lift;
        push_point(out, cap, &written, p0x, py, p0z);
        for (int step = 1; step <= ROUTE_CURVE_STEPS; step++) {
            float t = (float)step / (float)ROUTE_CURVE_STEPS;
            float u = 1.0f - t;
            push_point(out, cap, &written,
                       u * u * p0x + 2.0f * u * t * x[c] + t * t * p2x,
                       py,
                       u * u * p0z + 2.0f * u * t * z[c] + t * t * p2z);
        }
    }
    int last = nodes[count - 1];
    push_point(out, cap, &written, x[last], y[last] + lift, z[last]);
    return written;
}
