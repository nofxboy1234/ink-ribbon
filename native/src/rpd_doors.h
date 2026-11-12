#pragma once

// Doors are drawn from the Lock items. The item state decides the colour:
// present is locked, unlocked is blue and open rotates the leaf.
void doors_reset(void);
void doors_sync(void);
int doors_count(void);
int doors_discovered(int index);
