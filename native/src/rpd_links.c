#include "rpd_items.h"

#include <stddef.h>

#include "rpd_item_registry.h"

static bool item_on_map(int index) {
    const item_t *item = items_get(index);
    if (!item) return false;
    return item->state == ITEM_PRESENT || item->state == ITEM_OPEN || item->state == ITEM_UNLOCKED;
}

static void add_related(int *out, int *count, int cap, int candidate, int self) {
    if (candidate == self || candidate < 0 || candidate >= RPD_ITEM_COUNT) return;
    if (!item_on_map(candidate)) return;
    for (int i = 0; i < *count; i++) if (out[i] == candidate) return;
    if (*count < cap) out[(*count)++] = candidate;
}

int items_related(int index, int *out, int cap) {
    const rpd_item_def_t *def = items_def(index);
    if (!def || cap <= 0) return 0;
    int count = 0;
    for (int i = 0; i < def->opens_count; i++) add_related(out, &count, cap, def->opens[i], index);
    for (int i = 0; i < def->requires_count; i++) add_related(out, &count, cap, def->requires[i], index);
    for (int i = 0; i < RPD_ITEM_COUNT; i++) {
        if (i == index) continue;
        const rpd_item_def_t *other = items_def(i);
        if (!other) continue;
        for (int r = 0; r < other->opens_count; r++) {
            if (other->opens[r] == index) { add_related(out, &count, cap, i, index); break; }
        }
        for (int r = 0; r < other->requires_count; r++) {
            if (other->requires[r] == index) { add_related(out, &count, cap, i, index); break; }
        }
    }
    return count;
}
