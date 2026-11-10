import type { RpdModule } from "./rpd";

type RpdFactory = (options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}) => Promise<RpdModule>;

export type RpdClient = {
  loadScene(data: Uint8Array): number;
  getCamera(): Float32Array;
  setOrbit(tx: number, ty: number, tz: number, yaw: number, pitch: number, distance: number): number;
  animateOrbit(tx: number, ty: number, tz: number, distance: number, duration: number): number;
  getViewProj(): Float32Array;
  markerClear(): void;
  markerAdd(
    shape: number,
    x: number,
    y: number,
    z: number,
    size: number,
    r: number,
    g: number,
    b: number,
  ): number;
  markerSetVisible(index: number, visible: number): void;
  markerSetPosition(index: number, x: number, y: number, z: number): void;
  markerSetColor(index: number, r: number, g: number, b: number): void;
  markerSetRotation(index: number, radians: number): void;
  markerCount(): number;
  setPlayerPosition(x: number, y: number, z: number): void;
  playerRadius(): number;
  routeRadius(): number;
  setViewMode(mode: number): void;
  planSetFloors(levels: Float32Array, bounds: Float32Array): void;
  planSetGraph(
    count: number,
    x: Float32Array,
    y: Float32Array,
    z: Float32Array,
    floor: Uint8Array,
    kind: Uint8Array,
    first: Int32Array,
    adjacency: Int32Array,
    cost: Float32Array,
  ): void;
  planSetRooms(
    count: number,
    x: Float32Array,
    y: Float32Array,
    z: Float32Array,
    floor: Uint8Array,
    names: Uint8Array,
    offsets: Int32Array,
  ): void;
  planSetSpawn(x: number, y: number, z: number): void;
  planSetPlayer(x: number, y: number, z: number): void;
  planSetFloor(index: number): void;
  planActiveFloor(): number;
  planStartMove(): void;
  planAddTarget(x: number, y: number, z: number): void;
  planAddTargetNode(node: number): void;
  planRemoveTargetNode(node: number): number;
  planWaypoint(index: number): number;
  planHover(): number;
  planPointerMove(x: number, y: number): void;
  planNodeBlocked(node: number): number;
  planCamera(): Float32Array;
  planRouteCount(): number;
  planRoute(): Float32Array;
  popupState(): Float32Array;
  popupChoice(index: number): {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    enabled: boolean;
    action: number;
    label: string;
  } | null;
  popupMessage(): string;
  popupClose(): void;
  itemCount(): number;
  item(index: number): {
    x: number;
    y: number;
    z: number;
    r: number;
    g: number;
    b: number;
    node: number;
    taken: boolean;
    room: number;
    floor: number;
    state: number;
    action: number;
    hidden: boolean;
    available: boolean;
    flags: number;
    cubeX: number;
    cubeY: number;
    cubeZ: number;
    name: string;
    roomName: string;
  } | null;
  itemIcon(index: number): string;
  itemAction(index: number): string;
  itemHint(index: number): string;
  itemAct(index: number): number;
  itemDebugTake(index: number): number;
  itemRelated(index: number): number[];
  itemDebugHighlight(index: number): void;
  itemDebugHighlighted(): number;
  itemDiscard(index: number): number;
  boxStore(index: number): number;
  boxTake(slot: number): number;
  boxCount(): number;
  boxItem(slot: number): number;
  saveSnapshot(): Uint8Array;
  saveRestore(bytes: Uint8Array): number;
  saveSize(): number;
  doorsCount(): number;
  enemyCount(): number;
  enemyAlive(): number;
  enemyHealth(index: number): number;
  enemyHit(index: number, damage: number): number;
  enemyVisible(index: number): number;
  health(): number;
  shoot(index: number, stationary: boolean): number;
  stab(index: number): number;
  toggleDebug(): void;
  debugEnabled(): boolean;
  itemEnterCode(index: number, code: string): number;
  itemGrantExternal(id: number): number;
  itemHasCode(index: number): boolean;
  itemBlocked(index: number): number;
  itemIndexForId(id: number): number;
  inventoryItem(slot: number): number;
  inventoryCount(): number;
  inventory(): Float32Array;
  planMoveState(): Float32Array;
  setFpsVisible(visible: boolean): void;
  planCount(): number;
  planMoving(): number;
  planRoom(): string;
  planPlayer(): Float32Array;
  planReset(): void;
  planClearRoute(): void;
  openPopupAt(x: number, z: number): number;
  resetView(): void;
  recenter(): void;
  cameraModel(): Float32Array;
  debugFloors(): Float32Array;
  overlayStats(): Float32Array;
  debugBlend(): number;
  dispose(): void;
};

export async function createRpdClient(options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}): Promise<RpdClient> {
  const imported = await import("./rpd.js");
  const factory = (imported.default ?? imported) as unknown as RpdFactory;
  const module = await factory(options);
  const heap = module as unknown as {
    HEAPF32: Float32Array;
    HEAPU8: Uint8Array;
    UTF8ToString: (ptr: number) => string;
  };
  const viewProjPtr = module._malloc(16 * 4);
  const cameraPtr = module._malloc(6 * 4);
  const utf8 = (ptr: number) => {
    let end = ptr;
    while (heap.HEAPU8[end]) end += 1;
    return new TextDecoder().decode(heap.HEAPU8.subarray(ptr, end));
  };

  return {
    loadScene(data) {
      const ptr = module._malloc(data.byteLength);
      heap.HEAPU8.set(data, ptr);
      const result = module._rpd_load_scene(ptr, data.byteLength);
      module._free(ptr);
      return result;
    },
    getCamera() {
      module._rpd_get_camera(cameraPtr);
      return new Float32Array(module.HEAPU8.buffer, cameraPtr, 6).slice();
    },
    setOrbit(tx, ty, tz, yaw, pitch, distance) {
      return module._rpd_set_orbit(tx, ty, tz, yaw, pitch, distance);
    },
    animateOrbit(tx, ty, tz, distance, duration) {
      return module._rpd_animate_orbit(tx, ty, tz, distance, duration);
    },
    getViewProj() {
      module._rpd_get_view_proj(viewProjPtr);
      return new Float32Array(module.HEAPU8.buffer, viewProjPtr, 16).slice();
    },
    markerClear() {
      module._rpd_marker_clear();
    },
    markerAdd(shape, x, y, z, size, r, g, b) {
      return module._rpd_marker_add(shape, x, y, z, size, r, g, b);
    },
    markerSetVisible(index, visible) {
      module._rpd_marker_set_visible(index, visible);
    },
    markerSetPosition(index, x, y, z) {
      module._rpd_marker_set_position(index, x, y, z);
    },
    markerSetColor(index, r, g, b) {
      module._rpd_marker_set_color(index, r, g, b);
    },
    markerSetRotation(index, radians) {
      module._rpd_marker_set_rotation(index, radians);
    },
    markerCount() {
      return module._rpd_marker_count();
    },
    playerRadius() {
      return (module as unknown as { _rpd_player_radius: () => number })._rpd_player_radius();
    },
    routeRadius() {
      return (module as unknown as { _rpd_route_radius: () => number })._rpd_route_radius();
    },
    setPlayerPosition(x, y, z) {
      module._rpd_set_player_position(x, y, z);
    },
    setViewMode(mode) {
      module._rpd_set_view_mode(mode);
    },
    planSetFloors(levels, bounds) {
      const lp = module._malloc(levels.byteLength);
      const bp = module._malloc(bounds.byteLength);
      new Float32Array(heap.HEAPU8.buffer).set(levels, lp >> 2);
      new Float32Array(heap.HEAPU8.buffer).set(bounds, bp >> 2);
      (module as unknown as { _rpd_plan_set_floors: (n: number, l: number, b: number) => void })._rpd_plan_set_floors(levels.length, lp, bp);
      module._free(lp);
      module._free(bp);
    },
    planSetGraph(count, x, y, z, floor, kind, first, adjacency, cost) {
      const ptrs = [
        module._malloc(x.byteLength), module._malloc(y.byteLength), module._malloc(z.byteLength),
        module._malloc(floor.byteLength), module._malloc(kind.byteLength),
        module._malloc(first.byteLength), module._malloc(adjacency.byteLength), module._malloc(cost.byteLength),
      ];
      new Float32Array(heap.HEAPU8.buffer).set(x, ptrs[0] >> 2);
      new Float32Array(heap.HEAPU8.buffer).set(y, ptrs[1] >> 2);
      new Float32Array(heap.HEAPU8.buffer).set(z, ptrs[2] >> 2);
      heap.HEAPU8.set(floor, ptrs[3]);
      heap.HEAPU8.set(kind, ptrs[4]);
      heap.HEAPU8.set(new Uint8Array(first.buffer, first.byteOffset, first.byteLength), ptrs[5]);
      heap.HEAPU8.set(new Uint8Array(adjacency.buffer, adjacency.byteOffset, adjacency.byteLength), ptrs[6]);
      new Float32Array(heap.HEAPU8.buffer).set(cost, ptrs[7] >> 2);
      (module as unknown as { _rpd_plan_set_graph: (...args: number[]) => void })._rpd_plan_set_graph(
        count, ptrs[0], ptrs[1], ptrs[2], ptrs[3], ptrs[4], ptrs[5], ptrs[6], ptrs[7],
      );
      for (const ptr of ptrs) module._free(ptr);
    },
    planSetRooms(count, x, y, z, floor, names, offsets) {
      const ptrs = [
        module._malloc(x.byteLength), module._malloc(y.byteLength), module._malloc(z.byteLength),
        module._malloc(floor.byteLength), module._malloc(names.byteLength), module._malloc(offsets.byteLength),
      ];
      new Float32Array(heap.HEAPU8.buffer).set(x, ptrs[0] >> 2);
      new Float32Array(heap.HEAPU8.buffer).set(y, ptrs[1] >> 2);
      new Float32Array(heap.HEAPU8.buffer).set(z, ptrs[2] >> 2);
      heap.HEAPU8.set(floor, ptrs[3]);
      heap.HEAPU8.set(names, ptrs[4]);
      heap.HEAPU8.set(new Uint8Array(offsets.buffer, offsets.byteOffset, offsets.byteLength), ptrs[5]);
      (module as unknown as { _rpd_plan_set_rooms: (...args: number[]) => void })._rpd_plan_set_rooms(
        count, ptrs[0], ptrs[1], ptrs[2], ptrs[3], ptrs[4], names.byteLength, ptrs[5],
      );
      for (const ptr of ptrs) module._free(ptr);
    },
    planSetSpawn(x, y, z) {
      (module as unknown as { _rpd_plan_set_spawn: (x: number, y: number, z: number) => void })._rpd_plan_set_spawn(x, y, z);
    },
    planSetPlayer(x, y, z) {
      (module as unknown as { _rpd_plan_set_player: (x: number, y: number, z: number) => void })._rpd_plan_set_player(x, y, z);
    },
    planSetFloor(index) {
      (module as unknown as { _rpd_plan_set_floor: (i: number) => void })._rpd_plan_set_floor(index);
    },
    planActiveFloor() {
      return (module as unknown as { _rpd_plan_active_floor: () => number })._rpd_plan_active_floor();
    },
    planStartMove() {
      (module as unknown as { _rpd_plan_start_move: () => void })._rpd_plan_start_move();
    },
    planAddTarget(x, y, z) {
      (module as unknown as { _rpd_plan_add_target: (x: number, y: number, z: number) => void })._rpd_plan_add_target(x, y, z);
    },
    planAddTargetNode(node) {
      (module as unknown as { _rpd_plan_add_target_node: (n: number) => void })
        ._rpd_plan_add_target_node(node);
    },
    planRemoveTargetNode(node) {
      return (module as unknown as { _rpd_plan_remove_target_node: (n: number) => number })
        ._rpd_plan_remove_target_node(node);
    },
    planWaypoint(index) {
      return (module as unknown as { _rpd_plan_waypoint: (i: number) => number })
        ._rpd_plan_waypoint(index);
    },
    planHover() {
      return module._rpd_plan_hover();
    },
    planPointerMove(x, y) {
      module._rpd_plan_pointer_move(x, y);
    },
    planNodeBlocked(node) {
      return module._rpd_plan_node_blocked(node);
    },
    planCamera() {
      const ptr = module._malloc(3 * 4);
      (module as unknown as { _rpd_plan_camera: (p: number) => number })._rpd_plan_camera(ptr);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 3).slice();
      module._free(ptr);
      return out;
    },
    planRouteCount() {
      return (module as unknown as { _rpd_plan_route_count: () => number })._rpd_plan_route_count();
    },
    planRoute() {
      const count = (module as unknown as { _rpd_plan_route_count: () => number })._rpd_plan_route_count();
      if (count <= 0) return new Float32Array(0);
      const ptr = module._malloc(count * 3 * 4);
      const n = (module as unknown as { _rpd_plan_route: (p: number, cap: number) => number })
        ._rpd_plan_route(ptr, count);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, n * 3).slice();
      module._free(ptr);
      return out;
    },
    popupState() {
      const ptr = module._malloc(9 * 4);
      (module as unknown as { _rpd_popup_state: (p: number) => number })._rpd_popup_state(ptr);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 9).slice();
      module._free(ptr);
      return out;
    },
    popupChoice(index) {
      const ptr = module._malloc(6 * 4);
      const ok = (module as unknown as { _rpd_popup_choice: (i: number, p: number) => number })
        ._rpd_popup_choice(index, ptr);
      if (!ok) {
        module._free(ptr);
        return null;
      }
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 6).slice();
      module._free(ptr);
      const labelPtr = (module as unknown as { _rpd_popup_label: (i: number) => number })._rpd_popup_label(index);
      return {
        x0: out[0],
        y0: out[1],
        x1: out[2],
        y1: out[3],
        enabled: out[4] !== 0,
        action: out[5],
        label: utf8(labelPtr),
      };
    },
    popupMessage() {
      return utf8((module as unknown as { _rpd_popup_message: () => number })._rpd_popup_message());
    },
    popupClose() {
      (module as unknown as { _rpd_popup_close: () => void })._rpd_popup_close();
    },
    itemCount() {
      return (module as unknown as { _rpd_item_count: () => number })._rpd_item_count();
    },
    item(index) {
      const ptr = module._malloc(18 * 4);
      const ok = (module as unknown as { _rpd_item: (i: number, p: number) => number })
        ._rpd_item(index, ptr);
      if (!ok) {
        module._free(ptr);
        return null;
      }
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 18).slice();
      module._free(ptr);
      const namePtr = (module as unknown as { _rpd_item_name: (i: number) => number })._rpd_item_name(index);
      const roomPtr = (module as unknown as { _rpd_item_room: (i: number) => number })._rpd_item_room(index);
      return {
        x: out[0],
        y: out[1],
        z: out[2],
        r: out[3],
        g: out[4],
        b: out[5],
        node: out[6],
        taken: out[7] !== 0,
        room: out[8],
        floor: out[9],
        state: out[10],
        action: out[11],
        hidden: out[12] !== 0,
        available: out[13] !== 0,
        flags: out[14],
        cubeX: out[15],
        cubeY: out[16],
        cubeZ: out[17],
        name: utf8(namePtr),
        roomName: utf8(roomPtr),
      };
    },
    itemIcon(index) {
      return utf8((module as unknown as { _rpd_item_icon: (i: number) => number })._rpd_item_icon(index));
    },
    itemAction(index) {
      return utf8((module as unknown as { _rpd_item_action: (i: number) => number })._rpd_item_action(index));
    },
    itemHint(index) {
      return utf8((module as unknown as { _rpd_item_hint: (i: number) => number })._rpd_item_hint(index));
    },
    itemAct(index) {
      return (module as unknown as { _rpd_item_act: (i: number) => number })._rpd_item_act(index);
    },
    itemDebugTake(index) {
      return (module as unknown as { _rpd_item_debug_take: (i: number) => number })._rpd_item_debug_take(index);
    },
    itemRelated(index) {
      const ptr = module._malloc(8 * 4);
      const count = (module as unknown as { _rpd_item_related: (i: number, p: number, c: number) => number })
        ._rpd_item_related(index, ptr, 8);
      const out = Array.from(new Int32Array(heap.HEAPU8.buffer, ptr, Math.max(0, count)));
      module._free(ptr);
      return out;
    },
    itemDebugHighlight(index) {
      (module as unknown as { _rpd_item_debug_highlight: (i: number) => void })._rpd_item_debug_highlight(index);
    },
    itemDebugHighlighted() {
      return (module as unknown as { _rpd_item_debug_highlighted: () => number })._rpd_item_debug_highlighted();
    },
    itemDiscard(index) {
      return (module as unknown as { _rpd_item_discard: (i: number) => number })._rpd_item_discard(index);
    },
    boxStore(index) {
      return (module as unknown as { _rpd_box_store: (i: number) => number })._rpd_box_store(index);
    },
    boxTake(slot) {
      return (module as unknown as { _rpd_box_take: (s: number) => number })._rpd_box_take(slot);
    },
    boxCount() {
      return (module as unknown as { _rpd_box_count: () => number })._rpd_box_count();
    },
    boxItem(slot) {
      return (module as unknown as { _rpd_box_item: (s: number) => number })._rpd_box_item(slot);
    },
    saveSize() {
      return (module as unknown as { _rpd_save_size: () => number })._rpd_save_size();
    },
    doorsCount() {
      return (module as unknown as { _rpd_doors_count: () => number })._rpd_doors_count();
    },
    enemyCount() {
      return (module as unknown as { _rpd_enemy_count: () => number })._rpd_enemy_count();
    },
    enemyAlive() {
      return (module as unknown as { _rpd_enemy_alive: () => number })._rpd_enemy_alive();
    },
    enemyHealth(index) {
      return (module as unknown as { _rpd_enemy_health: (i: number) => number })._rpd_enemy_health(index);
    },
    enemyHit(index, damage) {
      return (module as unknown as { _rpd_enemy_hit: (i: number, d: number) => number })._rpd_enemy_hit(index, damage);
    },
    enemyVisible(index) {
      return (module as unknown as { _rpd_enemy_visible: (i: number) => number })._rpd_enemy_visible(index);
    },
    health() {
      return (module as unknown as { _rpd_game_health: () => number })._rpd_game_health();
    },
    shoot(index, stationary) {
      return (module as unknown as { _rpd_game_shoot: (i: number, s: number) => number })._rpd_game_shoot(index, stationary ? 1 : 0);
    },
    stab(index) {
      return (module as unknown as { _rpd_game_stab: (i: number) => number })._rpd_game_stab(index);
    },
    saveSnapshot() {
      const size = (module as unknown as { _rpd_save_size: () => number })._rpd_save_size();
      const ptr = module._malloc(size);
      (module as unknown as { _rpd_save_snapshot: (p: number, c: number) => number })
        ._rpd_save_snapshot(ptr, size);
      const out = new Uint8Array(heap.HEAPU8.buffer, ptr, size).slice();
      module._free(ptr);
      return out;
    },
    saveRestore(bytes) {
      const ptr = module._malloc(bytes.byteLength);
      heap.HEAPU8.set(bytes, ptr);
      const result = (module as unknown as { _rpd_save_restore: (p: number, s: number) => number })
        ._rpd_save_restore(ptr, bytes.byteLength);
      module._free(ptr);
      return result;
    },
    toggleDebug() {
      (module as unknown as { _rpd_game_toggle_debug: () => void })._rpd_game_toggle_debug();
    },
    debugEnabled() {
      return (module as unknown as { _rpd_game_debug: () => number })._rpd_game_debug() !== 0;
    },
    itemEnterCode(index, code) {
      const encoded = new TextEncoder().encode(code);
      const ptr = module._malloc(encoded.byteLength + 1);
      heap.HEAPU8.set(encoded, ptr);
      heap.HEAPU8[ptr + encoded.byteLength] = 0;
      const result = (module as unknown as { _rpd_item_enter_code: (i: number, c: number) => number })
        ._rpd_item_enter_code(index, ptr);
      module._free(ptr);
      return result;
    },
    itemGrantExternal(id) {
      return (module as unknown as { _rpd_item_grant_external: (id: number) => number })
        ._rpd_item_grant_external(id);
    },
    itemHasCode(index) {
      return (
        module as unknown as { _rpd_item_has_code: (i: number) => number }
      )._rpd_item_has_code(index) !== 0;
    },
    itemBlocked(index) {
      return (module as unknown as { _rpd_plan_item_blocked: (i: number) => number })
        ._rpd_plan_item_blocked(index);
    },
    itemIndexForId(id) {
      return (module as unknown as { _rpd_item_index_for_id: (id: number) => number })._rpd_item_index_for_id(id);
    },
    inventoryItem(slot) {
      return (module as unknown as { _rpd_inventory_item: (slot: number) => number })._rpd_inventory_item(slot);
    },
    inventoryCount() {
      return (module as unknown as { _rpd_inventory_count: () => number })._rpd_inventory_count();
    },
    inventory() {
      const ptr = module._malloc(8 * 4 * 4);
      (module as unknown as { _rpd_inventory: (p: number, cap: number) => number })
        ._rpd_inventory(ptr, 8);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 32).slice();
      module._free(ptr);
      return out;
    },
    setFpsVisible(visible) {
      (module as unknown as { _rpd_set_fps_visible: (v: number) => void })._rpd_set_fps_visible(visible ? 1 : 0);
    },
    planMoveState() {
      const ptr = module._malloc(3 * 4);
      (module as unknown as { _rpd_plan_move_state: (p: number) => number })._rpd_plan_move_state(ptr);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 3).slice();
      module._free(ptr);
      return out;
    },
    planCount() {
      return (module as unknown as { _rpd_plan_count: () => number })._rpd_plan_count();
    },
    planMoving() {
      return (module as unknown as { _rpd_plan_moving: () => number })._rpd_plan_moving();
    },
    planRoom() {
      return utf8((module as unknown as { _rpd_plan_room: () => number })._rpd_plan_room());
    },
    planPlayer() {
      const ptr = module._malloc(3 * 4);
      (module as unknown as { _rpd_plan_player: (p: number) => number })._rpd_plan_player(ptr);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 3).slice();
      module._free(ptr);
      return out;
    },
    planReset() {
      (module as unknown as { _rpd_plan_reset: () => void })._rpd_plan_reset();
    },
    planClearRoute() {
      (module as unknown as { _rpd_plan_clear_route: () => void })._rpd_plan_clear_route();
    },
    openPopupAt(x, z) {
      return (module as unknown as { _rpd_plan_open_popup: (x: number, z: number) => number })
        ._rpd_plan_open_popup(x, z);
    },
    resetView() {
      (module as unknown as { _rpd_reset_view: () => void })._rpd_reset_view();
    },
    recenter() {
      (module as unknown as { _rpd_recenter: () => void })._rpd_recenter();
    },
    cameraModel() {
      const ptr = module._malloc(9 * 4);
      (module as unknown as { _rpd_get_camera_model: (p: number) => number })._rpd_get_camera_model(ptr);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 9).slice();
      module._free(ptr);
      return out;
    },
    debugFloors() {
      const ptr = module._malloc(10 * 4);
      (module as unknown as { _rpd_debug_floors: (p: number) => number })._rpd_debug_floors(ptr);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 10).slice();
      module._free(ptr);
      return out;
    },
    overlayStats() {
      const ptr = module._malloc(6 * 4);
      (module as unknown as { _rpd_overlay_stats: (p: number) => number })._rpd_overlay_stats(ptr);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 6).slice();
      module._free(ptr);
      return out;
    },
    debugBlend() {
      return (module as unknown as { _rpd_debug_blend?: () => number })._rpd_debug_blend?.() ?? -1;
    },
    dispose() {
      module._free(viewProjPtr);
      module._free(cameraPtr);
    },
  };
}
