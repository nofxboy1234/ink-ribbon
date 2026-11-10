#pragma once

#include "rpd_popup.h"

void menu_open(float x, float y);
void menu_close(void);
int menu_is_open(void);
void menu_execute(popup_action_t action, int node, int data);
