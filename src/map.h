#ifndef MAP_H
#define MAP_H

#include "app.h"

void map_init(map_geometry *map);
bool map_contains(const map_geometry *map, vec2 p);
bool map_door_hit(const map_geometry *map, int door, vec2 p, float pad);

void map_build_route(const map_geometry *map, vec2 from, vec2 to, vec2 out[MAP_MAX_WAYPOINTS], int *count);

void player_init(player *p);
void player_set_target(player *p, const map_geometry *map, vec2 target);
void player_update(player *p, float dt);

void camera_init(camera *cam, float vp_w, float vp_h);
void camera_resize(camera *cam, float vp_w, float vp_h);
void camera_update(camera *cam, float dt);
void camera_reset(camera *cam, float vp_w, vec2 player_pos);
void camera_zoom_at(camera *cam, float vp_w, float vp_h, vec2 anchor, float factor);
void camera_clamp(camera *cam);

vec2 map_world_to_screen(const camera *cam, float vp_w, float vp_h, vec2 world);
vec2 map_screen_to_world(const camera *cam, float vp_w, float vp_h, vec2 screen);

#endif
