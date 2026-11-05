#pragma once

/* Camera plumbing for the plan view. The plan is drawn by the main scene
   renderer in rpd_app.c; this module only receives the orthographic framing
   from the web app. */
void map_set_camera(float cx, float cz, float scale, float vw, float vh, float floor_y);
