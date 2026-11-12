export type RpdModule = {
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _rpd_load_scene: (ptr: number, size: number) => number;
  _rpd_get_camera: (ptr: number) => number;
  _rpd_set_orbit: (
    tx: number,
    ty: number,
    tz: number,
    yaw: number,
    pitch: number,
    distance: number,
  ) => number;
  _rpd_animate_orbit: (
    tx: number,
    ty: number,
    tz: number,
    distance: number,
    duration: number,
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
  _rpd_set_player_position: (x: number, y: number, z: number) => void;
  _rpd_plan_route: (ptr: number, cap: number) => number;
  _rpd_popup_state: (ptr: number) => number;
  _rpd_popup_choice: (index: number, ptr: number) => number;
  _rpd_popup_label: (index: number) => number;
  _rpd_popup_message: () => number;
  _rpd_item_count: () => number;
  _rpd_item: (index: number, ptr: number) => number;
  _rpd_item_name: (index: number) => number;
  _rpd_item_room: (index: number) => number;
  _rpd_item_icon: (index: number) => number;
  _rpd_item_action: (index: number) => number;
  _rpd_item_hint: (index: number) => number;
  _rpd_item_act: (index: number) => number;
  _rpd_game_toggle_debug: () => void;
  _rpd_game_debug: () => number;
  _rpd_item_index_for_id: (id: number) => number;
  _rpd_inventory_item: (slot: number) => number;
  _rpd_inventory_count: () => number;
  _rpd_inventory: (ptr: number, cap: number) => number;
  _rpd_plan_active_floor: () => number;
  _rpd_plan_clear_route: () => void;
  _rpd_plan_hover: () => number;
  _rpd_plan_pointer_move: (x: number, y: number) => void;
  _rpd_plan_remove_target: () => number;
  _rpd_plan_node_blocked: (node: number) => number;
  _rpd_plan_set_menu_open: (open: number) => void;
  _rpd_plan_open_popup: (x: number, z: number) => number;
  _rpd_reset_view: () => void;
  _rpd_recenter: () => void;
  _rpd_get_camera_model: (ptr: number) => number;
  _rpd_debug_floors: (ptr: number) => number;
  _rpd_overlay_stats: (ptr: number) => number;
};

declare const createRpdModule: (options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}) => Promise<RpdModule>;

export default createRpdModule;
