#pragma once

#include "rpd_sokol.h"

void rpd_app_init(void);
void rpd_app_frame(void);
void rpd_app_cleanup(void);
void rpd_app_event(const sapp_event *e);
void camera_reset(void);
void camera_cancel_animation(void);
void camera_update_animation(float dt);
