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
  setRenderStyle(style: number): void;
  setViewMode(mode: number): void;
  setMapCamera(
    cx: number,
    cz: number,
    scale: number,
    vw: number,
    vh: number,
    floorY: number,
  ): void;
  setMapData(vertices: Float32Array): void;
  dispose(): void;
};

export async function createRpdClient(options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}): Promise<RpdClient> {
  const imported = await import("./rpd.js");
  const factory = (imported.default ?? imported) as unknown as RpdFactory;
  const module = await factory(options);
  const viewProjPtr = module._malloc(16 * 4);
  const cameraPtr = module._malloc(6 * 4);

  return {
    loadScene(data) {
      const ptr = module._malloc(data.byteLength);
      module.HEAPU8.set(data, ptr);
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
    setRenderStyle(style) {
      module._rpd_set_render_style(style);
    },
    setViewMode(mode) {
      module._rpd_set_view_mode(mode);
    },
    setMapCamera(cx, cz, scale, vw, vh, floorY) {
      module._rpd_map_set_camera(cx, cz, scale, vw, vh, floorY);
    },
    setMapData(vertices) {
      if (vertices.length === 0) return;
      const ptr = module._malloc(vertices.byteLength);
      module.HEAPU8.set(
        new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength),
        ptr,
      );
      module._rpd_map_set_data(ptr, vertices.length / 6);
      module._free(ptr);
    },
    dispose() {
      module._free(viewProjPtr);
      module._free(cameraPtr);
    },
  };
}
