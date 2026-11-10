#pragma once

// The inventory combine. The recipes are the public RE2 pairs simplified:
// two gunpowders make ammo, two herbs make a stronger herb.
int craft_recipe_result(int first, int second);
int craft_combine(int first, int second);
int craft_recipe_count(void);
