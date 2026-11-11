#pragma once

// Internal seam between the plan core and the pointer/popup interaction layer.
void plan_internal_project(float x, float y, float z, float *sx, float *sy, float *depth);
int plan_internal_pick_cell(float x, float y);
int plan_internal_nearest_node(int floor, float x, float y, float z, float maxd);
void plan_internal_add_waypoint(int node);
const float *plan_internal_player(void);
int plan_internal_active_floor(void);
int plan_internal_node_blocked(int node);
int plan_internal_hover(void);
void plan_internal_set_hover(int node);
int plan_internal_hover_item(void);
void plan_internal_set_hover_item(int item);
int plan_internal_view_width(void);
