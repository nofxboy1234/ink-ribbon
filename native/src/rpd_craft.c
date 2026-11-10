#include "rpd_craft.h"

#include <string.h>

#include "rpd_items.h"

typedef struct {
    const char *first;
    const char *second;
    const char *result;
} recipe_t;

// The result is a synthetic take: the source items are consumed and a fresh
// copy of the result is granted, so the inventory capacity is respected.
static const recipe_t recipes[] = {
    { "Gunpowder", "Gunpowder", "Handgun Ammo" },
    { "High-Grade Gunpowder", "High-Grade Gunpowder", "Magnum Ammo" },
    { "Green Herb", "Green Herb", "Green Herb" },
    { "Green Herb", "Red Herb", "Mixed Herb (G+R)" },
    { "Green Herb", "Blue Herb", "Mixed Herb (G+B)" },
};

static int find_item(const char *title) {
    for (int i = 0; i < items_count(); i++) {
        const item_t *item = items_get(i);
        if (item && item->def && item->def->title && strcmp(item->def->title, title) == 0) return i;
    }
    return -1;
}

int craft_recipe_count(void) { return (int)(sizeof(recipes) / sizeof(recipes[0])); }

int craft_recipe_result(int first, int second) {
    const item_t *a = items_get(first);
    const item_t *b = items_get(second);
    if (!a || !b || !a->def || !b->def) return -1;
    for (int i = 0; i < craft_recipe_count(); i++) {
        const int direct = strcmp(a->def->title, recipes[i].first) == 0 && strcmp(b->def->title, recipes[i].second) == 0;
        const int swapped = strcmp(a->def->title, recipes[i].second) == 0 && strcmp(b->def->title, recipes[i].first) == 0;
        if (direct || swapped) return find_item(recipes[i].result);
    }
    return -1;
}

int craft_combine(int first, int second) {
    const int result = craft_recipe_result(first, second);
    if (result < 0) return -1;
    if (items_discard(first) != 0) return -2;
    if (second != first && items_discard(second) != 0) return -3;
    item_t *entry = (item_t *)items_get(result);
    if (!entry) return -4;
    entry->state = ITEM_PRESENT;
    return items_act(result);
}
