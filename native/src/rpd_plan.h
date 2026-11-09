#pragma once

#include <stdint.h>

void plan_set_floors(int count, const float *levels, const float *bounds);
void plan_set_graph(int count, const float *x, const float *y, const float *z,
                    const uint8_t *floor, const uint8_t *kind, const int *first,
                    const int *adjacency, const float *adjacency_cost);
void plan_set_rooms(int count, const float *x, const float *y, const float *z,
                    const uint8_t *floor, const char *names, int names_len, const int *offsets);
void plan_set_spawn(float x, float y, float z);
void plan_set_floor(int index);
void plan_clear_route(void);
void plan_refresh_blocks(void);
int plan_item_blocked_count(int index);
int plan_open_popup_at(float x, float z);
void plan_fit_camera(void);
void plan_reset(void);

void plan_update(float dt, const float *view_proj, int width, int height);
void plan_pointer_move(float x, float y);
void plan_pointer_down(float x, float y);
void plan_pan(float dx, float dy);
void plan_zoom(float x, float y, float amount);
void plan_start_move(void);
void plan_set_player(float x, float y, float z);
void plan_add_target(float x, float y, float z);
void plan_add_target_node(int node);

int plan_active_floor(void);
float plan_level(void);
float plan_map_cx(void);
float plan_map_cz(void);
float plan_map_scale(void);

int plan_count(void);
int plan_moving(void);
int plan_hover(void);
int plan_hover_item(void);
int plan_waypoint_count(void);
const int *plan_waypoints(void);
int plan_route_count(void);
int plan_move_index(void);
int plan_move_count(void);
float plan_move_t(void);
const float *plan_route(void);
const char *plan_room_name(void);
void plan_player(float out[3]);
int plan_player_floor(void);
int plan_room_count(void);
const char *plan_room_name_at(int index);
float plan_room_x(int index);
float plan_room_y(int index);
float plan_room_z(int index);
int plan_room_floor(int index);
float plan_node_x(int node);
float plan_node_y(int node);
float plan_node_z(int node);
