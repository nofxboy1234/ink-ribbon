#include "rpd_map.h"

#include <emscripten/emscripten.h>

#include "rpd_state.h"

EMSCRIPTEN_KEEPALIVE void rpd_map_set_camera(float cx, float cz, float scale, float vw, float vh, float floor_y) {
    g_rpd.ortho_center[0] = cx;
    g_rpd.ortho_center[1] = cz;
    g_rpd.ortho_scale = scale;
    g_rpd.ortho_floor_y = floor_y;
    g_rpd.ortho_viewport[0] = vw;
    g_rpd.ortho_viewport[1] = vh;
}
