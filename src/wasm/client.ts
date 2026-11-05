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
  setMapCamera(
    cx: number,
    cz: number,
    scale: number,
    vw: number,
    vh: number,
    floorY: number,
  ): void;
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
  planStartMove(): void;
  planAddTarget(x: number, y: number, z: number): void;
  planCamera(): Float32Array;
  planRouteCount(): number;
  planMoveState(): Float32Array;
  planCount(): number;
  planMoving(): number;
  planRoom(): string;
  planPlayer(): Float32Array;
  planReset(): void;
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
    setMapCamera(cx, cz, scale, vw, vh, floorY) {
      module._rpd_map_set_camera(cx, cz, scale, vw, vh, floorY);
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
      const ptr = (module as unknown as { _rpd_plan_room: () => number })._rpd_plan_room();
      let end = ptr;
      while (heap.HEAPU8[end]) end += 1;
      return new TextDecoder().decode(heap.HEAPU8.subarray(ptr, end));
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
    debugBlend() {
      return (module as unknown as { _rpd_debug_blend?: () => number })._rpd_debug_blend?.() ?? -1;
    },
    dispose() {
      module._free(viewProjPtr);
      module._free(cameraPtr);
    },
  };
}
