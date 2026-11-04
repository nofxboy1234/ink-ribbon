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

void camera_eye(const camera_t *cam, float eye[3]) {
    float cp = cosf(cam->pitch);
    eye[0] = cam->target[0] + cam->distance * cp * sinf(cam->yaw);
    eye[1] = cam->target[1] + cam->distance * sinf(cam->pitch);
    eye[2] = cam->target[2] + cam->distance * cp * cosf(cam->yaw);
}

void camera_pan(camera_t *cam, float dx, float dy, float viewport_height) {
    float eye[3];
    camera_eye(cam, eye);
    float f[3] = { cam->target[0] - eye[0], cam->target[1] - eye[1], cam->target[2] - eye[2] };
    float fl = sqrtf(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
    f[0] /= fl; f[1] /= fl; f[2] /= fl;
    float right[3] = { -f[2], 0.0f, f[0] };
    float rl = sqrtf(right[0] * right[0] + right[2] * right[2]);
    right[0] /= rl; right[2] /= rl;
    float up[3] = { right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0] };
    float scale = 2.0f * cam->distance * tanf(0.31f) / viewport_height;
    for (int i = 0; i < 3; i++) {
        cam->target[i] -= right[i] * dx * scale;
        cam->target[i] += up[i] * dy * scale;
    }
}
