#pragma once

void overlay_init(void);
void overlay_build(const float *view_proj, int width, int height, int ortho, float fps);
void overlay_set_fps_visible(int visible);
void overlay_upload(void);
void overlay_draw(void);
