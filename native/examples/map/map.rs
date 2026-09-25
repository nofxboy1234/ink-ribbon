use std::ffi;

use ink_ribbon_native::bake::{bake, bake_floor_nav, BakedBytes, OverlayBytes, CELL_PX};
use ink_ribbon_native::save::{format_unix_utc, PlayerSave};
use ink_ribbon_native::scene::{
    BoolOp, Box2, Door, DoorKind, ItemDef, ItemKind, Link, Rect, Region, RegionState, RoomLabel,
    Scene, StairNode, Trigger, WallOp, DOOR_LONG_PX, DOOR_THICK_PX, FLOOR_FRAMES, NUM_FLOORS,
    ROOM_WALL_PX,
};
use ink_ribbon_native::walls::{region_rects, wall_plan, EdgeDir, WallPlan, WallTone};
use sokol::{app as sapp, gfx as sg, gl as sgl, glue as sglue};

const ZOOM_MIN: f32 = 0.7;
const ZOOM_MAX: f32 = 1.6;
const DEFAULT_ZOOM: f32 = 1.15;
const PAN_MARGIN: f32 = 700.0;

// All layout geometry, resolved for the current orientation. Landscape uses a
// 1920x1080 reference; portrait is its transpose (1080x1920).
#[derive(Clone, Copy)]
struct Layout {
    portrait: bool,
    ref_w: f32,
    ref_h: f32,
    map_x: f32,
    map_y: f32,
    map_w: f32,
    map_h: f32,
    floor_x: f32,
    floor_y: f32,
    floor_w: f32,
    floor_h: f32,
    zoom_x: f32,
    zoom_y: f32,
    zoom_w: f32,
    zoom_h: f32,
    panel_w: f32,
    floor_markers: [(f32, f32); 3],
    floor_up: (f32, f32),
    floor_down: (f32, f32),
    zoom_a: (f32, f32),
    zoom_b: (f32, f32),
    zoom_minus: (f32, f32),
    zoom_plus: (f32, f32),
    name_x: f32,
    name_y: f32,
    in_pos: (f32, f32),
    out_pos: (f32, f32),
    show_zoom: bool,
    text_scale: f32,
    stick_center: (f32, f32),
    stick_radius: f32,
    stick_knob: f32,
}

impl Layout {
    fn compute(width: f32, height: f32) -> Layout {
        if width < height {
            // Phone / portrait: no zoom bar (pinch to zoom), arrows flank the
            // diamonds, and text is scaled up for readability.
            let ref_w = 1080.0;
            let ref_h = 1920.0;
            let floor_h = 78.0;
            // No Care Center band in portrait: the floor bar sits at the bottom.
            let name_h = 0.0;
            let map_y = 0.0;
            let map_h = ref_h - floor_h - name_h;
            let floor_y = map_h;
            let marker_y = floor_y + 39.0;
            Layout {
                portrait: true,
                ref_w,
                ref_h,
                map_x: 0.0,
                map_y,
                map_w: ref_w,
                map_h,
                floor_x: 0.0,
                floor_y,
                floor_w: ref_w,
                floor_h,
                zoom_x: 0.0,
                zoom_y: 0.0,
                zoom_w: 0.0,
                zoom_h: 0.0,
                panel_w: 46.0,
                floor_markers: [(180.0, marker_y), (540.0, marker_y), (900.0, marker_y)],
                floor_up: (24.0, marker_y),
                floor_down: (ref_w - 24.0, marker_y),
                zoom_a: (0.0, 0.0),
                zoom_b: (0.0, 0.0),
                zoom_minus: (0.0, 0.0),
                zoom_plus: (0.0, 0.0),
                name_x: ref_w * 0.5,
                name_y: ref_h - 40.0,
                in_pos: (0.0, 0.0),
                out_pos: (0.0, 0.0),
                show_zoom: false,
                text_scale: 3.0,
                // Virtual thumbstick, bottom-left of the map window.
                stick_center: (190.0, map_h - 190.0),
                stick_radius: 150.0,
                stick_knob: 62.0,
            }
        } else {
            let ref_w = 1920.0;
            let ref_h = 1080.0;
            let panel_w = 46.0;
            // Landscape text is 2x the base size, so the name band grows to fit it.
            let text_scale = 1.5;
            let name_h = 52.0 * text_scale;
            let map_x = panel_w;
            let map_y = 0.0;
            let map_w = ref_w - panel_w * 2.0;
            let map_h = ref_h - name_h;
            let mid_y = map_h * 0.5;
            Layout {
                portrait: false,
                ref_w,
                ref_h,
                map_x,
                map_y,
                map_w,
                map_h,
                floor_x: 0.0,
                floor_y: 0.0,
                floor_w: panel_w,
                floor_h: map_h,
                zoom_x: ref_w - panel_w,
                zoom_y: 0.0,
                zoom_w: panel_w,
                zoom_h: map_h,
                panel_w,
                floor_markers: [
                    (panel_w * 0.5, mid_y - 44.0),
                    (panel_w * 0.5, mid_y),
                    (panel_w * 0.5, mid_y + 44.0),
                ],
                floor_up: (panel_w * 0.5, mid_y - 98.0),
                floor_down: (panel_w * 0.5, mid_y + 98.0),
                zoom_a: (ref_w - panel_w * 0.5, 24.0),
                zoom_b: (ref_w - panel_w * 0.5, map_h - 24.0),
                zoom_minus: (ref_w - panel_w * 0.5 - 8.0, map_h - 32.0),
                zoom_plus: (ref_w - panel_w * 0.5 - 8.0, 8.0),
                name_x: ref_w * 0.5,
                name_y: map_h + 14.0 * text_scale,
                in_pos: (ref_w - panel_w * 0.5 + 11.0, 34.0),
                out_pos: (ref_w - panel_w * 0.5 + 6.0, map_h - 56.0),
                show_zoom: true,
                text_scale,
                // Virtual thumbstick, bottom-left of the map window.
                stick_center: (map_x + 160.0, map_h - 160.0),
                stick_radius: 120.0,
                stick_knob: 50.0,
            }
        }
    }

    #[allow(non_snake_case)]
    fn vars(&self) -> (f32, f32, f32, f32, f32, f32, f32) {
        (
            self.map_x,
            self.map_y,
            self.map_w,
            self.map_h,
            self.floor_x,
            self.zoom_x,
            self.panel_w,
        )
    }
}

// Palette sampled from the reference interactive-map capture (near-monochrome).
const C_DIM: (f32, f32, f32) = (0.20, 0.21, 0.21); // #333636 dim chrome
const C_HILITE: (f32, f32, f32) = (0.80, 0.81, 0.80); // #cccfcc highlight
const C_ACCENT: (f32, f32, f32) = (0.78, 0.75, 0.60); // #c7c099 player / route
const C_PLAYER_ARROW: (f32, f32, f32) = (0.655, 0.627, 0.518); // #a7a084 location arrow
const C_LINE: (f32, f32, f32) = (0.55, 0.57, 0.57); // #8c9191 panels, markers
const C_LABEL: (f32, f32, f32) = (0.58, 0.58, 0.55); // #94948c room labels
const C_TITLE: (f32, f32, f32) = (0.72, 0.72, 0.70); // #b8b8b3 title
const C_ITEM: (f32, f32, f32) = (0.54, 0.40, 0.82); // #8a65d1 item markers
const C_ROUTE: (f32, f32, f32) = (0.63, 0.90, 0.67); // #a0e6aa route green
const C_FLOOR_YELLOW: (f32, f32, f32) = (0.55, 0.52, 0.14); // selected floor border
const C_LOCK: (f32, f32, f32) = (0.63, 0.27, 0.34); // #a04457 locked-door red

// A drawn rectangle is a room: a wall band runs inside its edge, so the two
// parallel lines are the band's outer (brighter) and inner (dimmer) edges
// (ref/map_ref.png). The band thickness lives in scene::ROOM_WALL_PX.
const C_WALL_OUTER: (f32, f32, f32) = (79.0 / 255.0, 85.0 / 255.0, 84.0 / 255.0); // #4f5554
const C_WALL_INNER: (f32, f32, f32) = (52.0 / 255.0, 57.0 / 255.0, 61.0 / 255.0); // #34393d
const WALL_LINE_PX: f32 = 7.3;

// Door props (ref/map_ref.png): flat rectangles at a fixed size.
const C_DOOR_UNLOCKED: (f32, f32, f32) = (115.0 / 255.0, 163.0 / 255.0, 182.0 / 255.0); // #73a3b6
const C_DOOR_LOCKED: (f32, f32, f32) = (0.63, 0.27, 0.34); // #a04457
const C_DOOR_UNKNOWN: (f32, f32, f32) = (0.55, 0.55, 0.60);

// Room floors are a uniform dark grey; some rooms get a dot grid or a diamond
// lattice (ref/map_ref.png).
const ROOM_FLOOR: (f32, f32, f32) = (0.090, 0.090, 0.090); // #171717
const ROOM_DOT: (f32, f32, f32) = (0.17, 0.17, 0.17);

const ROOM_LINE: (f32, f32, f32) = (0.13, 0.13, 0.13);
const ROOM_DOT_PX: f32 = 3.0;

fn wall_tone_color(tone: WallTone) -> (f32, f32, f32) {
    match tone {
        WallTone::Outer => C_WALL_OUTER,
        WallTone::Inner | WallTone::Interior => C_WALL_INNER,
    }
}

fn door_color(kind: DoorKind) -> (f32, f32, f32) {
    match kind {
        DoorKind::Unlocked => C_DOOR_UNLOCKED,
        DoorKind::Locked => C_DOOR_LOCKED,
        DoorKind::Unknown => C_DOOR_UNKNOWN,
    }
}

// Near-black background and faint map backing grid.
const BACKGROUND: (f32, f32, f32) = (0.047, 0.047, 0.047); // #0c0c0c
const GRID_RGB: (f32, f32, f32) = (0.10, 0.10, 0.10); // backing grid
                                                      // Backing grid spacing in reference units (screen space).
const GRID_STEP: f32 = 32.0;

// The committed, editable vector scene (native/src/scene.rs). The runtime bakes
// it into the overlay/nav/solid/stairs/items bytes at startup.
const SCENE_BIN: &[u8] = include_bytes!("../../assets/scene.bin");
const ITEM_RADIUS: f32 = 7.0;
const CIRCLE_SEGMENTS: usize = 24;
const CURSOR_RADIUS: f32 = 36.0;
const CURSOR_TICK: f32 = 20.0;
const CURSOR_SEGMENTS: usize = 48;

// Walk into a stair endpoint this close (source px) to take it to the paired floor.
const STAIR_RADIUS: f32 = 34.0;
const FONT_RGBA: &[u8] = include_bytes!("../../assets/font.rgba");
const FONT_BIN: &[u8] = include_bytes!("../../assets/font.bin");
// Player start (Guard Office), click tolerance (source px) and route styling (reference units).
const PLAYER: (f32, f32) = (3840.0, 5008.0);
const CLICK_RADIUS: f32 = 70.0;
// Player movement. The nav grid inflates walls, obstacles and locked doors by
// CLEARANCE_CELLS = 2 (16 source px), so "player centre on a walkable cell" is
// exactly equivalent to a collision disc of that radius. Speed is source px/s.
// These remain for the camera/route helpers and tests.
#[allow(dead_code)]
const PLAYER_SPEED: f32 = 160.0;
const PLAYER_COLLIDE_RADIUS: f32 = 8.0;
// Arrow half-length in background-grid cells; the reference arrow spans ~1.5
// cells, and a constant reference size (like the item dots) keeps it the same
// on screen at any zoom.
const PLAYER_ARROW_HALF: f32 = 0.486;
// Location pulse: a soft white glow expanding from the arrow (grid-cell units,
// measured from the reference video). A hard inner circle with a quick falloff.
const PLAYER_PULSE_PERIOD: f32 = 1.6;
const PLAYER_PULSE_MIN: f32 = 0.15;
const PLAYER_PULSE_MAX: f32 = 0.85;
const PLAYER_PULSE_FALLOFF: f32 = 0.6;
const PLAYER_PULSE_ALPHA: f32 = 0.26;
#[allow(dead_code)]
const PLAYER_ACCEL: f32 = 14.0;
const PLAYER_TURN_RATE: f32 = 10.0;
#[allow(dead_code)]
const MOVE_SUBSTEP: f32 = 4.0;
// Camera follow: how fast the camera catches up to the player's centred pan
// while a movement key is held (lower = lazier trail).
const FOLLOW_CATCHUP: f32 = 4.0;
// Virtual thumbstick: radial deadzone and how far outside the base a touch may
// land and still be captured as the stick.
const STICK_DEADZONE: f32 = 0.15;
const STICK_GRAB: f32 = 1.35;
const PATH_WIDTH: f32 = 5.0;
const GRID_ALPHA: f32 = 0.18;

// Turn-based movement: one move cell per backing grid unit, one turn per click.
// Walk and run budgets are measured in move cells. The reachable region's area
// grows with the square of the budget, so doubling the area scales the radius
// by sqrt(2): 4 -> ~6 walk, 7 -> ~10 run.
const MOVE_CELL: f32 = GRID_UNIT;
const WALK_CELLS: u16 = 6;
const RUN_CELLS: u16 = 10;
// Animation speed in move cells per second (walk vs run).
const WALK_SPEED_CELLS: f32 = 5.0;
const RUN_SPEED_CELLS: f32 = 10.0;
// Reachable-cell highlight (soft blue) and the hover rope preview.
const MOVE_WALK_TINT: (f32, f32, f32) = (0.34, 0.60, 0.92);
const MOVE_RUN_TINT: (f32, f32, f32) = (0.28, 0.46, 0.70);
const MOVE_WALK_ALPHA: f32 = 0.24;
const MOVE_RUN_ALPHA: f32 = 0.13;
const MOVE_CELL_INSET: f32 = 3.0;
const ROPE_ALPHA: f32 = 0.85;
const ROPE_WIDTH: f32 = 7.0;
const ROPE_WALK_TINT: (f32, f32, f32) = (0.62, 0.82, 1.0);
const ROPE_RUN_TINT: (f32, f32, f32) = (0.44, 0.66, 0.95);

#[cfg(target_os = "emscripten")]
extern "C" {
    fn emscripten_run_script(script: *const ffi::c_char);
}

// Let the surrounding web shell react to floor changes. On native there is no
// shell, so this is a no-op.
fn notify_floor(floor: usize) {
    #[cfg(target_os = "emscripten")]
    {
        let script = format!("window.inkRibbonSetFloor && window.inkRibbonSetFloor({floor})");
        if let Ok(script) = ffi::CString::new(script) {
            unsafe { emscripten_run_script(script.as_ptr()) };
        }
    }
    #[cfg(not(target_os = "emscripten"))]
    {
        let _ = floor;
    }
}

// Escape a string for embedding in a JSON string literal.
#[cfg_attr(not(target_os = "emscripten"), allow(dead_code))]
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

// A cheap signature of the goals list + selection, so notify only fires on
// change.
fn goals_signature(state: &State) -> u32 {
    let mut h = 2166136261u32;
    for g in &state.goals {
        let (tag, id) = match g.kind {
            GoalKind::Item(id) => (1u32, id),
            GoalKind::Door(id) => (2, id),
            GoalKind::Trigger(id) => (3, id),
        };
        h = (h ^ tag).wrapping_mul(16777619);
        h = (h ^ id).wrapping_mul(16777619);
        // Names change (renames), so fold the label text in too.
        for b in g.label.bytes() {
            h = (h ^ b as u32).wrapping_mul(16777619);
        }
    }
    h = (h ^ state.goal.map(|i| i as u32 + 1).unwrap_or(0)).wrapping_mul(16777619);
    (h ^ state.route_visible as u32).wrapping_mul(16777619)
}

// Push the turn-based run state (steps/turn/floor, goals) to the web shell. Only
// fires when it changes unless `force` (a fresh run / slot load).
fn notify_state(state: &mut State, force: bool) {
    let now = (state.steps, state.turn, state.floor, goals_signature(state));
    if !force && state.notified_state == Some(now) {
        return;
    }
    state.notified_state = Some(now);
    #[cfg(target_os = "emscripten")]
    {
        let mut goals = String::from("[");
        for (i, g) in state.goals.iter().enumerate() {
            if i > 0 {
                goals.push(',');
            }
            goals.push_str(&format!(
                "{{\"label\":\"{}\",\"floor\":{}}}",
                json_escape(&g.label),
                g.floor
            ));
        }
        goals.push(']');
        let script = format!(
            "window.inkRibbonOnState && window.inkRibbonOnState({{steps:{},turn:{},floor:{},goal:{},routeVisible:{},goals:{}}})",
            now.0,
            now.1,
            now.2,
            state.goal.map(|i| i as i32).unwrap_or(-1),
            state.route_visible,
            goals
        );
        if let Ok(script) = ffi::CString::new(script) {
            unsafe { emscripten_run_script(script.as_ptr()) };
        }
    }
    #[cfg(not(target_os = "emscripten"))]
    {
        let _ = force;
    }
}

// Reset the run's score counters. Triggered by the web shell's NEW RUN button.
#[allow(dead_code)]
fn new_run(state: &mut State) {
    state.turn = 0;
    state.steps = 0;
    state.move_anim = None;
    state.hover_cell = None;
    state.hover_path.clear();
    rebuild_move(state);
    on_progress_changed(state);
    notify_state(state, true);
    set_status(state, "NEW RUN");
}

// Spend a turn without moving (an interaction).
fn end_turn(state: &mut State) {
    state.turn += 1;
    state.hover_cell = None;
    state.hover_path.clear();
    rebuild_move(state);
    notify_state(state, true);
}

// Read and clear command flags set by the web shell.
fn poll_command(state: &mut State) {
    #[cfg(target_os = "emscripten")]
    {
        extern "C" {
            fn emscripten_run_script_int(script: *const ffi::c_char) -> i32;
        }
        const NEW_RUN: &[u8] = b"try { (window.inkRibbonCommand && window.inkRibbonCommand.newRun) ? (window.inkRibbonCommand.newRun=false,1) : 0 } catch (e) { 0 }\0";
        let reset =
            unsafe { emscripten_run_script_int(NEW_RUN.as_ptr() as *const ffi::c_char) != 0 };
        if reset {
            new_run(state);
        }
        // goal selection: -999 = unchanged, negative = clear, else an index.
        const GOAL: &[u8] = b"try { var c=window.inkRibbonCommand; if(!c||typeof c.goal!=='number'||c.goal===-999){-999}else{var g=c.goal;c.goal=-999;g} } catch(e){-999}\0";
        let goal = unsafe { emscripten_run_script_int(GOAL.as_ptr() as *const ffi::c_char) };
        if goal != -999 {
            set_goal(state, (goal >= 0).then_some(goal as usize));
        }
        // route visibility: -1 = unchanged, else 0/1.
        const ROUTE: &[u8] = b"try { var c=window.inkRibbonCommand; if(!c||typeof c.routeVisible!=='boolean'){-1}else{var r=c.routeVisible?1:0;c.routeVisible=null;r} } catch(e){-1}\0";
        let route = unsafe { emscripten_run_script_int(ROUTE.as_ptr() as *const ffi::c_char) };
        if route >= 0 {
            state.route_visible = route != 0;
        }
    }
    #[cfg(not(target_os = "emscripten"))]
    {
        let _ = state;
    }
}

// Walkable grid parsed from the bytes baked by native/src/bake.rs. The
// frame is the floor's source crop the grid was rasterised from.
struct Nav {
    w: i32,
    h: i32,
    frame: (f32, f32, f32, f32),
    bits: Vec<u8>,
}

impl Nav {
    fn from_bytes(bytes: &[u8], frame: (f32, f32, f32, f32)) -> Nav {
        // header: u32 LE cell_px, u32 LE width, u32 LE height
        let w = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as i32;
        let h = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as i32;
        Nav {
            w,
            h,
            frame,
            bits: bytes[12..].to_vec(),
        }
    }

    fn walkable(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return false;
        }
        let i = (y * self.w + x) as usize;
        (self.bits[i >> 3] >> (i & 7)) & 1 == 1
    }
}

// High-resolution collision mask baked by native/src/bake.rs: a set bit is a
// wall, obstacle or locked door (the real traced geometry, with no padding).
// Retained for the region-visibility phase and the collision tests.
#[allow(dead_code)]
struct Solid {
    w: i32,
    h: i32,
    frame: (f32, f32, f32, f32),
    bits: Vec<u8>,
}

#[allow(dead_code)]
impl Solid {
    fn from_bytes(bytes: &[u8], frame: (f32, f32, f32, f32)) -> Solid {
        // header: u32 LE cell_px, u32 LE width, u32 LE height
        let w = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as i32;
        let h = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as i32;
        Solid {
            w,
            h,
            frame,
            bits: bytes[12..].to_vec(),
        }
    }

    fn blocked(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return true;
        }
        let i = (y * self.w + x) as usize;
        (self.bits[i >> 3] >> (i & 7)) & 1 == 1
    }

    fn blocked_source(&self, sx: f32, sy: f32) -> bool {
        let (fx, fy, fw, fh) = self.frame;
        let x = ((sx - fx) / fw * self.w as f32).floor() as i32;
        let y = ((sy - fy) / fh * self.h as f32).floor() as i32;
        self.blocked(x, y)
    }
}

// Coarse turn-based movement grid: one cell per background grid unit
// (MOVE_CELL source px). A cell is walkable when the nav cell at its centre is,
// so the point player stays on the clearance-baked walkable surface.
struct MoveGrid {
    w: i32,
    h: i32,
    frame: (f32, f32, f32, f32),
    bits: Vec<u8>,
}

impl MoveGrid {
    fn from_nav(nav: &Nav) -> MoveGrid {
        let (fx, fy, fw, fh) = nav.frame;
        let w = (fw / MOVE_CELL).round().max(1.0) as i32;
        let h = (fh / MOVE_CELL).round().max(1.0) as i32;
        let per = (MOVE_CELL / CELL_PX as f32).round().max(1.0) as i32;
        let mut bits = vec![0u8; ((w * h) as usize).div_ceil(8)];
        for my in 0..h {
            for mx in 0..w {
                let cx = mx * per + per / 2;
                let cy = my * per + per / 2;
                if nav.walkable(cx, cy) {
                    let i = (my * w + mx) as usize;
                    bits[i >> 3] |= 1 << (i & 7);
                }
            }
        }
        MoveGrid {
            w,
            h,
            frame: (fx, fy, fw, fh),
            bits,
        }
    }

    fn walkable(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return false;
        }
        let i = (y * self.w + x) as usize;
        (self.bits[i >> 3] >> (i & 7)) & 1 == 1
    }

    // Centre of a move cell in source px.
    fn cell_source(&self, x: i32, y: i32) -> (f32, f32) {
        (
            self.frame.0 + (x as f32 + 0.5) * MOVE_CELL,
            self.frame.1 + (y as f32 + 0.5) * MOVE_CELL,
        )
    }

    // Move cell containing a source px point.
    fn source_cell(&self, sx: f32, sy: f32) -> (i32, i32) {
        (
            ((sx - self.frame.0) / MOVE_CELL).floor() as i32,
            ((sy - self.frame.1) / MOVE_CELL).floor() as i32,
        )
    }
}

// BFS distances (in move cells) from `start`, capped at RUN_CELLS. u16::MAX is
// unreachable.
fn move_reach(grid: &MoveGrid, start: (i32, i32)) -> Vec<u16> {
    let n = (grid.w * grid.h) as usize;
    let mut dist = vec![u16::MAX; n];
    if !grid.walkable(start.0, start.1) {
        return dist;
    }
    let index = |x: i32, y: i32| (y * grid.w + x) as usize;
    let si = index(start.0, start.1);
    dist[si] = 0;
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(start);
    while let Some((x, y)) = queue.pop_front() {
        let d = dist[index(x, y)];
        if d >= RUN_CELLS {
            continue;
        }
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if !grid.walkable(nx, ny) {
                continue;
            }
            let i = index(nx, ny);
            if dist[i] == u16::MAX {
                dist[i] = d + 1;
                queue.push_back((nx, ny));
            }
        }
    }
    dist
}

// One baked connection between two stair X marks, in source-composite pixels.
struct Stair {
    a_floor: usize,
    a_pos: (f32, f32),
    b_floor: usize,
    b_pos: (f32, f32),
}

impl Stair {
    fn touches(&self, floor: usize, pos: (f32, f32)) -> bool {
        let here = if floor == self.a_floor {
            self.a_pos
        } else if floor == self.b_floor {
            self.b_pos
        } else {
            return false;
        };
        let (dx, dy) = (pos.0 - here.0, pos.1 - here.1);
        dx * dx + dy * dy <= STAIR_RADIUS * STAIR_RADIUS
    }

    // The floor and X to spawn at when `floor`'s mark is touched.
    fn destination(&self, floor: usize, pos: (f32, f32)) -> Option<(usize, (f32, f32))> {
        if floor == self.a_floor && self.touches(floor, pos) {
            Some((self.b_floor, self.b_pos))
        } else if floor == self.b_floor && self.touches(floor, pos) {
            Some((self.a_floor, self.a_pos))
        } else {
            None
        }
    }
}

fn parse_stairs(bytes: &[u8]) -> Vec<Stair> {
    if bytes.len() < 4 {
        return Vec::new();
    }
    let count = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let mut stairs = Vec::with_capacity(count);
    for i in 0..count {
        let o = 4 + i * 24;
        if o + 24 > bytes.len() {
            break;
        }
        let u32_at =
            |p: usize| u32::from_le_bytes([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]);
        let f32_at =
            |p: usize| f32::from_le_bytes([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]);
        let a_floor = u32_at(o) as usize;
        let b_floor = u32_at(o + 4) as usize;
        if a_floor >= NUM_FLOORS || b_floor >= NUM_FLOORS || a_floor == b_floor {
            continue;
        }
        stairs.push(Stair {
            a_floor,
            a_pos: (f32_at(o + 8), f32_at(o + 12)),
            b_floor,
            b_pos: (f32_at(o + 16), f32_at(o + 20)),
        });
    }
    stairs
}

// A key item baked from an `item_*` layer: display name, floor index and
// source-composite position.
struct Item {
    id: u32,
    kind: ItemKind,
    name: String,
    floor: usize,
    pos: (f32, f32),
}

fn parse_items(bytes: &[u8]) -> Vec<Item> {
    if bytes.len() < 4 {
        return Vec::new();
    }
    let count = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let mut items = Vec::with_capacity(count);
    let mut p = 4;
    for _ in 0..count {
        // record: id(4) floor(4) kind(1) x(4) y(4) name_len(4) + name
        if p + 21 > bytes.len() {
            break;
        }
        let u32_at =
            |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let f32_at =
            |o: usize| f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let id = u32_at(p);
        let floor = u32_at(p + 4) as usize;
        let Some(kind) = ItemKind::from_u8(bytes[p + 8]) else {
            break;
        };
        let pos = (f32_at(p + 9), f32_at(p + 13));
        let name_len = u32_at(p + 17) as usize;
        p += 21;
        if p + name_len > bytes.len() || floor >= NUM_FLOORS {
            break;
        }
        let name = String::from_utf8_lossy(&bytes[p..p + name_len]).into_owned();
        p += name_len;
        items.push(Item {
            id,
            kind,
            name,
            floor,
            pos,
        });
    }
    items
}

// True when the primary pointer is coarse (phones, tablets). The sokol Rust
// bindings expose no touch/pointer capability query, so ask the browser.
#[cfg(target_os = "emscripten")]
fn touch_capable() -> bool {
    extern "C" {
        fn emscripten_run_script_int(script: *const ffi::c_char) -> i32;
    }
    const EXPR: &[u8] =
        b"try { matchMedia('(pointer: coarse)').matches ? 1 : 0 } catch (e) { 0 }\0";
    unsafe { emscripten_run_script_int(EXPR.as_ptr() as *const ffi::c_char) != 0 }
}

#[cfg(not(target_os = "emscripten"))]
fn touch_capable() -> bool {
    false
}

// Texture bitmap font baked by native/prepare-font.py.
struct Font {
    view: sg::View,
    sampler: sg::Sampler,
    atlas_w: f32,
    atlas_h: f32,
    cell_w: f32,
    cell_h: f32,
    first: i32,
    count: i32,
    pad: f32,
    advances: &'static [u8],
}

impl Font {
    fn new() -> Font {
        let h = |i: usize| u16::from_le_bytes([FONT_BIN[i], FONT_BIN[i + 1]]) as f32;
        let atlas_w = h(0);
        let atlas_h = h(2);
        let cell_w = h(4);
        let cell_h = h(6);
        let first = h(10) as i32;
        let count = h(12) as i32;
        let pad = h(14);
        assert_eq!(FONT_RGBA.len(), (atlas_w * atlas_h) as usize * 4);
        let pixels: Vec<u32> = FONT_RGBA
            .as_chunks::<4>()
            .0
            .iter()
            .map(|p| u32::from_ne_bytes(*p))
            .collect();
        let mut data = sg::ImageData::new();
        data.mip_levels[0] = sg::slice_as_range(&pixels);
        let image = sg::make_image(&sg::ImageDesc {
            width: atlas_w as i32,
            height: atlas_h as i32,
            num_slices: 1,
            num_mipmaps: 1,
            data,
            pixel_format: sg::PixelFormat::Rgba8,
            ..Default::default()
        });
        let view = sg::make_view(&sg::ViewDesc {
            texture: sg::TextureViewDesc {
                image,
                ..Default::default()
            },
            ..Default::default()
        });
        let sampler = sg::make_sampler(&sg::SamplerDesc {
            min_filter: sg::Filter::Linear,
            mag_filter: sg::Filter::Linear,
            wrap_u: sg::Wrap::ClampToEdge,
            wrap_v: sg::Wrap::ClampToEdge,
            ..Default::default()
        });
        Font {
            view,
            sampler,
            atlas_w,
            atlas_h,
            cell_w,
            cell_h,
            first,
            count,
            pad,
            advances: &FONT_BIN[16..],
        }
    }

    fn advance(&self, b: u8) -> f32 {
        let i = b as i32 - self.first;
        if i < 0 || i >= self.count {
            return self.cell_w;
        }
        let o = i as usize * 2;
        u16::from_le_bytes([self.advances[o], self.advances[o + 1]]) as f32
    }

    fn text_width(&self, text: &str, size: f32) -> f32 {
        let s = size / self.cell_h;
        text.bytes().map(|b| self.advance(b) * s).sum()
    }

    fn draw(&self, text: &str, x: f32, y: f32, size: f32) {
        let s = size / self.cell_h;
        let cols = (self.atlas_w / self.cell_w) as i32;
        let cw = self.cell_w * s;
        let ch = self.cell_h * s;
        let mut pen = x - self.pad * s;
        for b in text.bytes() {
            let i = b as i32 - self.first;
            if i >= 0 && i < self.count {
                let col = i % cols;
                let row = i / cols;
                let u0 = col as f32 * self.cell_w / self.atlas_w;
                let v0 = row as f32 * self.cell_h / self.atlas_h;
                let u1 = u0 + self.cell_w / self.atlas_w;
                let v1 = v0 + self.cell_h / self.atlas_h;
                sgl::begin_quads();
                sgl::v2f_t2f(pen, y, u0, v0);
                sgl::v2f_t2f(pen + cw, y, u1, v0);
                sgl::v2f_t2f(pen + cw, y + ch, u1, v1);
                sgl::v2f_t2f(pen, y + ch, u0, v1);
                sgl::end();
            }
            pen += self.advance(b) * s;
        }
    }
}

fn draw_text(font: &Font, text: &str, x: f32, y: f32, size: f32, color: (f32, f32, f32)) {
    sgl::c4f(color.0, color.1, color.2, 1.0);
    sgl::enable_texture();
    sgl::texture(font.view, font.sampler);
    font.draw(text, x, y, size);
    sgl::disable_texture();
}

#[derive(Clone, Copy, PartialEq)]
enum CursorMode {
    Free,
    Centered,
}

// Editor tools. Rect tools are click-dragged, point tools are single clicks;
// Select transforms and Connect links objects.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tool {
    Select,
    WallAdd,
    WallSub,
    Wall,
    Obstacle,
    DoorLocked,
    DoorUnlocked,
    DoorUnknown,
    Stair,
    Item,
    Label,
    Region,
    Trigger,
    Erase,
    Connect,
}

impl Tool {
    const ALL: [Tool; 15] = [
        Tool::Select,
        Tool::WallAdd,
        Tool::WallSub,
        Tool::Wall,
        Tool::Obstacle,
        Tool::DoorLocked,
        Tool::DoorUnlocked,
        Tool::DoorUnknown,
        Tool::Stair,
        Tool::Item,
        Tool::Label,
        Tool::Region,
        Tool::Trigger,
        Tool::Erase,
        Tool::Connect,
    ];

    fn label(self) -> &'static str {
        match self {
            Tool::Select => "SELECT",
            Tool::WallAdd => "WALL+",
            Tool::WallSub => "WALL-",
            Tool::Wall => "WALL",
            Tool::Obstacle => "OBST",
            Tool::DoorLocked => "LOCK",
            Tool::DoorUnlocked => "OPEN",
            Tool::DoorUnknown => "UNK",
            Tool::Stair => "STAIR",
            Tool::Item => "ITEM",
            Tool::Label => "NAME",
            Tool::Region => "ROOM",
            Tool::Trigger => "TRIG",
            Tool::Erase => "ERASE",
            Tool::Connect => "LINK",
        }
    }

    fn color(self) -> (f32, f32, f32) {
        match self {
            Tool::Select => (0.90, 0.90, 0.90),
            Tool::WallAdd => (0.55, 0.70, 0.55),
            Tool::WallSub => (0.80, 0.40, 0.40),
            Tool::Wall => (0.45, 0.50, 0.55),
            Tool::Obstacle => (0.62, 0.62, 0.62),
            Tool::DoorLocked => (0.80, 0.35, 0.45),
            Tool::DoorUnlocked => (0.35, 0.70, 0.78),
            Tool::DoorUnknown => (0.62, 0.62, 0.70),
            Tool::Stair => (0.90, 0.80, 0.35),
            Tool::Item => (0.65, 0.45, 0.95),
            Tool::Label => (0.58, 0.58, 0.55),
            Tool::Region => (0.35, 0.55, 0.85),
            Tool::Trigger => (0.95, 0.55, 0.25),
            Tool::Erase => (0.85, 0.30, 0.30),
            Tool::Connect => (0.90, 0.65, 0.90),
        }
    }

    /// One-line usage note for the toolbar tooltip.
    fn help(self) -> &'static str {
        match self {
            Tool::Select => {
                "Click to select. Drag to move; corners scale, top handle rotates. Shift-click adds."
            }
            Tool::WallAdd => "Drag a rectangle to add a room: walkable inside, double-walled. Overlaps merge.",
            Tool::WallSub => "Drag a rectangle to carve a hole out of an existing room.",
            Tool::Wall => "Drag a thin rectangle to add an interior partition: dim wall that blocks.",
            Tool::Obstacle => "Drag a box to place an obstacle that blocks movement.",
            Tool::DoorLocked => "Hover a wall to preview a locked door, then click to place it. LINK a key to open.",
            Tool::DoorUnlocked => "Hover a wall to preview an open door, then click. Open doors are walkable.",
            Tool::DoorUnknown => "Place a door that reads as unknown and reveals as the player approaches.",
            Tool::Stair => "Click to drop a stair endpoint, then LINK two endpoints on different floors.",
            Tool::Item => "Click to drop an item; the popup sets its kind. LINK a key to doors, R renames.",
            Tool::Label => "Click to drop a room name label; drag to move, R renames it.",
            Tool::Region => "Drag a fog region. It owns the geometry inside it (smallest wins); H toggles Hidden/Revealed.",
            Tool::Trigger => "Drag a trigger area: walking into it reveals the region LINKed to it.",
            Tool::Erase => "Click an object to delete it.",
            Tool::Connect => "Click two objects to link them: stair<->stair, key<->door, or door/item/trigger<->region.",
        }
    }

    fn is_rect(self) -> bool {
        matches!(
            self,
            Tool::WallAdd
                | Tool::WallSub
                | Tool::Wall
                | Tool::Obstacle
                | Tool::Region
                | Tool::Trigger
        )
    }

    fn is_door(self) -> bool {
        matches!(
            self,
            Tool::DoorLocked | Tool::DoorUnlocked | Tool::DoorUnknown
        )
    }
}

// What is currently selected in the editor (index into the viewed floor's vecs).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Selection {
    Wall(usize),
    Partition(usize),
    Obstacle(usize),
    Door(usize),
    Stair(usize),
    Item(usize),
    Label(usize),
    Region(usize),
    Trigger(usize),
}

// Geometry snapshot of a selected object, used while dragging handles.
#[derive(Clone, Copy)]
enum SelGeom {
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
    Box {
        center: (f32, f32),
        size: (f32, f32),
        rot: f32,
    },
    Point {
        pos: (f32, f32),
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DragMode {
    None,
    Create,
    Move,
    Scale(usize),
    Rotate,
}

// First endpoint of a link the Connect tool is building.
#[derive(Clone, Copy)]
enum PendingLink {
    Stair(usize, u32),
    Item(usize, u32),
    Door(usize, u32),
    Trigger(usize, u32),
    Region(usize, u32),
}

// A copied editor object, pasted with a fresh id.
#[derive(Clone)]
enum Clip {
    Wall(WallOp),
    Partition(WallOp),
    Obstacle(Box2),
    Door(Door),
    Stair(StairNode),
    Item(ItemDef),
    Label(RoomLabel),
    Region(Region),
    Trigger(Trigger),
}

// Modal overlay state. All menus freeze gameplay while open.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Menu {
    None,
    Pause,
    SaveSlots,
    LoadSlots,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Confirm {
    Overwrite(usize),
    Quit,
}

const SAVE_SLOTS: usize = 8;

#[derive(Clone, Copy)]
struct SlotMeta {
    saved_at: u64,
    play_time: f32,
    floor: usize,
    items: usize,
}

// Reference-space toolbar geometry (x, y, w, h per tool button).
const EDITOR_BAR_Y: f32 = 10.0;
const EDITOR_BAR_H: f32 = 40.0;
const EDITOR_BTN_W: f32 = 88.0;
const EDITOR_BTN_GAP: f32 = 4.0;

fn editor_button_rect(index: usize) -> (f32, f32, f32, f32) {
    (
        10.0 + index as f32 * (EDITOR_BTN_W + EDITOR_BTN_GAP),
        EDITOR_BAR_Y,
        EDITOR_BTN_W,
        EDITOR_BAR_H,
    )
}

fn tool_from_digit(k: sapp::Keycode) -> Option<Tool> {
    use sapp::Keycode::*;
    let index = match k {
        Num1 => 0,
        Num2 => 1,
        Num3 => 2,
        Num4 => 3,
        Num5 => 4,
        Num6 => 5,
        Num7 => 6,
        Num8 => 7,
        Num9 => 8,
        Num0 => 9,
        _ => return None,
    };
    Some(Tool::ALL[index])
}

// Zoom-to-cursor anchor: keeps a map point under the circle cursor and pulls it
// to the map centre as the zoom completes.
#[derive(Clone, Copy)]
struct ZoomAnchor {
    src: (f32, f32),
    cursor_ref: (f32, f32),
    end: f32,
}

// An in-flight turn-based move: source-px polyline (player start, then move-cell
// centres), progress along it, and the cell count to add to the step total.
struct MoveAnim {
    path: Vec<(f32, f32)>,
    seg: usize,
    t: f32,
    speed: f32,
    cells: u32,
}

// A route target surfaced to the web shell's goals list.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum GoalKind {
    Item(u32),
    Door(u32),
    Trigger(u32),
}

#[derive(Clone, PartialEq, Debug)]
struct Goal {
    kind: GoalKind,
    label: String,
    floor: usize,
    pos: (f32, f32),
}

struct State {
    layout: Layout,
    zoom_anchor: Option<ZoomAnchor>,
    pass_action: sg::PassAction,
    pipeline: sgl::Pipeline,
    overlay_views: [sg::View; NUM_FLOORS],
    overlay_sampler: sg::Sampler,
    // CPU-side baked overlay bytes, kept so textures can be (re)created on apply.
    overlay_data: [OverlayBytes; NUM_FLOORS],
    font: Option<Font>,
    nav: [Nav; NUM_FLOORS],
    nav_open: [Nav; NUM_FLOORS],
    solid: [Solid; NUM_FLOORS],
    wall_plans: [WallPlan; NUM_FLOORS],
    wall_plans_dirty: bool,
    stairs: Vec<Stair>,
    items: Vec<Item>,
    astar: Astar,
    // --- Editor ---
    scene: Scene,
    edit: bool,
    tool: Tool,
    snap: bool,
    drag_from: Option<(f32, f32)>,
    drag_to: Option<(f32, f32)>,
    // Snapped door prop under the cursor while a door tool is active.
    door_preview: Option<(f32, f32, f32)>,
    selection: Vec<Selection>,
    drag_mode: DragMode,
    drag_orig: Option<SelGeom>,
    drag_all: Vec<(Selection, SelGeom)>,
    drag_grab: (f32, f32),
    drag_dirty: bool,
    pending_link: Option<PendingLink>,
    clipboard: Vec<Clip>,
    rename: Option<String>,
    undo: Vec<Scene>,
    next_id: u32,
    status: String,
    status_t: f32,
    // --- Player progress, kept out of the authored scene ---
    collected: Vec<u32>,         // item ids picked up
    revealed: Vec<(usize, u32)>, // (floor, door id) that revealed
    unlocked: Vec<(usize, u32)>, // (floor, door id) unlocked with a key
    // Fog of war: regions reached (Visited) and regions revealed by a door,
    // trigger or item.
    visited: Vec<(usize, u32)>,
    revealed_regions: Vec<(usize, u32)>,
    fired_triggers: Vec<(usize, u32)>,
    // Authored scene with progress applied (reveals/unlocks/pickups/regions),
    // cached so drawing and baking agree. In edit mode it is the authored scene.
    play_scene: Scene,
    inventory: Vec<ItemDef>,
    inventory_open: bool,
    inventory_selected: usize,
    // Item box: shared storage shown alongside the inventory.
    item_box: Vec<ItemDef>,
    item_box_open: bool,
    item_box_cursor: usize,
    // Editor: kind used for newly placed items.
    item_kind: ItemKind,
    // Menus, saving and playtime.
    play_time: f32,
    menu: Menu,
    menu_index: usize,
    confirm: Option<Confirm>,
    confirm_index: usize,
    slot_meta: [Option<SlotMeta>; SAVE_SLOTS],
    // Reachable component per floor, computed from where the player is standing.
    reachable: [Vec<u8>; NUM_FLOORS],
    path_red: Vec<(f32, f32)>,
    path: Vec<(f32, f32)>,
    show_grid: bool,
    time: f32,
    zoom_target: f32,
    pan_target_x: f32,
    pan_target_y: f32,
    pending_floor: Option<usize>,
    transition_t: f32,
    // Floor the player actually occupies (may differ from the viewed `floor`).
    player_floor: usize,
    // Destination X to place the player at when a floor transition midpoint hits.
    pending_spawn: Option<(f32, f32)>,
    // Set after a stair ride so the destination X cannot immediately fire back.
    stair_lock: bool,
    cursor: (f32, f32),
    mouse: (f32, f32),
    mouse_in_map: bool,
    cursor_mode: CursorMode,
    os_cursor_hidden: bool,
    touch_last: (f32, f32),
    down_ref: (f32, f32),
    moved: bool,
    pinching: bool,
    pinch_dist: f32,
    pinch_base_zoom: f32,
    pinch_src: (f32, f32),
    player: (f32, f32),
    player_vel: (f32, f32),
    facing: f32,
    facing_target: f32,
    holding: [bool; 4],
    player_cell: Option<(i32, i32)>,
    follow_target: (f32, f32),
    recentre: bool,
    circle_cursor_hidden: bool,
    camera_ready: bool,
    stick_id: Option<usize>,
    stick_vec: (f32, f32),
    touch_capable: bool,
    touch_seen: bool,
    hover_item: Option<usize>,
    arrow_up_t: f32,
    arrow_down_t: f32,
    // --- Goals (routed on the web shell's list) ---
    goals: Vec<Goal>,
    goal: Option<usize>,
    route_visible: bool,
    // --- Turn-based movement ---
    move_grid: [MoveGrid; NUM_FLOORS],
    move_reach: [Vec<u16>; NUM_FLOORS],
    turn: u32,
    steps: u32,
    hover_cell: Option<(i32, i32)>,
    hover_path: Vec<(f32, f32)>,
    hover_run: bool,
    move_anim: Option<MoveAnim>,
    // Last (steps, turn, floor, goals signature) pushed to the web shell.
    notified_state: Option<(u32, u32, usize, u32)>,
    floor: usize,
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
    dragging: bool,
    debug_mode: bool,
    fps: f32,
    fps_elapsed: f32,
    fps_frames: u32,
}

// A floor's traced overlay is blank until it has been drawn in Krita; blank
// floors keep the procedural fallback.
fn overlay_texture(rgba: &[u8], width: i32, height: i32) -> sg::View {
    assert_eq!(rgba.len(), (width * height * 4) as usize);
    let pixels: Vec<u32> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| u32::from_ne_bytes(*p))
        .collect();
    let mut data = sg::ImageData::new();
    data.mip_levels[0] = sg::slice_as_range(&pixels);
    let image = sg::make_image(&sg::ImageDesc {
        width,
        height,
        num_slices: 1,
        num_mipmaps: 1,
        data,
        pixel_format: sg::PixelFormat::Rgba8,
        ..Default::default()
    });
    sg::make_view(&sg::ViewDesc {
        texture: sg::TextureViewDesc {
            image,
            ..Default::default()
        },
        ..Default::default()
    })
}

// Source frame (x, y, width, height) used to lay the current floor's art inside
// the map window.
fn floor_frame(floor: usize) -> (f32, f32, f32, f32) {
    FLOOR_FRAMES[floor]
}

extern "C" fn init(user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    sg::setup(&sg::Desc {
        environment: sglue::environment(),
        logger: sg::Logger {
            func: Some(sokol::log::slog_func),
            ..Default::default()
        },
        ..Default::default()
    });
    sgl::setup(&sgl::Desc {
        // The dotted background grid alone is tens of thousands of vertices, and
        // sgl's error state is sticky once the buffer fills, which silently drops
        // every later draw in the frame (e.g. the HUD on the busiest floor).
        max_vertices: 1 << 19,
        max_commands: 8_192,
        logger: sgl::Logger {
            func: Some(sokol::log::slog_func),
            ..Default::default()
        },
        ..Default::default()
    });
    state.font = Some(Font::new());
    state.overlay_views = std::array::from_fn(|i| {
        let o = &state.overlay_data[i];
        overlay_texture(&o.rgba, o.w, o.h)
    });
    state.overlay_sampler = sg::make_sampler(&sg::SamplerDesc {
        min_filter: sg::Filter::Linear,
        mag_filter: sg::Filter::Linear,
        wrap_u: sg::Wrap::ClampToEdge,
        wrap_v: sg::Wrap::ClampToEdge,
        ..Default::default()
    });

    let mut pipeline = sg::PipelineDesc::default();
    pipeline.depth.write_enabled = false;
    pipeline.colors[0].blend = sg::BlendState {
        enabled: true,
        src_factor_rgb: sg::BlendFactor::SrcAlpha,
        dst_factor_rgb: sg::BlendFactor::OneMinusSrcAlpha,
        op_rgb: sg::BlendOp::Add,
        src_factor_alpha: sg::BlendFactor::One,
        dst_factor_alpha: sg::BlendFactor::OneMinusSrcAlpha,
        op_alpha: sg::BlendOp::Add,
    };
    state.pipeline = sgl::make_pipeline(&pipeline);
    state.pass_action.colors[0] = sg::ColorAttachmentAction {
        load_action: sg::LoadAction::Clear,
        clear_value: sg::Color {
            r: BACKGROUND.0,
            g: BACKGROUND.1,
            b: BACKGROUND.2,
            a: 1.0,
        },
        ..Default::default()
    };
    set_cursor_hidden(true);
    state.os_cursor_hidden = true;
    // The traced Guard Office point can sit on room furniture; start on the
    // nearest walkable cell so the collision disc has room.
    let nav = &state.nav[state.player_floor];
    if let Some(cell) = snap_source(nav, PLAYER.0, PLAYER.1) {
        state.player = cell_to_source(nav, cell.0, cell.1);
        state.player_cell = Some(cell);
    }
    state.reachable[state.player_floor] = match snap_source(nav, state.player.0, state.player.1) {
        Some(start) => reachable_from(nav, start),
        None => Vec::new(),
    };
    rebuild_move(state);
    on_progress_changed(state);
}

// Viewed-floor change (selector, arrows). The player stays where they are; only
// taking stairs moves `player_floor`.
fn change_floor(state: &mut State, floor: usize) {
    if floor < NUM_FLOORS && floor != state.floor && state.pending_floor.is_none() {
        state.pending_floor = Some(floor);
        state.transition_t = 0.0;
        // Selection indices are floor-local, but a pending link stores its own
        // floor, so it survives a floor change (needed to link stairs across
        // floors).
        state.selection.clear();
        state.drag_mode = DragMode::None;
    }
}

fn take_stairs(state: &mut State, to_floor: usize, to_pos: (f32, f32)) {
    // Stair links only ever join different floors.
    if to_floor >= NUM_FLOORS || to_floor == state.player_floor || state.pending_floor.is_some() {
        return;
    }
    state.player_floor = to_floor;
    state.pending_spawn = Some(to_pos);
    state.stair_lock = true;
    state.player_vel = (0.0, 0.0);
    clear_goal_route(state);
    change_floor(state, to_floor);
}

fn floor_slot(floor: usize) -> usize {
    match floor {
        0 => 0,
        1 => 1,
        _ => 2,
    }
}

// Midpoint (in pixels) and separation of the first two active touches.
fn touch_pinch(touches: &[sapp::Touchpoint]) -> ((f32, f32), f32) {
    let (ax, ay) = (touches[0].pos_x, touches[0].pos_y);
    let (bx, by) = (touches[1].pos_x, touches[1].pos_y);
    let mid = ((ax + bx) * 0.5, (ay + by) * 0.5);
    let dist = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
    (mid, dist)
}

fn screen_to_ref(l: &Layout, mx: f32, my: f32) -> (f32, f32) {
    let width = sapp::widthf();
    let height = sapp::heightf();
    let (left, right, top, bottom) = reference_projection(l, width, height);
    (
        left + mx / width.max(1.0) * (right - left),
        top + my / height.max(1.0) * (bottom - top),
    )
}

fn cursor_center(l: &Layout) -> (f32, f32) {
    (l.map_x + l.map_w * 0.5, l.map_y + l.map_h * 0.5)
}

fn active_cursor(state: &State) -> (f32, f32) {
    match state.cursor_mode {
        CursorMode::Centered => cursor_center(&state.layout),
        CursorMode::Free => state.cursor,
    }
}

fn in_map(l: &Layout, p: (f32, f32)) -> bool {
    (l.map_x..l.map_x + l.map_w).contains(&p.0) && (l.map_y..l.map_y + l.map_h).contains(&p.1)
}

fn clamp_to_map(l: &Layout, p: (f32, f32)) -> (f32, f32) {
    (
        p.0.clamp(l.map_x, l.map_x + l.map_w),
        p.1.clamp(l.map_y, l.map_y + l.map_h),
    )
}

fn set_cursor_hidden(hidden: bool) {
    // The pixel buffer must outlive the binding: sokol keeps the range pointer.
    static CURSOR_PIXEL: [u32; 1] = [0];
    if hidden {
        let desc = sapp::ImageDesc {
            width: 1,
            height: 1,
            pixels: sapp::slice_as_range(&CURSOR_PIXEL),
            ..Default::default()
        };
        let cursor = sapp::bind_mouse_cursor_image(sapp::MouseCursor::Custom0, &desc);
        sapp::set_mouse_cursor(cursor);
    } else {
        sapp::set_mouse_cursor(sapp::MouseCursor::Default);
    }
}

fn drag_by(state: &mut State, dx: f32, dy: f32) {
    state.zoom_anchor = None;
    state.recentre = false;
    state.pan_x += dx;
    state.pan_y += dy;
    state.pan_target_x = state.pan_x;
    state.pan_target_y = state.pan_y;
}

// Pan that puts the player at the centre of the map window at the given zoom.
fn player_center_pan(
    l: &Layout,
    zoom: f32,
    player: (f32, f32),
    frame: (f32, f32, f32, f32),
) -> (f32, f32) {
    let (fx, fy, fw, fh) = frame;
    let (iw, ih) = image_size(l, zoom, frame);
    let (cx, cy) = cursor_center(l);
    (
        cx - (player.0 - fx) * iw / fw - l.map_x - (l.map_w - iw) * 0.5,
        cy - (player.1 - fy) * ih / fh - l.map_y - (l.map_h - ih) * 0.5,
    )
}

fn pan_to_center_player(state: &mut State) {
    // Computed for the default zoom so the player ends centred once zoom settles.
    let frame = floor_frame(state.player_floor);
    let (x, y) = player_center_pan(&state.layout, DEFAULT_ZOOM, state.player, frame);
    state.pan_target_x = x;
    state.pan_target_y = y;
}

fn show_stick(state: &State) -> bool {
    state.touch_capable || state.touch_seen
}

// The first active touch that is not the captured thumbstick finger.
fn primary_touch(event: &sapp::Event, stick_id: Option<usize>) -> Option<&sapp::Touchpoint> {
    let n = event.num_touches.clamp(0, event.touches.len() as i32) as usize;
    event.touches[..n]
        .iter()
        .find(|t| Some(t.identifier) != stick_id)
}

// Radial deadzone + clamp for a touch offset from the stick centre. Returns a
// direction scaled by magnitude in [0, 1]; zero inside the deadzone.
fn stick_vector(offset: (f32, f32), radius: f32, deadzone: f32) -> (f32, f32) {
    let len = (offset.0 * offset.0 + offset.1 * offset.1).sqrt();
    let dead = radius * deadzone;
    if radius <= 0.0 || len <= dead {
        return (0.0, 0.0);
    }
    let mag = ((len - dead) / (radius - dead)).min(1.0);
    (offset.0 / len * mag, offset.1 / len * mag)
}

// One frame of camera catch-up toward `target` (the player-centred pan). Only
// applied while a movement key is held; the eased rate is the "trailing" feel.
fn follow_step(target: (f32, f32), follow_target: (f32, f32), delta: f32) -> (f32, f32) {
    let k = (delta * FOLLOW_CATCHUP).min(1.0);
    (
        follow_target.0 + (target.0 - follow_target.0) * k,
        follow_target.1 + (target.1 - follow_target.1) * k,
    )
}

fn recenter_on_player(state: &mut State) {
    // Reset to the default zoom and bring the view to the player's floor.
    state.zoom_anchor = None;
    state.zoom_target = DEFAULT_ZOOM;
    if state.floor == state.player_floor {
        pan_to_center_player(state);
        state.follow_target = (state.pan_target_x, state.pan_target_y);
        state.recentre = false;
    } else {
        // Switching floors first; the camera catches up once we are there.
        change_floor(state, state.player_floor);
        state.recentre = true;
    }
}

// Unit direction for a facing angle (0 rad = up, increasing clockwise on screen).
fn facing_vector(facing: f32) -> (f32, f32) {
    (facing.sin(), -facing.cos())
}

// Interaction priority: lower is better — nearer, and more in front of the
// player. `distance` is passed in so box targets can use their own metric.
fn facing_score(player: (f32, f32), facing: f32, target: (f32, f32), distance: f32) -> f32 {
    let (dx, dy) = (target.0 - player.0, target.1 - player.1);
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-3 {
        return distance;
    }
    let f = facing_vector(facing);
    let align = (f.0 * dx + f.1 * dy) / len;
    distance - FACING_WEIGHT * align
}

fn wrap_angle(a: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    let mut a = a;
    while a > std::f32::consts::PI {
        a -= tau;
    }
    while a < -std::f32::consts::PI {
        a += tau;
    }
    a
}

// The player's collision disc, expressed on the nav grid. The grid already
// inflates walls/obstacles/locked doors by 2 cells (16px), so requiring the
// centre cell to be walkable is equivalent to a 16px disc against the raw art.
// Retained for the collision tests.
#[allow(dead_code)]
fn walkable_center(nav: &Nav, sx: f32, sy: f32) -> bool {
    let (cx, cy) = source_to_cell(nav, sx, sy);
    nav.walkable(cx, cy)
}

// Resolve one movement step axis by axis, so the player slides along a blocked
// surface instead of stopping dead. Returns (position, x blocked, y blocked).
#[allow(dead_code)]
fn resolve_move(
    free: impl Fn(f32, f32) -> bool,
    from: (f32, f32),
    step: (f32, f32),
) -> ((f32, f32), bool, bool) {
    let full = (from.0 + step.0, from.1 + step.1);
    if free(full.0, full.1) {
        return (full, false, false);
    }
    if free(from.0 + step.0, from.1) {
        return ((from.0 + step.0, from.1), false, true);
    }
    if free(from.0, from.1 + step.1) {
        return ((from.0, from.1 + step.1), true, false);
    }
    (from, true, true)
}

#[allow(dead_code)]
fn resolve_move_terrain(
    nav: &Nav,
    solid: &Solid,
    from: (f32, f32),
    step: (f32, f32),
) -> ((f32, f32), bool, bool) {
    resolve_move(|x, y| can_stand(nav, solid, x, y), from, step)
}

// Player collision: a disc of PLAYER_COLLIDE_RADIUS against the real wall,
// obstacle and locked-door ink, except that anywhere the nav grid is walkable is
// always allowed. That keeps every A* route followable while still stopping the
// player at the drawn geometry.
#[allow(dead_code)]
fn can_stand(nav: &Nav, solid: &Solid, sx: f32, sy: f32) -> bool {
    if walkable_center(nav, sx, sy) {
        return true;
    }
    if solid.blocked_source(sx, sy) {
        return false;
    }
    const SAMPLES: usize = 8;
    for i in 0..SAMPLES {
        let a = i as f32 / SAMPLES as f32 * std::f32::consts::TAU;
        let (px, py) = (
            sx + a.cos() * PLAYER_COLLIDE_RADIUS,
            sy + a.sin() * PLAYER_COLLIDE_RADIUS,
        );
        if solid.blocked_source(px, py) {
            return false;
        }
    }
    true
}

// Turn-based player update: advance any in-flight move, ease the facing toward
// the travel direction, then resolve door reveals and stairs. Walking is driven
// by a click (`select_at`/`start_move`), not by the arrow keys.
fn update_player(state: &mut State, delta: f32) {
    // The player only exists on their own floor; viewing another floor is
    // read-only until they take stairs back. Editing pauses the player.
    if state.edit || state.floor != state.player_floor {
        return;
    }
    update_move(state, delta);
    let turn = wrap_angle(state.facing_target - state.facing);
    state.facing += turn * (delta * PLAYER_TURN_RATE).min(1.0);
    state.player_vel = (0.0, 0.0);
    // Reveals/stairs resolve once the move has settled, so a turn never gets
    // interrupted mid-animation.
    if state.move_anim.is_none() {
        // Standing in a revealed region marks it visited (shading only).
        mark_region_visited(state);
        // A trigger or a nearby unknown door can reveal a region, which changes
        // the drawn/baked geometry on the revealed floors.
        let mut region_floors = reveal_regions_at_player(state);
        let (doors_changed, door_floors) = reveal_doors(state);
        for f in door_floors {
            if !region_floors.contains(&f) {
                region_floors.push(f);
            }
        }
        if !region_floors.is_empty() {
            region_floors.push(state.player_floor);
            region_floors.sort_unstable();
            region_floors.dedup();
            rebuild_progress(state, &region_floors);
        } else if doors_changed {
            rebuild_gameplay(state);
        }
        check_stairs(state);
    }
}

// Advance an in-flight move one frame. On arrival, bank the step count, spend
// the turn and refresh what is reachable.
fn update_move(state: &mut State, delta: f32) {
    let Some(mut anim) = state.move_anim.take() else {
        return;
    };
    let mut advance = anim.speed * MOVE_CELL * delta;
    while advance > 0.0 && anim.seg + 1 < anim.path.len() {
        let a = anim.path[anim.seg];
        let b = anim.path[anim.seg + 1];
        let seg_len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt().max(1e-3);
        let remain = (1.0 - anim.t) * seg_len;
        if advance >= remain {
            advance -= remain;
            anim.seg += 1;
            anim.t = 0.0;
            state.player = b;
        } else {
            anim.t += advance / seg_len;
            advance = 0.0;
            state.player = (a.0 + (b.0 - a.0) * anim.t, a.1 + (b.1 - a.1) * anim.t);
        }
    }
    if anim.seg + 1 < anim.path.len() {
        let a = anim.path[anim.seg];
        let b = anim.path[anim.seg + 1];
        state.facing_target = (b.0 - a.0).atan2(-(b.1 - a.1));
        state.move_anim = Some(anim);
    } else {
        state.steps += anim.cells;
        state.turn += 1;
        let pf = state.player_floor;
        state.player_cell = Some(state.move_grid[pf].source_cell(state.player.0, state.player.1));
        rebuild_move(state);
        on_progress_changed(state);
        notify_state(state, true);
    }
}

// Spend a turn moving to `goal` (a move cell) when it is inside the run budget.
fn start_move(state: &mut State, mut goal: (i32, i32)) {
    if state.edit || state.move_anim.is_some() || state.floor != state.player_floor {
        return;
    }
    let pf = state.player_floor;
    let start = state.move_grid[pf].source_cell(state.player.0, state.player.1);
    // Clicking the player's own cell does nothing.
    if goal == start {
        return;
    }
    let mut dist = move_cell_dist(state, pf, goal);
    // A click on a wall, or just past the budget, snaps to the nearest reachable
    // cell so taps near the arrow or the range edge still register.
    if dist == u16::MAX || dist > RUN_CELLS {
        match nearest_reachable_cell(state, pf, goal) {
            Some(near) => {
                goal = near;
                dist = move_cell_dist(state, pf, goal);
            }
            None => return,
        }
    }
    if dist == 0 || dist > RUN_CELLS {
        return;
    }
    let grid = &state.move_grid[pf];
    if !grid.walkable(goal.0, goal.1) {
        return;
    }
    if start == goal {
        return;
    }
    let (cells, path) = {
        let cells = match state
            .astar
            .search_grid(grid.w, grid.h, start, goal, |x, y| grid.walkable(x, y))
        {
            Some(c) if c.len() >= 2 => c,
            _ => return,
        };
        let mut path = Vec::with_capacity(cells.len());
        path.push(state.player);
        for &(x, y) in cells.iter().skip(1) {
            path.push(grid.cell_source(x, y));
        }
        (cells, path)
    };
    let run = dist > WALK_CELLS;
    state.move_anim = Some(MoveAnim {
        path,
        seg: 0,
        t: 0.0,
        speed: if run {
            RUN_SPEED_CELLS
        } else {
            WALK_SPEED_CELLS
        },
        cells: (cells.len() - 1) as u32,
    });
    // Highlights and any hover rope clear while the move plays out.
    state.move_reach[pf].fill(u16::MAX);
    state.hover_cell = None;
    state.hover_path.clear();
}

// Distance in move cells from the player, or u16::MAX when outside the grid.
fn move_cell_dist(state: &State, floor: usize, cell: (i32, i32)) -> u16 {
    let grid = &state.move_grid[floor];
    if cell.0 < 0 || cell.1 < 0 || cell.0 >= grid.w || cell.1 >= grid.h {
        return u16::MAX;
    }
    let reach = &state.move_reach[floor];
    let i = (cell.1 * grid.w + cell.0) as usize;
    if i >= reach.len() {
        return u16::MAX;
    }
    reach[i]
}

// Nearest reachable move cell to `cell`, searched outward in a ring.
fn nearest_reachable_cell(state: &State, floor: usize, cell: (i32, i32)) -> Option<(i32, i32)> {
    for radius in 1..=6i32 {
        let mut best: Option<((i32, i32), u16)> = None;
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx.abs() != radius && dy.abs() != radius {
                    continue;
                }
                let c = (cell.0 + dx, cell.1 + dy);
                let d = move_cell_dist(state, floor, c);
                if d != u16::MAX && d > 0 && d <= RUN_CELLS {
                    let better = best.is_none_or(|(_, bd)| d < bd);
                    if better {
                        best = Some((c, d));
                    }
                }
            }
        }
        if let Some((c, _)) = best {
            return Some(c);
        }
    }
    None
}

// Ride a stair if the player is standing on one, with a lock so landing on the
// destination X does not immediately fire the return trip.
fn check_stairs(state: &mut State) {
    let floor = state.player_floor;
    if state.stair_lock {
        if state.stairs.iter().any(|s| s.touches(floor, state.player)) {
            return;
        }
        state.stair_lock = false;
    }
    let dest = state
        .stairs
        .iter()
        .find_map(|s| s.destination(floor, state.player));
    if let Some((to_floor, to_pos)) = dest {
        take_stairs(state, to_floor, to_pos);
    }
}

fn hover_item_at(state: &State, cx: f32, cy: f32) -> Option<usize> {
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    if cx < MAP_X || cx > MAP_X + MAP_W || cy < MAP_Y || cy > MAP_Y + MAP_H {
        return None;
    }
    let frame = floor_frame(state.floor);
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);
    let sx = frame.0 + (cx - ox) * frame.2 / iw;
    let sy = frame.1 + (cy - oy) * frame.3 / ih;
    state.items.iter().position(|item| {
        if item.floor != state.floor {
            return false;
        }
        let (dx, dy) = (sx - item.pos.0, sy - item.pos.1);
        dx * dx + dy * dy <= CLICK_RADIUS * CLICK_RADIUS
    })
}
// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

fn set_status(state: &mut State, msg: impl Into<String>) {
    state.status = msg.into();
    state.status_t = 3.0;
}

fn push_undo(state: &mut State) {
    state.undo.push(state.scene.clone());
    if state.undo.len() > 64 {
        state.undo.remove(0);
    }
}

fn set_edit(state: &mut State, on: bool) {
    state.edit = on;
    let hide = if on {
        false
    } else {
        state.cursor_mode == CursorMode::Free
    };
    if hide != state.os_cursor_hidden {
        set_cursor_hidden(hide);
        state.os_cursor_hidden = hide;
    }
    state.dragging = false;
    state.drag_from = None;
    state.drag_to = None;
    state.recentre = false;
    // Editing bakes the authored scene; playing bakes the progress overrides.
    rebuild_assets(state);
    set_status(state, if on { "EDIT MODE" } else { "PLAY MODE" });
}

// Reference coords -> source-composite pixels on the viewed floor.
fn ref_to_source(state: &State, p: (f32, f32)) -> (f32, f32) {
    let frame = floor_frame(state.floor);
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);
    (
        frame.0 + (p.0 - ox) * frame.2 / iw,
        frame.1 + (p.1 - oy) * frame.3 / ih,
    )
}

fn snap_point(state: &State, p: (f32, f32)) -> (f32, f32) {
    if !state.snap {
        return p;
    }
    const GRID: f32 = 16.0;
    ((p.0 / GRID).round() * GRID, (p.1 / GRID).round() * GRID)
}

fn max_id(scene: &Scene) -> u32 {
    let mut max = 0;
    for floor in &scene.floors {
        for o in &floor.obstacles {
            max = max.max(o.id);
        }
        for d in &floor.doors {
            max = max.max(d.id);
        }
        for s in &floor.stairs {
            max = max.max(s.id);
        }
        for it in &floor.items {
            max = max.max(it.id);
        }
    }
    max
}

// One "grid" for gameplay ranges: the 32px background grid.
const GRID_UNIT: f32 = 32.0;
// Every interaction and prompt (and the unknown-door reveal) appears within
// 3 background grid units of the player centre.
const INTERACT_RADIUS: f32 = GRID_UNIT * 3.0;
// How much facing toward a target improves its score (source px of distance).
const FACING_WEIGHT: f32 = 20.0;

fn is_collected(state: &State, id: u32) -> bool {
    state.collected.contains(&id)
}

fn is_revealed(state: &State, floor: usize, id: u32) -> bool {
    state.revealed.contains(&(floor, id))
}

fn is_unlocked(state: &State, floor: usize, id: u32) -> bool {
    state.unlocked.contains(&(floor, id))
}

// The door kind after applying player-progress overrides.
fn effective_door_kind(state: &State, floor: usize, id: u32) -> Option<DoorKind> {
    let door = state.scene.floors[floor]
        .doors
        .iter()
        .find(|d| d.id == id)?;
    Some(if is_unlocked(state, floor, id) {
        DoorKind::Unlocked
    } else if is_revealed(state, floor, id) {
        door.reveals_as
    } else {
        door.kind
    })
}

// A clone of the authored scene with reveals/unlocks/pickups and fog-of-war
// applied. Baking this keeps gameplay progress out of the saved scene.
fn effective_scene(state: &State) -> Scene {
    let mut scene = apply_regions(&state.scene, &state.visited, &state.revealed_regions);
    for (fi, floor) in scene.floors.iter_mut().enumerate() {
        for d in floor.doors.iter_mut() {
            if is_unlocked(state, fi, d.id) {
                d.kind = DoorKind::Unlocked;
            } else if is_revealed(state, fi, d.id) {
                d.kind = d.reveals_as;
            }
        }
        floor.items.retain(|it| !is_collected(state, it.id));
    }
    scene
}

// Drop the geometry and regions owned by Hidden regions. Ownership follows the
// authoring rule: the smallest region containing a point owns it. Pure so it can
// be tested without a running State.
fn apply_regions(scene: &Scene, visited: &[(usize, u32)], revealed: &[(usize, u32)]) -> Scene {
    let mut out = scene.clone();
    for (fi, floor) in out.floors.iter_mut().enumerate() {
        let owner = |p: (f32, f32)| -> Option<RegionState> {
            scene.floors[fi]
                .regions
                .iter()
                .filter(|r| rect_contains(r.rect, p))
                .min_by(|a, b| {
                    rect_area(a.rect)
                        .partial_cmp(&rect_area(b.rect))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|r| region_state_raw(fi, r, visited, revealed))
        };
        let is_hidden = |p: (f32, f32)| owner(p) == Some(RegionState::Hidden);
        floor.walls.retain(|w| !is_hidden(rect_center(w.rect)));
        floor.partitions.retain(|w| !is_hidden(rect_center(w.rect)));
        floor.obstacles.retain(|o| !is_hidden(o.center));
        floor.doors.retain(|d| !is_hidden(d.center));
        floor.stairs.retain(|s| !is_hidden(s.pos));
        floor.items.retain(|it| !is_hidden(it.pos));
        floor.labels.retain(|l| !is_hidden(l.pos));
        floor.regions.retain(|r| !is_hidden(rect_center(r.rect)));
        floor.triggers.retain(|t| !is_hidden(rect_center(t.rect)));
    }
    out
}

// Refresh the cached progress-applied scene used for drawing and baking.
fn recompute_play_scene(state: &mut State) {
    let scene = if state.edit {
        state.scene.clone()
    } else {
        effective_scene(state)
    };
    state.play_scene = scene;
}

// The scene to draw from: the authored scene while editing (so edits show
// immediately), else the progress-applied scene.
fn view_scene(state: &State) -> &Scene {
    if state.edit {
        &state.scene
    } else {
        &state.play_scene
    }
}

fn rect_contains(r: Rect, p: (f32, f32)) -> bool {
    p.0 >= r.x && p.0 <= r.x + r.w && p.1 >= r.y && p.1 <= r.y + r.h
}

fn rect_inside(inner: Rect, outer: Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.w <= outer.x + outer.w
        && inner.y + inner.h <= outer.y + outer.h
}

fn rect_center(r: Rect) -> (f32, f32) {
    (r.x + r.w * 0.5, r.y + r.h * 0.5)
}

fn rect_area(r: Rect) -> f32 {
    r.w * r.h
}

fn region_state_raw(
    floor: usize,
    region: &Region,
    visited: &[(usize, u32)],
    revealed: &[(usize, u32)],
) -> RegionState {
    if visited.contains(&(floor, region.id)) {
        RegionState::Visited
    } else if region.initial != RegionState::Hidden || revealed.contains(&(floor, region.id)) {
        RegionState::Revealed
    } else {
        RegionState::Hidden
    }
}

// The runtime visibility of an authored region. `Visited` wins; an authored
// `Revealed` or a reveal link shows it; everything else is Hidden.
fn region_state(state: &State, floor: usize, region: &Region) -> RegionState {
    region_state_raw(floor, region, &state.visited, &state.revealed_regions)
}

// The smallest region containing `p` (authoring rule: region rects cover a room
// and its walls, so a room's centre picks its region).
#[allow(dead_code)]
fn region_at(state: &State, floor: usize, p: (f32, f32)) -> Option<&Region> {
    state.scene.floors[floor]
        .regions
        .iter()
        .filter(|r| rect_contains(r.rect, p))
        .min_by(|a, b| {
            rect_area(a.rect)
                .partial_cmp(&rect_area(b.rect))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn link_region(link: &Link) -> Option<(usize, u32)> {
    match *link {
        Link::DoorRegion {
            region_floor,
            region_id,
            ..
        }
        | Link::TriggerRegion {
            region_floor,
            region_id,
            ..
        }
        | Link::ItemRegion {
            region_floor,
            region_id,
            ..
        } => Some((region_floor as usize, region_id)),
        _ => None,
    }
}

// Reveal every region linked by a link matching `pred`. Returns the floors of
// any newly revealed regions (empty when nothing changed).
fn reveal_regions_linked_to(state: &mut State, pred: impl Fn(&Link) -> bool) -> Vec<usize> {
    let mut found: Vec<(usize, u32)> = Vec::new();
    for floor in &state.scene.floors {
        for link in &floor.links {
            if !pred(link) {
                continue;
            }
            if let Some(key) = link_region(link) {
                if !state.revealed_regions.contains(&key) && !found.contains(&key) {
                    found.push(key);
                }
            }
        }
    }
    let mut floors: Vec<usize> = found.iter().map(|(f, _)| *f).collect();
    floors.sort_unstable();
    floors.dedup();
    state.revealed_regions.extend(found);
    floors
}

// Fire any trigger the player is standing in and reveal its regions. Returns the
// floors of newly revealed regions.
fn reveal_regions_at_player(state: &mut State) -> Vec<usize> {
    let floor = state.player_floor;
    let fired: Vec<u32> = state.scene.floors[floor]
        .triggers
        .iter()
        .filter(|t| !state.fired_triggers.contains(&(floor, t.id)))
        .filter(|t| rect_contains(t.rect, state.player))
        .map(|t| t.id)
        .collect();
    let mut floors: Vec<usize> = Vec::new();
    for id in fired {
        state.fired_triggers.push((floor, id));
        for f in reveal_regions_linked_to(state, |l| {
            matches!(l, Link::TriggerRegion { trigger_floor, trigger_id, .. }
                if *trigger_floor as usize == floor && *trigger_id == id)
        }) {
            if !floors.contains(&f) {
                floors.push(f);
            }
        }
    }
    if !floors.is_empty() {
        set_status(state, "a new area appears on the map");
    }
    floors
}

// Mark the (revealed) region the player is standing in as Visited.
fn mark_region_visited(state: &mut State) -> bool {
    let floor = state.player_floor;
    let found = state.scene.floors[floor]
        .regions
        .iter()
        .filter(|r| rect_contains(r.rect, state.player))
        .filter(|r| region_state(state, floor, r) != RegionState::Hidden)
        .min_by(|a, b| {
            rect_area(a.rect)
                .partial_cmp(&rect_area(b.rect))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|r| (r.id, r.name.clone()));
    if let Some((id, name)) = found {
        if !state.visited.contains(&(floor, id)) {
            state.visited.push((floor, id));
            set_status(state, format!("entered {name}"));
            return true;
        }
    }
    false
}

// --- Goals -----------------------------------------------------------------

// Rebuild the goals list for the player's floor: collectibles, doors they can
// unlock, and unexplored reveal triggers.
fn recompute_goals(state: &mut State) {
    let floor = state.player_floor;
    // Keep the selection across a rebuild by identity; drop it when completed.
    let selected = state.goal.and_then(|i| state.goals.get(i)).map(|g| g.kind);
    let mut goals = Vec::new();
    for it in &state.play_scene.floors[floor].items {
        if it.kind.is_collectible() && !is_collected(state, it.id) {
            goals.push(Goal {
                kind: GoalKind::Item(it.id),
                label: format!("Pick up {}", it.name),
                floor,
                pos: it.pos,
            });
        }
    }
    for d in &state.play_scene.floors[floor].doors {
        if d.kind == DoorKind::Locked && door_has_inventory_key(state, floor, d.id) {
            goals.push(Goal {
                kind: GoalKind::Door(d.id),
                label: "Unlock door".to_string(),
                floor,
                pos: d.center,
            });
        }
    }
    // Unexplored areas: a trigger linked to a region that is still Hidden.
    let triggers: Vec<Trigger> = state.scene.floors[floor].triggers.clone();
    for t in triggers {
        if state.fired_triggers.contains(&(floor, t.id)) {
            continue;
        }
        for link in &state.scene.floors[floor].links {
            let Link::TriggerRegion {
                trigger_floor,
                trigger_id,
                region_floor,
                region_id,
            } = *link
            else {
                continue;
            };
            if trigger_floor as usize != floor || trigger_id != t.id {
                continue;
            }
            let rf = region_floor as usize;
            let region = state.scene.floors[rf]
                .regions
                .iter()
                .find(|r| r.id == region_id);
            let hidden = region.is_some_and(|r| {
                region_state_raw(rf, r, &state.visited, &state.revealed_regions)
                    == RegionState::Hidden
            });
            if hidden {
                let name = region.map(|r| r.name.clone()).unwrap_or_default();
                let label = if name.is_empty() {
                    "Explore an area".to_string()
                } else {
                    format!("Explore {name}")
                };
                goals.push(Goal {
                    kind: GoalKind::Trigger(t.id),
                    label,
                    floor,
                    pos: rect_center(t.rect),
                });
            }
        }
    }
    state.goals = goals;
    state.goal = selected.and_then(|k| state.goals.iter().position(|g| g.kind == k));
}

// Select (or clear) a goal and recompute its route.
#[cfg_attr(not(target_os = "emscripten"), allow(dead_code))]
fn set_goal(state: &mut State, goal: Option<usize>) {
    state.goal = match goal {
        Some(i) if i < state.goals.len() => Some(i),
        _ => None,
    };
    refresh_goal_route(state);
}

fn clear_goal_route(state: &mut State) {
    state.goal = None;
    state.path.clear();
    state.path_red.clear();
}

// Shortest route to the selected goal: green up to the reachable component,
// red past a blocker (a locked door or an unrevealed area).
fn refresh_goal_route(state: &mut State) {
    state.path.clear();
    state.path_red.clear();
    let Some(goal) = state.goal.and_then(|i| state.goals.get(i)).cloned() else {
        return;
    };
    let floor = state.player_floor;
    if goal.floor != floor || state.floor != floor {
        return;
    }
    if let Some(start) = snap_source(&state.nav[floor], state.player.0, state.player.1) {
        ensure_reachable(state, floor, start);
    }
    let (green, red) = route_to(
        &mut state.astar,
        &state.nav[floor],
        &state.nav_open[floor],
        &state.reachable[floor],
        state.player,
        goal.pos,
    );
    state.path = green;
    state.path_red = red;
}

// Progress or a move changed what is available: refresh goals and the route.
fn on_progress_changed(state: &mut State) {
    recompute_goals(state);
    refresh_goal_route(state);
}

// True when any collected key is linked to this door.
fn door_has_inventory_key(state: &State, floor: usize, door_id: u32) -> bool {
    state
        .scene
        .floors
        .iter()
        .flat_map(|f| f.links.iter())
        .any(|l| {
            matches!(l, Link::KeyDoor { item_id, door_floor, door_id: did, .. }
                if *door_floor as usize == floor
                    && *did == door_id
                    && state.inventory.iter().any(|it| it.id == *item_id))
        })
}

// Drop a key once every door it is linked to is Unlocked (keys with no links
// are kept).
fn prune_satisfied_keys(state: &mut State) {
    let mut remove: Vec<u32> = Vec::new();
    for item in &state.inventory {
        let mut linked = 0;
        let mut all_unlocked = true;
        for floor in 0..NUM_FLOORS {
            for l in &state.scene.floors[floor].links {
                if let Link::KeyDoor {
                    item_id,
                    door_floor,
                    door_id,
                    ..
                } = *l
                {
                    if item_id != item.id {
                        continue;
                    }
                    linked += 1;
                    if effective_door_kind(state, door_floor as usize, door_id)
                        != Some(DoorKind::Unlocked)
                    {
                        all_unlocked = false;
                    }
                }
            }
        }
        if linked > 0 && all_unlocked {
            remove.push(item.id);
        }
    }
    state.inventory.retain(|it| !remove.contains(&it.id));
    // Selection can rest on any slot (including empty ones), so only keep it in
    // range of the grid.
    if state.inventory_selected >= INV_COLS * INV_ROWS {
        state.inventory_selected = INV_COLS * INV_ROWS - 1;
    }
}

// Reveal Unknown doors the player is standing near, plus any regions they lead
// to. Returns `(door_changed, region_changed)` so the caller can pick the
// cheapest re-bake.
fn reveal_doors(state: &mut State) -> (bool, Vec<usize>) {
    let floor = state.player_floor;
    let pending: Vec<u32> = state.scene.floors[floor]
        .doors
        .iter()
        .filter(|d| d.kind == DoorKind::Unknown && !is_revealed(state, floor, d.id))
        .filter(|d| {
            dist_to_box(state.player, d.center, (DOOR_LONG_PX, DOOR_THICK_PX), d.rot)
                <= INTERACT_RADIUS
        })
        .map(|d| d.id)
        .collect();
    let door_changed = !pending.is_empty();
    let mut region_floors: Vec<usize> = Vec::new();
    for id in pending {
        state.revealed.push((floor, id));
        for f in reveal_regions_linked_to(state, |l| {
            matches!(l, Link::DoorRegion { door_floor, door_id, .. }
                if *door_floor as usize == floor && *door_id == id)
        }) {
            if !region_floors.contains(&f) {
                region_floors.push(f);
            }
        }
    }
    if door_changed {
        // A reveal to Unlocked can complete a key's doors.
        prune_satisfied_keys(state);
        set_status(state, "a door came into view");
    }
    (door_changed, region_floors)
}

fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

// Something the player can act on with Space when standing near it.
enum Interaction {
    Typewriter((f32, f32)),
    ItemBox((f32, f32)),
    Item {
        id: u32,
        name: String,
        pos: (f32, f32),
    },
    Door {
        id: u32,
        pos: (f32, f32),
    },
}

impl Interaction {
    fn pos(&self) -> (f32, f32) {
        match self {
            Interaction::Typewriter(p) => *p,
            Interaction::ItemBox(p) => *p,
            Interaction::Item { pos, .. } => *pos,
            Interaction::Door { pos, .. } => *pos,
        }
    }

    fn label(&self) -> String {
        match self {
            Interaction::Typewriter(_) => "SPACE: save".to_string(),
            Interaction::ItemBox(_) => "SPACE: item box".to_string(),
            Interaction::Item { name, .. } => format!("SPACE: pick up {name}"),
            Interaction::Door { .. } => "SPACE: unlock".to_string(),
        }
    }
}

// The interactable the player is most facing and closest to, within range.
// Exact ties prefer typewriter > item > door.
fn interaction_target(state: &State) -> Option<Interaction> {
    let floor = state.player_floor;
    let mut best: Option<(f32, u8, Interaction)> = None;
    let mut consider = |distance: f32, score: f32, rank: u8, inter: Interaction| {
        if distance <= INTERACT_RADIUS
            && best
                .as_ref()
                .is_none_or(|(bs, br, _)| (score, rank) < (*bs, *br))
        {
            best = Some((score, rank, inter));
        }
    };
    for it in &state.play_scene.floors[floor].items {
        match it.kind {
            ItemKind::Typewriter => {
                let d = dist(state.player, it.pos);
                consider(
                    d,
                    facing_score(state.player, state.facing, it.pos, d),
                    0,
                    Interaction::Typewriter(it.pos),
                );
            }
            ItemKind::ItemBox => {
                let d = dist(state.player, it.pos);
                consider(
                    d,
                    facing_score(state.player, state.facing, it.pos, d),
                    0,
                    Interaction::ItemBox(it.pos),
                );
            }
            k if k.is_collectible() && !is_collected(state, it.id) => {
                let d = dist(state.player, it.pos);
                consider(
                    d,
                    facing_score(state.player, state.facing, it.pos, d),
                    1,
                    Interaction::Item {
                        id: it.id,
                        name: it.name.clone(),
                        pos: it.pos,
                    },
                );
            }
            _ => {}
        }
    }
    for door in &state.play_scene.floors[floor].doors {
        if effective_door_kind(state, floor, door.id) == Some(DoorKind::Locked)
            && door_has_inventory_key(state, floor, door.id)
        {
            let d = dist_to_box(
                state.player,
                door.center,
                (DOOR_LONG_PX, DOOR_THICK_PX),
                door.rot,
            );
            consider(
                d,
                facing_score(state.player, state.facing, door.center, d),
                2,
                Interaction::Door {
                    id: door.id,
                    pos: door.center,
                },
            );
        }
    }
    best.map(|(_, _, inter)| inter)
}

fn collect_item(state: &mut State, id: u32, name: &str) {
    let floor = state.player_floor;
    let Some(item) = state.scene.floors[floor]
        .items
        .iter()
        .find(|it| it.id == id)
        .cloned()
    else {
        return;
    };
    state.collected.push(id);
    state.inventory.push(item);
    // Items don't affect the nav/solid grids or the overlays, so just drop the
    // picked-up item from the baked list instead of re-baking everything.
    state.items.retain(|it| it.id != id);
    clear_goal_route(state);
    // A map item can reveal a region, which changes the baked geometry on that
    // region's floor.
    let floors = reveal_regions_linked_to(state, |l| {
        matches!(l, Link::ItemRegion { item_floor, item_id, .. }
            if *item_floor as usize == floor && *item_id == id)
    });
    if floors.is_empty() {
        // Otherwise only the goals list changed (the item is now collected).
        on_progress_changed(state);
    } else {
        rebuild_progress(state, &floors);
    }
    set_status(state, format!("picked up {name}"));
}

// Unlock a specific locked door the player holds a key for.
fn unlock_door(state: &mut State, id: u32) {
    let floor = state.player_floor;
    if effective_door_kind(state, floor, id) != Some(DoorKind::Locked)
        || !door_has_inventory_key(state, floor, id)
    {
        set_status(state, "can't unlock this door");
        return;
    }
    state.unlocked.push((floor, id));
    prune_satisfied_keys(state);
    // The door opening changes the player's floor nav; a linked region can
    // reveal geometry on another floor too.
    let mut floors = reveal_regions_linked_to(state, |l| {
        matches!(l, Link::DoorRegion { door_floor, door_id, .. }
            if *door_floor as usize == floor && *door_id == id)
    });
    if floors.is_empty() {
        rebuild_gameplay(state);
    } else {
        floors.push(floor);
        floors.sort_unstable();
        floors.dedup();
        rebuild_progress(state, &floors);
    }
    set_status(state, "unlocked");
}

// --- Inventory HUD ---------------------------------------------------------

const INV_COLS: usize = 4;
const INV_ROWS: usize = 4;
const INV_SLOT: f32 = 56.0;
const INV_GAP: f32 = 8.0;
const INV_DETAIL_H: f32 = 56.0;

fn inventory_panel(l: &Layout) -> (f32, f32, f32, f32) {
    let w = INV_COLS as f32 * INV_SLOT + (INV_COLS as f32 + 1.0) * INV_GAP;
    let grid_h = INV_ROWS as f32 * INV_SLOT + (INV_ROWS as f32 + 1.0) * INV_GAP;
    let h = grid_h + INV_DETAIL_H + INV_GAP;
    (l.ref_w * 0.5 - w * 0.5, l.ref_h * 0.5 - h * 0.5, w, h)
}

fn inventory_slot_rect(l: &Layout, index: usize) -> (f32, f32, f32, f32) {
    let (px, py, _, _) = inventory_panel(l);
    let col = index % INV_COLS;
    let row = index / INV_COLS;
    (
        px + INV_GAP + col as f32 * (INV_SLOT + INV_GAP),
        py + INV_GAP + row as f32 * (INV_SLOT + INV_GAP),
        INV_SLOT,
        INV_SLOT,
    )
}

fn inventory_detail_rect(l: &Layout) -> (f32, f32, f32, f32) {
    let (px, py, pw, ph) = inventory_panel(l);
    let y = py + ph - INV_GAP - INV_DETAIL_H;
    (px + INV_GAP, y, pw - INV_GAP * 2.0, INV_DETAIL_H)
}

fn inventory_hit(state: &State, x: f32, y: f32) -> Option<usize> {
    if !state.inventory_open {
        return None;
    }
    for i in 0..INV_COLS * INV_ROWS {
        let (sx, sy, sw, sh) = inventory_slot_rect(&state.layout, i);
        if (sx..sx + sw).contains(&x) && (sy..sy + sh).contains(&y) {
            return Some(i);
        }
    }
    None
}

fn wrap(i: usize, delta: i32, n: usize) -> usize {
    if n == 0 {
        0
    } else {
        (i as i32 + delta).rem_euclid(n as i32) as usize
    }
}

fn nav_inventory(state: &mut State, delta: i32) {
    state.inventory_selected = wrap(state.inventory_selected, delta, INV_COLS * INV_ROWS);
}

fn draw_item_marker(cx: f32, cy: f32, kind: ItemKind, scale: f32) {
    match kind {
        ItemKind::Key => {
            sgl::c4f(C_ITEM.0, C_ITEM.1, C_ITEM.2, 1.0);
            filled_circle(cx, cy, ITEM_RADIUS * scale);
        }
        ItemKind::InkRibbon => {
            let (w, h) = (22.0 * scale, 8.0 * scale);
            sgl::c4f(0.90, 0.86, 0.62, 1.0);
            rect(cx - w * 0.5, cy - h * 0.5, w, h);
            sgl::c4f(0.55, 0.35, 0.55, 1.0);
            rect(cx - w * 0.5, cy - 1.0 * scale, w, 2.0 * scale);
        }
        ItemKind::Typewriter => {
            sgl::c4f(0.72, 0.74, 0.78, 1.0);
            rect(
                cx - 12.0 * scale,
                cy - 4.0 * scale,
                24.0 * scale,
                14.0 * scale,
            );
            sgl::c4f(0.92, 0.92, 0.90, 1.0);
            rect(
                cx - 9.0 * scale,
                cy - 13.0 * scale,
                18.0 * scale,
                9.0 * scale,
            );
            sgl::c4f(0.30, 0.30, 0.34, 1.0);
            rect(
                cx - 12.0 * scale,
                cy + 8.0 * scale,
                24.0 * scale,
                3.0 * scale,
            );
        }
        ItemKind::ItemBox => {
            // A lidded storage chest.
            sgl::c4f(0.42, 0.44, 0.50, 1.0);
            rect(
                cx - 14.0 * scale,
                cy - 12.0 * scale,
                28.0 * scale,
                10.0 * scale,
            );
            sgl::c4f(0.55, 0.57, 0.62, 1.0);
            rect(
                cx - 14.0 * scale,
                cy - 2.0 * scale,
                28.0 * scale,
                14.0 * scale,
            );
            sgl::c4f(0.85, 0.80, 0.55, 1.0);
            rect(cx - 3.0 * scale, cy - 4.0 * scale, 6.0 * scale, 6.0 * scale);
        }
    }
}

fn draw_inventory(state: &State, font: &Font) {
    if !state.inventory_open {
        return;
    }
    let l = &state.layout;
    let (px, py, pw, ph) = inventory_panel(l);
    sgl::c4f(0.05, 0.05, 0.07, 0.94);
    rect(px, py, pw, ph);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.8);
    outline_rect(px, py, pw, ph);
    draw_ui_text(
        font,
        "INVENTORY",
        px + 12.0,
        py - 26.0,
        C_HILITE,
        false,
        1.0,
    );

    for i in 0..INV_COLS * INV_ROWS {
        let (sx, sy, sw, sh) = inventory_slot_rect(l, i);
        sgl::c4f(0.10, 0.10, 0.13, 0.9);
        rect(sx, sy, sw, sh);
        let selected = i == state.inventory_selected;
        if selected {
            sgl::c4f(1.0, 1.0, 1.0, 1.0);
        } else {
            sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.5);
        }
        outline_rect(sx, sy, sw, sh);
        if let Some(item) = state.inventory.get(i) {
            draw_item_marker(sx + sw * 0.5, sy + sh * 0.5, item.kind, 1.0);
        }
    }

    let (dx, dy, dw, dh) = inventory_detail_rect(l);
    sgl::c4f(0.08, 0.08, 0.11, 0.95);
    rect(dx, dy, dw, dh);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.6);
    outline_rect(dx, dy, dw, dh);
    match state.inventory.get(state.inventory_selected) {
        Some(item) => {
            draw_item_marker(dx + 30.0, dy + dh * 0.5, item.kind, 1.6);
            draw_ui_text(
                font,
                &item.name,
                dx + 60.0,
                dy + dh * 0.5 - 10.0,
                C_HILITE,
                false,
                1.0,
            );
        }
        None => draw_ui_text(
            font,
            "(empty)",
            dx + 16.0,
            dy + dh * 0.5 - 10.0,
            C_LABEL,
            false,
            1.0,
        ),
    }
}

// --- Item box --------------------------------------------------------------
//
// A storage grid shown to the left of the inventory, with a single cursor that
// spans both (indices 0..16 are the box, 16..32 the inventory) so Left/Right
// steps between them.

const BOX_SEAM: f32 = 44.0;
const BOX_COLS: usize = INV_COLS * 2;
const BOX_SLOTS: usize = BOX_COLS * INV_ROWS;
const INV_SLOTS: usize = INV_COLS * INV_ROWS;

fn item_box_panel(l: &Layout) -> (f32, f32, f32, f32) {
    let w = BOX_COLS as f32 * INV_SLOT + (BOX_COLS as f32 + 1.0) * INV_GAP + BOX_SEAM;
    let grid_h = INV_ROWS as f32 * INV_SLOT + (INV_ROWS as f32 + 1.0) * INV_GAP;
    let h = grid_h + INV_DETAIL_H + INV_GAP;
    (l.ref_w * 0.5 - w * 0.5, l.ref_h * 0.5 - h * 0.5, w, h)
}

fn item_box_slot_rect(l: &Layout, index: usize) -> (f32, f32, f32, f32) {
    let (px, py, _, _) = item_box_panel(l);
    let col = index % BOX_COLS;
    let row = index / BOX_COLS;
    let seam = if col >= INV_COLS { BOX_SEAM } else { 0.0 };
    (
        px + INV_GAP + col as f32 * (INV_SLOT + INV_GAP) + seam,
        py + INV_GAP + row as f32 * (INV_SLOT + INV_GAP),
        INV_SLOT,
        INV_SLOT,
    )
}

fn item_box_detail_rect(l: &Layout) -> (f32, f32, f32, f32) {
    let (px, py, pw, ph) = item_box_panel(l);
    let y = py + ph - INV_GAP - INV_DETAIL_H;
    (px + INV_GAP, y, pw - INV_GAP * 2.0, INV_DETAIL_H)
}

// The item under a combined slot index, if any. Columns 0..4 are the box,
// 4..8 the inventory, so which grid a slot belongs to is by column.
fn box_slot_grid(index: usize) -> (bool, usize) {
    let col = index % BOX_COLS;
    let row = index / BOX_COLS;
    let from_box = col < INV_COLS;
    let item_index = row * INV_COLS + if from_box { col } else { col - INV_COLS };
    (from_box, item_index)
}

fn item_box_slot_item(state: &State, index: usize) -> Option<&ItemDef> {
    let (from_box, i) = box_slot_grid(index);
    if from_box {
        state.item_box.get(i)
    } else {
        state.inventory.get(i)
    }
}

fn item_box_hit(state: &State, x: f32, y: f32) -> Option<usize> {
    if !state.item_box_open {
        return None;
    }
    for i in 0..BOX_SLOTS {
        let (sx, sy, sw, sh) = item_box_slot_rect(&state.layout, i);
        if (sx..sx + sw).contains(&x) && (sy..sy + sh).contains(&y) {
            return Some(i);
        }
    }
    None
}

fn nav_item_box(state: &mut State, delta: i32) {
    state.item_box_cursor = wrap(state.item_box_cursor, delta, BOX_SLOTS);
}

// Move the item under the cursor to the other grid, if there is room.
fn transfer_box_item(state: &mut State) {
    let (from_box, item_index) = box_slot_grid(state.item_box_cursor);
    if from_box {
        if item_index >= state.item_box.len() {
            set_status(state, "empty slot");
            return;
        }
        if state.inventory.len() >= INV_SLOTS {
            set_status(state, "inventory full");
            return;
        }
        let item = state.item_box.remove(item_index);
        state.inventory.push(item);
        set_status(state, "moved to inventory");
    } else {
        if item_index >= state.inventory.len() {
            set_status(state, "empty slot");
            return;
        }
        if state.item_box.len() >= INV_SLOTS {
            set_status(state, "item box full");
            return;
        }
        let item = state.inventory.remove(item_index);
        state.item_box.push(item);
        set_status(state, "stored in item box");
    }
}

fn open_item_box(state: &mut State) {
    state.item_box_open = true;
    state.item_box_cursor = 0;
    state.inventory_open = false;
}

fn draw_item_box(state: &State, font: &Font) {
    if !state.item_box_open {
        return;
    }
    let l = &state.layout;
    sgl::c4f(0.0, 0.0, 0.0, 0.55);
    rect(0.0, 0.0, l.ref_w, l.ref_h);
    let (px, py, pw, ph) = item_box_panel(l);
    sgl::c4f(0.05, 0.05, 0.07, 0.94);
    rect(px, py, pw, ph);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.8);
    outline_rect(px, py, pw, ph);

    let (ix, _, _, _) = item_box_slot_rect(l, INV_COLS);
    draw_ui_text(font, "ITEM BOX", px + 12.0, py - 26.0, C_HILITE, false, 1.0);
    draw_ui_text(font, "INVENTORY", ix, py - 26.0, C_HILITE, false, 1.0);

    for i in 0..BOX_SLOTS {
        let (sx, sy, sw, sh) = item_box_slot_rect(l, i);
        sgl::c4f(0.10, 0.10, 0.13, 0.9);
        rect(sx, sy, sw, sh);
        if i == state.item_box_cursor {
            sgl::c4f(1.0, 1.0, 1.0, 1.0);
        } else {
            sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.5);
        }
        outline_rect(sx, sy, sw, sh);
        if let Some(item) = item_box_slot_item(state, i) {
            draw_item_marker(sx + sw * 0.5, sy + sh * 0.5, item.kind, 1.0);
        }
    }

    let (dx, dy, dw, dh) = item_box_detail_rect(l);
    sgl::c4f(0.08, 0.08, 0.11, 0.95);
    rect(dx, dy, dw, dh);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.6);
    outline_rect(dx, dy, dw, dh);
    match item_box_slot_item(state, state.item_box_cursor) {
        Some(item) => {
            draw_item_marker(dx + 30.0, dy + dh * 0.5, item.kind, 1.6);
            draw_ui_text(
                font,
                &item.name,
                dx + 60.0,
                dy + dh * 0.5 - 10.0,
                C_HILITE,
                false,
                1.0,
            );
        }
        None => draw_ui_text(
            font,
            "(empty)",
            dx + 16.0,
            dy + dh * 0.5 - 10.0,
            C_LABEL,
            false,
            1.0,
        ),
    }
    draw_ui_text(
        font,
        "CLICK / SPACE: move   ARROWS: select   ESC: close",
        px + 12.0,
        py + ph + 10.0,
        C_LABEL,
        false,
        0.9,
    );
}

// --- Modal menus (pause, save slots) --------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum MenuHit {
    Entry(usize),
    Yes,
    No,
}

fn menu_rows(state: &State) -> usize {
    match state.menu {
        Menu::Pause => pause_entry_count(),
        Menu::SaveSlots | Menu::LoadSlots => SAVE_SLOTS,
        Menu::None => 0,
    }
}

fn menu_panel(l: &Layout, rows: usize) -> (f32, f32, f32, f32) {
    let w = 660.0;
    let h = 56.0 + rows as f32 * 46.0 + 16.0;
    (l.ref_w * 0.5 - w * 0.5, l.ref_h * 0.5 - h * 0.5, w, h)
}

fn menu_row_rect(l: &Layout, rows: usize, i: usize) -> (f32, f32, f32, f32) {
    let (px, py, pw, _) = menu_panel(l, rows);
    (px + 16.0, py + 56.0 + i as f32 * 46.0, pw - 32.0, 40.0)
}

fn confirm_panel(l: &Layout) -> (f32, f32, f32, f32) {
    let w = 520.0;
    let h = 170.0;
    (l.ref_w * 0.5 - w * 0.5, l.ref_h * 0.5 - h * 0.5, w, h)
}

#[allow(clippy::type_complexity)]
fn confirm_buttons(l: &Layout) -> ((f32, f32, f32, f32), (f32, f32, f32, f32)) {
    let (px, py, pw, ph) = confirm_panel(l);
    let bw = 160.0;
    let bh = 44.0;
    let by = py + ph - bh - 20.0;
    (
        (px + pw * 0.5 - bw - 10.0, by, bw, bh),
        (px + pw * 0.5 + 10.0, by, bw, bh),
    )
}

fn menu_hit(state: &State, x: f32, y: f32) -> Option<MenuHit> {
    let l = &state.layout;
    if state.confirm.is_some() {
        let (yes, no) = confirm_buttons(l);
        let inside = |r: (f32, f32, f32, f32)| {
            (r.0..r.0 + r.2).contains(&x) && (r.1..r.1 + r.3).contains(&y)
        };
        if inside(yes) {
            return Some(MenuHit::Yes);
        }
        if inside(no) {
            return Some(MenuHit::No);
        }
        return None;
    }
    let rows = menu_rows(state);
    if rows == 0 {
        return None;
    }
    for i in 0..rows {
        let r = menu_row_rect(l, rows, i);
        if (r.0..r.0 + r.2).contains(&x) && (r.1..r.1 + r.3).contains(&y) {
            return Some(MenuHit::Entry(i));
        }
    }
    None
}

fn draw_menu(state: &State, font: &Font) {
    if state.menu == Menu::None && state.confirm.is_none() {
        return;
    }
    let l = &state.layout;
    sgl::c4f(0.0, 0.0, 0.0, 0.55);
    rect(0.0, 0.0, l.ref_w, l.ref_h);

    if let Some(c) = state.confirm {
        let (px, py, pw, ph) = confirm_panel(l);
        sgl::c4f(0.05, 0.05, 0.07, 0.98);
        rect(px, py, pw, ph);
        sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.85);
        outline_rect(px, py, pw, ph);
        let msg = match c {
            Confirm::Overwrite(slot) => format!("Overwrite slot {}?", slot + 1),
            Confirm::Quit => "Quit the game?".to_string(),
        };
        draw_ui_text(font, &msg, px + 24.0, py + 40.0, C_HILITE, true, 1.0);
        let (yes, no) = confirm_buttons(l);
        for (n, (r, label)) in [(yes, "YES"), (no, "NO")].into_iter().enumerate() {
            let selected = n == state.confirm_index;
            sgl::c4f(0.12, 0.12, 0.16, 0.95);
            rect(r.0, r.1, r.2, r.3);
            if selected {
                sgl::c4f(1.0, 1.0, 1.0, 1.0);
            } else {
                sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.7);
            }
            outline_rect(r.0, r.1, r.2, r.3);
            draw_ui_text(
                font,
                label,
                r.0 + 56.0,
                r.1 + 12.0,
                if selected { C_HILITE } else { C_LABEL },
                false,
                1.0,
            );
        }
        return;
    }

    let rows = menu_rows(state);
    let (px, py, pw, _) = menu_panel(l, rows);
    sgl::c4f(0.05, 0.05, 0.07, 0.97);
    rect(px, py, pw, menu_panel(l, rows).3);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.85);
    outline_rect(px, py, pw, menu_panel(l, rows).3);

    let title = match state.menu {
        Menu::Pause => "PAUSED",
        Menu::SaveSlots => "SAVE - CHOOSE A SLOT",
        Menu::LoadSlots => "LOAD - CHOOSE A SLOT",
        Menu::None => "",
    };
    draw_ui_text(font, title, px + 20.0, py + 18.0, C_HILITE, false, 1.0);

    for i in 0..rows {
        let r = menu_row_rect(l, rows, i);
        let selected = i == state.menu_index;
        sgl::c4f(0.10, 0.10, 0.13, 0.95);
        rect(r.0, r.1, r.2, r.3);
        if selected {
            sgl::c4f(1.0, 1.0, 1.0, 1.0);
        } else {
            sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.5);
        }
        outline_rect(r.0, r.1, r.2, r.3);
        match state.menu {
            Menu::Pause => {
                let label = ["RESUME", "LOAD", "ITEM BOX", "EXIT"][i.min(3)];
                draw_ui_text(font, label, r.0 + 16.0, r.1 + 10.0, C_HILITE, false, 1.0);
            }
            Menu::SaveSlots | Menu::LoadSlots => {
                draw_ui_text(
                    font,
                    &format!("SLOT {}", i + 1),
                    r.0 + 16.0,
                    r.1 + 10.0,
                    C_LABEL,
                    false,
                    1.0,
                );
                let detail = match state.slot_meta[i] {
                    Some(m) => format!(
                        "{}   {}   F{}   {} items",
                        format_unix_utc(m.saved_at),
                        format_play_time(m.play_time),
                        m.floor + 1,
                        m.items
                    ),
                    None => "empty".to_string(),
                };
                let dim = state.slot_meta[i].is_none()
                    || (state.menu == Menu::LoadSlots && state.slot_meta[i].is_none());
                draw_ui_text(
                    font,
                    &detail,
                    r.0 + 200.0,
                    r.1 + 10.0,
                    if dim { C_LABEL } else { C_HILITE },
                    false,
                    0.95,
                );
            }
            Menu::None => {}
        }
    }
}

// --- Door properties popup (editor) ---------------------------------------

#[derive(Clone, Copy)]
enum DoorPopupHit {
    Kind(DoorKind),
    Reveals(DoorKind),
}

fn selected_door_index(state: &State) -> Option<usize> {
    if let Some(Selection::Door(i)) = primary_selection(state) {
        if state.scene.floors[state.floor].doors.get(i).is_some() {
            return Some(i);
        }
    }
    None
}

#[allow(clippy::type_complexity)]
fn door_popup_buttons(
    state: &State,
) -> Option<(
    Vec<((f32, f32, f32, f32), DoorPopupHit)>,
    (f32, f32, f32, f32),
)> {
    let i = selected_door_index(state)?;
    let door = state.scene.floors[state.floor].doors.get(i)?;
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, _, _, _, _, _) = state.layout.vars();
    let px = MAP_X + 16.0;
    let py = MAP_Y + 16.0;
    let (bw, bh, gap) = (96.0, 32.0, 6.0);
    let row1 = py + 36.0;
    let mut buttons = Vec::new();
    for (n, kind) in [DoorKind::Locked, DoorKind::Unlocked, DoorKind::Unknown]
        .into_iter()
        .enumerate()
    {
        buttons.push((
            (px + 8.0 + n as f32 * (bw + gap), row1, bw, bh),
            DoorPopupHit::Kind(kind),
        ));
    }
    let mut h = 36.0 + bh + 12.0;
    if door.kind == DoorKind::Unknown {
        let row2 = row1 + bh + 26.0;
        for (n, kind) in [DoorKind::Locked, DoorKind::Unlocked]
            .into_iter()
            .enumerate()
        {
            buttons.push((
                (px + 8.0 + n as f32 * (bw + gap), row2, bw, bh),
                DoorPopupHit::Reveals(kind),
            ));
        }
        h = 36.0 + bh + 26.0 + bh + 12.0;
    }
    let panel = (px, py, 16.0 + 3.0 * bw + 2.0 * gap, h);
    Some((buttons, panel))
}

fn door_popup_hit(state: &State, x: f32, y: f32) -> Option<DoorPopupHit> {
    let (buttons, panel) = door_popup_buttons(state)?;
    if !(panel.0..panel.0 + panel.2).contains(&x) || !(panel.1..panel.1 + panel.3).contains(&y) {
        return None;
    }
    buttons
        .into_iter()
        .find(|(r, _)| (r.0..r.0 + r.2).contains(&x) && (r.1..r.1 + r.3).contains(&y))
        .map(|(_, hit)| hit)
}

fn apply_door_popup(state: &mut State, hit: DoorPopupHit) {
    let Some(i) = selected_door_index(state) else {
        return;
    };
    push_undo(state);
    let door = &mut state.scene.floors[state.floor].doors[i];
    match hit {
        DoorPopupHit::Kind(kind) => door.kind = kind,
        DoorPopupHit::Reveals(kind) => door.reveals_as = kind,
    }
    rebuild_assets(state);
    set_status(state, "door updated");
}

fn draw_door_popup(state: &State, font: &Font) {
    let Some((buttons, panel)) = door_popup_buttons(state) else {
        return;
    };
    let door = &state.scene.floors[state.floor].doors[selected_door_index(state).unwrap()];
    sgl::c4f(0.05, 0.05, 0.07, 0.95);
    rect(panel.0, panel.1, panel.2, panel.3);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.8);
    outline_rect(panel.0, panel.1, panel.2, panel.3);
    draw_ui_text(
        font,
        &format!("DOOR {}", door.id),
        panel.0 + 12.0,
        panel.1 + 10.0,
        C_HILITE,
        false,
        0.95,
    );
    let active_kind = |k: DoorKind| door.kind == k;
    for (r, hit) in &buttons {
        let (label, active) = match *hit {
            DoorPopupHit::Kind(k) => (door_kind_label(k), active_kind(k)),
            DoorPopupHit::Reveals(k) => (door_kind_label(k), door.reveals_as == k),
        };
        sgl::c4f(0.10, 0.10, 0.13, 0.95);
        rect(r.0, r.1, r.2, r.3);
        if active {
            sgl::c4f(1.0, 1.0, 1.0, 1.0);
        } else {
            sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.6);
        }
        outline_rect(r.0, r.1, r.2, r.3);
        draw_ui_text(
            font,
            label,
            r.0 + 8.0,
            r.1 + 8.0,
            if active { C_HILITE } else { C_LABEL },
            false,
            0.85,
        );
    }
    if door.kind == DoorKind::Unknown {
        // Label the reveal row (sits between the two rows).
        let row2_y = buttons.last().map(|(r, _)| r.1).unwrap_or(panel.1);
        draw_ui_text(
            font,
            "reveals as:",
            panel.0 + 12.0,
            row2_y - 22.0,
            C_LABEL,
            false,
            0.85,
        );
    }
}

fn door_kind_label(kind: DoorKind) -> &'static str {
    match kind {
        DoorKind::Locked => "LOCKED",
        DoorKind::Unlocked => "UNLOCKED",
        DoorKind::Unknown => "UNKNOWN",
    }
}

// --- Item properties popup (editor) ---------------------------------------

#[derive(Clone, Copy)]
enum ItemPopupHit {
    Kind(ItemKind),
}

fn selected_item_index(state: &State) -> Option<usize> {
    if let Some(Selection::Item(i)) = primary_selection(state) {
        if state.scene.floors[state.floor].items.get(i).is_some() {
            return Some(i);
        }
    }
    None
}

#[allow(clippy::type_complexity)]
fn item_popup_buttons(
    state: &State,
) -> Option<(
    Vec<((f32, f32, f32, f32), ItemPopupHit)>,
    (f32, f32, f32, f32),
)> {
    let i = selected_item_index(state)?;
    let _ = state.scene.floors[state.floor].items.get(i)?;
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, _, _, _, _, _) = state.layout.vars();
    let px = MAP_X + 16.0;
    let py = MAP_Y + 16.0;
    let (bw, bh, gap) = (96.0, 32.0, 6.0);
    let row = py + 36.0;
    let mut buttons = Vec::new();
    for (n, kind) in [
        ItemKind::Key,
        ItemKind::InkRibbon,
        ItemKind::Typewriter,
        ItemKind::ItemBox,
    ]
    .into_iter()
    .enumerate()
    {
        buttons.push((
            (px + 8.0 + n as f32 * (bw + gap), row, bw, bh),
            ItemPopupHit::Kind(kind),
        ));
    }
    let panel = (px, py, 16.0 + 4.0 * bw + 3.0 * gap, 36.0 + bh + 12.0);
    Some((buttons, panel))
}

fn item_popup_hit(state: &State, x: f32, y: f32) -> Option<ItemPopupHit> {
    let (buttons, panel) = item_popup_buttons(state)?;
    if !(panel.0..panel.0 + panel.2).contains(&x) || !(panel.1..panel.1 + panel.3).contains(&y) {
        return None;
    }
    buttons
        .into_iter()
        .find(|(r, _)| (r.0..r.0 + r.2).contains(&x) && (r.1..r.1 + r.3).contains(&y))
        .map(|(_, hit)| hit)
}

fn apply_item_popup(state: &mut State, hit: ItemPopupHit) {
    let Some(i) = selected_item_index(state) else {
        return;
    };
    let ItemPopupHit::Kind(kind) = hit;
    push_undo(state);
    state.scene.floors[state.floor].items[i].kind = kind;
    state.item_kind = kind;
    rebuild_assets(state);
    set_status(state, "item kind updated");
}

fn draw_item_popup(state: &State, font: &Font) {
    let Some((buttons, panel)) = item_popup_buttons(state) else {
        return;
    };
    let item = &state.scene.floors[state.floor].items[selected_item_index(state).unwrap()];
    sgl::c4f(0.05, 0.05, 0.07, 0.95);
    rect(panel.0, panel.1, panel.2, panel.3);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.8);
    outline_rect(panel.0, panel.1, panel.2, panel.3);
    draw_ui_text(
        font,
        &format!("ITEM {}  {}", item.id, item.name),
        panel.0 + 12.0,
        panel.1 + 10.0,
        C_HILITE,
        false,
        0.9,
    );
    for (r, hit) in &buttons {
        let ItemPopupHit::Kind(kind) = *hit;
        let active = item.kind == kind;
        sgl::c4f(0.10, 0.10, 0.13, 0.95);
        rect(r.0, r.1, r.2, r.3);
        if active {
            sgl::c4f(1.0, 1.0, 1.0, 1.0);
        } else {
            sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.6);
        }
        outline_rect(r.0, r.1, r.2, r.3);
        draw_ui_text(
            font,
            item_kind_label(kind),
            r.0 + 8.0,
            r.1 + 8.0,
            if active { C_HILITE } else { C_LABEL },
            false,
            0.8,
        );
    }
}

fn item_kind_label(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Key => "KEY",
        ItemKind::InkRibbon => "INK RIBBON",
        ItemKind::Typewriter => "TYPEWRITER",
        ItemKind::ItemBox => "ITEM BOX",
    }
}

// Re-bake the scene and swap the running map's assets in place.
fn rebuild_assets(state: &mut State) {
    recompute_play_scene(state);
    let scene = state.play_scene.clone();
    let baked = bake(&scene);
    let BakedBytes {
        overlays,
        nav,
        nav_open,
        solid,
        stairs,
        items,
    } = baked;
    apply_gameplay(state, nav, nav_open, solid, stairs, items);
    state.move_grid = std::array::from_fn(|i| MoveGrid::from_nav(&state.nav[i]));
    state.wall_plans = std::array::from_fn(|i| wall_plan(&scene.floors[i]));
    state.wall_plans_dirty = false;
    for (i, overlay) in overlays.into_iter().enumerate() {
        sg::destroy_view(state.overlay_views[i]);
        state.overlay_views[i] = overlay_texture(&overlay.rgba, overlay.w, overlay.h);
        state.overlay_data[i] = overlay;
    }
    reset_navigation(state);
}

/// Re-bake only the player's floor nav/solid for a progress change (a door
/// revealing/unlocking). The overlays never change with progress, so their 2048px
/// textures are left alone, and no other floor's geometry changed.
fn rebuild_gameplay(state: &mut State) {
    recompute_play_scene(state);
    let scene = state.play_scene.clone();
    let f = state.player_floor;
    let (nav, nav_open) = bake_floor_nav(&scene, f);
    state.nav[f] = Nav::from_bytes(&nav, FLOOR_FRAMES[f]);
    state.nav_open[f] = Nav::from_bytes(&nav_open, FLOOR_FRAMES[f]);
    state.move_grid[f] = MoveGrid::from_nav(&state.nav[f]);
    refresh_items_and_stairs(state, &scene);
    reset_navigation(state);
}

// Re-derive the baked item and stair lists. A region reveal can expose or hide
// items/stairs on any floor, so a progress change must refresh them.
fn refresh_items_and_stairs(state: &mut State, scene: &Scene) {
    state.stairs = parse_stairs(&ink_ribbon_native::bake::bake_scene_stairs(scene));
    state.items = parse_items(&ink_ribbon_native::bake::bake_scene_items(scene));
}

/// Re-upload one floor's baked obstacle overlay.
fn rebuild_overlay(state: &mut State, f: usize, scene: &Scene) {
    let overlay = ink_ribbon_native::bake::bake_floor_overlay(scene, f);
    sg::destroy_view(state.overlay_views[f]);
    state.overlay_views[f] = overlay_texture(&overlay.rgba, overlay.w, overlay.h);
    state.overlay_data[f] = overlay;
}

/// Re-bake only the floors whose baked geometry actually changed, and only the
/// overlays whose obstacles changed. Region reveals usually change neither (items
/// and labels are drawn from the scene, not baked), so this avoids the 2048px
/// overlay-texture churn of a full `rebuild_assets`.
fn rebuild_progress(state: &mut State, floors: &[usize]) {
    let old = state.play_scene.clone();
    recompute_play_scene(state);
    let scene = state.play_scene.clone();
    let mut player_nav_changed = false;
    for &f in floors {
        let o = &old.floors[f];
        let n = &scene.floors[f];
        let geometry_changed = o.walls != n.walls
            || o.partitions != n.partitions
            || o.obstacles != n.obstacles
            || o.doors != n.doors
            || o.stairs != n.stairs;
        if geometry_changed {
            let (nav, nav_open) = bake_floor_nav(&scene, f);
            state.nav[f] = Nav::from_bytes(&nav, FLOOR_FRAMES[f]);
            state.nav_open[f] = Nav::from_bytes(&nav_open, FLOOR_FRAMES[f]);
            state.move_grid[f] = MoveGrid::from_nav(&state.nav[f]);
            player_nav_changed |= f == state.player_floor;
        }
        if o.walls != n.walls || o.partitions != n.partitions {
            state.wall_plans[f] = wall_plan(&scene.floors[f]);
        }
        if o.obstacles != n.obstacles {
            rebuild_overlay(state, f, &scene);
        }
    }
    refresh_items_and_stairs(state, &scene);
    if player_nav_changed {
        reset_navigation(state);
    } else {
        on_progress_changed(state);
    }
}

fn apply_gameplay(
    state: &mut State,
    nav: [Vec<u8>; NUM_FLOORS],
    nav_open: [Vec<u8>; NUM_FLOORS],
    solid: [Vec<u8>; NUM_FLOORS],
    stairs: Vec<u8>,
    items: Vec<u8>,
) {
    state.nav = std::array::from_fn(|i| Nav::from_bytes(&nav[i], FLOOR_FRAMES[i]));
    state.nav_open = std::array::from_fn(|i| Nav::from_bytes(&nav_open[i], FLOOR_FRAMES[i]));
    state.solid = std::array::from_fn(|i| Solid::from_bytes(&solid[i], FLOOR_FRAMES[i]));
    state.stairs = parse_stairs(&stairs);
    state.items = parse_items(&items);
}

fn reset_navigation(state: &mut State) {
    // Navigation changed: reset reachability and re-snap the player.
    state.reachable = std::array::from_fn(|_| Vec::new());
    clear_goal_route(state);
    let pf = state.player_floor;
    if let Some(cell) = snap_source(&state.nav[pf], state.player.0, state.player.1) {
        state.player = cell_to_source(&state.nav[pf], cell.0, cell.1);
        state.player_cell = Some(cell);
        state.reachable[pf] = reachable_from(&state.nav[pf], cell);
    }
    rebuild_move(state);
    on_progress_changed(state);
}

// Recompute the player's turn-based reachable set from the move grid.
fn rebuild_move(state: &mut State) {
    let pf = state.player_floor;
    let start = state.move_grid[pf].source_cell(state.player.0, state.player.1);
    let reach = move_reach(&state.move_grid[pf], start);
    state.move_reach[pf] = reach;
    state.hover_cell = None;
    state.hover_path.clear();
}

fn place_rect(state: &mut State, a: (f32, f32), b: (f32, f32)) {
    let x = a.0.min(b.0);
    let y = a.1.min(b.1);
    let w = (b.0 - a.0).abs();
    let h = (b.1 - a.1).abs();
    if w < 4.0 || h < 4.0 {
        return;
    }
    push_undo(state);
    let id = state.next_id;
    state.next_id += 1;
    let tool = state.tool;
    let floor = &mut state.scene.floors[state.floor];
    let center = (x + w * 0.5, y + h * 0.5);
    match tool {
        Tool::WallAdd | Tool::WallSub => floor.walls.push(WallOp {
            mode: if tool == Tool::WallAdd {
                BoolOp::Add
            } else {
                BoolOp::Sub
            },
            rect: Rect { x, y, w, h },
        }),
        Tool::Wall => floor.partitions.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect { x, y, w, h },
        }),
        Tool::Obstacle => floor.obstacles.push(Box2 {
            id,
            center,
            size: (w, h),
            rot: 0.0,
        }),
        Tool::Region => floor.regions.push(Region {
            id,
            name: format!("Region {id}"),
            rect: Rect { x, y, w, h },
            initial: RegionState::Hidden,
        }),
        Tool::Trigger => floor.triggers.push(Trigger {
            id,
            rect: Rect { x, y, w, h },
        }),
        _ => {}
    }
    // Regions and triggers are metadata: they don't change the baked art.
    if !matches!(tool, Tool::Region | Tool::Trigger) {
        rebuild_assets(state);
    }
    set_status(state, format!("{} placed", tool.label()));
}

/// The door prop for the active tool, if any.
fn door_kind_for_tool(tool: Tool) -> Option<DoorKind> {
    match tool {
        Tool::DoorLocked => Some(DoorKind::Locked),
        Tool::DoorUnlocked => Some(DoorKind::Unlocked),
        Tool::DoorUnknown => Some(DoorKind::Unknown),
        _ => None,
    }
}

// How close the cursor must be to a wall to drop a door.
const DOOR_SNAP_RADIUS: f32 = 50.0;

/// The nearest wall the cursor can drop a door into, as `(centre, rot)`. The
/// door sits on the wall centreline, aligned with the wall.
fn snap_door_to_wall(state: &State, p: (f32, f32)) -> Option<(f32, f32, f32)> {
    snap_door_in(&state.wall_plans[state.floor], p)
}

fn snap_door_in(plan: &WallPlan, p: (f32, f32)) -> Option<(f32, f32, f32)> {
    let half = ROOM_WALL_PX * 0.5;
    let mut best: Option<(f32, (f32, f32, f32))> = None;
    for e in &plan.edges {
        // The wall is on the filled side for outer/interior edges, on the
        // unfilled side for the room's inner edge.
        let on_filled = e.tone != WallTone::Inner;
        let (center, rot) = match e.dir {
            EdgeDir::Up | EdgeDir::Down => {
                let x = p.0.clamp(e.x0.min(e.x1), e.x0.max(e.x1));
                let down = matches!(e.dir, EdgeDir::Up) == on_filled;
                let y = if down { e.y0 + half } else { e.y0 - half };
                ((x, y), 0.0)
            }
            EdgeDir::Left | EdgeDir::Right => {
                let y = p.1.clamp(e.y0.min(e.y1), e.y0.max(e.y1));
                let right = matches!(e.dir, EdgeDir::Left) == on_filled;
                let x = if right { e.x0 + half } else { e.x0 - half };
                ((x, y), std::f32::consts::FRAC_PI_2)
            }
        };
        let d = ((p.0 - center.0).powi(2) + (p.1 - center.1).powi(2)).sqrt();
        if d <= DOOR_SNAP_RADIUS && best.as_ref().is_none_or(|(bd, _)| d < *bd) {
            best = Some((d, (center.0, center.1, rot)));
        }
    }
    best.map(|(_, v)| v)
}

fn place_door(state: &mut State, center: (f32, f32), rot: f32) {
    let Some(kind) = door_kind_for_tool(state.tool) else {
        return;
    };
    push_undo(state);
    let id = state.next_id;
    state.next_id += 1;
    state.scene.floors[state.floor].doors.push(Door {
        id,
        kind,
        reveals_as: DoorKind::Locked,
        center,
        size: (DOOR_LONG_PX, DOOR_THICK_PX),
        rot,
    });
    rebuild_assets(state);
    set_status(state, format!("{} placed", state.tool.label()));
}

fn place_point(state: &mut State, p: (f32, f32)) {
    push_undo(state);
    let id = state.next_id;
    state.next_id += 1;
    let tool = state.tool;
    let floor = &mut state.scene.floors[state.floor];
    match tool {
        Tool::Stair => floor.stairs.push(StairNode { id, pos: p }),
        Tool::Item => floor.items.push(ItemDef {
            id,
            kind: state.item_kind,
            name: format!("Item {id}"),
            pos: p,
        }),
        Tool::Label => floor.labels.push(RoomLabel {
            name: "Room".into(),
            pos: p,
        }),
        _ => {}
    }
    // Labels are not baked, so placing one needs no rebuild.
    if tool != Tool::Label {
        rebuild_assets(state);
    }
    set_status(state, format!("{} placed", tool.label()));
}

fn dist_to_box(p: (f32, f32), c: (f32, f32), s: (f32, f32), rot: f32) -> f32 {
    let (sin, cos) = rot.sin_cos();
    let dx = p.0 - c.0;
    let dy = p.1 - c.1;
    let lx = dx * cos + dy * sin;
    let ly = -dx * sin + dy * cos;
    let ox = (lx.abs() - s.0 * 0.5).max(0.0);
    let oy = (ly.abs() - s.1 * 0.5).max(0.0);
    (ox * ox + oy * oy).sqrt()
}

fn dist_to_rect(p: (f32, f32), r: Rect) -> f32 {
    let ox = (r.x - p.0).max(p.0 - (r.x + r.w)).max(0.0);
    let oy = (r.y - p.1).max(p.1 - (r.y + r.h)).max(0.0);
    (ox * ox + oy * oy).sqrt()
}

fn pick_object(scene: &Scene, floor_index: usize, p: (f32, f32)) -> Option<Selection> {
    const REACH: f32 = 44.0;
    // Point-like objects get their own reach, and win outright when hit: a room
    // contains any point inside it (distance 0), so a point object inside a room
    // could otherwise never be selected.
    const POINT_REACH: f32 = 40.0;
    const LABEL_REACH: f32 = 90.0;
    let floor = &scene.floors[floor_index];
    let dist_pt = |q: (f32, f32)| ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt();

    let mut point: Option<(f32, Selection)> = None;
    let mut consider_point = |d: f32, reach: f32, sel: Selection| {
        if d <= reach && point.as_ref().is_none_or(|(bd, _)| d < *bd) {
            point = Some((d, sel));
        }
    };
    for (i, s) in floor.stairs.iter().enumerate() {
        consider_point(dist_pt(s.pos), POINT_REACH, Selection::Stair(i));
    }
    for (i, it) in floor.items.iter().enumerate() {
        consider_point(dist_pt(it.pos), POINT_REACH, Selection::Item(i));
    }
    for (i, l) in floor.labels.iter().enumerate() {
        consider_point(dist_pt(l.pos), LABEL_REACH, Selection::Label(i));
    }
    if let Some((_, sel)) = point {
        return Some(sel);
    }

    // Area objects: nearest wins; when several contain the cursor (a room and the
    // things inside it all have distance 0) the smallest wins.
    let mut best: Option<(f32, f32, Selection)> = None;
    let mut consider = |d: f32, area: f32, sel: Selection| {
        if d > REACH {
            return;
        }
        let better = match best {
            None => true,
            Some((bd, ba, _)) => d < bd - 0.01 || ((d - bd).abs() <= 0.01 && area < ba),
        };
        if better {
            best = Some((d, area, sel));
        }
    };
    for (i, w) in floor.walls.iter().enumerate() {
        consider(
            dist_to_rect(p, w.rect),
            w.rect.w * w.rect.h,
            Selection::Wall(i),
        );
    }
    for (i, w) in floor.partitions.iter().enumerate() {
        consider(
            dist_to_rect(p, w.rect),
            w.rect.w * w.rect.h,
            Selection::Partition(i),
        );
    }
    for (i, o) in floor.obstacles.iter().enumerate() {
        consider(
            dist_to_box(p, o.center, o.size, o.rot),
            o.size.0 * o.size.1,
            Selection::Obstacle(i),
        );
    }
    for (i, d) in floor.doors.iter().enumerate() {
        consider(
            dist_to_box(p, d.center, (DOOR_LONG_PX, DOOR_THICK_PX), d.rot),
            DOOR_LONG_PX * DOOR_THICK_PX,
            Selection::Door(i),
        );
    }
    // Triggers and regions are large areas; they lose to the objects inside them.
    for (i, t) in floor.triggers.iter().enumerate() {
        consider(
            dist_to_rect(p, t.rect),
            rect_area(t.rect),
            Selection::Trigger(i),
        );
    }
    for (i, r) in floor.regions.iter().enumerate() {
        consider(
            dist_to_rect(p, r.rect),
            rect_area(r.rect),
            Selection::Region(i),
        );
    }
    best.map(|(_, _, sel)| sel)
}

fn editor_erase(state: &mut State, p: (f32, f32)) {
    let Some(sel) = pick_object(&state.scene, state.floor, p) else {
        return;
    };
    push_undo(state);
    let floor = &mut state.scene.floors[state.floor];
    match sel {
        Selection::Wall(i) => {
            floor.walls.remove(i);
        }
        Selection::Partition(i) => {
            floor.partitions.remove(i);
        }
        Selection::Obstacle(i) => {
            floor.obstacles.remove(i);
        }
        Selection::Door(i) => {
            floor.doors.remove(i);
        }
        Selection::Stair(i) => {
            floor.stairs.remove(i);
        }
        Selection::Item(i) => {
            floor.items.remove(i);
        }
        Selection::Label(i) => {
            floor.labels.remove(i);
        }
        Selection::Region(i) => {
            floor.regions.remove(i);
        }
        Selection::Trigger(i) => {
            floor.triggers.remove(i);
        }
    }
    state.selection.clear();
    rebuild_assets(state);
    set_status(state, "erased");
}

// --- Selection geometry + transforms ---------------------------------------

fn primary_selection(state: &State) -> Option<Selection> {
    state.selection.last().copied()
}

fn selection_geom(scene: &Scene, floor_index: usize, sel: Selection) -> Option<SelGeom> {
    let floor = &scene.floors[floor_index];
    Some(match sel {
        Selection::Wall(i) => {
            let r = floor.walls.get(i)?.rect;
            SelGeom::Rect {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
            }
        }
        Selection::Partition(i) => {
            let r = floor.partitions.get(i)?.rect;
            SelGeom::Rect {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
            }
        }
        Selection::Obstacle(i) => {
            let o = floor.obstacles.get(i)?;
            SelGeom::Box {
                center: o.center,
                size: o.size,
                rot: o.rot,
            }
        }
        Selection::Door(i) => {
            let d = floor.doors.get(i)?;
            SelGeom::Box {
                center: d.center,
                size: (DOOR_LONG_PX, DOOR_THICK_PX),
                rot: d.rot,
            }
        }
        Selection::Stair(i) => SelGeom::Point {
            pos: floor.stairs.get(i)?.pos,
        },
        Selection::Item(i) => SelGeom::Point {
            pos: floor.items.get(i)?.pos,
        },
        Selection::Label(i) => SelGeom::Point {
            pos: floor.labels.get(i)?.pos,
        },
        Selection::Region(i) => {
            let r = floor.regions.get(i)?.rect;
            SelGeom::Rect {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
            }
        }
        Selection::Trigger(i) => {
            let r = floor.triggers.get(i)?.rect;
            SelGeom::Rect {
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
            }
        }
    })
}

fn set_selection_geom(scene: &mut Scene, floor_index: usize, sel: Selection, geom: SelGeom) {
    let floor = &mut scene.floors[floor_index];
    match (sel, geom) {
        (Selection::Wall(i), SelGeom::Rect { x, y, w, h }) => {
            if let Some(w0) = floor.walls.get_mut(i) {
                w0.rect = Rect { x, y, w, h };
            }
        }
        (Selection::Partition(i), SelGeom::Rect { x, y, w, h }) => {
            if let Some(w0) = floor.partitions.get_mut(i) {
                w0.rect = Rect { x, y, w, h };
            }
        }
        (Selection::Obstacle(i), SelGeom::Box { center, size, rot }) => {
            if let Some(o) = floor.obstacles.get_mut(i) {
                o.center = center;
                o.size = size;
                o.rot = rot;
            }
        }
        (Selection::Door(i), SelGeom::Box { center, rot, .. }) => {
            if let Some(d) = floor.doors.get_mut(i) {
                // Doors keep their fixed prop size; only position/rotation move.
                d.center = center;
                d.size = (DOOR_LONG_PX, DOOR_THICK_PX);
                d.rot = rot;
            }
        }
        (Selection::Stair(i), SelGeom::Point { pos }) => {
            if let Some(s) = floor.stairs.get_mut(i) {
                s.pos = pos;
            }
        }
        (Selection::Item(i), SelGeom::Point { pos }) => {
            if let Some(it) = floor.items.get_mut(i) {
                it.pos = pos;
            }
        }
        (Selection::Label(i), SelGeom::Point { pos }) => {
            if let Some(l) = floor.labels.get_mut(i) {
                l.pos = pos;
            }
        }
        (Selection::Region(i), SelGeom::Rect { x, y, w, h }) => {
            if let Some(r) = floor.regions.get_mut(i) {
                r.rect = Rect { x, y, w, h };
            }
        }
        (Selection::Trigger(i), SelGeom::Rect { x, y, w, h }) => {
            if let Some(t) = floor.triggers.get_mut(i) {
                t.rect = Rect { x, y, w, h };
            }
        }
        _ => {}
    }
}

fn geom_center(g: SelGeom) -> (f32, f32) {
    match g {
        SelGeom::Rect { x, y, w, h } => (x + w * 0.5, y + h * 0.5),
        SelGeom::Box { center, .. } => center,
        SelGeom::Point { pos } => pos,
    }
}

fn geom_corners(g: SelGeom) -> Vec<(f32, f32)> {
    match g {
        SelGeom::Rect { x, y, w, h } => vec![(x, y), (x + w, y), (x, y + h), (x + w, y + h)],
        SelGeom::Box { center, size, rot } => {
            let (hw, hh) = (size.0 * 0.5, size.1 * 0.5);
            let (s, c) = rot.sin_cos();
            [(-hw, -hh), (hw, -hh), (-hw, hh), (hw, hh)]
                .iter()
                .map(|(lx, ly)| (center.0 + lx * c - ly * s, center.1 + lx * s + ly * c))
                .collect()
        }
        SelGeom::Point { .. } => Vec::new(),
    }
}

fn geom_rotate_handle(g: SelGeom) -> Option<(f32, f32)> {
    match g {
        SelGeom::Box { center, size, rot } => {
            let (s, c) = rot.sin_cos();
            let (lx, ly) = (0.0, -size.1 * 0.5 - 28.0);
            Some((center.0 + lx * c - ly * s, center.1 + lx * s + ly * c))
        }
        _ => None,
    }
}

fn geom_hit(g: SelGeom, p: (f32, f32), tol: f32) -> bool {
    match g {
        SelGeom::Rect { x, y, w, h } => dist_to_rect(p, Rect { x, y, w, h }) <= tol,
        SelGeom::Box { center, size, rot } => dist_to_box(p, center, size, rot) <= tol,
        SelGeom::Point { pos } => ((p.0 - pos.0).powi(2) + (p.1 - pos.1).powi(2)).sqrt() <= tol,
    }
}

fn translate_geom(g: SelGeom, dx: f32, dy: f32) -> SelGeom {
    match g {
        SelGeom::Rect { x, y, w, h } => SelGeom::Rect {
            x: x + dx,
            y: y + dy,
            w,
            h,
        },
        SelGeom::Box { center, size, rot } => SelGeom::Box {
            center: (center.0 + dx, center.1 + dy),
            size,
            rot,
        },
        SelGeom::Point { pos } => SelGeom::Point {
            pos: (pos.0 + dx, pos.1 + dy),
        },
    }
}

fn scale_geom(g: SelGeom, cursor: (f32, f32), corner: usize) -> SelGeom {
    match g {
        SelGeom::Rect { x, y, w, h } => {
            let opp = match corner {
                0 => (x + w, y + h),
                1 => (x, y + h),
                2 => (x + w, y),
                _ => (x, y),
            };
            SelGeom::Rect {
                x: opp.0.min(cursor.0),
                y: opp.1.min(cursor.1),
                w: (cursor.0 - opp.0).abs(),
                h: (cursor.1 - opp.1).abs(),
            }
        }
        SelGeom::Box { center, rot, .. } => {
            let (s, c) = rot.sin_cos();
            let dx = cursor.0 - center.0;
            let dy = cursor.1 - center.1;
            let lx = dx * c + dy * s;
            let ly = -dx * s + dy * c;
            SelGeom::Box {
                center,
                size: ((lx.abs() * 2.0).max(8.0), (ly.abs() * 2.0).max(8.0)),
                rot,
            }
        }
        other => other,
    }
}

fn rotate_geom(g: SelGeom, cursor: (f32, f32), snap: bool) -> SelGeom {
    match g {
        SelGeom::Box { center, size, .. } => {
            let mut rot =
                (cursor.1 - center.1).atan2(cursor.0 - center.0) + std::f32::consts::FRAC_PI_2;
            if snap {
                let step = std::f32::consts::PI / 12.0;
                rot = (rot / step).round() * step;
            }
            SelGeom::Box { center, size, rot }
        }
        other => other,
    }
}

fn handle_tol(state: &State) -> f32 {
    let frame = floor_frame(state.floor);
    let (_, _, iw, _) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);
    frame.2 / iw * 14.0
}

fn start_drag(state: &mut State, mode: DragMode, p: (f32, f32)) {
    state.drag_mode = mode;
    state.drag_all = state
        .selection
        .iter()
        .filter_map(|s| selection_geom(&state.scene, state.floor, *s).map(|g| (*s, g)))
        .collect();
    state.drag_orig =
        primary_selection(state).and_then(|s| selection_geom(&state.scene, state.floor, s));
    let center = state.drag_orig.map(geom_center).unwrap_or(p);
    state.drag_grab = (p.0 - center.0, p.1 - center.1);
    state.drag_dirty = false;
}

fn apply_drag(state: &mut State, cursor: (f32, f32)) {
    let Some(orig) = state.drag_orig else {
        return;
    };
    let floor_index = state.floor;
    match state.drag_mode {
        DragMode::Move => {
            let c = geom_center(orig);
            let target = (cursor.0 - state.drag_grab.0, cursor.1 - state.drag_grab.1);
            let (dx, dy) = (target.0 - c.0, target.1 - c.1);
            if !state.drag_dirty {
                push_undo(state);
                state.drag_dirty = true;
            }
            for (sel, geom) in &state.drag_all {
                let moved = translate_geom(*geom, dx, dy);
                set_selection_geom(&mut state.scene, floor_index, *sel, moved);
            }
        }
        DragMode::Scale(corner) => {
            let Some(sel) = primary_selection(state) else {
                return;
            };
            if !state.drag_dirty {
                push_undo(state);
                state.drag_dirty = true;
            }
            let geom = scale_geom(orig, cursor, corner);
            set_selection_geom(&mut state.scene, floor_index, sel, geom);
        }
        DragMode::Rotate => {
            let Some(sel) = primary_selection(state) else {
                return;
            };
            if !state.drag_dirty {
                push_undo(state);
                state.drag_dirty = true;
            }
            let geom = rotate_geom(orig, cursor, state.snap);
            set_selection_geom(&mut state.scene, floor_index, sel, geom);
        }
        _ => {}
    }
    if state.drag_dirty {
        state.wall_plans_dirty = true;
    }
}

fn select_press(state: &mut State, p: (f32, f32), shift: bool) {
    let floor_index = state.floor;
    let tol = handle_tol(state);
    let hit = pick_object(&state.scene, floor_index, p);
    if !shift {
        if let Some(sel) = primary_selection(state) {
            if let Some(geom) = selection_geom(&state.scene, floor_index, sel) {
                if let Some(rh) = geom_rotate_handle(geom) {
                    if ((p.0 - rh.0).powi(2) + (p.1 - rh.1).powi(2)).sqrt() <= tol {
                        start_drag(state, DragMode::Rotate, p);
                        return;
                    }
                }
                for (i, c) in geom_corners(geom).iter().enumerate() {
                    if ((p.0 - c.0).powi(2) + (p.1 - c.1).powi(2)).sqrt() <= tol {
                        start_drag(state, DragMode::Scale(i), p);
                        return;
                    }
                }
                // Only move the current selection when the click actually
                // targets it; otherwise a click on an object inside a selected
                // room would move the room instead of selecting that object.
                if hit == Some(sel) && geom_hit(geom, p, tol) {
                    start_drag(state, DragMode::Move, p);
                    return;
                }
            }
        }
    }
    match hit {
        Some(sel) => {
            if shift {
                if let Some(pos) = state.selection.iter().position(|s| *s == sel) {
                    state.selection.remove(pos);
                } else {
                    state.selection.push(sel);
                }
                state.drag_mode = DragMode::None;
            } else {
                if !state.selection.contains(&sel) {
                    state.selection = vec![sel];
                }
                start_drag(state, DragMode::Move, p);
            }
        }
        None => {
            if !shift {
                state.selection.clear();
                // Empty space: a left drag pans the map instead of doing nothing.
                state.drag_mode = DragMode::None;
                state.dragging = true;
            } else {
                state.drag_mode = DragMode::None;
            }
        }
    }
}

#[derive(Clone, Copy)]
enum LinkTarget {
    Stair(u32),
    Item(u32),
    Door(u32),
    Trigger(u32),
    Region(u32),
}

fn pick_link_target(scene: &Scene, floor_index: usize, p: (f32, f32)) -> Option<LinkTarget> {
    const REACH: f32 = 44.0;
    let floor = &scene.floors[floor_index];
    let mut best: Option<(f32, LinkTarget)> = None;
    let mut consider = |d: f32, t: LinkTarget| {
        if d <= REACH && best.as_ref().is_none_or(|(bd, _)| d < *bd) {
            best = Some((d, t));
        }
    };
    for s in &floor.stairs {
        consider(
            ((p.0 - s.pos.0).powi(2) + (p.1 - s.pos.1).powi(2)).sqrt(),
            LinkTarget::Stair(s.id),
        );
    }
    for it in &floor.items {
        consider(
            ((p.0 - it.pos.0).powi(2) + (p.1 - it.pos.1).powi(2)).sqrt(),
            LinkTarget::Item(it.id),
        );
    }
    for d in &floor.doors {
        consider(
            dist_to_box(p, d.center, (DOOR_LONG_PX, DOOR_THICK_PX), d.rot),
            LinkTarget::Door(d.id),
        );
    }
    for t in &floor.triggers {
        consider(dist_to_rect(p, t.rect), LinkTarget::Trigger(t.id));
    }
    for r in &floor.regions {
        consider(dist_to_rect(p, r.rect), LinkTarget::Region(r.id));
    }
    best.map(|(_, t)| t)
}

fn connect_press(state: &mut State, p: (f32, f32)) {
    let floor_index = state.floor;
    let Some(target) = pick_link_target(&state.scene, floor_index, p) else {
        state.pending_link = None;
        set_status(state, "link cleared");
        return;
    };
    match (state.pending_link, target) {
        (Some(PendingLink::Stair(f, a)), LinkTarget::Stair(b)) => {
            // A stair link joins two different floors (and never a node to itself).
            if f == floor_index {
                state.pending_link = None;
                set_status(state, "stairs must be on different floors");
            } else {
                let link = Link::Stair {
                    a_floor: f as u8,
                    a_id: a,
                    b_floor: floor_index as u8,
                    b_id: b,
                };
                push_unique_link(state, floor_index, link, "stairs linked");
            }
        }
        // Reveal links: a door / item / trigger reveals a region, either order.
        (Some(PendingLink::Door(f, d)), LinkTarget::Region(r)) => {
            let link = Link::DoorRegion {
                door_floor: f as u8,
                door_id: d,
                region_floor: floor_index as u8,
                region_id: r,
            };
            push_unique_link(state, floor_index, link, "door -> region linked");
        }
        (Some(PendingLink::Region(f, r)), LinkTarget::Door(d)) => {
            let link = Link::DoorRegion {
                door_floor: floor_index as u8,
                door_id: d,
                region_floor: f as u8,
                region_id: r,
            };
            push_unique_link(state, floor_index, link, "door -> region linked");
        }
        (Some(PendingLink::Item(f, i)), LinkTarget::Region(r)) => {
            let link = Link::ItemRegion {
                item_floor: f as u8,
                item_id: i,
                region_floor: floor_index as u8,
                region_id: r,
            };
            push_unique_link(state, floor_index, link, "item -> region linked");
        }
        (Some(PendingLink::Region(f, r)), LinkTarget::Item(i)) => {
            let link = Link::ItemRegion {
                item_floor: floor_index as u8,
                item_id: i,
                region_floor: f as u8,
                region_id: r,
            };
            push_unique_link(state, floor_index, link, "item -> region linked");
        }
        (Some(PendingLink::Trigger(f, t)), LinkTarget::Region(r)) => {
            let link = Link::TriggerRegion {
                trigger_floor: f as u8,
                trigger_id: t,
                region_floor: floor_index as u8,
                region_id: r,
            };
            push_unique_link(state, floor_index, link, "trigger -> region linked");
        }
        (Some(PendingLink::Region(f, r)), LinkTarget::Trigger(t)) => {
            let link = Link::TriggerRegion {
                trigger_floor: floor_index as u8,
                trigger_id: t,
                region_floor: f as u8,
                region_id: r,
            };
            push_unique_link(state, floor_index, link, "trigger -> region linked");
        }
        // Key <-> door links work in either click order.
        (Some(PendingLink::Item(f, a)), LinkTarget::Door(d)) => {
            link_key_door(state, floor_index, f, a, floor_index, d);
        }
        (Some(PendingLink::Door(f, d)), LinkTarget::Item(a)) => {
            link_key_door(state, floor_index, floor_index, a, f, d);
        }
        (_, LinkTarget::Stair(id)) => {
            state.pending_link = Some(PendingLink::Stair(floor_index, id));
            set_status(state, "stair picked - pick another");
        }
        (_, LinkTarget::Item(id)) => {
            state.pending_link = Some(PendingLink::Item(floor_index, id));
            set_status(state, "item picked - pick a door or region");
        }
        (_, LinkTarget::Door(id)) => {
            state.pending_link = Some(PendingLink::Door(floor_index, id));
            set_status(state, "door picked - pick a key item or region");
        }
        (_, LinkTarget::Trigger(id)) => {
            state.pending_link = Some(PendingLink::Trigger(floor_index, id));
            set_status(state, "trigger picked - pick a region");
        }
        (_, LinkTarget::Region(id)) => {
            state.pending_link = Some(PendingLink::Region(floor_index, id));
            set_status(state, "region picked - pick a door, item or trigger");
        }
    }
}

// Push `link` if none equal exists, re-bake and report.
fn push_unique_link(state: &mut State, floor_index: usize, link: Link, status: &str) -> bool {
    let duplicate = state.scene.floors.iter().any(|f| f.links.contains(&link));
    state.pending_link = None;
    if duplicate {
        set_status(state, "already linked");
        return false;
    }
    push_undo(state);
    state.scene.floors[floor_index].links.push(link);
    rebuild_assets(state);
    set_status(state, status);
    true
}

// Link a key item to a door and re-bake. Floors are stored per endpoint.
fn link_key_door(
    state: &mut State,
    floor_index: usize,
    item_floor: usize,
    item_id: u32,
    door_floor: usize,
    door_id: u32,
) {
    let link = Link::KeyDoor {
        item_floor: item_floor as u8,
        item_id,
        door_floor: door_floor as u8,
        door_id,
    };
    push_unique_link(state, floor_index, link, "key <-> door linked");
}

fn delete_selection(state: &mut State) {
    if state.selection.is_empty() {
        return;
    }
    push_undo(state);
    let selected = state.selection.clone();
    let floor = &mut state.scene.floors[state.floor];
    let mut walls = Vec::new();
    let mut partitions = Vec::new();
    let mut obstacles = Vec::new();
    let mut doors = Vec::new();
    let mut stairs = Vec::new();
    let mut items = Vec::new();
    let mut labels = Vec::new();
    let mut regions = Vec::new();
    let mut triggers = Vec::new();
    for sel in selected {
        match sel {
            Selection::Wall(i) => walls.push(i),
            Selection::Partition(i) => partitions.push(i),
            Selection::Obstacle(i) => obstacles.push(i),
            Selection::Door(i) => doors.push(i),
            Selection::Stair(i) => stairs.push(i),
            Selection::Item(i) => items.push(i),
            Selection::Label(i) => labels.push(i),
            Selection::Region(i) => regions.push(i),
            Selection::Trigger(i) => triggers.push(i),
        }
    }
    remove_desc(&mut floor.walls, walls);
    remove_desc(&mut floor.partitions, partitions);
    remove_desc(&mut floor.obstacles, obstacles);
    remove_desc(&mut floor.doors, doors);
    remove_desc(&mut floor.stairs, stairs);
    remove_desc(&mut floor.items, items);
    remove_desc(&mut floor.labels, labels);
    remove_desc(&mut floor.regions, regions);
    remove_desc(&mut floor.triggers, triggers);
    state.selection.clear();
    rebuild_assets(state);
    set_status(state, "deleted");
}

fn remove_desc<T>(vec: &mut Vec<T>, mut indices: Vec<usize>) {
    indices.sort_unstable_by(|a, b| b.cmp(a));
    for i in indices {
        if i < vec.len() {
            vec.remove(i);
        }
    }
}

fn copy_selection(state: &mut State) {
    if state.selection.is_empty() {
        return;
    }
    let selected = state.selection.clone();
    let floor = &state.scene.floors[state.floor];
    state.clipboard = selected
        .into_iter()
        .filter_map(|sel| match sel {
            Selection::Wall(i) => floor.walls.get(i).map(|w| Clip::Wall(*w)),
            Selection::Partition(i) => floor.partitions.get(i).map(|w| Clip::Partition(*w)),
            Selection::Obstacle(i) => floor.obstacles.get(i).map(|o| Clip::Obstacle(*o)),
            Selection::Door(i) => floor.doors.get(i).map(|d| Clip::Door(*d)),
            Selection::Stair(i) => floor.stairs.get(i).map(|s| Clip::Stair(*s)),
            Selection::Item(i) => floor.items.get(i).map(|it| Clip::Item(it.clone())),
            Selection::Label(i) => floor.labels.get(i).map(|l| Clip::Label(l.clone())),
            Selection::Region(i) => floor.regions.get(i).map(|r| Clip::Region(r.clone())),
            Selection::Trigger(i) => floor.triggers.get(i).map(|t| Clip::Trigger(*t)),
        })
        .collect();
    set_status(state, format!("copied {}", state.clipboard.len()));
}

fn paste_clipboard(state: &mut State, at: Option<(f32, f32)>) {
    if state.clipboard.is_empty() {
        set_status(state, "clipboard empty");
        return;
    }
    push_undo(state);
    let clips = state.clipboard.clone();
    for (n, clip) in clips.into_iter().enumerate() {
        let id = state.next_id;
        state.next_id += 1;
        let step = n as f32 * 18.0;
        let floor = &mut state.scene.floors[state.floor];
        match clip {
            Clip::Wall(mut w) => {
                let c = (w.rect.x + w.rect.w * 0.5, w.rect.y + w.rect.h * 0.5);
                let to = at.unwrap_or((c.0 + 24.0 + step, c.1 + 24.0 + step));
                w.rect.x += to.0 - c.0;
                w.rect.y += to.1 - c.1;
                floor.walls.push(w);
            }
            Clip::Partition(mut w) => {
                let c = (w.rect.x + w.rect.w * 0.5, w.rect.y + w.rect.h * 0.5);
                let to = at.unwrap_or((c.0 + 24.0 + step, c.1 + 24.0 + step));
                w.rect.x += to.0 - c.0;
                w.rect.y += to.1 - c.1;
                floor.partitions.push(w);
            }
            Clip::Obstacle(mut o) => {
                o.id = id;
                o.center = at.unwrap_or((o.center.0 + 24.0 + step, o.center.1 + 24.0 + step));
                floor.obstacles.push(o);
            }
            Clip::Door(mut d) => {
                d.id = id;
                d.center = at.unwrap_or((d.center.0 + 24.0 + step, d.center.1 + 24.0 + step));
                floor.doors.push(d);
            }
            Clip::Stair(mut s) => {
                s.id = id;
                s.pos = at.unwrap_or((s.pos.0 + 24.0 + step, s.pos.1 + 24.0 + step));
                floor.stairs.push(s);
            }
            Clip::Item(mut it) => {
                it.id = id;
                it.pos = at.unwrap_or((it.pos.0 + 24.0 + step, it.pos.1 + 24.0 + step));
                floor.items.push(it);
            }
            Clip::Label(mut l) => {
                l.pos = at.unwrap_or((l.pos.0 + 24.0 + step, l.pos.1 + 24.0 + step));
                floor.labels.push(l);
            }
            Clip::Region(mut r) => {
                r.id = id;
                let c = (r.rect.x + r.rect.w * 0.5, r.rect.y + r.rect.h * 0.5);
                let to = at.unwrap_or((c.0 + 24.0 + step, c.1 + 24.0 + step));
                r.rect.x += to.0 - c.0;
                r.rect.y += to.1 - c.1;
                floor.regions.push(r);
            }
            Clip::Trigger(mut t) => {
                t.id = id;
                let c = (t.rect.x + t.rect.w * 0.5, t.rect.y + t.rect.h * 0.5);
                let to = at.unwrap_or((c.0 + 24.0 + step, c.1 + 24.0 + step));
                t.rect.x += to.0 - c.0;
                t.rect.y += to.1 - c.1;
                floor.triggers.push(t);
            }
        }
    }
    rebuild_assets(state);
    set_status(state, "pasted");
}

// Cycle the selected region's authored visibility between Hidden and Revealed.
fn toggle_region_visibility(state: &mut State) {
    match primary_selection(state) {
        Some(Selection::Region(i)) => {
            if let Some(r) = state.scene.floors[state.floor].regions.get_mut(i) {
                r.initial = match r.initial {
                    RegionState::Hidden => RegionState::Revealed,
                    _ => RegionState::Hidden,
                };
                let label = if r.initial == RegionState::Hidden {
                    "hidden"
                } else {
                    "revealed"
                };
                set_status(state, format!("region {label}"));
            }
        }
        _ => set_status(state, "select a region first"),
    }
}

fn start_rename(state: &mut State) {
    match primary_selection(state) {
        Some(Selection::Item(i)) => {
            if let Some(it) = state.scene.floors[state.floor].items.get(i) {
                state.rename = Some(it.name.clone());
                set_status(state, "type a name, Enter to accept");
            }
        }
        Some(Selection::Label(i)) => {
            if let Some(l) = state.scene.floors[state.floor].labels.get(i) {
                state.rename = Some(l.name.clone());
                set_status(state, "type a name, Enter to accept");
            }
        }
        Some(Selection::Region(i)) => {
            if let Some(r) = state.scene.floors[state.floor].regions.get(i) {
                state.rename = Some(r.name.clone());
                set_status(state, "type a name, Enter to accept");
            }
        }
        _ => set_status(state, "select an item, label or region to rename"),
    }
}

fn commit_rename(state: &mut State) {
    let Some(name) = state.rename.take() else {
        return;
    };
    match primary_selection(state) {
        Some(Selection::Item(i)) => {
            if let Some(it) = state.scene.floors[state.floor].items.get_mut(i) {
                it.name = name;
            }
            rebuild_assets(state);
            set_status(state, "renamed");
        }
        Some(Selection::Label(i)) => {
            if let Some(l) = state.scene.floors[state.floor].labels.get_mut(i) {
                l.name = name;
            }
            set_status(state, "renamed");
        }
        Some(Selection::Region(i)) => {
            if let Some(r) = state.scene.floors[state.floor].regions.get_mut(i) {
                r.name = name;
            }
            set_status(state, "renamed");
        }
        _ => {}
    }
}

fn editor_clear_floor(state: &mut State) {
    push_undo(state);
    let floor = &mut state.scene.floors[state.floor];
    floor.walls.clear();
    floor.partitions.clear();
    floor.obstacles.clear();
    floor.doors.clear();
    floor.stairs.clear();
    floor.items.clear();
    floor.labels.clear();
    floor.regions.clear();
    floor.triggers.clear();
    floor.links.clear();
    rebuild_assets(state);
    set_status(state, "floor cleared");
}

fn editor_toolbar_hit(x: f32, y: f32) -> Option<usize> {
    for i in 0..Tool::ALL.len() {
        let (bx, by, bw, bh) = editor_button_rect(i);
        if (bx..bx + bw).contains(&x) && (by..by + bh).contains(&y) {
            return Some(i);
        }
    }
    None
}

fn editor_undo(state: &mut State) {
    if let Some(prev) = state.undo.pop() {
        state.scene = prev;
        rebuild_assets(state);
        set_status(state, "undo");
    }
}

fn save_scene(state: &mut State) {
    let bytes = state.scene.to_bytes();
    if save_scene_bytes(&bytes) {
        set_status(
            state,
            format!("saved {} ({} bytes)", scene_save_label(), bytes.len()),
        );
    } else {
        set_status(state, "save failed");
    }
}

#[cfg(target_os = "emscripten")]
fn scene_save_label() -> &'static str {
    "scene.bin (download + localStorage)"
}

#[cfg(not(target_os = "emscripten"))]
fn scene_save_label() -> &'static str {
    "assets/scene.bin"
}

fn load_scene(state: &mut State) {
    match load_scene_bytes().and_then(|b| Scene::from_bytes(&b)) {
        Some(scene) => {
            push_undo(state);
            state.scene = scene;
            state.next_id = max_id(&state.scene) + 1;
            rebuild_assets(state);
            set_status(state, "scene loaded");
        }
        None => set_status(state, "no scene found"),
    }
}

#[cfg(target_os = "emscripten")]
fn save_scene_bytes(bytes: &[u8]) -> bool {
    if std::fs::write("/scene.bin", bytes).is_err() {
        return false;
    }
    extern "C" {
        fn emscripten_run_script(script: *const ffi::c_char);
    }
    let script = b"window.inkRibbonPersistScene && window.inkRibbonPersistScene();\0";
    unsafe { emscripten_run_script(script.as_ptr() as *const ffi::c_char) };
    true
}

#[cfg(not(target_os = "emscripten"))]
fn save_scene_bytes(bytes: &[u8]) -> bool {
    // Write the committed source in place when run via the npm scripts (cwd =
    // native/), otherwise fall back to the working directory.
    let path = if std::path::Path::new("assets").is_dir() {
        "assets/scene.bin"
    } else {
        "scene.bin"
    };
    std::fs::write(path, bytes).is_ok()
}

fn load_scene_bytes() -> Option<Vec<u8>> {
    #[cfg(target_os = "emscripten")]
    {
        extern "C" {
            fn emscripten_run_script_int(script: *const ffi::c_char) -> i32;
        }
        let script = b"window.inkRibbonLoadScene ? window.inkRibbonLoadScene() : 0\0";
        let ok = unsafe { emscripten_run_script_int(script.as_ptr() as *const ffi::c_char) };
        if ok == 0 {
            return None;
        }
    }
    std::fs::read("assets/scene.bin")
        .or_else(|_| std::fs::read("scene.bin"))
        .ok()
}

// --- Save slots ------------------------------------------------------------

#[cfg(not(target_os = "emscripten"))]
fn slot_path(slot: usize) -> String {
    format!("saves/slot-{}.bin", slot + 1)
}

#[cfg(target_os = "emscripten")]
fn slot_guest_path(slot: usize) -> String {
    format!("/save-{}.bin", slot + 1)
}

#[cfg(target_os = "emscripten")]
fn run_script(script: String) {
    extern "C" {
        fn emscripten_run_script(s: *const ffi::c_char);
    }
    if let Ok(c) = ffi::CString::new(script) {
        unsafe { emscripten_run_script(c.as_ptr()) };
    }
}

#[cfg(target_os = "emscripten")]
fn run_script_int(script: String) -> i32 {
    extern "C" {
        fn emscripten_run_script_int(s: *const ffi::c_char) -> i32;
    }
    match ffi::CString::new(script) {
        Ok(c) => unsafe { emscripten_run_script_int(c.as_ptr()) },
        Err(_) => 0,
    }
}

#[cfg(target_os = "emscripten")]
fn save_slot_bytes(slot: usize, bytes: &[u8]) -> bool {
    if std::fs::write(slot_guest_path(slot), bytes).is_err() {
        return false;
    }
    run_script(format!("window.inkRibbonPersistSlot({})", slot + 1));
    true
}

#[cfg(not(target_os = "emscripten"))]
fn save_slot_bytes(slot: usize, bytes: &[u8]) -> bool {
    if std::fs::create_dir_all("saves").is_err() {
        return false;
    }
    std::fs::write(slot_path(slot), bytes).is_ok()
}

#[cfg(target_os = "emscripten")]
fn load_slot_bytes(slot: usize) -> Option<Vec<u8>> {
    if run_script_int(format!("window.inkRibbonLoadSlot({})", slot + 1)) == 0 {
        return None;
    }
    std::fs::read(slot_guest_path(slot)).ok()
}

#[cfg(not(target_os = "emscripten"))]
fn load_slot_bytes(slot: usize) -> Option<Vec<u8>> {
    std::fs::read(slot_path(slot)).ok()
}

#[cfg(target_os = "emscripten")]
fn slot_exists(slot: usize) -> bool {
    run_script_int(format!("window.inkRibbonHasSlot({})", slot + 1)) != 0
}

#[cfg(not(target_os = "emscripten"))]
fn slot_exists(slot: usize) -> bool {
    std::path::Path::new(&slot_path(slot)).is_file()
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn format_play_time(t: f32) -> String {
    let s = t.max(0.0) as u64;
    format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
}

fn refresh_slot_meta(state: &mut State) {
    for slot in 0..SAVE_SLOTS {
        state.slot_meta[slot] = if slot_exists(slot) {
            load_slot_bytes(slot)
                .and_then(|b| PlayerSave::from_bytes(&b))
                .map(|s| SlotMeta {
                    saved_at: s.saved_at,
                    play_time: s.play_time,
                    floor: s.player_floor,
                    items: s.inventory.len() + s.item_box.len(),
                })
        } else {
            None
        };
    }
}

fn open_menu(state: &mut State, menu: Menu) {
    state.menu = menu;
    state.menu_index = 0;
    state.confirm = None;
    state.confirm_index = 0;
    state.inventory_open = false;
    if matches!(menu, Menu::SaveSlots | Menu::LoadSlots) {
        refresh_slot_meta(state);
    }
}

fn ink_ribbon_count(state: &State) -> usize {
    state
        .inventory
        .iter()
        .filter(|it| it.kind == ItemKind::InkRibbon)
        .count()
}

// Space in play mode: act on the nearest interactable.
fn interact(state: &mut State) -> bool {
    // No interacting mid-move; the turn resolves when the move lands.
    if state.move_anim.is_some() {
        return false;
    }
    match interaction_target(state) {
        Some(Interaction::Typewriter(_)) => {
            if ink_ribbon_count(state) == 0 {
                set_status(state, "need an ink-ribbon to save");
                return false;
            }
            open_menu(state, Menu::SaveSlots);
            set_status(state, "choose a slot to save");
            true
        }
        Some(Interaction::ItemBox(_)) => {
            open_item_box(state);
            set_status(state, "item box open");
            true
        }
        Some(Interaction::Item { id, name, .. }) => {
            collect_item(state, id, &name);
            true
        }
        Some(Interaction::Door { id, .. }) => {
            unlock_door(state, id);
            true
        }
        None => {
            set_status(state, "nothing to interact with");
            false
        }
    }
}

fn door_exists(state: &State, floor: usize, id: u32) -> bool {
    state
        .scene
        .floors
        .get(floor)
        .is_some_and(|f| f.doors.iter().any(|d| d.id == id))
}

fn region_exists(state: &State, floor: usize, id: u32) -> bool {
    state
        .scene
        .floors
        .get(floor)
        .is_some_and(|f| f.regions.iter().any(|r| r.id == id))
}

fn do_save(state: &mut State, slot: usize) {
    // Each save consumes one ink-ribbon; consume before snapshotting so the
    // saved inventory reflects the cost.
    let Some(idx) = state
        .inventory
        .iter()
        .position(|it| it.kind == ItemKind::InkRibbon)
    else {
        set_status(state, "need an ink-ribbon to save");
        return;
    };
    let ribbon = state.inventory.remove(idx);
    let save = PlayerSave {
        player_floor: state.player_floor,
        player: state.player,
        collected: state.collected.clone(),
        revealed: state.revealed.clone(),
        unlocked: state.unlocked.clone(),
        inventory: state.inventory.clone(),
        item_box: state.item_box.clone(),
        visited: state.visited.clone(),
        revealed_regions: state.revealed_regions.clone(),
        steps: state.steps,
        turn: state.turn,
        play_time: state.play_time,
        saved_at: now_unix(),
    };
    if !save_slot_bytes(slot, &save.to_bytes()) {
        state.inventory.insert(idx, ribbon);
        set_status(state, "save failed");
        return;
    }
    refresh_slot_meta(state);
    state.menu = Menu::None;
    set_status(state, format!("saved to slot {}", slot + 1));
}

fn apply_save(state: &mut State, save: PlayerSave) {
    let floor = save.player_floor.min(NUM_FLOORS - 1);
    state.player_floor = floor;
    state.floor = floor;
    state.player = save.player;
    state.collected = save.collected;
    state.revealed = save
        .revealed
        .into_iter()
        .filter(|(f, id)| door_exists(state, *f, *id))
        .collect();
    state.unlocked = save
        .unlocked
        .into_iter()
        .filter(|(f, id)| door_exists(state, *f, *id))
        .collect();
    state.visited = save
        .visited
        .into_iter()
        .filter(|(f, id)| region_exists(state, *f, *id))
        .collect();
    state.revealed_regions = save
        .revealed_regions
        .into_iter()
        .filter(|(f, id)| region_exists(state, *f, *id))
        .collect();
    state.fired_triggers.clear();
    state.steps = save.steps;
    state.turn = save.turn;
    state.inventory = save.inventory;
    state.inventory_selected = 0;
    state.item_box = save.item_box;
    state.item_box_cursor = 0;
    state.play_time = save.play_time;
    clear_goal_route(state);
    state.menu = Menu::None;
    state.inventory_open = false;
    state.pending_floor = None;
    state.pending_spawn = None;
    state.transition_t = 0.0;
    state.stair_lock = false;
    rebuild_assets(state);
    notify_floor(floor);
    if let Some(cell) = snap_source(&state.nav[floor], state.player.0, state.player.1) {
        state.player = cell_to_source(&state.nav[floor], cell.0, cell.1);
        state.player_cell = Some(cell);
        state.reachable[floor] = reachable_from(&state.nav[floor], cell);
    }
    pan_to_center_player(state);
    state.follow_target = (state.pan_target_x, state.pan_target_y);
    state.recentre = false;
}

fn do_load(state: &mut State, slot: usize) {
    let Some(save) = load_slot_bytes(slot).and_then(|b| PlayerSave::from_bytes(&b)) else {
        set_status(state, "load failed");
        return;
    };
    apply_save(state, save);
    set_status(state, format!("loaded slot {}", slot + 1));
}

fn pause_entry_count() -> usize {
    if cfg!(target_os = "emscripten") {
        3
    } else {
        4
    }
}

fn menu_activate(state: &mut State) {
    match state.menu {
        Menu::Pause => match state.menu_index {
            0 => state.menu = Menu::None,
            1 => open_menu(state, Menu::LoadSlots),
            2 => {
                state.menu = Menu::None;
                open_item_box(state);
            }
            _ => {
                state.confirm = Some(Confirm::Quit);
                state.confirm_index = 0;
            }
        },
        Menu::SaveSlots => {
            let slot = state.menu_index.min(SAVE_SLOTS - 1);
            if state.slot_meta[slot].is_some() {
                state.confirm = Some(Confirm::Overwrite(slot));
                state.confirm_index = 0;
            } else {
                do_save(state, slot);
            }
        }
        Menu::LoadSlots => {
            let slot = state.menu_index.min(SAVE_SLOTS - 1);
            if state.slot_meta[slot].is_some() {
                do_load(state, slot);
            }
        }
        Menu::None => {}
    }
}

fn confirm_activate(state: &mut State, yes: bool) {
    let Some(c) = state.confirm.take() else {
        return;
    };
    if !yes {
        return;
    }
    match c {
        Confirm::Overwrite(slot) => do_save(state, slot),
        Confirm::Quit => {
            #[cfg(not(target_os = "emscripten"))]
            sapp::request_quit();
            #[cfg(target_os = "emscripten")]
            set_status(state, "exit is unavailable in the browser");
        }
    }
}

// Panel controls consume the click; returns true if it was handled.
fn panel_click(state: &mut State, x: f32, y: f32) -> bool {
    let l = state.layout;

    // Floor bar.
    if (l.floor_x..l.floor_x + l.floor_w).contains(&x)
        && (l.floor_y..l.floor_y + l.floor_h).contains(&y)
    {
        // Portrait: arrows flank the row on the left/right. Landscape: above/below.
        let on_up = if l.portrait {
            (x - l.floor_up.0).abs() < 22.0
        } else {
            (x - l.floor_up.0).abs() < 40.0 && (y - l.floor_up.1).abs() < 20.0
        };
        let on_down = if l.portrait {
            (x - l.floor_down.0).abs() < 22.0
        } else {
            (x - l.floor_down.0).abs() < 40.0 && (y - l.floor_down.1).abs() < 20.0
        };
        if on_up {
            state.arrow_up_t = 0.001;
            let floor = (state.floor + NUM_FLOORS - 1) % NUM_FLOORS;
            change_floor(state, floor);
        } else if on_down {
            state.arrow_down_t = 0.001;
            let floor = (state.floor + 1) % NUM_FLOORS;
            change_floor(state, floor);
        } else {
            let slot = l
                .floor_markers
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    let da = if l.portrait { a.0 - x } else { a.1 - y };
                    let db = if l.portrait { b.0 - x } else { b.1 - y };
                    da.abs().total_cmp(&db.abs())
                })
                .map(|(i, _)| i)
                .unwrap_or(0);
            match slot.cmp(&floor_slot(state.floor)) {
                std::cmp::Ordering::Less => state.arrow_up_t = 0.001,
                std::cmp::Ordering::Greater => state.arrow_down_t = 0.001,
                std::cmp::Ordering::Equal => {}
            }
            change_floor(state, slot);
        }
        return true;
    }

    // Zoom bar (hidden in portrait / phone layout).
    if l.show_zoom
        && (l.zoom_x..l.zoom_x + l.zoom_w).contains(&x)
        && (l.zoom_y..l.zoom_y + l.zoom_h).contains(&y)
    {
        state.recentre = false;
        if l.portrait {
            if x < l.zoom_a.0 - 20.0 {
                state.zoom_target = (state.zoom_target - 0.12).max(ZOOM_MIN);
            } else if x > l.zoom_b.0 + 20.0 {
                state.zoom_target = (state.zoom_target + 0.12).min(ZOOM_MAX);
            } else {
                let t = ((x - l.zoom_a.0) / (l.zoom_b.0 - l.zoom_a.0)).clamp(0.0, 1.0);
                state.zoom_target = ZOOM_MIN + (ZOOM_MAX - ZOOM_MIN) * t;
            }
        } else if y < l.zoom_a.1 - 20.0 {
            state.zoom_target = (state.zoom_target + 0.12).min(ZOOM_MAX);
        } else if y > l.zoom_b.1 + 20.0 {
            state.zoom_target = (state.zoom_target - 0.12).max(ZOOM_MIN);
        } else {
            let t = ((y - l.zoom_b.1) / (l.zoom_a.1 - l.zoom_b.1)).clamp(0.0, 1.0);
            state.zoom_target = ZOOM_MIN + (ZOOM_MAX - ZOOM_MIN) * t;
        }
        capture_zoom_anchor(state);
        return true;
    }
    false
}

// A tap (not a drag): toggle/clear the route to the key item under the cursor.
// A tap in play mode spends the turn moving to the clicked move cell (or the
// nearest reachable cell when the tap lands just off one).
fn select_at(state: &mut State, x: f32, y: f32) {
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    if state.floor != state.player_floor
        || !(MAP_X..MAP_X + MAP_W).contains(&x)
        || !(MAP_Y..MAP_Y + MAP_H).contains(&y)
    {
        return;
    }
    let (hx, hy) = if state.cursor_mode == CursorMode::Centered {
        cursor_center(&state.layout)
    } else {
        (x, y)
    };
    let (sx, sy) = ref_to_source(state, (hx, hy));
    let cell = state.move_grid[state.player_floor].source_cell(sx, sy);
    start_move(state, cell);
}

// The move cell under the cursor (the centred cursor when in that mode), or None
// when the pointer is outside the map window.
fn cursor_source_cell(state: &State) -> Option<(i32, i32)> {
    let p = if state.cursor_mode == CursorMode::Centered {
        cursor_center(&state.layout)
    } else {
        state.mouse
    };
    if !in_map(&state.layout, p) {
        return None;
    }
    let (sx, sy) = ref_to_source(state, p);
    Some(state.move_grid[state.player_floor].source_cell(sx, sy))
}

// Refresh the hover rope when the cursor moves onto a new reachable cell.
fn update_hover(state: &mut State) {
    if state.edit || state.floor != state.player_floor || state.move_anim.is_some() {
        return;
    }
    let cell = match cursor_source_cell(state) {
        Some(c) => c,
        None => {
            state.hover_cell = None;
            state.hover_path.clear();
            return;
        }
    };
    if state.hover_cell == Some(cell) {
        return;
    }
    state.hover_cell = Some(cell);
    state.hover_path.clear();
    state.hover_run = false;
    let pf = state.player_floor;
    let dist = move_cell_dist(state, pf, cell);
    if dist == 0 || dist == u16::MAX || dist > RUN_CELLS {
        return;
    }
    let grid = &state.move_grid[pf];
    let start = grid.source_cell(state.player.0, state.player.1);
    let mut path = vec![state.player];
    {
        let cells = match state
            .astar
            .search_grid(grid.w, grid.h, start, cell, |x, y| grid.walkable(x, y))
        {
            Some(c) if c.len() >= 2 => c,
            _ => return,
        };
        for &(x, y) in cells.iter().skip(1) {
            path.push(grid.cell_source(x, y));
        }
    }
    state.hover_path = path;
    state.hover_run = dist > WALK_CELLS;
}

extern "C" fn event(event: *const sapp::Event, user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    let event = unsafe { &*event };
    match event._type {
        // Character input (text fields). sokol delivers these separately from
        // key-down, and char_code is only valid on char events (it is 0 on a
        // key-down), so text entry must be handled here.
        sapp::EventType::Char => {
            if let Some(buffer) = state.rename.as_mut() {
                if (32..127).contains(&event.char_code) && buffer.chars().count() < 40 {
                    if let Some(c) = char::from_u32(event.char_code) {
                        buffer.push(c);
                    }
                }
            }
        }
        sapp::EventType::MouseMove => {
            let (mx, my) = screen_to_ref(&state.layout, event.mouse_x, event.mouse_y);
            state.mouse = (mx, my);
            state.circle_cursor_hidden = false;
            state.mouse_in_map = in_map(&state.layout, (mx, my));
            if state.edit {
                // Panning: middle/right drag anywhere, or a left drag that did
                // not start on a tool/object (Select on empty space).
                if state.dragging {
                    if (mx - state.down_ref.0).abs() > 6.0 || (my - state.down_ref.1).abs() > 6.0 {
                        state.moved = true;
                    }
                    drag_by(state, event.mouse_dx, event.mouse_dy);
                    return;
                }
                // Door tools preview the snapped prop under the cursor.
                let src = ref_to_source(state, (mx, my));
                state.door_preview = if state.tool.is_door() {
                    snap_door_to_wall(state, src)
                } else {
                    None
                };
                match state.drag_mode {
                    DragMode::Create => {
                        let src = ref_to_source(state, (mx, my));
                        state.drag_to = Some(snap_point(state, src));
                    }
                    DragMode::Move | DragMode::Scale(_) => {
                        let src = snap_point(state, ref_to_source(state, (mx, my)));
                        apply_drag(state, src);
                    }
                    DragMode::Rotate => {
                        let src = ref_to_source(state, (mx, my));
                        apply_drag(state, src);
                    }
                    DragMode::None => {}
                }
                return;
            }
            if state.dragging {
                if (mx - state.down_ref.0).abs() > 6.0 || (my - state.down_ref.1).abs() > 6.0 {
                    state.moved = true;
                }
                drag_by(state, event.mouse_dx, event.mouse_dy);
            }
            if state.cursor_mode == CursorMode::Free && state.mouse_in_map {
                state.cursor = clamp_to_map(&state.layout, state.mouse);
            }
        }
        sapp::EventType::MouseLeave => state.mouse_in_map = false,
        sapp::EventType::MouseDown => {
            let (x, y) = screen_to_ref(&state.layout, event.mouse_x, event.mouse_y);
            if state.cursor_mode == CursorMode::Free {
                state.cursor = clamp_to_map(&state.layout, (x, y));
            }
            if state.edit {
                state.down_ref = (x, y);
                state.moved = false;
                // Middle/right button pans the map.
                if event.mouse_button != sapp::Mousebutton::Left {
                    state.dragging = true;
                    return;
                }
                if let Some(i) = editor_toolbar_hit(x, y) {
                    state.tool = Tool::ALL[i];
                    state.drag_mode = DragMode::None;
                    state.door_preview = None;
                    set_status(state, format!("tool {}", state.tool.label()));
                    return;
                }
                // Door / item properties popups consume clicks inside them.
                if door_popup_buttons(state).is_some() {
                    if let Some(hit) = door_popup_hit(state, x, y) {
                        apply_door_popup(state, hit);
                    }
                    if door_popup_buttons(state).is_some_and(|(_, panel)| {
                        (panel.0..panel.0 + panel.2).contains(&x)
                            && (panel.1..panel.1 + panel.3).contains(&y)
                    }) {
                        return;
                    }
                }
                if item_popup_buttons(state).is_some() {
                    if let Some(hit) = item_popup_hit(state, x, y) {
                        apply_item_popup(state, hit);
                    }
                    if item_popup_buttons(state).is_some_and(|(_, panel)| {
                        (panel.0..panel.0 + panel.2).contains(&x)
                            && (panel.1..panel.1 + panel.3).contains(&y)
                    }) {
                        return;
                    }
                }
                // Floor selector / zoom bar still work while editing.
                if panel_click(state, x, y) {
                    return;
                }
                // Clicking the name box focuses it for editing.
                if rename_box_hit(x, y) {
                    if state.rename.is_none() && selected_name(state).is_some() {
                        start_rename(state);
                    }
                    return;
                }
                let src = snap_point(state, ref_to_source(state, (x, y)));
                match state.tool {
                    Tool::Select => {
                        select_press(state, src, event.modifiers & sapp::MODIFIER_SHIFT != 0)
                    }
                    Tool::Connect => connect_press(state, src),
                    t if t.is_door() => {
                        // Click-to-place into the wall under the cursor.
                        if let Some((cx, cy, rot)) = snap_door_to_wall(state, src) {
                            place_door(state, (cx, cy), rot);
                        }
                    }
                    _ => {
                        state.drag_mode = DragMode::Create;
                        state.drag_from = Some(src);
                        state.drag_to = Some(src);
                    }
                }
                return;
            }
            if let Some(hit) = menu_hit(state, x, y) {
                match hit {
                    MenuHit::Entry(i) => {
                        state.menu_index = i;
                        menu_activate(state);
                    }
                    MenuHit::Yes => confirm_activate(state, true),
                    MenuHit::No => confirm_activate(state, false),
                }
                return;
            }
            if state.menu != Menu::None || state.confirm.is_some() {
                // Clicking outside an open menu does nothing.
                return;
            }
            if let Some(slot) = item_box_hit(state, x, y) {
                // Clicking an occupied slot moves it to the other side; an empty
                // slot just moves the cursor there.
                state.item_box_cursor = slot;
                if item_box_slot_item(state, slot).is_some() {
                    transfer_box_item(state);
                }
                return;
            }
            if let Some(slot) = inventory_hit(state, x, y) {
                state.inventory_selected = slot;
                return;
            }
            if panel_click(state, x, y) {
                state.dragging = false;
            } else {
                state.down_ref = (x, y);
                state.moved = false;
                state.dragging = true;
            }
        }
        sapp::EventType::MouseUp => {
            if state.edit {
                if state.dragging {
                    state.dragging = false;
                    return;
                }
                match state.drag_mode {
                    DragMode::Create => {
                        if let Some(a) = state.drag_from.take() {
                            let b = state.drag_to.take().unwrap_or(a);
                            if state.tool == Tool::Erase {
                                editor_erase(state, a);
                            } else if state.tool.is_rect() {
                                place_rect(state, a, b);
                            } else {
                                place_point(state, a);
                            }
                        }
                    }
                    DragMode::Move | DragMode::Scale(_) | DragMode::Rotate => {
                        if state.drag_dirty {
                            // Labels are not baked, so moving one needs no rebuild.
                            let labels_only = !state.selection.is_empty()
                                && state
                                    .selection
                                    .iter()
                                    .all(|s| matches!(s, Selection::Label(_)));
                            if !labels_only {
                                rebuild_assets(state);
                            }
                            set_status(state, "updated");
                        }
                    }
                    DragMode::None => {}
                }
                state.drag_mode = DragMode::None;
                state.drag_orig = None;
                state.drag_all.clear();
                state.drag_dirty = false;
                state.drag_from = None;
                state.drag_to = None;
                return;
            }
            let was_drag = state.moved;
            state.dragging = false;
            if !was_drag {
                let (x, y) = screen_to_ref(&state.layout, event.mouse_x, event.mouse_y);
                select_at(state, x, y);
            }
        }
        sapp::EventType::TouchesBegan => {
            state.touch_seen = true;
            // A touch landing on the thumbstick base is captured by the stick.
            if show_stick(state) && state.stick_id.is_none() {
                let l = state.layout;
                let grab = l.stick_radius * STICK_GRAB;
                let n = event.num_touches.clamp(0, event.touches.len() as i32) as usize;
                for t in &event.touches[..n] {
                    if !t.changed {
                        continue;
                    }
                    let p = screen_to_ref(&l, t.pos_x, t.pos_y);
                    let dx = p.0 - l.stick_center.0;
                    let dy = p.1 - l.stick_center.1;
                    if dx * dx + dy * dy <= grab * grab {
                        state.stick_id = Some(t.identifier);
                        state.stick_vec = (0.0, 0.0);
                        state.recentre = true;
                        state.circle_cursor_hidden = true;
                        state.moved = true;
                        state.dragging = false;
                        break;
                    }
                }
            }
            if state.stick_id.is_none() && event.num_touches >= 2 {
                // Two fingers: pinch to zoom (and pan with the midpoint).
                let (mid_px, dist) = touch_pinch(&event.touches[..2]);
                state.pinching = true;
                state.dragging = false;
                state.moved = true;
                state.recentre = false;
                state.pinch_dist = dist.max(1.0);
                state.pinch_base_zoom = state.zoom_target;
                let mid = screen_to_ref(&state.layout, mid_px.0, mid_px.1);
                let frame = floor_frame(state.floor);
                let (ox, oy, iw, ih) =
                    map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);
                state.pinch_src = (
                    frame.0 + (mid.0 - ox) * frame.2 / iw,
                    frame.1 + (mid.1 - oy) * frame.3 / ih,
                );
                state.zoom_anchor = Some(ZoomAnchor {
                    src: state.pinch_src,
                    cursor_ref: mid,
                    end: state.zoom_target,
                });
                state.mouse = mid;
                if state.cursor_mode == CursorMode::Free {
                    state.cursor = clamp_to_map(&state.layout, mid);
                    state.mouse_in_map = in_map(&state.layout, mid);
                }
            } else if let Some(t) = primary_touch(event, state.stick_id) {
                let t = (t.pos_x, t.pos_y);
                state.touch_last = t;
                let (x, y) = screen_to_ref(&state.layout, t.0, t.1);
                state.mouse = (x, y);
                state.mouse_in_map = in_map(&state.layout, (x, y));
                if state.cursor_mode == CursorMode::Free {
                    state.cursor = clamp_to_map(&state.layout, (x, y));
                }
                if panel_click(state, x, y) {
                    state.dragging = false;
                } else {
                    state.down_ref = (x, y);
                    state.moved = false;
                    state.dragging = true;
                }
            }
        }
        sapp::EventType::TouchesMoved => {
            // Track the captured thumbstick finger.
            if let Some(id) = state.stick_id {
                let l = state.layout;
                let n = event.num_touches.clamp(0, event.touches.len() as i32) as usize;
                if let Some(t) = event.touches[..n].iter().find(|t| t.identifier == id) {
                    let p = screen_to_ref(&l, t.pos_x, t.pos_y);
                    state.stick_vec = stick_vector(
                        (p.0 - l.stick_center.0, p.1 - l.stick_center.1),
                        l.stick_radius,
                        STICK_DEADZONE,
                    );
                }
            }
            if state.pinching && state.stick_id.is_none() && event.num_touches >= 2 {
                state.recentre = false;
                let (mid_px, dist) = touch_pinch(&event.touches[..2]);
                let mid = screen_to_ref(&state.layout, mid_px.0, mid_px.1);
                let factor = dist / state.pinch_dist;
                state.zoom_target = (state.pinch_base_zoom * factor).clamp(ZOOM_MIN, ZOOM_MAX);
                state.zoom_anchor = Some(ZoomAnchor {
                    src: state.pinch_src,
                    cursor_ref: mid,
                    end: state.zoom_target,
                });
                state.mouse = mid;
                if state.cursor_mode == CursorMode::Free {
                    state.cursor = clamp_to_map(&state.layout, mid);
                    state.mouse_in_map = in_map(&state.layout, mid);
                }
            } else if !state.pinching {
                if let Some(t) = primary_touch(event, state.stick_id) {
                    let t = (t.pos_x, t.pos_y);
                    if state.dragging {
                        let dx = t.0 - state.touch_last.0;
                        let dy = t.1 - state.touch_last.1;
                        if dx.abs() + dy.abs() > 3.0 {
                            state.moved = true;
                        }
                        drag_by(state, dx, dy);
                    }
                    state.touch_last = t;
                    let (x, y) = screen_to_ref(&state.layout, t.0, t.1);
                    state.mouse = (x, y);
                }
            }
        }
        sapp::EventType::TouchesEnded | sapp::EventType::TouchesCancelled => {
            let stick_held = state.stick_id.is_some();
            // Release the stick when its finger is no longer down.
            if let Some(id) = state.stick_id {
                let n = event.num_touches.clamp(0, event.touches.len() as i32) as usize;
                let still_down = event.touches[..n]
                    .iter()
                    .any(|t| t.identifier == id && !t.changed);
                if !still_down {
                    state.stick_id = None;
                    state.stick_vec = (0.0, 0.0);
                }
            }
            if state.pinching {
                state.pinching = false;
            } else if !stick_held && !state.moved {
                select_at(state, state.mouse.0, state.mouse.1);
            }
            state.dragging = false;
        }
        sapp::EventType::MouseScroll => {
            state.zoom_target =
                (state.zoom_target + event.scroll_y * 0.08).clamp(ZOOM_MIN, ZOOM_MAX);
            state.recentre = false;
            capture_zoom_anchor(state);
        }
        sapp::EventType::KeyDown => {
            // Text entry takes over while renaming an item.
            if state.rename.is_some() {
                match event.key_code {
                    sapp::Keycode::Enter => {
                        commit_rename(state);
                        return;
                    }
                    sapp::Keycode::Escape => {
                        state.rename = None;
                        return;
                    }
                    sapp::Keycode::Backspace => {
                        if let Some(buffer) = state.rename.as_mut() {
                            buffer.pop();
                        }
                        return;
                    }
                    // Printable characters arrive as Char events.
                    _ => return,
                }
            }
            // Item box navigation (play mode).
            if state.item_box_open && !state.edit {
                match event.key_code {
                    sapp::Keycode::Left => nav_item_box(state, -1),
                    sapp::Keycode::Right => nav_item_box(state, 1),
                    sapp::Keycode::Up => nav_item_box(state, -(BOX_COLS as i32)),
                    sapp::Keycode::Down => nav_item_box(state, BOX_COLS as i32),
                    sapp::Keycode::Space | sapp::Keycode::Enter if !event.key_repeat => {
                        transfer_box_item(state)
                    }
                    sapp::Keycode::Escape | sapp::Keycode::B => {
                        state.item_box_open = false;
                        set_status(state, "item box closed");
                    }
                    _ => {}
                }
                return;
            }
            // Inventory navigation (play mode).
            if state.inventory_open && !state.edit {
                match event.key_code {
                    sapp::Keycode::Left => nav_inventory(state, -1),
                    sapp::Keycode::Right => nav_inventory(state, 1),
                    sapp::Keycode::Up => nav_inventory(state, -(INV_COLS as i32)),
                    sapp::Keycode::Down => nav_inventory(state, INV_COLS as i32),
                    sapp::Keycode::Escape | sapp::Keycode::I => {
                        state.inventory_open = false;
                        set_status(state, "inventory closed");
                    }
                    _ => {}
                }
                return;
            }
            // Menus take over in play mode while open.
            if !state.edit && (state.confirm.is_some() || state.menu != Menu::None) {
                if state.confirm.is_some() {
                    match event.key_code {
                        sapp::Keycode::Left
                        | sapp::Keycode::Up
                        | sapp::Keycode::Right
                        | sapp::Keycode::Down => {
                            state.confirm_index = wrap(state.confirm_index, 1, 2);
                        }
                        sapp::Keycode::Enter | sapp::Keycode::Space => {
                            confirm_activate(state, state.confirm_index == 0)
                        }
                        sapp::Keycode::Y => confirm_activate(state, true),
                        sapp::Keycode::N | sapp::Keycode::Escape => confirm_activate(state, false),
                        _ => {}
                    }
                    return;
                }
                let rows = menu_rows(state);
                match event.key_code {
                    sapp::Keycode::Up => {
                        state.menu_index = wrap(state.menu_index, -1, rows);
                    }
                    sapp::Keycode::Down => {
                        state.menu_index = wrap(state.menu_index, 1, rows);
                    }
                    sapp::Keycode::Enter | sapp::Keycode::Space => menu_activate(state),
                    sapp::Keycode::Escape => state.menu = Menu::None,
                    _ => {}
                }
                return;
            }
            if event.key_code == sapp::Keycode::Tab && !event.key_repeat {
                set_edit(state, !state.edit);
                return;
            }
            let ctrl = event.modifiers & sapp::MODIFIER_CTRL != 0;
            if state.edit {
                if ctrl {
                    match event.key_code {
                        sapp::Keycode::C => {
                            copy_selection(state);
                            return;
                        }
                        sapp::Keycode::V => {
                            let at = if state.mouse_in_map {
                                Some(snap_point(state, ref_to_source(state, state.mouse)))
                            } else {
                                None
                            };
                            paste_clipboard(state, at);
                            return;
                        }
                        sapp::Keycode::D => {
                            copy_selection(state);
                            let at = if state.mouse_in_map {
                                Some(snap_point(state, ref_to_source(state, state.mouse)))
                            } else {
                                None
                            };
                            paste_clipboard(state, at);
                            return;
                        }
                        _ => {}
                    }
                }
                if let Some(tool) = tool_from_digit(event.key_code) {
                    state.tool = tool;
                    state.drag_mode = DragMode::None;
                    set_status(state, format!("tool {}", tool.label()));
                    return;
                }
                match event.key_code {
                    sapp::Keycode::C if !event.key_repeat => {
                        state.tool = Tool::Connect;
                        state.drag_mode = DragMode::None;
                        set_status(state, "tool LINK");
                        return;
                    }
                    sapp::Keycode::R if !event.key_repeat => {
                        start_rename(state);
                        return;
                    }
                    sapp::Keycode::H if !event.key_repeat => {
                        toggle_region_visibility(state);
                        return;
                    }
                    sapp::Keycode::Delete | sapp::Keycode::Backspace => {
                        delete_selection(state);
                        return;
                    }
                    sapp::Keycode::Escape => {
                        if !state.selection.is_empty() {
                            state.selection.clear();
                            return;
                        }
                        set_edit(state, false);
                        return;
                    }
                    sapp::Keycode::Z => {
                        editor_undo(state);
                        return;
                    }
                    sapp::Keycode::S => {
                        save_scene(state);
                        return;
                    }
                    sapp::Keycode::L => {
                        load_scene(state);
                        return;
                    }
                    sapp::Keycode::X => {
                        editor_clear_floor(state);
                        return;
                    }
                    sapp::Keycode::Space if !event.key_repeat => {
                        state.snap = !state.snap;
                        set_status(state, if state.snap { "snap on" } else { "snap off" });
                        return;
                    }
                    _ => {}
                }
            }
            match event.key_code {
                sapp::Keycode::I if !state.edit && !event.key_repeat => {
                    state.inventory_open = !state.inventory_open;
                    if state.inventory_open {
                        state.item_box_open = false;
                    }
                    set_status(
                        state,
                        if state.inventory_open {
                            "inventory open"
                        } else {
                            "inventory closed"
                        },
                    );
                }
                sapp::Keycode::B if !state.edit && !event.key_repeat => {
                    if state.item_box_open {
                        state.item_box_open = false;
                        set_status(state, "item box closed");
                    } else {
                        open_item_box(state);
                        set_status(state, "item box open");
                    }
                }
                sapp::Keycode::Escape if !state.edit && !event.key_repeat => {
                    open_menu(state, Menu::Pause);
                }
                sapp::Keycode::Space if !state.edit && !event.key_repeat => {
                    if interact(state) {
                        end_turn(state);
                    }
                }
                sapp::Keycode::F1 if !event.key_repeat => state.debug_mode = !state.debug_mode,
                sapp::Keycode::G if !event.key_repeat => state.show_grid = !state.show_grid,
                sapp::Keycode::M if !event.key_repeat => {
                    state.cursor_mode = match state.cursor_mode {
                        CursorMode::Free => CursorMode::Centered,
                        CursorMode::Centered => CursorMode::Free,
                    };
                    let hide = state.cursor_mode == CursorMode::Free;
                    if hide != state.os_cursor_hidden {
                        set_cursor_hidden(hide);
                        state.os_cursor_hidden = hide;
                    }
                }
                sapp::Keycode::F if !event.key_repeat => recenter_on_player(state),
                sapp::Keycode::Q => {
                    state.arrow_up_t = 0.001;
                    let floor = (state.floor + NUM_FLOORS - 1) % NUM_FLOORS;
                    change_floor(state, floor);
                }
                sapp::Keycode::E => {
                    state.arrow_down_t = 0.001;
                    let floor = (state.floor + 1) % NUM_FLOORS;
                    change_floor(state, floor);
                }
                sapp::Keycode::Up => {
                    state.holding[0] = true;
                    state.recentre = true;
                    state.circle_cursor_hidden = true;
                }
                sapp::Keycode::Down => {
                    state.holding[1] = true;
                    state.recentre = true;
                    state.circle_cursor_hidden = true;
                }
                sapp::Keycode::Left => {
                    state.holding[2] = true;
                    state.recentre = true;
                    state.circle_cursor_hidden = true;
                }
                sapp::Keycode::Right => {
                    state.holding[3] = true;
                    state.recentre = true;
                    state.circle_cursor_hidden = true;
                }
                sapp::Keycode::Equal | sapp::Keycode::KpAdd => {
                    state.zoom_target = (state.zoom_target + 0.12).min(ZOOM_MAX);
                    state.recentre = false;
                    capture_zoom_anchor(state);
                }
                sapp::Keycode::Minus | sapp::Keycode::KpSubtract => {
                    state.zoom_target = (state.zoom_target - 0.12).max(ZOOM_MIN);
                    state.recentre = false;
                    capture_zoom_anchor(state);
                }
                _ => {}
            }
        }
        sapp::EventType::KeyUp => match event.key_code {
            sapp::Keycode::Up => state.holding[0] = false,
            sapp::Keycode::Down => state.holding[1] = false,
            sapp::Keycode::Left => state.holding[2] = false,
            sapp::Keycode::Right => state.holding[3] = false,
            _ => {}
        },
        // Dropping focus must not leave a direction stuck on.
        sapp::EventType::Unfocused => state.holding = [false; 4],
        _ => {}
    }
}

fn line(x1: f32, y1: f32, x2: f32, y2: f32) {
    sgl::begin_lines();
    sgl::v2f(x1, y1);
    sgl::v2f(x2, y2);
    sgl::end();
}

fn rect(x: f32, y: f32, width: f32, height: f32) {
    sgl::begin_quads();
    sgl::v2f(x, y);
    sgl::v2f(x + width, y);
    sgl::v2f(x + width, y + height);
    sgl::v2f(x, y + height);
    sgl::end();
}

fn outline_rect(x: f32, y: f32, width: f32, height: f32) {
    line(x, y, x + width, y);
    line(x + width, y, x + width, y + height);
    line(x + width, y + height, x, y + height);
    line(x, y + height, x, y);
}

fn diamond(cx: f32, cy: f32, radius: f32, filled: bool) {
    if filled {
        sgl::begin_triangles();
        sgl::v2f(cx, cy - radius);
        sgl::v2f(cx + radius, cy);
        sgl::v2f(cx, cy + radius);
        sgl::v2f(cx, cy - radius);
        sgl::v2f(cx, cy + radius);
        sgl::v2f(cx - radius, cy);
        sgl::end();
    } else {
        line(cx, cy - radius, cx + radius, cy);
        line(cx + radius, cy, cx, cy + radius);
        line(cx, cy + radius, cx - radius, cy);
        line(cx - radius, cy, cx, cy - radius);
    }
}

fn triangle(cx: f32, cy: f32, radius: f32, up: bool) {
    sgl::begin_triangles();
    if up {
        sgl::v2f(cx, cy - radius);
        sgl::v2f(cx + radius, cy + radius);
        sgl::v2f(cx - radius, cy + radius);
    } else {
        sgl::v2f(cx - radius, cy - radius);
        sgl::v2f(cx + radius, cy - radius);
        sgl::v2f(cx, cy + radius);
    }
    sgl::end();
}

// Triangle whose apex points along (dx, dy); used for the horizontal floor bar.
fn triangle_dir(cx: f32, cy: f32, radius: f32, dx: f32, dy: f32) {
    let (bx, by) = (-dy, dx);
    sgl::begin_triangles();
    sgl::v2f(cx + dx * radius, cy + dy * radius);
    sgl::v2f(
        cx - dx * radius + bx * radius,
        cy - dy * radius + by * radius,
    );
    sgl::v2f(
        cx - dx * radius - bx * radius,
        cy - dy * radius - by * radius,
    );
    sgl::end();
}

// Player location arrow: a concave-backed dart (tip, two barbs, a forward
// notch) matching the reference map cursor. The apex points along (dx, dy) and
// `radius` is half the arrow's length, so its box stays centred on the player.
fn player_arrow_dir(cx: f32, cy: f32, radius: f32, dx: f32, dy: f32) {
    let (bx, by) = (-dy, dx);
    // Offsets as fractions of the half-length, measured from the reference.
    let (back, barb, notch) = (radius, radius * 0.67, radius * 0.61);
    let tip = (cx + dx * radius, cy + dy * radius);
    let rest = (cx - dx * back, cy - dy * back);
    let middle = (cx - dx * notch, cy - dy * notch);
    sgl::begin_triangles();
    sgl::v2f(tip.0, tip.1);
    sgl::v2f(rest.0 + bx * barb, rest.1 + by * barb);
    sgl::v2f(middle.0, middle.1);
    sgl::v2f(tip.0, tip.1);
    sgl::v2f(middle.0, middle.1);
    sgl::v2f(rest.0 - bx * barb, rest.1 - by * barb);
    sgl::end();
}

fn filled_circle(cx: f32, cy: f32, radius: f32) {
    sgl::begin_triangles();
    let step = std::f32::consts::TAU / CIRCLE_SEGMENTS as f32;
    for i in 0..CIRCLE_SEGMENTS {
        let a0 = i as f32 * step;
        let a1 = (i + 1) as f32 * step;
        sgl::v2f(cx, cy);
        sgl::v2f(cx + radius * a0.cos(), cy + radius * a0.sin());
        sgl::v2f(cx + radius * a1.cos(), cy + radius * a1.sin());
    }
    sgl::end();
}

// Floors 2 and 3 have no traced art, so their walls are a stable set of random
// squares and rectangles spanning roughly the same area as Floor 1. Deterministic
// LCG per floor so the layout never changes between frames or runs.

// Floor art frame inside the fixed map window, centred and scaled by zoom.
fn image_size(l: &Layout, zoom: f32, frame: (f32, f32, f32, f32)) -> (f32, f32) {
    let (_, _, frame_w, frame_h) = frame;
    // Landscape fits the floor width; portrait fits the floor height.
    if l.portrait {
        let ih = l.map_h * zoom;
        (ih * frame_w / frame_h, ih)
    } else {
        let iw = l.map_w * zoom;
        (iw, iw * frame_h / frame_w)
    }
}

fn map_rect(
    l: &Layout,
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
    frame: (f32, f32, f32, f32),
) -> (f32, f32, f32, f32) {
    let (image_width, image_height) = image_size(l, zoom, frame);
    let x = l.map_x + (l.map_w - image_width) * 0.5 + pan_x;
    let y = l.map_y + (l.map_h - image_height) * 0.5 + pan_y;
    (x, y, image_width, image_height)
}

// Capture the map point under the circle cursor when a zoom starts.
fn capture_zoom_anchor(state: &mut State) {
    let l = state.layout;
    let cursor = active_cursor(state);
    if !in_map(&l, cursor) {
        state.zoom_anchor = None;
        return;
    }
    let frame = floor_frame(state.floor);
    let (ox, oy, iw, ih) = map_rect(&l, state.zoom, state.pan_x, state.pan_y, frame);
    let sx = frame.0 + (cursor.0 - ox) * frame.2 / iw;
    let sy = frame.1 + (cursor.1 - oy) * frame.3 / ih;
    state.zoom_anchor = Some(ZoomAnchor {
        src: (sx, sy),
        cursor_ref: cursor,
        end: state.zoom_target,
    });
}

// Pan that places `src` at `ref_point` for the given zoom.
fn anchor_pan(
    l: &Layout,
    zoom: f32,
    src: (f32, f32),
    ref_point: (f32, f32),
    frame: (f32, f32, f32, f32),
) -> (f32, f32) {
    let (frame_x, frame_y, frame_w, frame_h) = frame;
    let (iw, ih) = image_size(l, zoom, frame);
    (
        ref_point.0 - l.map_x - (l.map_w - iw) * 0.5 - (src.0 - frame_x) * iw / frame_w,
        ref_point.1 - l.map_y - (l.map_h - ih) * 0.5 - (src.1 - frame_y) * ih / frame_h,
    )
}

// Source-composite pixel -> reference coordinates for a floor frame.
fn src_to_ref(
    frame: (f32, f32, f32, f32),
    ox: f32,
    oy: f32,
    iw: f32,
    ih: f32,
    sx: f32,
    sy: f32,
) -> (f32, f32) {
    let (fx, fy, fw, fh) = frame;
    (ox + (sx - fx) * iw / fw, oy + (sy - fy) * ih / fh)
}

fn source_to_cell(nav: &Nav, sx: f32, sy: f32) -> (i32, i32) {
    let (fx, fy, fw, fh) = nav.frame;
    (
        ((sx - fx) / fw * nav.w as f32).floor() as i32,
        ((sy - fy) / fh * nav.h as f32).floor() as i32,
    )
}

fn cell_to_source(nav: &Nav, cx: i32, cy: i32) -> (f32, f32) {
    let (fx, fy, fw, fh) = nav.frame;
    (
        fx + (cx as f32 + 0.5) / nav.w as f32 * fw,
        fy + (cy as f32 + 0.5) / nav.h as f32 * fh,
    )
}

fn nearest_walkable(nav: &Nav, cx: i32, cy: i32) -> Option<(i32, i32)> {
    if nav.walkable(cx, cy) {
        return Some((cx, cy));
    }
    for r in 1i32..80 {
        for dy in -r..=r {
            for dx in -r..=r {
                if dx.abs().max(dy.abs()) != r {
                    continue;
                }
                if nav.walkable(cx + dx, cy + dy) {
                    return Some((cx + dx, cy + dy));
                }
            }
        }
    }
    None
}

fn snap_source(nav: &Nav, sx: f32, sy: f32) -> Option<(i32, i32)> {
    let (cx, cy) = source_to_cell(nav, sx, sy);
    nearest_walkable(nav, cx, cy)
}

// Reusable A* scratch: the cost/came arrays are stamped with a generation
// counter instead of being cleared, so repeated searches don't reallocate or
// re-zero the whole grid, and the open heap is reused too.
struct Astar {
    g: Vec<u32>,
    came: Vec<i32>,
    stamp: Vec<u32>,
    gen: u32,
    heap: std::collections::BinaryHeap<std::cmp::Reverse<(u32, i32)>>,
}

impl Astar {
    fn new() -> Astar {
        Astar {
            g: Vec::new(),
            came: Vec::new(),
            stamp: Vec::new(),
            gen: 0,
            heap: std::collections::BinaryHeap::new(),
        }
    }
}

impl Astar {
    // A* on the nav grid, 4-neighbour with a Manhattan heuristic. Retained for
    // the goal-route phase and the reuse test.
    #[allow(dead_code)]
    fn search(
        &mut self,
        nav: &Nav,
        start: (i32, i32),
        goal: (i32, i32),
    ) -> Option<Vec<(i32, i32)>> {
        self.search_grid(nav.w, nav.h, start, goal, |x, y| nav.walkable(x, y))
    }

    // A* over any uniform-cost 4-neighbour grid described by `walkable`.
    fn search_grid(
        &mut self,
        w: i32,
        h: i32,
        start: (i32, i32),
        goal: (i32, i32),
        walkable: impl Fn(i32, i32) -> bool,
    ) -> Option<Vec<(i32, i32)>> {
        let n = (w * h) as usize;
        if self.g.len() != n {
            self.g = vec![0; n];
            self.came = vec![-1; n];
            self.stamp = vec![0; n];
            self.gen = 0;
        }
        self.gen = self.gen.wrapping_add(1);
        if self.gen == 0 {
            self.stamp.fill(0);
            self.gen = 1;
        }
        let gen = self.gen;

        let sidx = (start.1 * w + start.0) as usize;
        let gidx = (goal.1 * w + goal.0) as usize;
        let heuristic = |x: i32, y: i32| (x - goal.0).unsigned_abs() + (y - goal.1).unsigned_abs();

        self.heap.clear();
        self.stamp[sidx] = gen;
        self.g[sidx] = 0;
        self.heap.push(std::cmp::Reverse((
            heuristic(start.0, start.1),
            sidx as i32,
        )));
        while let Some(std::cmp::Reverse((_f, cur))) = self.heap.pop() {
            let cur = cur as usize;
            if cur == gidx {
                break;
            }
            let cx = (cur as i32) % w;
            let cy = (cur as i32) / w;
            let cg = self.g[cur];
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (cx + dx, cy + dy);
                if !walkable(nx, ny) {
                    continue;
                }
                let ni = (ny * w + nx) as usize;
                let ng = cg + 1;
                if self.stamp[ni] != gen || ng < self.g[ni] {
                    self.stamp[ni] = gen;
                    self.g[ni] = ng;
                    self.came[ni] = cur as i32;
                    self.heap
                        .push(std::cmp::Reverse((ng + heuristic(nx, ny), ni as i32)));
                }
            }
        }
        if self.stamp[gidx] != gen {
            return None;
        }
        let mut cells = Vec::new();
        let mut cur = gidx as i32;
        loop {
            let ci = cur as usize;
            cells.push(((ci as i32) % w, (ci as i32) / w));
            if ci == sidx {
                break;
            }
            cur = self.came[ci];
            if cur < 0 {
                return None;
            }
        }
        cells.reverse();
        Some(cells)
    }
}

// Shortest route in source px between two source px points, or empty on failure.
#[allow(dead_code)]
fn compute_path(astar: &mut Astar, nav: &Nav, from: (f32, f32), to: (f32, f32)) -> Route {
    let (start, goal) = match (
        snap_source(nav, from.0, from.1),
        snap_source(nav, to.0, to.1),
    ) {
        (Some(s), Some(g)) => (s, g),
        _ => return Vec::new(),
    };
    match astar.search(nav, start, goal) {
        Some(cells) => simplify(
            cells
                .iter()
                .map(|&(x, y)| cell_to_source(nav, x, y))
                .collect(),
        ),
        None => Vec::new(),
    }
}

fn reachable_from(nav: &Nav, start: (i32, i32)) -> Vec<u8> {
    let n = (nav.w * nav.h) as usize;
    let mut bits = vec![0u8; n.div_ceil(8)];
    if !nav.walkable(start.0, start.1) {
        return bits;
    }
    let index = |x: i32, y: i32| (y * nav.w + x) as usize;
    let si = index(start.0, start.1);
    bits[si >> 3] |= 1 << (si & 7);
    let mut stack = vec![start];
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nav.walkable(nx, ny) {
                let i = index(nx, ny);
                if (bits[i >> 3] >> (i & 7)) & 1 == 0 {
                    bits[i >> 3] |= 1 << (i & 7);
                    stack.push((nx, ny));
                }
            }
        }
    }
    bits
}

// Refresh the reachable set only when the player's cell is not already in it.
// The nav grid is static, so the player's component never changes by walking.
fn ensure_reachable(state: &mut State, floor: usize, cell: (i32, i32)) {
    let nav = &state.nav[floor];
    if !is_reachable(&state.reachable[floor], nav, cell.0, cell.1) {
        state.reachable[floor] = reachable_from(nav, cell);
    }
}

fn is_reachable(bits: &[u8], nav: &Nav, x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x >= nav.w || y >= nav.h || bits.is_empty() {
        return false;
    }
    let i = (y * nav.w + x) as usize;
    (bits[i >> 3] >> (i & 7)) & 1 == 1
}

// A polyline in source pixels.
#[allow(dead_code)]
type Route = Vec<(f32, f32)>;

// Route to a target. Returns (green reachable part, red part past the blocker).
#[allow(dead_code)]
fn route_to(
    astar: &mut Astar,
    nav: &Nav,
    nav_open: &Nav,
    reachable: &[u8],
    from: (f32, f32),
    to: (f32, f32),
) -> (Route, Route) {
    if let Some(goal) = snap_source(nav, to.0, to.1) {
        if is_reachable(reachable, nav, goal.0, goal.1) {
            let green = compute_path(astar, nav, from, to);
            if !green.is_empty() {
                return (green, Vec::new());
            }
        }
    }
    // Optimistic grid (locked doors passable): split where it enters blocked space.
    if let (Some(start), Some(goal)) = (
        snap_source(nav_open, from.0, from.1),
        snap_source(nav_open, to.0, to.1),
    ) {
        if let Some(cells) = astar.search(nav_open, start, goal) {
            let split = cells
                .iter()
                .position(|&(x, y)| !is_reachable(reachable, nav, x, y))
                .unwrap_or(cells.len());
            let from_cell = split.saturating_sub(1);
            let green = cells[..split]
                .iter()
                .map(|&(x, y)| cell_to_source(nav, x, y))
                .collect();
            let red = cells[from_cell..]
                .iter()
                .map(|&(x, y)| cell_to_source(nav, x, y))
                .collect();
            return (simplify(green), simplify(red));
        }
    }
    (Vec::new(), Vec::new())
}

#[allow(dead_code)]
fn simplify(points: Vec<(f32, f32)>) -> Vec<(f32, f32)> {
    if points.len() < 3 {
        return points;
    }
    let mut out = Vec::with_capacity(points.len());
    out.push(points[0]);
    for i in 1..points.len() - 1 {
        let a = *out.last().unwrap();
        let b = points[i];
        let c = points[i + 1];
        let cross = (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0);
        if cross.abs() > 0.01 {
            out.push(b);
        }
    }
    out.push(points[points.len() - 1]);
    out
}

fn thick_polyline(points: &[(f32, f32)], width: f32) {
    if points.is_empty() {
        return;
    }
    let hw = width * 0.5;
    for pair in points.windows(2) {
        let (x1, y1) = pair[0];
        let (x2, y2) = pair[1];
        let (dx, dy) = (x2 - x1, y2 - y1);
        let len = (dx * dx + dy * dy).sqrt();
        if len < 0.0001 {
            continue;
        }
        let (nx, ny) = (-dy / len * hw, dx / len * hw);
        sgl::begin_quads();
        sgl::v2f(x1 + nx, y1 + ny);
        sgl::v2f(x2 + nx, y2 + ny);
        sgl::v2f(x2 - nx, y2 - ny);
        sgl::v2f(x1 - nx, y1 - ny);
        sgl::end();
    }
    for &(x, y) in points {
        filled_circle(x, y, hw);
    }
}

fn outline_circle_seg(cx: f32, cy: f32, radius: f32, segments: usize) {
    sgl::begin_line_strip();
    for i in 0..=segments {
        let a = i as f32 / segments as f32 * std::f32::consts::TAU;
        sgl::v2f(cx + radius * a.cos(), cy + radius * a.sin());
    }
    sgl::end();
}

fn outline_circle(cx: f32, cy: f32, radius: f32) {
    outline_circle_seg(cx, cy, radius, CIRCLE_SEGMENTS);
}

// Black bar with a horizontal alpha ramp: solid in the middle, fading at the
// left and right ends. Used behind the hover popup text.
fn draw_gradient_rect(x: f32, y: f32, width: f32, height: f32, alpha_max: f32, fade: f32) {
    let strips = 24;
    let strip_w = width / strips as f32;
    for i in 0..strips {
        let sx = x + i as f32 * strip_w;
        let center = sx + strip_w * 0.5;
        let edge = ((center - x) / fade)
            .min((x + width - center) / fade)
            .clamp(0.0, 1.0);
        let alpha = alpha_max * edge;
        if alpha <= 0.0 {
            continue;
        }
        sgl::c4f(0.0, 0.0, 0.0, alpha);
        rect(sx, y, strip_w, height);
    }
}

// Reference map cursor: a circle with four short ticks at N/E/S/W.
fn draw_cursor(
    state: &State,
    width: f32,
    height: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
) {
    if state.circle_cursor_hidden || (state.cursor_mode == CursorMode::Free && !state.mouse_in_map)
    {
        return;
    }
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    let (cx, cy) = active_cursor(state);
    if cx < MAP_X || cx > MAP_X + MAP_W || cy < MAP_Y || cy > MAP_Y + MAP_H {
        return;
    }
    let clip_x = ((MAP_X - left) / (right - left) * width).clamp(0.0, width);
    let clip_y = ((MAP_Y - top) / (bottom - top) * height).clamp(0.0, height);
    let clip_right = ((MAP_X + MAP_W - left) / (right - left) * width).clamp(0.0, width);
    let clip_bottom = ((MAP_Y + MAP_H - top) / (bottom - top) * height).clamp(0.0, height);
    sgl::scissor_rectf(
        clip_x,
        clip_y,
        (clip_right - clip_x).max(0.0),
        (clip_bottom - clip_y).max(0.0),
        true,
    );
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.9);
    outline_circle_seg(cx, cy, CURSOR_RADIUS, CURSOR_SEGMENTS);
    line(cx, cy - CURSOR_RADIUS, cx, cy - CURSOR_RADIUS - CURSOR_TICK);
    line(cx, cy + CURSOR_RADIUS, cx, cy + CURSOR_RADIUS + CURSOR_TICK);
    line(cx - CURSOR_RADIUS, cy, cx - CURSOR_RADIUS - CURSOR_TICK, cy);
    line(cx + CURSOR_RADIUS, cy, cx + CURSOR_RADIUS + CURSOR_TICK, cy);
    if let Some(i) = state.hover_item {
        let font = state.font.as_ref().unwrap();
        let text = state.items[i].name.as_str();
        let size = 19.5 * state.layout.text_scale;
        let tx = cx;
        let ty = cy + CURSOR_RADIUS + CURSOR_TICK + 6.0;
        let width = font.text_width(text, size);
        let pad = 13.0;
        draw_gradient_rect(tx - pad, ty - 4.0, width + pad * 2.0, size + 8.0, 0.8, pad);
        draw_text(font, text, tx + 1.5, ty + 1.5, size, (0.02, 0.02, 0.02));
        draw_text(font, text, tx, ty, size, C_HILITE);
    }
    sgl::scissor_rectf(0.0, 0.0, width, height, true);
}

// Reference player marker: a pale arrow with an expanding soft glow ring.
fn draw_player_marker(state: &State, cx: f32, cy: f32, radius: f32) {
    // The pulse is a hard-edged white circle that expands and fades, glowing
    // outward from its rim, leaving the map dark inside.
    let p = (state.time / PLAYER_PULSE_PERIOD).fract();
    let inner = (PLAYER_PULSE_MIN + (PLAYER_PULSE_MAX - PLAYER_PULSE_MIN) * p) * GRID_STEP;
    let outer = inner + PLAYER_PULSE_FALLOFF * GRID_STEP;
    let alpha = PLAYER_PULSE_ALPHA * (1.0 - p * p);
    glow_band(cx, cy, inner, outer, alpha, 0.0);
    // Rotate the arrow to face the direction of movement (0 rad = up).
    let (dx, dy) = facing_vector(state.facing);
    sgl::c4f(C_PLAYER_ARROW.0, C_PLAYER_ARROW.1, C_PLAYER_ARROW.2, 1.0);
    player_arrow_dir(cx, cy, radius, dx, dy);
}

// A soft annulus between two radii, alpha ramping from the inner edge (a0) to
// the outer edge (a1). Drawn as a triangle fan per segment so the Sokol colour
// interpolation gives the radial gradient.
fn glow_band(cx: f32, cy: f32, r0: f32, r1: f32, a0: f32, a1: f32) {
    const SEGMENTS: usize = 64;
    let step = std::f32::consts::TAU / SEGMENTS as f32;
    sgl::begin_triangles();
    for i in 0..SEGMENTS {
        let t0 = i as f32 * step;
        let t1 = (i + 1) as f32 * step;
        let (c0, s0) = (t0.cos(), t0.sin());
        let (c1, s1) = (t1.cos(), t1.sin());
        sgl::c4f(1.0, 1.0, 1.0, a0);
        sgl::v2f(cx + r0 * c0, cy + r0 * s0);
        sgl::c4f(1.0, 1.0, 1.0, a1);
        sgl::v2f(cx + r1 * c0, cy + r1 * s0);
        sgl::v2f(cx + r1 * c1, cy + r1 * s1);
        sgl::c4f(1.0, 1.0, 1.0, a0);
        sgl::v2f(cx + r0 * c0, cy + r0 * s0);
        sgl::c4f(1.0, 1.0, 1.0, a1);
        sgl::v2f(cx + r1 * c1, cy + r1 * s1);
        sgl::c4f(1.0, 1.0, 1.0, a0);
        sgl::v2f(cx + r0 * c1, cy + r0 * s1);
    }
    sgl::end();
}

// Debug view: fill each walkable cell (the exact grid A* uses), batched per row run.
fn draw_nav_grid(nav: &Nav, ox: f32, oy: f32, iw: f32, ih: f32) {
    let cell_w = iw / nav.w as f32;
    let cell_h = ih / nav.h as f32;
    sgl::c4f(C_HILITE.0, C_HILITE.1, C_HILITE.2, GRID_ALPHA);
    sgl::begin_quads();
    for cy in 0..nav.h {
        let mut run: Option<i32> = None;
        for cx in 0..=nav.w {
            let on = cx < nav.w && nav.walkable(cx, cy);
            match (run, on) {
                (None, true) => run = Some(cx),
                (Some(s), false) => {
                    let x = ox + s as f32 * cell_w;
                    let y = oy + cy as f32 * cell_h;
                    let w = (cx - s) as f32 * cell_w;
                    sgl::v2f(x, y);
                    sgl::v2f(x + w, y);
                    sgl::v2f(x + w, y + cell_h);
                    sgl::v2f(x, y + cell_h);
                    run = None;
                }
                _ => {}
            }
        }
    }
    sgl::end();
}

// Wall rectangles for the floors without traced art, in the same source frame
// and wall colour as Floor 1 so they pan and zoom identically.
fn draw_move_cells(state: &State, frame: (f32, f32, f32, f32), ox: f32, oy: f32, iw: f32, ih: f32) {
    if state.edit || state.floor != state.player_floor || state.move_anim.is_some() {
        return;
    }
    let grid = &state.move_grid[state.player_floor];
    let reach = &state.move_reach[state.player_floor];
    if reach.is_empty() || grid.w == 0 || grid.h == 0 {
        return;
    }
    let hx = (MOVE_CELL * 0.5 - MOVE_CELL_INSET) * iw / frame.2;
    let hy = (MOVE_CELL * 0.5 - MOVE_CELL_INSET) * ih / frame.3;
    if hx <= 0.0 || hy <= 0.0 {
        return;
    }
    sgl::begin_quads();
    for my in 0..grid.h {
        for mx in 0..grid.w {
            let i = (my * grid.w + mx) as usize;
            let d = reach[i];
            if d == 0 || d == u16::MAX || d > RUN_CELLS {
                continue;
            }
            let walk = d <= WALK_CELLS;
            let (c, a) = if walk {
                (MOVE_WALK_TINT, MOVE_WALK_ALPHA)
            } else {
                (MOVE_RUN_TINT, MOVE_RUN_ALPHA)
            };
            let (sx, sy) = grid.cell_source(mx, my);
            let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, sx, sy);
            sgl::c4f(c.0, c.1, c.2, a);
            sgl::v2f(rx - hx, ry - hy);
            sgl::v2f(rx + hx, ry - hy);
            sgl::v2f(rx + hx, ry + hy);
            sgl::v2f(rx - hx, ry + hy);
        }
    }
    sgl::end();
}

// The rope preview to the hovered cell, tinted walk (light) or run (deeper).
fn draw_hover_path(state: &State, frame: (f32, f32, f32, f32), ox: f32, oy: f32, iw: f32, ih: f32) {
    if state.edit || state.hover_path.len() < 2 {
        return;
    }
    let route: Vec<(f32, f32)> = state
        .hover_path
        .iter()
        .map(|&(sx, sy)| src_to_ref(frame, ox, oy, iw, ih, sx, sy))
        .collect();
    let c = if state.hover_run {
        ROPE_RUN_TINT
    } else {
        ROPE_WALK_TINT
    };
    sgl::c4f(c.0, c.1, c.2, ROPE_ALPHA);
    thick_polyline(&route, ROPE_WIDTH);
}

fn draw_floor(
    state: &State,
    width: f32,
    height: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
) {
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    // Keep the map content inside the map window.
    let clip_x = ((MAP_X - left) / (right - left) * width).clamp(0.0, width);
    let clip_y = ((MAP_Y - top) / (bottom - top) * height).clamp(0.0, height);
    let clip_right = ((MAP_X + MAP_W - left) / (right - left) * width).clamp(0.0, width);
    let clip_bottom = ((MAP_Y + MAP_H - top) / (bottom - top) * height).clamp(0.0, height);
    sgl::scissor_rectf(
        clip_x,
        clip_y,
        (clip_right - clip_x).max(0.0),
        (clip_bottom - clip_y).max(0.0),
        true,
    );

    let frame = floor_frame(state.floor);
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);

    if state.show_grid {
        draw_nav_grid(&state.nav[state.floor], ox, oy, iw, ih);
    }

    // Room floors and their dot/diamond patterns sit under the map art.
    draw_rooms(state, frame, ox, oy, iw, ih);
    // Turn-based reachable cells sit on the room floor, under the map art.
    draw_move_cells(state, frame, ox, oy, iw, ih);

    sgl::enable_texture();
    sgl::texture(state.overlay_views[state.floor], state.overlay_sampler);
    sgl::c4f(1.0, 1.0, 1.0, 1.0);
    sgl::begin_quads();
    sgl::v2f_t2f(ox, oy, 0.0, 0.0);
    sgl::v2f_t2f(ox + iw, oy, 1.0, 0.0);
    sgl::v2f_t2f(ox + iw, oy + ih, 1.0, 1.0);
    sgl::v2f_t2f(ox, oy + ih, 0.0, 1.0);
    sgl::end();
    sgl::disable_texture();

    // Wall faces: room walls draw an outer (brighter) and inner (dimmer) line;
    // interior partitions draw dim on both, all with miter corners. Thickness is
    // in source pixels so the lines scale with the map like the baked art.
    let plan = &state.wall_plans[state.floor];
    if !plan.edges.is_empty() {
        let sx = iw / frame.2;
        let sy = ih / frame.3;
        let tx = WALL_LINE_PX * sx;
        let ty = WALL_LINE_PX * sy;
        sgl::begin_quads();
        for e in &plan.edges {
            let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, e.x0, e.y0);
            let (rx1, ry1) = src_to_ref(frame, ox, oy, iw, ih, e.x1, e.y1);
            // Insets sit on the wall side: the filled side for the outer contour
            // and partitions, the unfilled side for the room's inner contour.
            let inset = e.tone == WallTone::Inner;
            let (x, y, w, h) = match e.dir {
                EdgeDir::Up | EdgeDir::Down => {
                    let y =
                        if matches!((e.dir, inset), (EdgeDir::Up, false) | (EdgeDir::Down, true)) {
                            ry
                        } else {
                            ry - ty
                        };
                    (rx, y, rx1 - rx, ty)
                }
                EdgeDir::Left | EdgeDir::Right => {
                    let x = if matches!(
                        (e.dir, inset),
                        (EdgeDir::Left, false) | (EdgeDir::Right, true)
                    ) {
                        rx
                    } else {
                        rx - tx
                    };
                    (x, ry, tx, ry1 - ry)
                }
            };
            let c = wall_tone_color(e.tone);
            sgl::c4f(c.0, c.1, c.2, 1.0);
            sgl::v2f(x, y);
            sgl::v2f(x + w, y);
            sgl::v2f(x + w, y + h);
            sgl::v2f(x, y + h);
        }
        for c in &plan.corners {
            let (dx, dy) = if c.tone == WallTone::Inner {
                (-c.sx, -c.sy)
            } else {
                (c.sx, c.sy)
            };
            let (x0, y0) = src_to_ref(frame, ox, oy, iw, ih, c.x, c.y);
            let (x1, y1) = src_to_ref(
                frame,
                ox,
                oy,
                iw,
                ih,
                c.x + dx * WALL_LINE_PX,
                c.y + dy * WALL_LINE_PX,
            );
            let (x, w) = (x0.min(x1), (x1 - x0).abs());
            let (y, h) = (y0.min(y1), (y1 - y0).abs());
            let col = wall_tone_color(c.tone);
            sgl::c4f(col.0, col.1, col.2, 1.0);
            sgl::v2f(x, y);
            sgl::v2f(x + w, y);
            sgl::v2f(x + w, y + h);
            sgl::v2f(x, y + h);
        }
        sgl::end();
    }

    // Door props sit on top of the wall lines so they read as openings.
    draw_doors(state, frame, ox, oy, iw, ih);

    // Items and typewriters, constant screen size, on whichever floor they live.
    for item in &state.items {
        if item.floor != state.floor {
            continue;
        }
        let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, item.pos.0, item.pos.1);
        draw_item_marker(rx, ry, item.kind, 1.0);
    }

    // Hover rope: the path a click would take this turn, over the map art.
    draw_hover_path(state, frame, ox, oy, iw, ih);

    // Selected goal route and ring, when shown and on the viewed floor.
    if state.route_visible {
        if let Some(goal) = state.goal.and_then(|i| state.goals.get(i)) {
            if goal.floor == state.floor {
                if !state.path.is_empty() {
                    let route: Vec<(f32, f32)> = state
                        .path
                        .iter()
                        .map(|&(sx, sy)| src_to_ref(frame, ox, oy, iw, ih, sx, sy))
                        .collect();
                    sgl::c4f(C_ROUTE.0, C_ROUTE.1, C_ROUTE.2, 0.75);
                    thick_polyline(&route, PATH_WIDTH);
                }
                if !state.path_red.is_empty() {
                    let route: Vec<(f32, f32)> = state
                        .path_red
                        .iter()
                        .map(|&(sx, sy)| src_to_ref(frame, ox, oy, iw, ih, sx, sy))
                        .collect();
                    sgl::c4f(C_LOCK.0, C_LOCK.1, C_LOCK.2, 0.75);
                    thick_polyline(&route, PATH_WIDTH);
                }
                let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, goal.pos.0, goal.pos.1);
                let color = if state.path_red.is_empty() {
                    C_ROUTE
                } else {
                    C_LOCK
                };
                sgl::c4f(color.0, color.1, color.2, 1.0);
                outline_circle(rx, ry, ITEM_RADIUS + 6.0);
            }
        }
    }

    // Player marker on whichever floor the player actually occupies.
    if state.floor == state.player_floor {
        let (px, py) = src_to_ref(frame, ox, oy, iw, ih, state.player.0, state.player.1);
        let collide_ref = PLAYER_COLLIDE_RADIUS * iw / frame.2;
        // The arrow is a constant size on screen, sized in grid cells so it
        // matches the reference map cursor.
        let marker_ref = PLAYER_ARROW_HALF * GRID_STEP;
        if state.debug_mode {
            // The collision disc the player keeps clear of walls, obstacles and
            // locked doors, plus the 8 samples debug uses to eyeball it.
            sgl::c4f(C_ACCENT.0, C_ACCENT.1, C_ACCENT.2, 0.7);
            outline_circle(px, py, collide_ref);
            sgl::c4f(C_LOCK.0, C_LOCK.1, C_LOCK.2, 0.9);
            sgl::begin_points();
            sgl::point_size(3.0);
            sgl::v2f(px, py);
            for i in 0..8 {
                let a = i as f32 / 8.0 * std::f32::consts::TAU;
                sgl::v2f(px + a.cos() * collide_ref, py + a.sin() * collide_ref);
            }
            sgl::end();
        }
        draw_player_marker(state, px, py, marker_ref);

        // Interaction prompt for the nearest item / typewriter / door.
        if !state.edit {
            if let Some(inter) = interaction_target(state) {
                let center = inter.pos();
                let (hx, hy) = src_to_ref(frame, ox, oy, iw, ih, center.0, center.1);
                let font = state.font.as_ref().unwrap();
                let text = inter.label();
                let width = font.text_width(&text, 19.5);
                let tx = (hx - width * 0.5).clamp(MAP_X, MAP_X + MAP_W - width);
                draw_gradient_rect(tx - 8.0, hy - 34.0, width + 16.0, 26.0, 0.85, 8.0);
                draw_ui_text(font, &text, tx, hy - 30.0, C_HILITE, false, 1.0);
            }
        }
    }

    // Viewing a floor the player is not on: play is paused here.
    if !state.edit && state.floor != state.player_floor {
        let font = state.font.as_ref().unwrap();
        let msg = "VIEWING ANOTHER FLOOR  -  TAKE THE STAIRS TO MOVE THE PLAYER";
        let width = font.text_width(msg, 17.5);
        let max_x = (MAP_X + MAP_W - width).max(MAP_X);
        let tx = (MAP_X + MAP_W * 0.5 - width * 0.5).clamp(MAP_X, max_x);
        let ty = MAP_Y + MAP_H - 30.0;
        draw_gradient_rect(tx - 10.0, ty - 7.0, width + 20.0, 26.0, 0.85, 8.0);
        draw_ui_text(font, msg, tx, ty, C_HILITE, false, 0.9);
    }

    // Room name labels, centred on their position.
    {
        let font = state.font.as_ref().unwrap();
        let scale = state.layout.text_scale;
        for label in &view_scene(state).floors[state.floor].labels {
            let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, label.pos.0, label.pos.1);
            if rx < MAP_X || rx > MAP_X + MAP_W || ry < MAP_Y || ry > MAP_Y + MAP_H {
                continue;
            }
            let width = font.text_width(&label.name, 19.5 * scale);
            // Keep the (now larger) labels inside the map window instead of clipping.
            let max_x = (MAP_X + MAP_W - width).max(MAP_X);
            let tx = (rx - width * 0.5).clamp(MAP_X, max_x);
            draw_ui_text(
                font,
                &label.name,
                tx,
                ry - 9.75 * scale,
                C_LABEL,
                false,
                scale,
            );
        }
    }

    sgl::scissor_rectf(0.0, 0.0, width, height, true);
}

// A rotated box in reference space, for edit-mode obstacles/doors.
// Door props: a flat rect at the fixed size, on top of the wall lines.
fn draw_doors(state: &State, frame: (f32, f32, f32, f32), ox: f32, oy: f32, iw: f32, ih: f32) {
    // The viewed scene already carries reveal/unlock state (and hides fogged
    // doors) in play mode, and the authored state in edit mode.
    for d in &view_scene(state).floors[state.floor].doors {
        draw_door(frame, ox, oy, iw, ih, d.center, d.rot, d.kind, 1.0);
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_door(
    frame: (f32, f32, f32, f32),
    ox: f32,
    oy: f32,
    iw: f32,
    ih: f32,
    center: (f32, f32),
    rot: f32,
    kind: DoorKind,
    alpha: f32,
) {
    draw_box_rot(
        frame,
        ox,
        oy,
        iw,
        ih,
        center,
        (DOOR_LONG_PX, DOOR_THICK_PX),
        rot,
        door_color(kind),
        alpha,
        true,
    );
}

#[allow(clippy::too_many_arguments)]
fn draw_box_rot(
    frame: (f32, f32, f32, f32),
    ox: f32,
    oy: f32,
    iw: f32,
    ih: f32,
    center: (f32, f32),
    size: (f32, f32),
    rot: f32,
    color: (f32, f32, f32),
    alpha: f32,
    fill: bool,
) {
    let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, center.0, center.1);
    let w = size.0 * iw / frame.2;
    let h = size.1 * ih / frame.3;
    sgl::push_matrix();
    sgl::translate(rx, ry, 0.0);
    sgl::rotate(rot, 0.0, 0.0, 1.0);
    sgl::c4f(color.0, color.1, color.2, alpha);
    if fill {
        rect(-w * 0.5, -h * 0.5, w, h);
    } else {
        outline_rect(-w * 0.5, -h * 0.5, w, h);
    }
    sgl::pop_matrix();
}

// Editable name field under the editor toolbar, for the selected item/label.
fn rename_box_rect() -> (f32, f32, f32, f32) {
    (12.0, EDITOR_BAR_Y + EDITOR_BAR_H + 52.0, 340.0, 30.0)
}

fn rename_box_hit(x: f32, y: f32) -> bool {
    let (bx, by, bw, bh) = rename_box_rect();
    (bx..bx + bw).contains(&x) && (by..by + bh).contains(&y)
}

// The name of the selected item or label, if any.
fn selected_name(state: &State) -> Option<String> {
    match primary_selection(state) {
        Some(Selection::Item(i)) => state.scene.floors[state.floor]
            .items
            .get(i)
            .map(|it| it.name.clone()),
        Some(Selection::Label(i)) => state.scene.floors[state.floor]
            .labels
            .get(i)
            .map(|l| l.name.clone()),
        _ => None,
    }
}

fn draw_name_box(state: &State, font: &Font) {
    let editing = state.rename.is_some();
    let Some(text) = state.rename.clone().or_else(|| selected_name(state)) else {
        return;
    };
    let (x, y, w, h) = rename_box_rect();
    sgl::c4f(0.055, 0.055, 0.075, 0.95);
    rect(x, y, w, h);
    let border = if editing { C_HILITE } else { C_LINE };
    sgl::c4f(border.0, border.1, border.2, 0.9);
    outline_rect(x, y, w, h);
    draw_ui_text(font, "NAME", x + 8.0, y + 8.0, C_LABEL, false, 0.8);
    let tx = x + 62.0;
    draw_ui_text(font, &text, tx, y + 8.0, C_HILITE, false, 1.0);
    if editing {
        // Blinking caret after the text.
        if (state.time * 2.0) as i32 % 2 == 0 {
            let tw = font.text_width(&text, 19.5);
            sgl::c4f(C_HILITE.0, C_HILITE.1, C_HILITE.2, 1.0);
            rect(tx + tw + 1.0, y + 6.0, 1.5, h - 12.0);
        }
    } else {
        draw_ui_text(
            font,
            "[R] edit",
            x + w - 64.0,
            y + 8.0,
            C_LABEL,
            false,
            0.75,
        );
    }
}

// Hover tooltip under the tool bar: the tool's name plus a one-line usage note.
fn draw_tool_tooltip(state: &State, font: &Font, index: usize) {
    let tool = Tool::ALL[index];
    let help = tool.help();
    let (bx, _, _, _) = editor_button_rect(index);
    let (pad, title_scale, body_scale) = (12.0, 1.35, 1.17);
    let title_w = font.text_width(tool.label(), 19.5 * title_scale);
    let body_w = font.text_width(help, 19.5 * body_scale);
    let w = title_w.max(body_w) + pad * 2.0 + 6.0;
    let h = 58.0;
    let l = state.layout;
    let min_x = l.map_x + 8.0;
    let max_x = (l.map_x + l.map_w - w - 8.0).max(min_x);
    let x = bx.clamp(min_x, max_x);
    let y = EDITOR_BAR_Y + EDITOR_BAR_H + 6.0;
    sgl::c4f(0.05, 0.05, 0.07, 0.94);
    rect(x, y, w, h);
    let c = tool.color();
    sgl::c4f(c.0, c.1, c.2, 0.9);
    outline_rect(x, y, w, h);
    draw_ui_text(font, tool.label(), x + pad, y + 8.0, c, false, title_scale);
    draw_ui_text(font, help, x + pad, y + 32.0, C_LABEL, false, body_scale);
}

// Edit-mode overlay: vector objects for the viewed floor plus the tool bar.
fn draw_editor(
    state: &State,
    width: f32,
    height: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
) {
    let font = state.font.as_ref().unwrap();
    let frame = floor_frame(state.floor);
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);
    let floor = &state.scene.floors[state.floor];

    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    let clip_x = ((MAP_X - left) / (right - left) * width).clamp(0.0, width);
    let clip_y = ((MAP_Y - top) / (bottom - top) * height).clamp(0.0, height);
    let clip_right = ((MAP_X + MAP_W - left) / (right - left) * width).clamp(0.0, width);
    let clip_bottom = ((MAP_Y + MAP_H - top) / (bottom - top) * height).clamp(0.0, height);
    sgl::scissor_rectf(
        clip_x,
        clip_y,
        (clip_right - clip_x).max(0.0),
        (clip_bottom - clip_y).max(0.0),
        true,
    );

    // Fog-of-war regions and reveal triggers sit under the objects they own.
    for r in &floor.regions {
        let (x0, y0) = src_to_ref(frame, ox, oy, iw, ih, r.rect.x, r.rect.y);
        let (x1, y1) = src_to_ref(
            frame,
            ox,
            oy,
            iw,
            ih,
            r.rect.x + r.rect.w,
            r.rect.y + r.rect.h,
        );
        let (c, a) = match r.initial {
            RegionState::Hidden => ((0.30, 0.45, 0.80), 0.16),
            RegionState::Revealed | RegionState::Visited => ((0.35, 0.72, 0.95), 0.20),
        };
        sgl::c4f(c.0, c.1, c.2, a);
        rect(x0, y0, x1 - x0, y1 - y0);
        sgl::c4f(c.0, c.1, c.2, 0.85);
        outline_rect(x0, y0, x1 - x0, y1 - y0);
        let linked = floor.links.iter().any(|l| {
            matches!(l, Link::DoorRegion { region_id, .. }
                | Link::TriggerRegion { region_id, .. }
                | Link::ItemRegion { region_id, .. } if *region_id == r.id)
        });
        if linked {
            sgl::c4f(0.95, 0.85, 0.35, 0.9);
            outline_rect(x0 + 2.0, y0 + 2.0, x1 - x0 - 4.0, y1 - y0 - 4.0);
        }
        if let Some(PendingLink::Region(pf, pid)) = state.pending_link {
            if pf == state.floor && pid == r.id {
                sgl::c4f(1.0, 1.0, 1.0, 0.9);
                outline_rect(x0 - 3.0, y0 - 3.0, x1 - x0 + 6.0, y1 - y0 + 6.0);
            }
        }
    }
    for t in &floor.triggers {
        let (x0, y0) = src_to_ref(frame, ox, oy, iw, ih, t.rect.x, t.rect.y);
        let (x1, y1) = src_to_ref(
            frame,
            ox,
            oy,
            iw,
            ih,
            t.rect.x + t.rect.w,
            t.rect.y + t.rect.h,
        );
        sgl::c4f(0.95, 0.55, 0.25, 0.18);
        rect(x0, y0, x1 - x0, y1 - y0);
        sgl::c4f(0.95, 0.55, 0.25, 0.9);
        outline_rect(x0, y0, x1 - x0, y1 - y0);
        if let Some(PendingLink::Trigger(pf, pid)) = state.pending_link {
            if pf == state.floor && pid == t.id {
                sgl::c4f(1.0, 1.0, 1.0, 0.9);
                outline_rect(x0 - 3.0, y0 - 3.0, x1 - x0 + 6.0, y1 - y0 + 6.0);
            }
        }
    }

    for o in &floor.obstacles {
        draw_box_rot(
            frame,
            ox,
            oy,
            iw,
            ih,
            o.center,
            o.size,
            o.rot,
            (0.62, 0.62, 0.62),
            0.35,
            true,
        );
    }
    for d in &floor.doors {
        // Door props are drawn by draw_floor; here only the pending-link ring.
        if let Some(PendingLink::Door(pf, pid)) = state.pending_link {
            if pf == state.floor && pid == d.id {
                draw_box_rot(
                    frame,
                    ox,
                    oy,
                    iw,
                    ih,
                    d.center,
                    (DOOR_LONG_PX + 16.0, DOOR_THICK_PX + 16.0),
                    d.rot,
                    (1.0, 1.0, 1.0),
                    1.0,
                    false,
                );
            }
        }
    }
    for s in &floor.stairs {
        let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, s.pos.0, s.pos.1);
        sgl::c4f(0.95, 0.85, 0.35, 1.0);
        outline_circle(rx, ry, 11.0);
        filled_circle(rx, ry, 3.0);
        let linked = floor.links.iter().any(|l| {
            matches!(l, Link::Stair { a_floor, a_id, b_floor, b_id }
                if (*a_floor as usize == state.floor && *a_id == s.id)
                    || (*b_floor as usize == state.floor && *b_id == s.id))
        });
        if linked {
            sgl::c4f(0.40, 1.0, 0.50, 1.0);
            filled_circle(rx, ry, 6.0);
        }
        if let Some(PendingLink::Stair(pf, pid)) = state.pending_link {
            if pf == state.floor && pid == s.id {
                sgl::c4f(1.0, 1.0, 1.0, 1.0);
                outline_circle(rx, ry, 16.0);
            }
        }
    }
    for it in &floor.items {
        let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, it.pos.0, it.pos.1);
        draw_item_marker(rx, ry, it.kind, 1.0);
        if let Some(PendingLink::Item(pf, pid)) = state.pending_link {
            if pf == state.floor && pid == it.id {
                sgl::c4f(1.0, 1.0, 1.0, 1.0);
                outline_circle(rx, ry, ITEM_RADIUS + 6.0);
            }
        }
    }
    // Key -> door links on this floor, plus the selected object's handles.
    for link in &floor.links {
        if let Link::KeyDoor {
            item_floor,
            item_id,
            door_floor,
            door_id,
        } = *link
        {
            if item_floor as usize == state.floor && door_floor as usize == state.floor {
                let item = floor.items.iter().find(|i| i.id == item_id);
                let door = floor.doors.iter().find(|d| d.id == door_id);
                if let (Some(i), Some(d)) = (item, door) {
                    let (ix, iy) = src_to_ref(frame, ox, oy, iw, ih, i.pos.0, i.pos.1);
                    let (dx, dy) = src_to_ref(frame, ox, oy, iw, ih, d.center.0, d.center.1);
                    sgl::c4f(0.90, 0.65, 0.90, 0.7);
                    line(ix, iy, dx, dy);
                }
            }
        }
    }
    // Outline every selected object; handles only for the primary one.
    for sel in &state.selection {
        if let Some(geom) = selection_geom(&state.scene, state.floor, *sel) {
            sgl::c4f(1.0, 1.0, 1.0, 0.55);
            match geom {
                SelGeom::Rect { x, y, w, h } => {
                    let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, x, y);
                    let (rx1, ry1) = src_to_ref(frame, ox, oy, iw, ih, x + w, y + h);
                    outline_rect(rx, ry, rx1 - rx, ry1 - ry);
                }
                SelGeom::Box { center, size, rot } => {
                    draw_box_rot(
                        frame,
                        ox,
                        oy,
                        iw,
                        ih,
                        center,
                        size,
                        rot,
                        (1.0, 1.0, 1.0),
                        0.55,
                        false,
                    );
                }
                SelGeom::Point { pos } => {
                    let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, pos.0, pos.1);
                    outline_circle(rx, ry, 14.0);
                }
            }
        }
    }
    if let Some(sel) = primary_selection(state) {
        if let Some(geom) = selection_geom(&state.scene, state.floor, sel) {
            sgl::c4f(1.0, 1.0, 1.0, 0.95);
            for c in geom_corners(geom) {
                let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, c.0, c.1);
                rect(rx - 4.0, ry - 4.0, 8.0, 8.0);
            }
            if let Some(rh) = geom_rotate_handle(geom) {
                let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, rh.0, rh.1);
                let center = geom_center(geom);
                let (cx, cy) = src_to_ref(frame, ox, oy, iw, ih, center.0, center.1);
                sgl::c4f(1.0, 1.0, 1.0, 0.5);
                line(cx, cy, rx, ry);
                sgl::c4f(0.40, 0.80, 1.0, 1.0);
                filled_circle(rx, ry, 6.0);
            }
        }
    }
    if let (Some(a), Some(b)) = (state.drag_from, state.drag_to) {
        if state.tool.is_rect() {
            let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, a.0.min(b.0), a.1.min(b.1));
            let (rx1, ry1) = src_to_ref(frame, ox, oy, iw, ih, a.0.max(b.0), a.1.max(b.1));
            let c = state.tool.color();
            sgl::c4f(c.0, c.1, c.2, 0.9);
            outline_rect(rx, ry, rx1 - rx, ry1 - ry);
        }
    }
    // Snapped door prop preview while hovering a wall.
    if let Some((cx, cy, rot)) = state.door_preview {
        if let Some(kind) = door_kind_for_tool(state.tool) {
            draw_door(frame, ox, oy, iw, ih, (cx, cy), rot, kind, 0.6);
        }
    }
    sgl::scissor_rectf(0.0, 0.0, width, height, true);

    for (i, tool) in Tool::ALL.iter().enumerate() {
        let (bx, by, bw, bh) = editor_button_rect(i);
        let active = *tool == state.tool;
        sgl::c4f(0.08, 0.08, 0.10, 0.9);
        rect(bx, by, bw, bh);
        let c = tool.color();
        sgl::c4f(c.0, c.1, c.2, if active { 1.0 } else { 0.55 });
        outline_rect(bx, by, bw, bh);
        draw_ui_text(
            font,
            tool.label(),
            bx + 6.0,
            by + 7.5,
            if active { C_HILITE } else { C_LABEL },
            false,
            1.2,
        );
    }

    if state.status_t > 0.0 {
        draw_ui_text(
            font,
            &state.status,
            12.0,
            EDITOR_BAR_Y + EDITOR_BAR_H + 12.0,
            C_HILITE,
            false,
            1.0,
        );
    }
    let counts = format!(
        "walls {}  obstacles {}  doors {}  stairs {}  items {}  links {}   [Tab] exit  [Z] undo  [X] clear  [S] save  [L] load  [Space] snap:{}  [C] link  [R] rename  [Del] delete  [Shift+click] multi  [Ctrl+C/V] copy/paste  [right/middle drag] pan",
        floor.walls.len(),
        floor.obstacles.len(),
        floor.doors.len(),
        floor.stairs.len(),
        floor.items.len(),
        floor.links.len(),
        if state.snap { "on" } else { "off" }
    );
    draw_ui_text(
        font,
        &counts,
        12.0,
        EDITOR_BAR_Y + EDITOR_BAR_H + 36.0,
        C_LABEL,
        false,
        0.8,
    );
    draw_name_box(state, font);
    if let Some(pending) = state.pending_link {
        let what = match pending {
            PendingLink::Stair(..) => "another stair (any floor)",
            PendingLink::Item(..) => "a door or region",
            PendingLink::Door(..) => "a key item or region",
            PendingLink::Trigger(..) => "a region",
            PendingLink::Region(..) => "a door, item or trigger",
        };
        let text = format!("LINK: pick {what}  (click empty space to cancel)");
        draw_ui_text(
            font,
            &text,
            12.0,
            EDITOR_BAR_Y + EDITOR_BAR_H + 92.0,
            (0.90, 0.65, 0.90),
            false,
            0.95,
        );
    }
    draw_door_popup(state, font);
    draw_item_popup(state, font);

    // Hover tooltip last, so it sits above the status and control lines.
    if let Some(i) = editor_toolbar_hit(state.mouse.0, state.mouse.1) {
        draw_tool_tooltip(state, font, i);
    }
}

// Fade the map window out/in around a floor change.
fn draw_floor_fade(
    state: &State,
    width: f32,
    height: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
) {
    if state.pending_floor.is_none() {
        return;
    }
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    let clip_x = ((MAP_X - left) / (right - left) * width).clamp(0.0, width);
    let clip_y = ((MAP_Y - top) / (bottom - top) * height).clamp(0.0, height);
    let clip_right = ((MAP_X + MAP_W - left) / (right - left) * width).clamp(0.0, width);
    let clip_bottom = ((MAP_Y + MAP_H - top) / (bottom - top) * height).clamp(0.0, height);
    sgl::scissor_rectf(
        clip_x,
        clip_y,
        (clip_right - clip_x).max(0.0),
        (clip_bottom - clip_y).max(0.0),
        true,
    );
    let fade = 1.0 - (2.0 * state.transition_t - 1.0).abs();
    sgl::c4f(BACKGROUND.0, BACKGROUND.1, BACKGROUND.2, fade);
    rect(MAP_X, MAP_Y, MAP_W, MAP_H);
    sgl::scissor_rectf(0.0, 0.0, width, height, true);
}

fn draw_floor_selector(state: &State) {
    let l = state.layout;
    let selected_slot = floor_slot(state.floor);
    let sel_alpha = if state.pending_floor.is_some() {
        (2.0 * state.transition_t - 1.0).abs()
    } else {
        1.0
    };
    let up_off = (state.arrow_up_t * std::f32::consts::PI).sin() * 10.0;
    let down_off = (state.arrow_down_t * std::f32::consts::PI).sin() * 10.0;

    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.08);
    rect(l.floor_x, l.floor_y, l.floor_w, l.floor_h);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.75);
    outline_rect(l.floor_x, l.floor_y, l.floor_w, l.floor_h);

    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.92);
    if l.portrait {
        // Arrows flank the diamond row (up on the left, down on the right).
        triangle_dir(l.floor_up.0 - up_off, l.floor_up.1, 6.0, -1.0, 0.0);
        triangle_dir(l.floor_down.0 + down_off, l.floor_down.1, 6.0, 1.0, 0.0);
    } else {
        // Arrows sit just above/below the diamond group.
        triangle(l.floor_up.0, l.floor_up.1 - up_off, 6.0, true);
        triangle(l.floor_down.0, l.floor_down.1 + down_off, 6.0, false);
    }

    for (slot, (mx, my)) in l.floor_markers.into_iter().enumerate() {
        if slot == selected_slot {
            sgl::c4f(
                C_FLOOR_YELLOW.0,
                C_FLOOR_YELLOW.1,
                C_FLOOR_YELLOW.2,
                0.9 * sel_alpha,
            );
            diamond(mx, my, 12.5, false);
            sgl::c4f(C_HILITE.0, C_HILITE.1, C_HILITE.2, sel_alpha);
            diamond(mx, my, 9.0, true);
        } else {
            sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.8);
            diamond(mx, my, 9.0, false);
        }
    }
}

fn draw_zoom_selector(state: &State) {
    let l = state.layout;
    if !l.show_zoom {
        return;
    }
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.08);
    rect(l.zoom_x, l.zoom_y, l.zoom_w, l.zoom_h);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.75);
    outline_rect(l.zoom_x, l.zoom_y, l.zoom_w, l.zoom_h);

    let normalized = ((state.zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)).clamp(0.0, 1.0);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.86);
    if l.portrait {
        // Horizontal bar: - left, + right, vertical default-zoom centre line.
        let (mx, my) = l.zoom_minus;
        outline_rect(mx, my, 16.0, 16.0);
        line(mx + 4.0, my + 8.0, mx + 12.0, my + 8.0);
        let (px, py) = l.zoom_plus;
        outline_rect(px, py, 16.0, 16.0);
        line(px + 4.0, py + 8.0, px + 12.0, py + 8.0);
        line(px + 8.0, py + 4.0, px + 8.0, py + 12.0);

        line(l.zoom_a.0, l.zoom_a.1, l.zoom_b.0, l.zoom_b.1);
        let cx = (l.zoom_a.0 + l.zoom_b.0) * 0.5;
        sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.72);
        line(cx, l.zoom_a.1 - 8.0, cx, l.zoom_a.1 + 8.0);
        let marker_x = l.zoom_a.0 + (l.zoom_b.0 - l.zoom_a.0) * normalized;
        sgl::c4f(C_HILITE.0, C_HILITE.1, C_HILITE.2, 1.0);
        rect(marker_x - 2.0, l.zoom_a.1 - 10.0, 4.0, 20.0);
    } else {
        // Vertical bar: + top, - bottom, horizontal default-zoom centre line.
        let (px, py) = l.zoom_plus;
        outline_rect(px, py, 16.0, 16.0);
        line(px + 4.0, py + 8.0, px + 12.0, py + 8.0);
        line(px + 8.0, py + 4.0, px + 8.0, py + 12.0);
        let (mx, my) = l.zoom_minus;
        outline_rect(mx, my, 16.0, 16.0);
        line(mx + 4.0, my + 8.0, mx + 12.0, my + 8.0);

        line(l.zoom_a.0, l.zoom_a.1, l.zoom_b.0, l.zoom_b.1);
        let cy = (l.zoom_a.1 + l.zoom_b.1) * 0.5;
        sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.72);
        rect(l.zoom_a.0 - 8.0, cy - 1.0, 16.0, 2.0);
        let marker_y = l.zoom_b.1 + (l.zoom_a.1 - l.zoom_b.1) * normalized;
        sgl::c4f(C_HILITE.0, C_HILITE.1, C_HILITE.2, 1.0);
        rect(l.zoom_a.0 - 10.0, marker_y - 2.0, 20.0, 4.0);
    }
}

fn draw_map_frame(l: &Layout) {
    let right = l.map_x + l.map_w;
    let bottom = l.map_y + l.map_h;
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.75);
    if l.portrait {
        line(l.map_x, l.map_y, right, l.map_y);
        line(l.map_x, bottom, right, bottom);
    } else {
        line(l.floor_x, l.map_y, l.zoom_x + l.panel_w, l.map_y);
        line(l.floor_x, bottom, l.zoom_x + l.panel_w, bottom);
    }
    line(l.map_x, l.map_y, l.map_x, bottom);
    line(right, l.map_y, right, bottom);

    // Gradation ticks at the map edge, pointing inward (no outside margin).
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.5);
    let mut x = l.map_x + 4.0;
    while x < right - 2.0 {
        rect(x, l.map_y, 1.0, 6.0);
        rect(x, bottom - 6.0, 1.0, 6.0);
        x += 8.0;
    }
    let mut y = l.map_y + 4.0;
    while y < bottom - 2.0 {
        rect(l.map_x, y, 6.0, 1.0);
        rect(right - 6.0, y, 6.0, 1.0);
        y += 8.0;
    }
}

fn draw_ui_text(
    font: &Font,
    text: &str,
    x: f32,
    y: f32,
    color: (f32, f32, f32),
    large: bool,
    scale: f32,
) {
    let size = if large { 28.6 } else { 19.5 } * scale;
    draw_text(font, text, x, y, size, color);
}

fn draw_map_labels(font: &Font, l: &Layout) {
    let right = l.map_x + l.map_w;
    let bottom = l.map_y + l.map_h;
    let label = |text: &str, x: f32, y: f32, color: (f32, f32, f32), large: bool| {
        draw_ui_text(font, text, x, y, color, large, l.text_scale)
    };

    // Status HUD: each label gets a rule sized to its own text, so the larger
    // type still sits inside the decoration.
    let scale = l.text_scale;
    let size = 19.5 * scale;
    let hud_right = right - 20.0 * scale;
    let text_right = hud_right - 8.0 * scale;
    // Cap-height band within the em cell (top of caps .. baseline).
    let cap_top = 0.265;
    let cap_bot = 0.81;
    let line_h = size * 0.95;
    sgl::c4f(C_DIM.0, C_DIM.1, C_DIM.2, 0.62);
    let mut last_rule = l.map_y + 8.0 * scale;
    for (i, text) in ["BATTERY", "MEMORY", "DISC"].iter().enumerate() {
        let w = font.text_width(text, size);
        let tx = text_right - w;
        let ty = l.map_y + 8.0 * scale + i as f32 * line_h;
        // Rule just under the baseline so it never crosses the glyphs.
        let rule_y = ty + cap_bot * size + 4.0 * scale;
        last_rule = rule_y;
        line(tx - 8.0 * scale, rule_y, hud_right, rule_y);
        draw_ui_text(font, text, tx, ty, C_DIM, false, scale);
    }
    sgl::begin_points();
    sgl::point_size(2.0 * scale);
    sgl::v2f(hud_right, last_rule);
    sgl::end();

    // AREA MAP inside a border that hugs its (scaled) text.
    let area = "AREA MAP";
    let area_w = font.text_width(area, size);
    let pad_x = 9.0 * scale;
    let pad_y = 5.0 * scale;
    let box_h = (cap_bot - cap_top) * size + pad_y * 2.0;
    let box_w = area_w + pad_x * 2.0;
    let box_x = hud_right - box_w;
    let box_y = bottom - 9.0 * scale - box_h;
    let area_y = box_y + pad_y - cap_top * size;
    line(hud_right, last_rule, hud_right, box_y);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.9);
    outline_rect(box_x, box_y, box_w, box_h);
    draw_ui_text(font, area, box_x + pad_x, area_y, C_HILITE, false, scale);

    if !l.portrait {
        // Two short registration lines continue below the lower-right corner.
        sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.9);
        line(
            right - 34.0 * scale,
            bottom + 4.0 * scale,
            right - 34.0 * scale,
            bottom + 48.0 * scale,
        );
        line(
            right - 20.0 * scale,
            bottom + 4.0 * scale,
            right - 20.0 * scale,
            bottom + 48.0 * scale,
        );

        label("In", l.in_pos.0, l.in_pos.1, C_LABEL, false);
        label("Out", l.out_pos.0, l.out_pos.1, C_LABEL, false);

        // Care Center name, in its bracketed nameplate.
        let name = "Care Center";
        let name_x = l.name_x - font.text_width(name, 28.6 * scale) * 0.5;
        label(name, name_x, l.name_y, C_TITLE, true);

        let inner = l.map_x + 14.0 * scale;
        let name_right = l.map_x + 242.0 * scale;
        sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.9);
        line(
            l.map_x,
            bottom + 4.0 * scale,
            l.map_x,
            bottom + 48.0 * scale,
        );
        line(inner, bottom + 4.0 * scale, inner, bottom + 48.0 * scale);
        line(
            name_right,
            bottom + 4.0 * scale,
            name_right,
            bottom + 48.0 * scale,
        );
    }
}

// On-screen thumbstick for touch devices: a dim base with an accent knob.
fn draw_stick(state: &State) {
    if !show_stick(state) {
        return;
    }
    let l = state.layout;
    let (cx, cy) = l.stick_center;
    sgl::c4f(BACKGROUND.0, BACKGROUND.1, BACKGROUND.2, 0.35);
    filled_circle(cx, cy, l.stick_radius);
    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.55);
    outline_circle(cx, cy, l.stick_radius);
    sgl::c4f(C_DIM.0, C_DIM.1, C_DIM.2, 0.6);
    outline_circle(cx, cy, l.stick_knob);
    let kx = cx + state.stick_vec.0 * l.stick_radius;
    let ky = cy + state.stick_vec.1 * l.stick_radius;
    sgl::c4f(C_ACCENT.0, C_ACCENT.1, C_ACCENT.2, 0.85);
    filled_circle(kx, ky, l.stick_knob * 0.72);
}

fn draw_debug_overlay(state: &State) {
    if !state.debug_mode {
        return;
    }
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    let _ = (MAP_Y, MAP_H);
    let font = state.font.as_ref().unwrap();
    let scale = state.layout.text_scale;
    let text = format!("FPS: {:5.1}", state.fps);
    let width = font.text_width(&text, 19.5 * scale);
    draw_ui_text(
        font,
        &text,
        MAP_X + MAP_W - width - 10.0,
        MAP_Y + 8.0,
        C_ACCENT,
        false,
        scale,
    );
}

// Faint coordinate grid across the whole viewport, behind the map.
fn draw_background_grid(left: f32, right: f32, top: f32, bottom: f32) {
    const S: f32 = GRID_STEP;
    let i0 = (left / S).floor() as i32;
    let i1 = (right / S).ceil() as i32;
    let j0 = (top / S).floor() as i32;
    let j1 = (bottom / S).ceil() as i32;
    let half = S * 0.5;
    sgl::begin_quads();
    // Bright dots at the grid vertices.
    sgl::c4f(GRID_RGB.0, GRID_RGB.1, GRID_RGB.2, 1.0);
    for i in i0..=i1 {
        for j in j0..=j1 {
            dot(i as f32 * S, j as f32 * S, 2.2);
        }
    }
    // Fainter dots at the edge midpoints and the square centres.
    sgl::c4f(GRID_RGB.0, GRID_RGB.1, GRID_RGB.2, 0.5);
    for i in i0..=i1 {
        for j in j0..=j1 {
            let (x, y) = (i as f32 * S, j as f32 * S);
            dot(x + half, y, 1.6);
            dot(x, y + half, 1.6);
            dot(x + half, y + half, 1.6);
        }
    }
    sgl::end();
}

// A small filled square in reference space.
fn dot(cx: f32, cy: f32, size: f32) {
    let h = size * 0.5;
    sgl::v2f(cx - h, cy - h);
    sgl::v2f(cx + h, cy - h);
    sgl::v2f(cx + h, cy + h);
    sgl::v2f(cx - h, cy + h);
}

// Fill each room with the floor colour, then scatter a per-room dot grid or
// diamond lattice. Which pattern (and grid size) is picked from the room's
// rectangle, so it is stable across frames.
fn draw_rooms(state: &State, frame: (f32, f32, f32, f32), ox: f32, oy: f32, iw: f32, ih: f32) {
    let floor = &view_scene(state).floors[state.floor];
    // The floor follows the room union, plus any WALL- carve that sits fully
    // inside a room (an enclosed alcove reads as a room; an open carve stays a
    // hole, matching the nav).
    let adds: Vec<Rect> = floor
        .walls
        .iter()
        .filter(|w| w.mode == BoolOp::Add)
        .map(|w| w.rect)
        .collect();
    let mut region = region_rects(&floor.wall_ops());
    for w in floor.walls.iter().filter(|w| w.mode == BoolOp::Sub) {
        if adds.iter().any(|a| rect_inside(w.rect, *a)) {
            region.push(w.rect);
        }
    }
    if region.is_empty() {
        return;
    }
    sgl::c4f(ROOM_FLOOR.0, ROOM_FLOOR.1, ROOM_FLOOR.2, 1.0);
    sgl::begin_quads();
    for r in &region {
        let (x0, y0) = src_to_ref(frame, ox, oy, iw, ih, r.x, r.y);
        let (x1, y1) = src_to_ref(frame, ox, oy, iw, ih, r.x + r.w, r.y + r.h);
        sgl::v2f(x0, y0);
        sgl::v2f(x1, y0);
        sgl::v2f(x1, y1);
        sgl::v2f(x0, y1);
    }
    sgl::end();

    sgl::begin_quads();
    for w in floor.walls.iter().filter(|w| w.mode == BoolOp::Add) {
        let inner = Rect {
            x: w.rect.x + ROOM_WALL_PX,
            y: w.rect.y + ROOM_WALL_PX,
            w: w.rect.w - 2.0 * ROOM_WALL_PX,
            h: w.rect.h - 2.0 * ROOM_WALL_PX,
        };
        if inner.w <= 0.0 || inner.h <= 0.0 {
            continue;
        }
        let h = rect_hash(inner);
        match h % 6 {
            0 => {} // no grid
            1 => draw_diamonds(frame, ox, oy, iw, ih, inner, 84.0),
            n => {
                let step = match n {
                    2 => 44.0,
                    3 => 64.0,
                    4 => 92.0,
                    _ => 64.0,
                };
                draw_room_dots(frame, ox, oy, iw, ih, inner, step);
            }
        }
    }
    sgl::end();

    // Fog floor: a region that has not been entered yet has no background (it is
    // erased back to the page), then greys in once visited. Edit mode always
    // shows the authored floor.
    if !state.edit {
        for r in &state.scene.floors[state.floor].regions {
            if region_state(state, state.floor, r) == RegionState::Visited {
                continue;
            }
            let (x0, y0) = src_to_ref(frame, ox, oy, iw, ih, r.rect.x, r.rect.y);
            let (x1, y1) = src_to_ref(
                frame,
                ox,
                oy,
                iw,
                ih,
                r.rect.x + r.rect.w,
                r.rect.y + r.rect.h,
            );
            sgl::c4f(BACKGROUND.0, BACKGROUND.1, BACKGROUND.2, 1.0);
            rect(x0, y0, x1 - x0, y1 - y0);
        }
    }
}

fn draw_room_dots(
    frame: (f32, f32, f32, f32),
    ox: f32,
    oy: f32,
    iw: f32,
    ih: f32,
    r: Rect,
    step: f32,
) {
    sgl::c4f(ROOM_DOT.0, ROOM_DOT.1, ROOM_DOT.2, 1.0);
    let hx = ROOM_DOT_PX * iw / frame.2 * 0.5;
    let hy = ROOM_DOT_PX * ih / frame.3 * 0.5;
    let mut y = r.y;
    while y <= r.y + r.h + 0.1 {
        let mut x = r.x;
        while x <= r.x + r.w + 0.1 {
            let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, x, y);
            sgl::v2f(rx - hx, ry - hy);
            sgl::v2f(rx + hx, ry - hy);
            sgl::v2f(rx + hx, ry + hy);
            sgl::v2f(rx - hx, ry + hy);
            x += step;
        }
        y += step;
    }
}

// A 45-degree lattice that tiles the room with diamonds.
fn draw_diamonds(
    frame: (f32, f32, f32, f32),
    ox: f32,
    oy: f32,
    iw: f32,
    ih: f32,
    r: Rect,
    step: f32,
) {
    sgl::c4f(ROOM_LINE.0, ROOM_LINE.1, ROOM_LINE.2, 1.0);
    let t = 1.6 * iw / frame.2;
    let (x0, y0, x1, y1) = (r.x, r.y, r.x + r.w, r.y + r.h);
    // Family y = x + c.
    let mut c = ((y0 - x1) / step).floor() * step;
    while c <= y1 - x0 {
        let xa = x0.max(y0 - c);
        let xb = x1.min(y1 - c);
        if xb > xa {
            emit_line(frame, ox, oy, iw, ih, (xa, xa + c), (xb, xb + c), t);
        }
        c += step;
    }
    // Family y = -x + c.
    let mut c = ((y0 + x0) / step).floor() * step;
    while c <= y1 + x1 {
        let xa = x0.max(c - y1);
        let xb = x1.min(c - y0);
        if xb > xa {
            emit_line(frame, ox, oy, iw, ih, (xa, -xa + c), (xb, -xb + c), t);
        }
        c += step;
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_line(
    frame: (f32, f32, f32, f32),
    ox: f32,
    oy: f32,
    iw: f32,
    ih: f32,
    a: (f32, f32),
    b: (f32, f32),
    thickness: f32,
) {
    let (ax, ay) = src_to_ref(frame, ox, oy, iw, ih, a.0, a.1);
    let (bx, by) = src_to_ref(frame, ox, oy, iw, ih, b.0, b.1);
    let (dx, dy) = (bx - ax, by - ay);
    let len = (dx * dx + dy * dy).sqrt().max(0.001);
    let (px, py) = (-dy / len * thickness * 0.5, dx / len * thickness * 0.5);
    sgl::v2f(ax + px, ay + py);
    sgl::v2f(bx + px, by + py);
    sgl::v2f(bx - px, by - py);
    sgl::v2f(ax - px, ay - py);
}

fn rect_hash(r: Rect) -> u32 {
    let mut h = 2166136261u32;
    for v in [r.x, r.y, r.w, r.h] {
        for b in v.to_bits().to_le_bytes() {
            h ^= b as u32;
            h = h.wrapping_mul(16777619);
        }
    }
    h
}

fn reference_projection(l: &Layout, width: f32, height: f32) -> (f32, f32, f32, f32) {
    // Fill the resized viewport without distorting the reference layout. If the
    // viewport aspect differs, expose extra reference space on the longer axis.
    let reference_aspect = l.ref_w / l.ref_h;
    let aspect = if height > 0.0 {
        width / height
    } else {
        reference_aspect
    };
    if aspect >= reference_aspect {
        let visible_width = l.ref_h * aspect;
        let crop = (visible_width - l.ref_w) * 0.5;
        (-crop, l.ref_w + crop, 0.0, l.ref_h)
    } else {
        let visible_height = l.ref_w / aspect.max(0.0001);
        let crop = (visible_height - l.ref_h) * 0.5;
        (0.0, l.ref_w, -crop, l.ref_h + crop)
    }
}

extern "C" fn frame(user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    let delta = (sapp::frame_duration() as f32).clamp(0.0, 0.1);
    state.layout = Layout::compute(sapp::widthf(), sapp::heightf());
    if !state.camera_ready {
        // Open the map centred on the player instead of the map's middle.
        pan_to_center_player(state);
        state.pan_x = state.pan_target_x;
        state.pan_y = state.pan_target_y;
        state.follow_target = (state.pan_x, state.pan_y);
        state.camera_ready = true;
    }
    state.time += delta;
    // Commands from the web shell (e.g. NEW RUN) are read every frame.
    poll_command(state);
    // Modal menus (and the inventory) freeze gameplay and playtime.
    let frozen = state.menu != Menu::None || state.inventory_open || state.item_box_open;
    if !frozen {
        state.play_time += delta;
        update_player(state, delta);
        update_hover(state);
        notify_state(state, false);
    }
    let ease = (delta * 14.0).min(1.0);
    state.zoom += (state.zoom_target - state.zoom) * ease;
    if let Some(a) = state.zoom_anchor {
        let l = state.layout;
        // Google-Maps style: keep the anchored map point under the cursor.
        let frame = floor_frame(state.floor);
        let (pan_x, pan_y) = anchor_pan(&l, state.zoom, a.src, a.cursor_ref, frame);
        state.pan_x = pan_x;
        state.pan_y = pan_y;
        state.pan_target_x = pan_x;
        state.pan_target_y = pan_y;
        if (state.zoom - a.end).abs() < 0.002 {
            state.zoom_anchor = None;
        }
    } else {
        state.pan_x += (state.pan_target_x - state.pan_x) * ease;
        state.pan_y += (state.pan_target_y - state.pan_y) * ease;
    }
    // Camera follow. Holding a movement key tracks the player continuously; a
    // tap latches `recentre` so a single press still pans smoothly all the way
    // back to the player. When neither is active the camera never moves on its
    // own, so a manual pan stays where it was left.
    let stick_mag = (state.stick_vec.0.powi(2) + state.stick_vec.1.powi(2)).sqrt();
    let has_input = stick_mag > 0.0 || state.holding.iter().any(|&held| held);
    let following = (has_input || state.recentre)
        && !state.edit
        && !frozen
        && state.floor == state.player_floor
        && state.zoom_anchor.is_none()
        && !state.dragging
        && !state.pinching;
    if following {
        let frame = floor_frame(state.player_floor);
        let target = player_center_pan(&state.layout, state.zoom, state.player, frame);
        state.follow_target = follow_step(target, state.follow_target, delta);
        state.pan_target_x = state.follow_target.0;
        state.pan_target_y = state.follow_target.1;
        // A tap-recentre is done once the camera has reached the player.
        if state.recentre
            && (state.follow_target.0 - target.0).abs() < 1.0
            && (state.follow_target.1 - target.1).abs() < 1.0
        {
            state.recentre = false;
        }
    } else {
        // Keep the catch-up seed in sync so a later follow never jumps.
        state.follow_target = (state.pan_target_x, state.pan_target_y);
    }

    if state.arrow_up_t > 0.0 {
        state.arrow_up_t = (state.arrow_up_t + delta / 0.25).min(1.0);
        if state.arrow_up_t >= 1.0 {
            state.arrow_up_t = 0.0;
        }
    }
    if state.arrow_down_t > 0.0 {
        state.arrow_down_t = (state.arrow_down_t + delta / 0.25).min(1.0);
        if state.arrow_down_t >= 1.0 {
            state.arrow_down_t = 0.0;
        }
    }

    // Limit panning so the map stays within the window.
    {
        let l = state.layout;
        let frame = floor_frame(state.floor);
        let (iw, ih) = image_size(&l, state.zoom, frame);
        let max_x = if iw > l.map_w {
            (iw - l.map_w) * 0.5
        } else {
            0.0
        } + PAN_MARGIN;
        let max_y = if ih > l.map_h {
            (ih - l.map_h) * 0.5
        } else {
            0.0
        } + PAN_MARGIN;
        state.pan_x = state.pan_x.clamp(-max_x, max_x);
        state.pan_y = state.pan_y.clamp(-max_y, max_y);
        state.pan_target_x = state.pan_target_x.clamp(-max_x, max_x);
        state.pan_target_y = state.pan_target_y.clamp(-max_y, max_y);
    }

    // Hovered key item under the active cursor (drives the popup label).
    let (hc_x, hc_y) = active_cursor(state);
    let show_cursor = !state.circle_cursor_hidden
        && !(state.cursor_mode == CursorMode::Free && !state.mouse_in_map);
    state.hover_item = if show_cursor {
        hover_item_at(state, hc_x, hc_y)
    } else {
        None
    };

    // Free cursor follows the mouse.
    if state.cursor_mode == CursorMode::Free && state.mouse_in_map {
        state.cursor = clamp_to_map(&state.layout, state.mouse);
    }
    if let Some(target) = state.pending_floor {
        state.transition_t = (state.transition_t + delta / 0.225).min(1.0);
        if state.transition_t >= 0.5 && state.floor != target {
            state.floor = target;
            notify_floor(target);
            // Stair rides land here at the fade midpoint.
            if let Some(spawn) = state.pending_spawn.take() {
                let nav = &state.nav[state.player_floor];
                let cell = snap_source(nav, spawn.0, spawn.1);
                state.player = match cell {
                    Some(c) => cell_to_source(nav, c.0, c.1),
                    None => spawn,
                };
                state.player_cell = cell;
                if let Some(c) = cell {
                    ensure_reachable(state, state.player_floor, c);
                }
                state.player_vel = (0.0, 0.0);
                // The player is on a new floor: refresh its turn-based reach and
                // goals, or nothing here would be clickable.
                state.move_anim = None;
                rebuild_move(state);
                on_progress_changed(state);
                notify_state(state, true);
                pan_to_center_player(state);
                state.follow_target = (state.pan_target_x, state.pan_target_y);
                state.recentre = false;
            }
        }
        if state.transition_t >= 1.0 {
            state.pending_floor = None;
        }
    }
    state.fps_elapsed += delta;
    state.status_t = (state.status_t - delta).max(0.0);
    state.fps_frames += 1;
    if state.fps_elapsed >= 0.25 {
        state.fps = state.fps_frames as f32 / state.fps_elapsed.max(0.0001);
        state.fps_elapsed = 0.0;
        state.fps_frames = 0;
    }

    // A transform drag changed the walls: re-extract the boundary once, here,
    // rather than rebuilding the whole bake every frame.
    if state.wall_plans_dirty {
        state.wall_plans[state.floor] = wall_plan(&state.scene.floors[state.floor]);
        state.wall_plans_dirty = false;
    }

    let width = sapp::widthf();
    let height = sapp::heightf();
    let (left, right, top, bottom) = reference_projection(&state.layout, width, height);

    sgl::viewportf(0.0, 0.0, width, height, true);
    sgl::defaults();
    sgl::matrix_mode_projection();
    sgl::ortho(left, right, bottom, top, -1.0, 1.0);
    sgl::matrix_mode_modelview();
    sgl::load_identity();
    sgl::load_pipeline(state.pipeline);

    draw_background_grid(left, right, top, bottom);
    draw_floor_selector(state);
    draw_zoom_selector(state);
    draw_floor(state, width, height, left, right, top, bottom);
    if state.edit {
        draw_editor(state, width, height, left, right, top, bottom);
    }
    draw_floor_fade(state, width, height, left, right, top, bottom);
    draw_map_frame(&state.layout);
    draw_map_labels(state.font.as_ref().unwrap(), &state.layout);
    draw_inventory(state, state.font.as_ref().unwrap());
    draw_item_box(state, state.font.as_ref().unwrap());
    draw_menu(state, state.font.as_ref().unwrap());
    draw_cursor(state, width, height, left, right, top, bottom);
    draw_stick(state);
    draw_debug_overlay(state);

    sg::begin_pass(&sg::Pass {
        action: state.pass_action,
        swapchain: sglue::swapchain(),
        ..Default::default()
    });
    sgl::draw();
    sg::end_pass();
    sg::commit();
}

extern "C" fn cleanup(user_data: *mut ffi::c_void) {
    // Unbind the custom cursor while the X11 display is still alive. Sokol's
    // Linux shutdown closes the display before discarding bound cursor images
    // (sokol_app.h _sapp_discard_state), which would segfault in XFreeCursor.
    sapp::unbind_mouse_cursor_image(sapp::MouseCursor::Custom0);
    sgl::shutdown();
    sg::shutdown();
    let _ = unsafe { Box::from_raw(user_data as *mut State) };
}

fn main() {
    // Prefer a saved scene (localStorage/file), else the committed scene.bin.
    let scene = load_scene_bytes()
        .and_then(|b| Scene::from_bytes(&b))
        .or_else(|| Scene::from_bytes(SCENE_BIN))
        .unwrap_or_default();
    let next_id = max_id(&scene) + 1;
    // The app starts in play mode: bake with initial region visibility applied.
    let play_scene = apply_regions(&scene, &[], &[]);
    let baked = bake(&play_scene);
    let BakedBytes {
        overlays,
        nav,
        nav_open,
        solid,
        stairs,
        items,
    } = baked;
    let nav = std::array::from_fn(|i| Nav::from_bytes(&nav[i], FLOOR_FRAMES[i]));
    let nav_open = std::array::from_fn(|i| Nav::from_bytes(&nav_open[i], FLOOR_FRAMES[i]));
    let solid = std::array::from_fn(|i| Solid::from_bytes(&solid[i], FLOOR_FRAMES[i]));
    let move_grid: [MoveGrid; NUM_FLOORS] = std::array::from_fn(|i| MoveGrid::from_nav(&nav[i]));
    let wall_plans: [WallPlan; NUM_FLOORS] =
        std::array::from_fn(|i| wall_plan(&play_scene.floors[i]));

    let state = Box::new(State {
        layout: Layout::compute(1920.0, 1080.0),
        zoom_anchor: None,
        pass_action: sg::PassAction::new(),
        pipeline: sgl::Pipeline::new(),
        overlay_views: std::array::from_fn(|_| sg::View::new()),
        overlay_sampler: sg::Sampler::new(),
        overlay_data: overlays,
        font: None,
        nav,
        nav_open,
        solid,
        wall_plans,
        wall_plans_dirty: false,
        stairs: parse_stairs(&stairs),
        items: parse_items(&items),
        astar: Astar::new(),
        scene,
        edit: false,
        tool: Tool::WallAdd,
        snap: true,
        drag_from: None,
        drag_to: None,
        door_preview: None,
        selection: Vec::new(),
        drag_mode: DragMode::None,
        drag_orig: None,
        drag_all: Vec::new(),
        drag_grab: (0.0, 0.0),
        drag_dirty: false,
        pending_link: None,
        clipboard: Vec::new(),
        rename: None,
        collected: Vec::new(),
        revealed: Vec::new(),
        unlocked: Vec::new(),
        visited: Vec::new(),
        revealed_regions: Vec::new(),
        fired_triggers: Vec::new(),
        play_scene,
        inventory: Vec::new(),
        inventory_open: false,
        inventory_selected: 0,
        item_box: Vec::new(),
        item_box_open: false,
        item_box_cursor: 0,
        item_kind: ItemKind::Key,
        play_time: 0.0,
        menu: Menu::None,
        menu_index: 0,
        confirm: None,
        confirm_index: 0,
        slot_meta: [None; SAVE_SLOTS],
        undo: Vec::new(),
        next_id,
        status: String::new(),
        status_t: 0.0,
        reachable: std::array::from_fn(|_| Vec::new()),
        path_red: Vec::new(),
        path: Vec::new(),
        show_grid: false,
        time: 0.0,
        zoom_target: DEFAULT_ZOOM,
        pan_target_x: 0.0,
        pan_target_y: 0.0,
        pending_floor: None,
        transition_t: 0.0,
        player_floor: 2,
        pending_spawn: None,
        stair_lock: false,
        cursor: (959.5, 588.0),
        mouse: (959.5, 588.0),
        // Show the default map-centre cursor from the first frame; it snaps
        // to the pointer on the first mouse-move event in mouse-cursor mode.
        mouse_in_map: true,
        cursor_mode: CursorMode::Free,
        os_cursor_hidden: false,
        touch_last: (0.0, 0.0),
        down_ref: (0.0, 0.0),
        moved: false,
        pinching: false,
        pinch_dist: 0.0,
        pinch_base_zoom: DEFAULT_ZOOM,
        pinch_src: (0.0, 0.0),
        player: PLAYER,
        player_vel: (0.0, 0.0),
        facing: 0.0,
        facing_target: 0.0,
        holding: [false; 4],
        player_cell: None,
        follow_target: (0.0, 0.0),
        recentre: false,
        circle_cursor_hidden: false,
        camera_ready: false,
        stick_id: None,
        stick_vec: (0.0, 0.0),
        touch_capable: touch_capable(),
        touch_seen: false,
        hover_item: None,
        arrow_up_t: 0.0,
        arrow_down_t: 0.0,
        goals: Vec::new(),
        goal: None,
        route_visible: true,
        move_grid,
        move_reach: std::array::from_fn(|_| Vec::new()),
        turn: 0,
        steps: 0,
        hover_cell: None,
        hover_path: Vec::new(),
        hover_run: false,
        move_anim: None,
        notified_state: None,
        floor: 2,
        zoom: DEFAULT_ZOOM,
        pan_x: 0.0,
        pan_y: 0.0,
        dragging: false,
        debug_mode: false,
        fps: 0.0,
        fps_elapsed: 0.0,
        fps_frames: 0,
    });
    sapp::run(&sapp::Desc {
        init_userdata_cb: Some(init),
        frame_userdata_cb: Some(frame),
        event_userdata_cb: Some(event),
        cleanup_userdata_cb: Some(cleanup),
        user_data: Box::into_raw(state) as *mut ffi::c_void,
        window_title: c"Resident Evil Requiem Map".as_ptr(),
        width: 1280,
        height: 720,
        // Native Sokol uses the platform's borderless fullscreen path. The
        // web target stays inside the React shell's map canvas.
        fullscreen: true,
        // Render at the display's true pixel density so sokol lines stay crisp
        // on HiDPI screens.
        high_dpi: true,
        sample_count: 4,
        swap_interval: 1,
        html5: sapp::Html5Desc {
            canvas_selector: c"#map-canvas".as_ptr(),
            // Track the canvas' CSS size (instead of forcing the fixed
            // 1280x720 backing store) so the browser never upscales the frame.
            canvas_resize: false,
            ..Default::default()
        },
        logger: sapp::Logger {
            func: Some(sokol::log::slog_func),
            ..Default::default()
        },
        ..Default::default()
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ink_ribbon_native::scene::{
        Floor, FLOOR1_FRAME, FLOOR1_H, FLOOR1_INDEX, FLOOR1_W, FLOOR1_X, FLOOR1_Y,
    };

    #[test]
    fn picking_prefers_objects_inside_a_room() {
        let mut scene = Scene::default();
        let floor = &mut scene.floors[FLOOR1_INDEX];
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect {
                x: 0.0,
                y: 0.0,
                w: 600.0,
                h: 600.0,
            },
        });
        floor.obstacles.push(Box2 {
            id: 1,
            center: (300.0, 300.0),
            size: (64.0, 64.0),
            rot: 0.0,
        });
        floor.doors.push(Door {
            id: 2,
            kind: DoorKind::Unlocked,
            reveals_as: DoorKind::Locked,
            center: (200.0, 0.0),
            size: (DOOR_LONG_PX, DOOR_THICK_PX),
            rot: 0.0,
        });
        floor.labels.push(RoomLabel {
            name: "Room".into(),
            pos: (450.0, 450.0),
        });
        // Empty room space picks the room; the smaller objects win when hit.
        assert_eq!(
            pick_object(&scene, FLOOR1_INDEX, (100.0, 100.0)),
            Some(Selection::Wall(0))
        );
        assert_eq!(
            pick_object(&scene, FLOOR1_INDEX, (300.0, 300.0)),
            Some(Selection::Obstacle(0))
        );
        assert_eq!(
            pick_object(&scene, FLOOR1_INDEX, (200.0, 0.0)),
            Some(Selection::Door(0))
        );
        // A point object inside a room is selectable when clicked near it.
        assert_eq!(
            pick_object(&scene, FLOOR1_INDEX, (450.0, 450.0)),
            Some(Selection::Label(0))
        );
        assert_eq!(
            pick_object(&scene, FLOOR1_INDEX, (500.0, 450.0)),
            Some(Selection::Label(0))
        );
    }

    #[test]
    fn item_box_grid_mapping() {
        // Box slots are columns 0..4 of each row; inventory is columns 4..8.
        assert_eq!(box_slot_grid(0), (true, 0));
        assert_eq!(box_slot_grid(3), (true, 3));
        assert_eq!(box_slot_grid(4), (false, 0));
        assert_eq!(box_slot_grid(7), (false, 3));
        assert_eq!(box_slot_grid(8), (true, 4));
        assert_eq!(box_slot_grid(12), (false, 4));
        assert_eq!(box_slot_grid(31), (false, 15));
    }

    #[test]
    fn door_snaps_to_the_nearest_wall() {
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect {
                x: 0.0,
                y: 0.0,
                w: 400.0,
                h: 400.0,
            },
        });
        let plan = wall_plan(&floor);
        // Just inside the top wall -> horizontal door on the wall centreline.
        let s = snap_door_in(&plan, (200.0, 5.0)).expect("snap to top wall");
        assert_eq!(s.2, 0.0);
        assert!(
            (s.1 - ROOM_WALL_PX * 0.5).abs() < 0.01,
            "centre y = {}",
            s.1
        );
        // Near the left wall -> vertical door.
        let s = snap_door_in(&plan, (5.0, 200.0)).expect("snap to left wall");
        assert!((s.2 - std::f32::consts::FRAC_PI_2).abs() < 0.01);
        // Far from any wall -> no snap.
        assert!(snap_door_in(&plan, (200.0, 200.0)).is_none());
    }

    #[test]
    fn zoom_anchor_keeps_point_under_cursor() {
        for portrait in [false, true] {
            let l = if portrait {
                Layout::compute(450.0, 800.0)
            } else {
                Layout::compute(1280.0, 720.0)
            };
            assert_eq!(l.portrait, portrait);
            let cursor = (l.map_x + l.map_w * 0.3, l.map_y + l.map_h * 0.4);
            let (ox, oy, iw, ih) = map_rect(&l, DEFAULT_ZOOM, 0.0, 0.0, FLOOR1_FRAME);
            let sx = FLOOR1_X + (cursor.0 - ox) * FLOOR1_W / iw;
            let sy = FLOOR1_Y + (cursor.1 - oy) * FLOOR1_H / ih;
            // Google style: the anchored point stays under the cursor.
            let (px, py) = anchor_pan(&l, 1.5, (sx, sy), cursor, FLOOR1_FRAME);
            let (ox1, oy1, iw1, ih1) = map_rect(&l, 1.5, px, py, FLOOR1_FRAME);
            let (rx, ry) = src_to_ref(FLOOR1_FRAME, ox1, oy1, iw1, ih1, sx, sy);
            assert!(
                (rx - cursor.0).abs() < 1.0 && (ry - cursor.1).abs() < 1.0,
                "portrait={portrait} anchored point drifted from the cursor"
            );
        }
    }

    // Build a throwaway nav grid for collision tests (leaked so it is 'static).
    fn synthetic_nav(w: usize, h: usize, blocked: impl Fn(usize, usize) -> bool) -> Nav {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(&(w as u32).to_le_bytes());
        bytes.extend_from_slice(&(h as u32).to_le_bytes());
        let mut bits = vec![0u8; (w * h + 7) / 8];
        for y in 0..h {
            for x in 0..w {
                if !blocked(x, y) {
                    let i = y * w + x;
                    bits[i >> 3] |= 1 << (i & 7);
                }
            }
        }
        bytes.extend_from_slice(&bits);
        let leaked: &'static [u8] = Box::leak(bytes.into_boxed_slice());
        Nav::from_bytes(leaked, FLOOR1_FRAME)
    }

    #[test]
    fn facing_vector_points_with_the_angle() {
        let up = facing_vector(0.0);
        assert!(up.0.abs() < 1e-6 && up.1 < -0.99, "0 rad should point up");
        let right = facing_vector(std::f32::consts::FRAC_PI_2);
        assert!(
            right.0 > 0.99 && right.1.abs() < 1e-6,
            "90 deg should point right"
        );
        let down = facing_vector(std::f32::consts::PI);
        assert!(
            down.0.abs() < 1e-6 && down.1 > 0.99,
            "180 deg should point down"
        );
    }

    #[test]
    fn facing_score_prefers_ahead_and_nearer() {
        let player = (100.0, 100.0);
        // Facing up (0 rad): ahead is -y.
        let ahead = (100.0, 70.0);
        let behind = (100.0, 130.0);
        let side = (130.0, 100.0);
        let s_ahead = facing_score(player, 0.0, ahead, dist(player, ahead));
        let s_behind = facing_score(player, 0.0, behind, dist(player, behind));
        let s_side = facing_score(player, 0.0, side, dist(player, side));
        assert!(s_ahead < s_side, "ahead should beat an equidistant side");
        assert!(
            s_ahead < s_behind,
            "ahead should beat an equidistant behind"
        );
        // Equally in front: the nearer one wins.
        let near = (100.0, 90.0);
        let far = (100.0, 60.0);
        assert!(
            facing_score(player, 0.0, near, dist(player, near))
                < facing_score(player, 0.0, far, dist(player, far))
        );
    }

    // Build a throwaway collision mask (leaked so it is 'static).
    fn synthetic_solid(w: usize, h: usize, blocked: impl Fn(usize, usize) -> bool) -> Solid {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(w as u32).to_le_bytes());
        bytes.extend_from_slice(&(h as u32).to_le_bytes());
        let mut bits = vec![0u8; (w * h + 7) / 8];
        for y in 0..h {
            for x in 0..w {
                if blocked(x, y) {
                    let i = y * w + x;
                    bits[i >> 3] |= 1 << (i & 7);
                }
            }
        }
        bytes.extend_from_slice(&bits);
        let leaked: &'static [u8] = Box::leak(bytes.into_boxed_slice());
        Solid::from_bytes(leaked, FLOOR1_FRAME)
    }

    #[test]
    fn player_slides_along_walls() {
        // Vertical wall at x == 11; everything else walkable.
        let nav = synthetic_nav(40, 40, |x, _| x == 11);
        let start = cell_to_source(&nav, 10, 10);
        assert!(walkable_center(&nav, start.0, start.1));
        let free = |x: f32, y: f32| walkable_center(&nav, x, y);

        // Straight into the wall is refused.
        let (pos, blocked_x, _) = resolve_move(free, start, (100.0, 0.0));
        assert_eq!(pos, start, "moving straight into a wall should not move");
        assert!(blocked_x, "x should report as blocked");

        // Diagonal into the wall keeps the tangential component: it slides in y.
        let (pos, blocked_x, blocked_y) = resolve_move(free, start, (100.0, 60.0));
        assert!(blocked_x, "x should be blocked by the wall");
        assert!(!blocked_y, "y should stay free so the player slides");
        assert!(pos.1 > start.1, "player should slide along the wall");
        assert!(
            (pos.0 - start.0).abs() < 0.01,
            "player must not advance into the wall"
        );
    }

    #[test]
    fn player_stops_at_real_wall_ink() {
        // Nav says walkable for x < 20; the real wall ink only starts at x == 24.
        // The player should be able to enter the (nav-blocked) ring but stop one
        // collision radius short of the ink.
        let nav = synthetic_nav(40, 40, |x, _| x >= 20);
        let solid = synthetic_solid(40, 40, |x, _| x >= 24);
        let wall_x = FLOOR1_X + 24.0 / 40.0 * FLOOR1_W;
        let free_at = |sx: f32| can_stand(&nav, &solid, sx, 4136.6);
        assert!(free_at(wall_x - 9.0), "outside the radius should be free");
        assert!(
            !free_at(wall_x - 7.0),
            "inside the collision radius should be blocked by the wall"
        );
    }

    #[test]
    fn per_floor_frames_use_own_aspect() {
        assert_eq!(floor_frame(FLOOR1_INDEX), FLOOR1_FRAME);
        assert_eq!(floor_frame(0), FLOOR_FRAMES[0]);
        assert_eq!(floor_frame(1), FLOOR_FRAMES[1]);

        // Each floor's on-screen image uses its own aspect ratio.
        let l = Layout::compute(1280.0, 720.0);
        for (floor, (_, _, w, h)) in FLOOR_FRAMES.iter().enumerate() {
            let (iw, ih) = image_size(&l, 1.0, floor_frame(floor));
            assert!(
                (iw / ih - w / h).abs() < 1e-3,
                "floor {floor} aspect drift: {iw}x{ih}"
            );
        }
    }

    #[test]
    fn astar_reuse_matches_fresh_searches() {
        // A fully walkable synthetic grid; corners are mutually reachable.
        let nav = synthetic_nav(40, 40, |_, _| false);
        let start = (0, 0);
        let goal = (39, 39);
        let mut reused = Astar::new();
        // Interleave an unrelated search so stale stamps would show up.
        let _ = reused.search(&nav, goal, start);
        let got = reused.search(&nav, start, goal);
        let fresh = Astar::new().search(&nav, start, goal);
        assert_eq!(got, fresh, "reused scratch diverged from a fresh search");
        assert!(got.is_some(), "the corners should be reachable");
    }

    #[test]
    fn stick_vector_deadzone_clamp_and_direction() {
        // Inside the deadzone => no movement.
        assert_eq!(stick_vector((5.0, 0.0), 100.0, 0.15), (0.0, 0.0));
        // At the rim => unit length, same direction.
        let full = stick_vector((0.0, 100.0), 100.0, 0.15);
        assert!(full.1 > 0.999 && full.0.abs() < 1e-6);
        // Beyond the rim => clamped to unit length.
        let over = stick_vector((300.0, 0.0), 100.0, 0.15);
        assert!(over.0 > 0.999 && over.1.abs() < 1e-6);
        // Partial deflection scales magnitude: (57.5-15)/(100-15) = 0.5.
        let half = stick_vector((0.0, 57.5), 100.0, 0.15);
        assert!((half.1 - 0.5).abs() < 1e-4);
        // A diagonal never exceeds unit length (no faster diagonals).
        let diag = stick_vector((100.0, 100.0), 100.0, 0.15);
        assert!((diag.0 - diag.1).abs() < 1e-6);
        assert!((diag.0 * diag.0 + diag.1 * diag.1).sqrt() <= 1.0 + 1e-6);
    }

    #[test]
    fn player_center_pan_centres_the_player() {
        let l = Layout::compute(1280.0, 720.0);
        let player = (4000.0, 4600.0);
        let (px, py) = player_center_pan(&l, DEFAULT_ZOOM, player, FLOOR1_FRAME);
        let (ox, oy, iw, ih) = map_rect(&l, DEFAULT_ZOOM, px, py, FLOOR1_FRAME);
        let (rx, ry) = src_to_ref(FLOOR1_FRAME, ox, oy, iw, ih, player.0, player.1);
        let (cx, cy) = cursor_center(&l);
        assert!((rx - cx).abs() < 1.0 && (ry - cy).abs() < 1.0);
    }

    #[test]
    fn tap_recentre_finishes_after_release() {
        // A single frame of input arms the latch; the camera must keep easing to
        // the player after release, then stop.
        let l = Layout::compute(1280.0, 720.0);
        let dt = 1.0 / 60.0;
        // Start deliberately panned away from the player.
        let mut follow_target = player_center_pan(&l, DEFAULT_ZOOM, PLAYER, FLOOR1_FRAME);
        follow_target.0 -= 400.0;
        let target = player_center_pan(&l, DEFAULT_ZOOM, PLAYER, FLOOR1_FRAME);
        let mut recentre = true;
        let mut frames = 0;
        while recentre {
            follow_target = follow_step(target, follow_target, dt);
            if (follow_target.0 - target.0).abs() < 1.0 && (follow_target.1 - target.1).abs() < 1.0
            {
                recentre = false;
            }
            frames += 1;
            assert!(frames < 600, "recentre never reached the player");
        }
        // It must actually have travelled back.
        assert!(frames > 10, "recentre finished suspiciously fast");
    }

    #[test]
    fn camera_follow_is_continuous_while_input_is_held() {
        // Walking at a constant speed must move the camera every frame, smoothly
        // (the old deadzone gate stopped and restarted the follow -> stutter).
        let l = Layout::compute(1280.0, 720.0);
        let dt = 1.0 / 60.0;
        let mut player = PLAYER;
        let mut follow = player_center_pan(&l, DEFAULT_ZOOM, player, FLOOR1_FRAME);
        let mut prev_delta: Option<f32> = None;
        for _ in 0..600 {
            player.0 += PLAYER_SPEED * dt;
            let target = player_center_pan(&l, DEFAULT_ZOOM, player, FLOOR1_FRAME);
            let next = follow_step(target, follow, dt);
            let delta = next.0 - follow.0;
            assert!(
                delta.abs() > 1e-3,
                "camera stopped while the player was moving"
            );
            if let Some(prev) = prev_delta {
                assert!(
                    delta.abs() <= prev.abs() * 2.0 + 1e-3,
                    "camera jumped between frames"
                );
            }
            prev_delta = Some(delta);
            follow = next;
        }
    }

    #[test]
    fn stairs_parse_and_resolve_destinations() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // a_floor = Floor 2
        bytes.extend_from_slice(&2u32.to_le_bytes()); // b_floor = Floor 1
        for v in [100.0f32, 200.0, 300.0, 400.0] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let stairs = parse_stairs(&bytes);
        assert_eq!(stairs.len(), 1);
        let s = &stairs[0];
        assert!(s.touches(1, (100.0 + STAIR_RADIUS - 1.0, 200.0)));
        assert!(!s.touches(1, (100.0 + STAIR_RADIUS + 1.0, 200.0)));
        assert_eq!(s.destination(1, (100.0, 200.0)), Some((2, (300.0, 400.0))));
        assert_eq!(s.destination(2, (300.0, 400.0)), Some((1, (100.0, 200.0))));
        assert_eq!(s.destination(0, (100.0, 200.0)), None);
    }

    #[test]
    fn source_to_cell_uses_the_nav_frame() {
        // A fully walkable 10x10 grid laid over Floor 2's frame.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.extend_from_slice(&[0xFFu8; 13]);
        let leaked: &'static [u8] = Box::leak(bytes.into_boxed_slice());
        let nav = Nav::from_bytes(leaked, FLOOR_FRAMES[1]);
        let (cx, cy) = source_to_cell(&nav, 1600.0 + 4750.0 * 0.55, 1500.0 + 2240.0 * 0.55);
        assert_eq!((cx, cy), (5, 5));
        let (sx, sy) = cell_to_source(&nav, 5, 5);
        assert!((sx - (1600.0 + 4750.0 * 0.55)).abs() < 1.0);
        assert!((sy - (1500.0 + 2240.0 * 0.55)).abs() < 1.0);
    }

    #[test]
    fn committed_scene_parses_and_bakes() {
        let scene = Scene::from_bytes(SCENE_BIN).expect("scene.bin should parse");
        let baked = bake(&scene);
        for floor in 0..NUM_FLOORS {
            assert_eq!(
                u32::from_le_bytes([
                    baked.nav[floor][0],
                    baked.nav[floor][1],
                    baked.nav[floor][2],
                    baked.nav[floor][3]
                ]),
                ink_ribbon_native::bake::CELL_PX
            );
            assert!(!baked.overlays[floor].rgba.is_empty());
        }
    }

    #[test]
    fn items_parse_round_trip() {
        // header count=3, then a floor-2 item, a floor-1 item and an item box.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        for (id, floor, kind, x, y, name) in [
            (
                7u32,
                1u32,
                ItemKind::Key,
                100.0f32,
                200.0f32,
                "ID Wristband (Level 2)",
            ),
            (
                9u32,
                2u32,
                ItemKind::InkRibbon,
                300.0f32,
                400.0f32,
                "Pantry Key",
            ),
            (
                11u32,
                2u32,
                ItemKind::ItemBox,
                500.0f32,
                600.0f32,
                "Item Box",
            ),
        ] {
            let n = name.as_bytes();
            bytes.extend_from_slice(&id.to_le_bytes());
            bytes.extend_from_slice(&floor.to_le_bytes());
            bytes.push(kind.to_u8());
            bytes.extend_from_slice(&x.to_le_bytes());
            bytes.extend_from_slice(&y.to_le_bytes());
            bytes.extend_from_slice(&(n.len() as u32).to_le_bytes());
            bytes.extend_from_slice(n);
        }
        let items = parse_items(&bytes);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].kind, ItemKind::Key);
        assert_eq!(items[0].floor, 1);
        assert_eq!(items[0].name, "ID Wristband (Level 2)");
        assert_eq!(items[0].pos, (100.0, 200.0));
        assert_eq!(items[1].kind, ItemKind::InkRibbon);
        assert_eq!(items[1].floor, 2);
        assert_eq!(items[1].name, "Pantry Key");
        assert_eq!(items[1].pos, (300.0, 400.0));
        assert_eq!(items[2].kind, ItemKind::ItemBox);
        assert!(!items[2].kind.is_collectible());
        assert!(parse_items(&[]).is_empty());
    }

    #[test]
    fn remove_desc_removes_high_indices_first() {
        let mut v = vec![0, 1, 2, 3, 4];
        remove_desc(&mut v, vec![1, 3]);
        assert_eq!(v, vec![0, 2, 4]);
    }

    #[test]
    fn wrap_cycles_both_ways() {
        // Menu rows of 3.
        assert_eq!(wrap(2, 1, 3), 0);
        assert_eq!(wrap(0, -1, 3), 2);
        // Inventory grid of 16.
        assert_eq!(wrap(15, 1, 16), 0);
        assert_eq!(wrap(0, -1, 16), 15);
        assert_eq!(wrap(0, -4, 16), 12);
        // Empty is safe.
        assert_eq!(wrap(0, 1, 0), 0);
    }

    #[test]
    fn editor_geometry_helpers() {
        let rect = SelGeom::Rect {
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 50.0,
        };
        // Drag the top-left corner to (200, 200); the opposite corner is fixed.
        match scale_geom(rect, (200.0, 200.0), 0) {
            SelGeom::Rect { x, y, w, h } => {
                assert_eq!((x, y, w, h), (100.0, 50.0, 100.0, 150.0))
            }
            _ => panic!("rect scale returned a non-rect"),
        }
        match translate_geom(rect, 10.0, -5.0) {
            SelGeom::Rect { x, y, .. } => assert_eq!((x, y), (10.0, -5.0)),
            _ => panic!("rect translate returned a non-rect"),
        }
        let b = SelGeom::Box {
            center: (0.0, 0.0),
            size: (100.0, 50.0),
            rot: 0.0,
        };
        // Cursor straight above the centre -> rotation 0 (snapped).
        match rotate_geom(b, (0.0, -10.0), true) {
            SelGeom::Box { rot, .. } => assert!(rot.abs() < 1e-3),
            _ => panic!("box rotate returned a non-box"),
        }
    }

    fn synthetic_move(w: i32, h: i32, open: impl Fn(i32, i32) -> bool) -> MoveGrid {
        let mut bits = vec![0u8; ((w * h) as usize).div_ceil(8)];
        for y in 0..h {
            for x in 0..w {
                if open(x, y) {
                    let i = (y * w + x) as usize;
                    bits[i >> 3] |= 1 << (i & 7);
                }
            }
        }
        MoveGrid {
            w,
            h,
            frame: (0.0, 0.0, w as f32 * MOVE_CELL, h as f32 * MOVE_CELL),
            bits,
        }
    }

    #[test]
    fn move_cells_map_to_their_centres() {
        let grid = synthetic_move(10, 10, |_, _| true);
        assert_eq!(grid.source_cell(0.0, 0.0), (0, 0));
        assert_eq!(grid.source_cell(MOVE_CELL - 0.01, MOVE_CELL - 0.01), (0, 0));
        assert_eq!(grid.source_cell(MOVE_CELL + 0.01, 0.0), (1, 0));
        let (sx, sy) = grid.cell_source(2, 3);
        assert_eq!(grid.source_cell(sx, sy), (2, 3));
    }

    #[test]
    fn move_reach_respects_budget_and_walls() {
        // Open 20x20 except a wall at x == 5 for y < 15 (a detour of 16+ cells).
        let grid = synthetic_move(20, 20, |x, y| !(x == 5 && y < 15));
        let dist = move_reach(&grid, (0, 0));
        // Walk east along y == 0: index == x for that row.
        assert_eq!(dist[0], 0);
        assert_eq!(dist[2], 2);
        assert_eq!(dist[4], 4);
        assert_eq!(dist[5], u16::MAX, "the wall itself is not a move cell");
        assert_eq!(
            dist[6],
            u16::MAX,
            "a cell behind the wall is outside the run budget"
        );
    }

    #[test]
    fn move_reach_caps_at_the_run_budget() {
        let grid = synthetic_move(40, 40, |_, _| true);
        let dist = move_reach(&grid, (0, 0));
        assert_eq!(dist[RUN_CELLS as usize], RUN_CELLS);
        assert_eq!(
            dist[RUN_CELLS as usize + 1],
            u16::MAX,
            "cells past the run budget stay unreachable"
        );
    }

    fn region(id: u32, rect: Rect, initial: RegionState) -> Region {
        Region {
            id,
            name: format!("Region {id}"),
            rect,
            initial,
        }
    }

    #[test]
    fn hidden_regions_drop_their_geometry() {
        use ink_ribbon_native::scene::FLOOR1_INDEX;
        let mut scene = Scene::default();
        let room = Rect {
            x: 100.0,
            y: 200.0,
            w: 300.0,
            h: 300.0,
        };
        scene.floors[FLOOR1_INDEX].walls.push(WallOp {
            mode: BoolOp::Add,
            rect: room,
        });
        scene.floors[FLOOR1_INDEX].regions.push(region(
            1,
            Rect {
                x: room.x - 20.0,
                y: room.y - 20.0,
                w: room.w + 40.0,
                h: room.h + 40.0,
            },
            RegionState::Hidden,
        ));

        // Hidden: the room (and the region) are dropped.
        let hidden = apply_regions(&scene, &[], &[]);
        assert!(hidden.floors[FLOOR1_INDEX].walls.is_empty());
        assert!(hidden.floors[FLOOR1_INDEX].regions.is_empty());
        // Revealed by a link, or visited: the room reappears.
        let revealed = apply_regions(&scene, &[], &[(FLOOR1_INDEX, 1)]);
        assert_eq!(revealed.floors[FLOOR1_INDEX].walls.len(), 1);
        let visited = apply_regions(&scene, &[(FLOOR1_INDEX, 1)], &[]);
        assert_eq!(visited.floors[FLOOR1_INDEX].walls.len(), 1);
    }

    #[test]
    fn the_smallest_region_owns_a_point() {
        use ink_ribbon_native::scene::FLOOR1_INDEX;
        let mut scene = Scene::default();
        let room = Rect {
            x: 100.0,
            y: 200.0,
            w: 300.0,
            h: 300.0,
        };
        scene.floors[FLOOR1_INDEX].walls.push(WallOp {
            mode: BoolOp::Add,
            rect: room,
        });
        // A big Hidden region around a small Revealed one: the small region wins.
        scene.floors[FLOOR1_INDEX].regions.push(region(
            1,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 2000.0,
                h: 2000.0,
            },
            RegionState::Hidden,
        ));
        scene.floors[FLOOR1_INDEX].regions.push(region(
            2,
            Rect {
                x: room.x - 10.0,
                y: room.y - 10.0,
                w: room.w + 20.0,
                h: room.h + 20.0,
            },
            RegionState::Revealed,
        ));

        let out = apply_regions(&scene, &[], &[]);
        assert_eq!(
            out.floors[FLOOR1_INDEX].walls.len(),
            1,
            "the small revealed region owns the room"
        );
    }

    #[test]
    fn region_state_prefers_visited_then_revealed() {
        let r = region(
            7,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            },
            RegionState::Hidden,
        );
        assert_eq!(region_state_raw(2, &r, &[], &[]), RegionState::Hidden);
        assert_eq!(
            region_state_raw(2, &r, &[], &[(2, 7)]),
            RegionState::Revealed
        );
        assert_eq!(
            region_state_raw(2, &r, &[(2, 7)], &[(2, 7)]),
            RegionState::Visited
        );
        let mut shown = r.clone();
        shown.initial = RegionState::Revealed;
        assert_eq!(region_state_raw(2, &shown, &[], &[]), RegionState::Revealed);
    }
}
