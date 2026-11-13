#include "rpd_math.h"

#include <math.h>
#include <string.h>

mat4 mat4_mul(mat4 a, mat4 b) {
    mat4 out;
    for (int col = 0; col < 4; col++) {
        for (int row = 0; row < 4; row++) {
            out.m[col * 4 + row] =
                a.m[0 * 4 + row] * b.m[col * 4 + 0] +
                a.m[1 * 4 + row] * b.m[col * 4 + 1] +
                a.m[2 * 4 + row] * b.m[col * 4 + 2] +
                a.m[3 * 4 + row] * b.m[col * 4 + 3];
        }
    }
    return out;
}

mat4 mat4_perspective(float fovy_rad, float aspect, float near_z, float far_z) {
    mat4 m;
    memset(&m, 0, sizeof(m));
    float f = 1.0f / tanf(fovy_rad * 0.5f);
    m.m[0] = f / aspect;
    m.m[5] = f;
    m.m[10] = (far_z + near_z) / (near_z - far_z);
    m.m[11] = -1.0f;
    m.m[14] = (2.0f * far_z * near_z) / (near_z - far_z);
    return m;
}

mat4 mat4_ortho(float left, float right, float bottom, float top, float near_z, float far_z) {
    mat4 m;
    memset(&m, 0, sizeof(m));
    m.m[0] = 2.0f / (right - left);
    m.m[5] = 2.0f / (top - bottom);
    m.m[10] = -2.0f / (far_z - near_z);
    m.m[12] = -(right + left) / (right - left);
    m.m[13] = -(top + bottom) / (top - bottom);
    m.m[14] = -(far_z + near_z) / (far_z - near_z);
    m.m[15] = 1.0f;
    return m;
}

mat4 mat4_look_at(float eye[3], float center[3], float up[3]) {
    float f[3] = { center[0] - eye[0], center[1] - eye[1], center[2] - eye[2] };
    float fl = sqrtf(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
    f[0] /= fl; f[1] /= fl; f[2] /= fl;
    float s[3] = { f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0] };
    float sl = sqrtf(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
    s[0] /= sl; s[1] /= sl; s[2] /= sl;
    float u[3] = { s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0] };
    mat4 m;
    memset(&m, 0, sizeof(m));
    m.m[0] = s[0]; m.m[4] = s[1]; m.m[8] = s[2];
    m.m[1] = u[0]; m.m[5] = u[1]; m.m[9] = u[2];
    m.m[2] = -f[0]; m.m[6] = -f[1]; m.m[10] = -f[2];
    m.m[12] = -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]);
    m.m[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
    m.m[14] = (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]);
    m.m[15] = 1.0f;
    return m;
}

mat4 mat4_view_basis(const float eye[3], const float right[3], const float up[3], const float forward[3]) {
    mat4 m;
    memset(&m, 0, sizeof(m));
    m.m[0] = right[0]; m.m[4] = right[1]; m.m[8] = right[2];
    m.m[1] = up[0]; m.m[5] = up[1]; m.m[9] = up[2];
    m.m[2] = -forward[0]; m.m[6] = -forward[1]; m.m[10] = -forward[2];
    m.m[12] = -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]);
    m.m[13] = -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]);
    m.m[14] = (forward[0] * eye[0] + forward[1] * eye[1] + forward[2] * eye[2]);
    m.m[15] = 1.0f;
    return m;
}

typedef struct { float x, y, z, w; } quat_t;

static quat_t quat_mul(quat_t a, quat_t b) {
    return (quat_t){
        a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
}

static quat_t quat_axis_angle(float x, float y, float z, float angle) {
    float half = 0.5f * angle;
    float s = sinf(half);
    return (quat_t){ x * s, y * s, z * s, cosf(half) };
}

static quat_t quat_slerp(quat_t a, quat_t b, float t) {
    float dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    if (dot < 0.0f) {
        b.x = -b.x; b.y = -b.y; b.z = -b.z; b.w = -b.w;
        dot = -dot;
    }
    if (dot > 0.9995f) {
        quat_t out = {
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t,
            a.w + (b.w - a.w) * t,
        };
        float length = sqrtf(out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w);
        out.x /= length; out.y /= length; out.z /= length; out.w /= length;
        return out;
    }
    float theta = acosf(dot);
    float sin_theta = sinf(theta);
    float wa = sinf((1.0f - t) * theta) / sin_theta;
    float wb = sinf(t * theta) / sin_theta;
    return (quat_t){
        a.x * wa + b.x * wb,
        a.y * wa + b.y * wb,
        a.z * wa + b.z * wb,
        a.w * wa + b.w * wb,
    };
}

static void quat_rotate(quat_t q, const float v[3], float out[3]) {
    float tx = 2.0f * (q.y * v[2] - q.z * v[1]);
    float ty = 2.0f * (q.z * v[0] - q.x * v[2]);
    float tz = 2.0f * (q.x * v[1] - q.y * v[0]);
    out[0] = v[0] + q.w * tx + q.y * tz - q.z * ty;
    out[1] = v[1] + q.w * ty + q.z * tx - q.x * tz;
    out[2] = v[2] + q.w * tz + q.x * ty - q.y * tx;
}

float camera_distance(const camera_t *cam) {
    float frame = cam->frame > 0.01f ? cam->frame : 0.01f;
    return 0.5f * frame / tanf(RPD_PERSPECTIVE_FOV * 0.5f);
}

float camera_frame_from_distance(float distance) {
    return 2.0f * distance * tanf(RPD_PERSPECTIVE_FOV * 0.5f);
}

static quat_t camera_saved_quat(const camera_t *cam) {
    return quat_mul(quat_axis_angle(0.0f, 1.0f, 0.0f, cam->yaw), quat_axis_angle(1.0f, 0.0f, 0.0f, -cam->pitch));
}

static quat_t camera_top_down_quat(void) {
    return quat_axis_angle(1.0f, 0.0f, 0.0f, -RPD_PI * 0.5f);
}

void camera_basis(const camera_t *cam, float blend, float right[3], float up[3], float forward[3]) {
    if (blend < 0.0f) blend = 0.0f;
    if (blend > 1.0f) blend = 1.0f;
    quat_t q = quat_slerp(camera_saved_quat(cam), camera_top_down_quat(), blend);
    quat_rotate(q, (const float[3]){ 1.0f, 0.0f, 0.0f }, right);
    quat_rotate(q, (const float[3]){ 0.0f, 1.0f, 0.0f }, up);
    quat_rotate(q, (const float[3]){ 0.0f, 0.0f, -1.0f }, forward);
}

void camera_eye(const camera_t *cam, float blend, float eye[3]) {
    float right[3], up[3], forward[3];
    camera_basis(cam, blend, right, up, forward);
    float distance = camera_distance(cam);
    eye[0] = cam->target[0] - forward[0] * distance;
    eye[1] = cam->target[1] - forward[1] * distance;
    eye[2] = cam->target[2] - forward[2] * distance;
}

void camera_pan(camera_t *cam, float dx, float dy, float viewport_height) {
    if (viewport_height < 1.0f) viewport_height = 1.0f;
    float right[3], up[3], forward[3];
    camera_basis(cam, 0.0f, right, up, forward);
    float scale = cam->frame / viewport_height;
    for (int i = 0; i < 3; i++) {
        cam->target[i] -= right[i] * dx * scale;
        cam->target[i] += up[i] * dy * scale;
    }
}

void camera_pan_ortho(camera_t *cam, float dx, float dy, float viewport_height) {
    if (viewport_height < 1.0f) viewport_height = 1.0f;
    float scale = cam->frame / viewport_height;
    cam->target[0] -= dx * scale;
    cam->target[2] -= dy * scale;
}

void camera_zoom(camera_t *cam, float amount) {
    float frame = cam->frame * powf(0.9f, amount);
    if (frame < 30.0f) frame = 30.0f;
    if (frame > 260.0f) frame = 260.0f;
    cam->frame = frame;
}
