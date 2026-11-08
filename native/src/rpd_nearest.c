#include "rpd_nearest.h"

float nearest_dist2(float ax, float ay, float az, float bx, float by, float bz) {
    float dx = ax - bx, dy = (ay - by) * 1.4f, dz = az - bz;
    return dx * dx + dy * dy + dz * dz;
}

int nearest_floor_node(int count, const float *x, const float *y, const float *z,
                       const uint8_t *floor, const uint8_t *blocked, int floor_index,
                       float px, float py, float pz, float max_distance) {
    int best = -1;
    float best_distance = max_distance * max_distance;
    for (int i = 0; i < count; i++) {
        if (floor[i] != floor_index) continue;
        if (blocked && blocked[i]) continue;
        float distance = nearest_dist2(x[i], y[i], z[i], px, py, pz);
        if (distance < best_distance) { best_distance = distance; best = i; }
    }
    return best;
}

int nearest_room_index(int count, const float *x, const float *y, const float *z,
                       const uint8_t *floor, int player_floor,
                       float px, float py, float pz) {
    if (count <= 0) return -1;
    int best = -1;
    float best_distance = 1e30f;
    for (int i = 0; i < count; i++) {
        if (floor[i] != player_floor) continue;
        float distance = nearest_dist2(x[i], y[i], z[i], px, py, pz);
        if (distance < best_distance) { best_distance = distance; best = i; }
    }
    if (best < 0) {
        for (int i = 0; i < count; i++) {
            float distance = nearest_dist2(x[i], y[i], z[i], px, py, pz);
            if (distance < best_distance) { best_distance = distance; best = i; }
        }
    }
    return best;
}
