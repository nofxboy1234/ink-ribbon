export type RpdModule = {
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _rpd_load_scene: (ptr: number, size: number) => number;
  _rpd_get_camera: (ptr: number) => number;
  _rpd_set_camera: (
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
  ) => number;
  _rpd_get_view_proj: (ptr: number) => number;
  _rpd_marker_clear: () => void;
  _rpd_marker_add: (
    shape: number,
    x: number,
    y: number,
    z: number,
    size: number,
    r: number,
    g: number,
    b: number,
  ) => number;
  _rpd_marker_set_visible: (index: number, visible: number) => void;
  _rpd_marker_set_position: (
    index: number,
    x: number,
    y: number,
    z: number,
  ) => void;
  _rpd_marker_set_color: (index: number, r: number, g: number, b: number) => void;
  _rpd_marker_set_rotation: (index: number, radians: number) => void;
  _rpd_marker_count: () => number;
  _rpd_set_camera_mode: (mode: number) => number;
  _rpd_get_camera_mode: () => number;
  _rpd_set_player_position: (x: number, y: number, z: number) => void;
};

declare const createRpdModule: (options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}) => Promise<RpdModule>;

export default createRpdModule;
