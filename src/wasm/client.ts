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
    name: string;
    roomName: string;
  } | null;
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
      const ptr = module._malloc(8 * 4);
      (module as unknown as { _rpd_popup_state: (p: number) => number })._rpd_popup_state(ptr);
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 8).slice();
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
    itemCount() {
      return (module as unknown as { _rpd_item_count: () => number })._rpd_item_count();
    },
    item(index) {
      const ptr = module._malloc(10 * 4);
      const ok = (module as unknown as { _rpd_item: (i: number, p: number) => number })
        ._rpd_item(index, ptr);
      if (!ok) {
        module._free(ptr);
        return null;
      }
      const out = new Float32Array(heap.HEAPU8.buffer, ptr, 10).slice();
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
        name: utf8(namePtr),
        roomName: utf8(roomPtr),
      };
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
