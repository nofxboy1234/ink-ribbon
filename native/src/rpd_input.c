#include "rpd_input.h"

#include <math.h>

#include "rpd_app.h"
#include "rpd_state.h"

void input_handle_event(const sapp_event *e) {
    switch (e->type) {
    case SAPP_EVENTTYPE_MOUSE_DOWN:
        camera_cancel_animation();
        g_rpd.input.user_moved = true;
        if (e->mouse_button == SAPP_MOUSEBUTTON_RIGHT) g_rpd.input.rotating = true;
        if (e->mouse_button == SAPP_MOUSEBUTTON_MIDDLE) g_rpd.input.panning = true;
        g_rpd.input.last_x = e->mouse_x;
        g_rpd.input.last_y = e->mouse_y;
        g_rpd.input.pointer_valid = true;
        break;
    case SAPP_EVENTTYPE_MOUSE_UP:
        if (e->mouse_button == SAPP_MOUSEBUTTON_RIGHT) g_rpd.input.rotating = false;
        if (e->mouse_button == SAPP_MOUSEBUTTON_MIDDLE) g_rpd.input.panning = false;
        break;
    case SAPP_EVENTTYPE_MOUSE_ENTER:
        g_rpd.input.last_x = e->mouse_x;
        g_rpd.input.last_y = e->mouse_y;
        g_rpd.input.pointer_valid = true;
        break;
    case SAPP_EVENTTYPE_MOUSE_LEAVE:
        g_rpd.input.rotating = false;
        g_rpd.input.panning = false;
        g_rpd.input.pointer_valid = false;
        break;
    case SAPP_EVENTTYPE_MOUSE_MOVE: {
        if (!g_rpd.input.pointer_valid) {
            g_rpd.input.last_x = e->mouse_x;
            g_rpd.input.last_y = e->mouse_y;
            g_rpd.input.pointer_valid = true;
            break;
        }
        float dx = e->mouse_x - g_rpd.input.last_x;
        float dy = e->mouse_y - g_rpd.input.last_y;
        g_rpd.input.last_x = e->mouse_x;
        g_rpd.input.last_y = e->mouse_y;
        if (g_rpd.input.rotating) {
            g_rpd.camera.yaw -= dx * 0.006f;
            g_rpd.camera.pitch = fminf(1.45f, fmaxf(0.08f, g_rpd.camera.pitch + dy * 0.006f));
        } else if (g_rpd.input.panning) {
            camera_pan(&g_rpd.camera, dx, dy, (float)sapp_height());
        }
        break;
    }
    case SAPP_EVENTTYPE_MOUSE_SCROLL:
        camera_cancel_animation();
        g_rpd.input.user_moved = true;
        g_rpd.camera.distance = fminf(700.0f, fmaxf(8.0f, g_rpd.camera.distance * powf(0.9f, e->scroll_y)));
        break;
    case SAPP_EVENTTYPE_TOUCHES_BEGAN:
    case SAPP_EVENTTYPE_TOUCHES_MOVED:
    case SAPP_EVENTTYPE_TOUCHES_ENDED: {
        float cx = 0.0f, cy = 0.0f;
        for (int i = 0; i < e->num_touches; i++) { cx += e->touches[i].pos_x; cy += e->touches[i].pos_y; }
        if (e->num_touches > 0) { cx /= (float)e->num_touches; cy /= (float)e->num_touches; }
        if (e->type == SAPP_EVENTTYPE_TOUCHES_BEGAN) {
            camera_cancel_animation();
            g_rpd.input.last_x = cx; g_rpd.input.last_y = cy;
            break;
        }
        if (e->num_touches == 1 && e->type != SAPP_EVENTTYPE_TOUCHES_ENDED) {
            float dx = e->touches[0].pos_x - g_rpd.input.last_x;
            float dy = e->touches[0].pos_y - g_rpd.input.last_y;
            g_rpd.camera.yaw -= dx * 0.006f;
            g_rpd.camera.pitch = fminf(1.45f, fmaxf(0.08f, g_rpd.camera.pitch + dy * 0.006f));
        } else if (e->num_touches >= 2) {
            float dx = cx - g_rpd.input.last_x, dy = cy - g_rpd.input.last_y;
            camera_pan(&g_rpd.camera, dx, dy, (float)sapp_height());
        }
        g_rpd.input.last_x = e->num_touches > 0 ? cx : g_rpd.input.last_x;
        g_rpd.input.last_y = e->num_touches > 0 ? cy : g_rpd.input.last_y;
        break;
    }
    case SAPP_EVENTTYPE_KEY_DOWN:
        if (e->key_code == SAPP_KEYCODE_R) {
            g_rpd.input.user_moved = false;
            camera_reset();
        }
        break;
    case SAPP_EVENTTYPE_UNFOCUSED:
        g_rpd.input.rotating = false;
        g_rpd.input.panning = false;
        break;
    case SAPP_EVENTTYPE_RESIZED:
        g_rpd.target.dirty = true;
        if (!g_rpd.input.user_moved && g_rpd.scene.loaded) camera_reset();
        break;
    default: break;
    }
}
