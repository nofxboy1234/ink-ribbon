#pragma once

#include <stdbool.h>

#include "rpd_sokol.h"

typedef struct {
    bool rotating;
    bool panning;
    bool user_moved;
    float last_x, last_y;
    bool pointer_valid;
} input_t;

void input_handle_event(const sapp_event *e);
