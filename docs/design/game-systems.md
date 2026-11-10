# RPD game systems design

This is the pre-implementation design for the systems the acceptance playthrough needs. It is a proposal for review, not an implementation.

Agreed choices:

- The collection is the 116 obtainable items, plus the 3 unreachable items preloaded into the global item box at the start.
- Three save slots, each resuming the session it saved.
- Every system is built before the acceptance run.
- The current menus stay, and the map grows one feature at a time as each system lands.
- The recording is a time-lapse with real-time menu and item moments.

## 1. State and time model

### Authoritative state

The C side owns the game state; React renders it and sends intents. The current split is kept and extended:

| State | Today | Target |
|---|---|---|
| Player position, floor, route, moving | `rpd_plan.c` | stays, plus intent and action timer |
| Items, inventory, item states, gates | `rpd_items.c` | stays, plus the item box |
| Doors | item gates only | new `rpd_doors.c/h` |
| Enemies, enemy health, Mr X | none | new `rpd_enemies.c/h` |
| Claire health | none | new fields in `rpd_plan.c` |
| Notes | file items only | new `rpd_notes.c/h` |
| Crafting | none | new `rpd_craft.c/h` |
| Save slots | none | new `rpd_save.c/h` |
| Debug mode | none | new `rpd_debug.c/h` |

Proposed shapes:

```c
typedef enum { HEALTH_FINE, HEALTH_CAUTION, HEALTH_DANGER } health_band_t;

typedef enum { ACTION_NONE, ACTION_SHOOT, ACTION_STAB, ACTION_OPEN, ACTION_TAKE,
               ACTION_SAVE, ACTION_HEAL } action_t;

typedef struct {
    action_t action;
    float elapsed;
    float duration;
    int target;   /* enemy, door or item index */
} action_run_t;

typedef struct {
    float x, y, z;
    int floor;
    int health;          /* 0..120, bands at 60 and 30 */
    int node;
    action_run_t action;
} player_state_t;

typedef struct {
    int id;
    int floor;
    float x, y, z;
    int state;           /* locked, unlocked, open */
    float open;          /* 0..1 animation */
} door_t;

typedef struct {
    int kind;            /* zombie, dog, mr_x */
    float x, y, z;
    int floor;
    int health;
    int state;           /* idle, alert, chase, attack, downed */
    float timer;
} enemy_t;
```

The item box is one global `inventory_slot_t[32]` store in `rpd_items.c`, shared by every box marker. The save state is a serialized struct of the player, inventory, item box, doors, enemies, notes read flags, crafting and the active floor. Three slots in `localStorage`, keyed by slot, each with a version and the scene asset version.

### The clock

`game_update(dt)` runs once per frame after input, in this order:

1. If paused (menu open, Escape menu, code entry, inventory, save/load), tick nothing. Pause freezes the player, the action timer, the enemies, the door animation and the item box.
2. Apply the player intent: a route move, a step, or an action. A route move advances the player and queues the action when it arrives.
3. If the player moved or started an action, tick the enemies one step. A player action that is running also counts as acting for the full action duration.
4. Tick the action timer. At the end, apply the effect (the shot, the stab, the open, the take, the save, the heal).
5. Tick the doors' open/close animation and the enemy attack timers.
6. Expire grants and refresh the item gates.

The hybrid rule is explicit: enemies only change state while `player_acted` or `player_moving` is true. Standing still is safe. Actions have durations: the shot 0.55 s, the stab 0.45 s, the open 0.6 s, the take 0.3 s, the save 1.0 s, the heal 0.8 s. The player can be hit during an action, and the action can be interrupted by damage.

The current `plan_update` keeps the walking and the route. The new `game_update` wraps it and becomes the only caller from `rpd_app.c`. `plan_update` loses the direct enemy-free assumption and calls the shared action state.

### Update ownership

- `rpd_app.c` owns the frame, the `dt` clamp and the pause flag.
- `rpd_game.c` owns the update order and the pause.
- `rpd_plan.c` owns the player and the route.
- `rpd_items.c` owns the items, the inventory and the box.
- `rpd_doors.c` owns the door state and the animation.
- `rpd_enemies.c` owns the enemies and their AI.
- `rpd_save.c` owns the slot serialization.
- `src/session/usePlanSession.ts` and a new `useGameSession.ts` mirror the state into React; `src/wasm/client.ts` exposes the commands.

## 2. System and menu inventory

| Surface | Menu or system | Today | Drive |
|---|---|---|---|
| React | Floor selector | yes | floor buttons, `__quest.debug().activeFloor` |
| React | Inventory panel | yes | slots, item title, `__quest.items()` |
| React | Code entry | yes | `__quest.enterCode` |
| React | Status / loading | yes | `.rpd-status` |
| React | Legend | yes | DOM labels |
| React | Item select, description, context | planned | DOM, `__quest.items()` |
| React | Item box panel | planned | DOM, `__quest.box()` |
| React | Notes page | planned | DOM, `__quest.notes()` |
| React | Save/load panel | planned | DOM, `__quest.saves()` |
| React | Pause / Escape menu | planned | DOM, `__quest.paused()` |
| React | Health band | planned | DOM, `__quest.health()` |
| React | Crafting combine | planned | DOM, `__quest.craft()` |
| Sokol | Route menu | yes | canvas right-click, `__quest.menu()` |
| Sokol | Item action popup | yes | canvas click, `__quest.popup()` |
| Sokol | Debug menu (D) | planned | canvas right-click, `__quest.debugMenu()` |
| Sokol | Teleport square Go and waypoint | planned | canvas right-click |
| Sokol | Enemy shoot | planned | canvas right-click on an enemy |
| Sokol | Run toggle | planned | menu choice, `__quest.running()` |

## 3. Real-game data

The item registry has 271 rows, including 28 files, 10 Gunpowder, 5 High-Grade Gunpowder, 6 Ink Ribbon, 4 Item Box, 37 Lock, 31 Transition, 6 Mr Raccoon and 8 Window. The 116 obtainable set and the 3 unreachable items come from `tools/check_item_reachability.mjs`.

The following is the public RE2 Remake behaviour used as the reference; the values are deliberate simplifications and are marked as approximations.

| System | Real game reference | Simplified value |
|---|---|---|
| Zombie | Slow shamble, grab, headshot, can be downed and revive | 100 health, 8 m sight, 1.1 m/s chase, 25 damage grab, 6 s downed |
| Zombie dog | Fast, lunge, low health | 45 health, 10 m sight, 3.2 m/s, 15 damage lunge |
| Mr X | Relentless pursuit, immune to damage, knock-down only | 999 health, 12 m hearing, 1.4 m/s, 35 damage, follows across rooms |
| Claire health | Fine, Caution, Danger | 120 max, Caution below 60, Danger below 30 |
| Gun | Handgun, 15 rounds, reload | 0.55 s shot, 12 damage, hit chance 0.85 stationary, 0.5 moving |
| Knife | Short range, durability | 0.45 s stab, 18 damage, 1.2 m range, 30 uses |
| Crafting | Gunpowder and herbs | 2 Gunpowder gives 10 handgun rounds; 2 High-Grade gives 5 magnum rounds; Green + Green heals more; Green + Red heals most; Green + Blue cures poison; Red + Blue is a mixed cure |
| Notes | 28 file items in the registry | the file text on the notes page |
| Save | Typewriter plus Ink Ribbon | three slots, the Ink Ribbon consumed per save |

Items that cannot be extracted or confirmed are listed as approximations, not facts. The registry is the item source; the public RE2 references are the behaviour source.

## 4. Slice plan

1. **State and time plus debug mode.** `game_update`, the pause, the action timer, `rpd_debug` with D, teleport here, debug take, the related-item highlight and the go-to list. Verify with a new contract section and the existing 48 shots.
2. **Inventory, item box, descriptions, discard and notes.** The React panels and the per-item actions. Verify the slots, the descriptions, the store and take out, the discard, the notes toggle and the capacity.
3. **Save and load.** Three slots, the typewriter and the Ink Ribbon. Verify a save, a page reload and a continue, and the slot isolation.
4. **Doors.** The locked red, unlocked blue and open rotation, the no-collision rule and the walk-through animation. Verify the states, the colors, the animation and the route through.
5. **Enemies, combat and health.** The prototypes for shooting and stabbing first, then the zombie, dog and Mr X AI, the enemy health and the Claire health bands. Verify the visibility radius, the capsule colors, the damage, the hit chance and the pause.
6. **Teleport squares, run and pause, zoom persistence.** The Go and the waypoint, the run toggle at 1.5x, the menu pause and the zoom across floors. Verify each.
7. **Crafting.** The combine flow and the recipes. Verify the ingredients are removed and the result appears.
8. **Acceptance playthrough and GIFs.** The deterministic session, the two recordings, the cold rerun and the final state.

The riskiest unknowns are the enemy AI and the combat feel, so slice 5 starts with throwaway prototypes. The acceptance run is last and reuses the feature map.

## Open questions for the user

- Confirm the simplified enemy and combat values above or name changes.
- Confirm the crafting recipes, especially the herb pairs.
- Confirm the notes text source, the registry file items or the actual game text.
- Confirm whether the Ink Ribbon is consumed per save.
- Confirm the run speed multiplier and the action durations.
- Confirm whether the debug go-to list jumps the camera, the player or both.
