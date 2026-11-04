#pragma once

#include <stdbool.h>

#define RPD_PI 3.14159265358979323846f

typedef struct { float m[16]; } mat4;
typedef struct { float min[3]; float max[3]; } bounds_t;

typedef struct {
    float yaw;
    float pitch;
    float distance;
    float target[3];
} camera_t;

typedef struct {
    bool active;
    float from_target[3];
    float to_target[3];
    float from_distance;
    float to_distance;
    float elapsed, duration;
} orbit_anim_t;

mat4 mat4_mul(mat4 a, mat4 b);
mat4 mat4_perspective(float fovy_rad, float aspect, float near_z, float far_z);
mat4 mat4_ortho(float left, float right, float bottom, float top, float near_z, float far_z);
mat4 mat4_look_at(float eye[3], float center[3], float up[3]);
void camera_eye(const camera_t *cam, float eye[3]);
void camera_pan(camera_t *cam, float dx, float dy, float viewport_height);
