/*
 * Real RPD geometry viewer.
 *
 * The asset is the LOD-0 RPD terrain mesh. Each source material subdivision
 * has one flat colour; there are no textures. The clip box and flat top
 * envelopes are trimmed, but the rest of the real building shell is kept.
 *
 * Rendering lives in native/src. math owns matrices and camera geometry,
 * shaders owns the GLSL, target owns the offscreen pass and composite, scene
 * owns the mesh and markers, map owns the 2D pass, input owns camera events,
 * and app owns the explicit renderer state and frame loop.
 */

#include "rpd_app.h"
#include "rpd_sokol.h"

sapp_desc sokol_main(int argc, char *argv[]) {
    (void)argc; (void)argv;
    return (sapp_desc){
        .init_cb = rpd_app_init,
        .frame_cb = rpd_app_frame,
        .cleanup_cb = rpd_app_cleanup,
        .event_cb = rpd_app_event,
        .width = 1600,
        .height = 900,
        .high_dpi = true,
        .window_title = "RPD — floors 1–3",
    };
}
