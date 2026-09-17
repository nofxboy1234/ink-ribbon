use std::ffi;

use ink_ribbon_native::bake::{bake, BakedBytes, OverlayBytes};
use ink_ribbon_native::scene::{
    BoolOp, Box2, Door, DoorKind, FloorSource, ItemDef, ItemKind, Link, Rect, Scene, StairNode,
    WallOp, FLOOR1_FRAME, FLOOR1_H, FLOOR1_INDEX, FLOOR1_W, FLOOR1_X, FLOOR1_Y, FLOOR_FRAMES,
    NUM_FLOORS,
};
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
const C_LINE: (f32, f32, f32) = (0.55, 0.57, 0.57); // #8c9191 panels, markers
const C_WALL: (f32, f32, f32) = (0.361, 0.376, 0.376); // #5c6060 wall ink (Floor 1)
const C_LABEL: (f32, f32, f32) = (0.58, 0.58, 0.55); // #94948c room labels
const C_TITLE: (f32, f32, f32) = (0.72, 0.72, 0.70); // #b8b8b3 title
const C_ITEM: (f32, f32, f32) = (0.54, 0.40, 0.82); // #8a65d1 item markers
const C_ROUTE: (f32, f32, f32) = (0.63, 0.90, 0.67); // #a0e6aa route green
const C_FLOOR_YELLOW: (f32, f32, f32) = (0.55, 0.52, 0.14); // selected floor border
const C_LOCK: (f32, f32, f32) = (0.63, 0.27, 0.34); // #a04457 locked-door red

// Near-black background and faint map backing grid.
const BACKGROUND: (f32, f32, f32) = (0.047, 0.047, 0.047); // #0c0c0c
const GRID_RGB: (f32, f32, f32) = (0.10, 0.10, 0.10); // backing grid

// Hand-traced overlay (walls, obstacles, doors) per floor, composited to one raw
// RGBA texture by native/prepare-overlay.py. A floor whose trace is still blank
// falls back to the procedural walls.
const OVERLAY_W: i32 = 2048;
const OVERLAY_H: [i32; NUM_FLOORS] = [662, 966, 1177];
const OVERLAY_RGBA: [&[u8]; NUM_FLOORS] = [
    include_bytes!("../../assets/floor-3-overlay.rgba"),
    include_bytes!("../../assets/floor-2-overlay.rgba"),
    include_bytes!("../../assets/floor-1-overlay.rgba"),
];

// Key item placements baked by native/prepare-items.py from the `item_*` layers.
const ITEMS_BIN: &[u8] = include_bytes!("../../assets/items.bin");
const ITEM_RADIUS: f32 = 7.0;
const CIRCLE_SEGMENTS: usize = 24;
const CURSOR_RADIUS: f32 = 36.0;
const CURSOR_TICK: f32 = 20.0;
const CURSOR_SEGMENTS: usize = 48;

// Floor 1 room name labels (composite source px), drawn with sokol_debugtext.
const ROOMS: [(&str, f32, f32); 17] = [
    ("Cold Storage", 2146.0, 3775.0),
    ("Courtyard", 4035.0, 3862.0),
    ("Dining Room", 3490.0, 3960.0),
    ("Restroom", 2830.0, 4078.0),
    ("Isolation Ward", 5830.0, 4100.0),
    ("Blood Lab", 5256.0, 4196.0),
    ("Security Manager's", 6030.0, 4375.0),
    ("Treatment Room", 4754.0, 4148.0),
    ("Kitchen", 3011.0, 4614.0),
    ("Parlor", 3390.0, 4700.0),
    ("Central Hall", 4035.0, 4738.0),
    ("East Wing Lobby", 4520.0, 4862.0),
    ("Waiting Room", 5080.0, 4862.0),
    ("Guard Office", 3840.0, 5060.0),
    ("Custodian's Office", 2905.0, 5128.0),
    ("Medication Room", 3504.0, 5145.0),
    ("Garage", 2404.0, 5740.0),
];

// Navigation grids generated by native/prepare-nav.py, indexed like `floor`.
const NAV_BINS: [&[u8]; NUM_FLOORS] = [
    include_bytes!("../../assets/floor-3-nav.bin"),
    include_bytes!("../../assets/floor-2-nav.bin"),
    include_bytes!("../../assets/floor-1-nav.bin"),
];
const NAV_OPEN_BINS: [&[u8]; NUM_FLOORS] = [
    include_bytes!("../../assets/floor-3-nav-open.bin"),
    include_bytes!("../../assets/floor-2-nav-open.bin"),
    include_bytes!("../../assets/floor-1-nav-open.bin"),
];
// High-resolution collision masks (1 = wall / obstacle / locked door), 2px cells.
const SOLID_BINS: [&[u8]; NUM_FLOORS] = [
    include_bytes!("../../assets/floor-3-solid.bin"),
    include_bytes!("../../assets/floor-2-solid.bin"),
    include_bytes!("../../assets/floor-1-solid.bin"),
];
// Stair endpoints baked by native/prepare-stairs.py from the `stairs_*` layers.
const STAIRS_BIN: &[u8] = include_bytes!("../../assets/stairs.bin");
// Walk into a stair X this close (source px) to take it to the paired floor.
const STAIR_RADIUS: f32 = 34.0;
const FONT_RGBA: &[u8] = include_bytes!("../../assets/font.rgba");
const FONT_BIN: &[u8] = include_bytes!("../../assets/font.bin");
// Player start (Guard Office), click tolerance (source px) and route styling (reference units).
const PLAYER: (f32, f32) = (3840.0, 5008.0);
const CLICK_RADIUS: f32 = 70.0;
// Player movement. The nav grid inflates walls, obstacles and locked doors by
// CLEARANCE_CELLS = 2 (16 source px), so "player centre on a walkable cell" is
// exactly equivalent to a collision disc of that radius. Speed is source px/s.
const PLAYER_SPEED: f32 = 160.0;
const PLAYER_COLLIDE_RADIUS: f32 = 8.0;
// Arrow radius in source px at the default zoom; converted to a constant
// reference size (like the item dots) so zooming never changes how big it looks.
const PLAYER_MARKER_RADIUS: f32 = 13.6;
const PLAYER_ACCEL: f32 = 14.0;
const PLAYER_TURN_RATE: f32 = 10.0;
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

// Walkable grid parsed from floor-N-nav.bin (see native/prepare-nav.py). The
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

// High-resolution collision mask baked by native/prepare-nav.py: a set bit is a
// wall, obstacle or locked door (the real traced geometry, with no padding).
struct Solid {
    w: i32,
    h: i32,
    frame: (f32, f32, f32, f32),
    bits: Vec<u8>,
}

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
        if p + 16 > bytes.len() {
            break;
        }
        let u32_at =
            |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let f32_at =
            |o: usize| f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        let floor = u32_at(p) as usize;
        let pos = (f32_at(p + 4), f32_at(p + 8));
        let name_len = u32_at(p + 12) as usize;
        p += 16;
        if p + name_len > bytes.len() || floor >= NUM_FLOORS {
            break;
        }
        let name = String::from_utf8_lossy(&bytes[p..p + name_len]).into_owned();
        p += name_len;
        items.push(Item { name, floor, pos });
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
    Obstacle,
    DoorLocked,
    DoorUnlocked,
    DoorUnknown,
    Stair,
    Item,
    Erase,
    Connect,
}

impl Tool {
    const ALL: [Tool; 11] = [
        Tool::Select,
        Tool::WallAdd,
        Tool::WallSub,
        Tool::Obstacle,
        Tool::DoorLocked,
        Tool::DoorUnlocked,
        Tool::DoorUnknown,
        Tool::Stair,
        Tool::Item,
        Tool::Erase,
        Tool::Connect,
    ];

    fn label(self) -> &'static str {
        match self {
            Tool::Select => "SELECT",
            Tool::WallAdd => "WALL+",
            Tool::WallSub => "WALL-",
            Tool::Obstacle => "OBST",
            Tool::DoorLocked => "LOCK",
            Tool::DoorUnlocked => "OPEN",
            Tool::DoorUnknown => "UNK",
            Tool::Stair => "STAIR",
            Tool::Item => "ITEM",
            Tool::Erase => "ERASE",
            Tool::Connect => "LINK",
        }
    }

    fn color(self) -> (f32, f32, f32) {
        match self {
            Tool::Select => (0.90, 0.90, 0.90),
            Tool::WallAdd => (0.55, 0.70, 0.55),
            Tool::WallSub => (0.80, 0.40, 0.40),
            Tool::Obstacle => (0.62, 0.62, 0.62),
            Tool::DoorLocked => (0.80, 0.35, 0.45),
            Tool::DoorUnlocked => (0.35, 0.70, 0.78),
            Tool::DoorUnknown => (0.62, 0.62, 0.70),
            Tool::Stair => (0.90, 0.80, 0.35),
            Tool::Item => (0.65, 0.45, 0.95),
            Tool::Erase => (0.85, 0.30, 0.30),
            Tool::Connect => (0.90, 0.65, 0.90),
        }
    }

    fn is_rect(self) -> bool {
        matches!(
            self,
            Tool::WallAdd
                | Tool::WallSub
                | Tool::Obstacle
                | Tool::DoorLocked
                | Tool::DoorUnlocked
                | Tool::DoorUnknown
        )
    }
}

// What is currently selected in the editor (index into the viewed floor's vecs).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Selection {
    Wall(usize),
    Obstacle(usize),
    Door(usize),
    Stair(usize),
    Item(usize),
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
}

// A copied editor object, pasted with a fresh id.
#[derive(Clone)]
enum Clip {
    Wall(WallOp),
    Obstacle(Box2),
    Door(Door),
    Stair(StairNode),
    Item(ItemDef),
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
    stairs: Vec<Stair>,
    items: Vec<Item>,
    astar: Astar,
    extra_floors: [Vec<(f32, f32, f32, f32)>; NUM_FLOORS],
    floor_has_art: [bool; NUM_FLOORS],
    // --- Editor ---
    scene: Scene,
    edit: bool,
    tool: Tool,
    snap: bool,
    drag_from: Option<(f32, f32)>,
    drag_to: Option<(f32, f32)>,
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
    // Reachable component per floor, computed from where the player is standing.
    reachable: [Vec<u8>; NUM_FLOORS],
    path_red: Vec<(f32, f32)>,
    target: Option<usize>,
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
fn overlay_has_art(rgba: &[u8]) -> bool {
    rgba.iter().skip(3).step_by(4).any(|&a| a > 0)
}

// The baked assets compiled into the binary, used as the default map and as the
// fallback for floors that have not been redrawn as vector objects yet. Built
// once; re-baking on every edit reuses it.
fn embedded_bytes() -> &'static BakedBytes {
    static FALLBACK: std::sync::OnceLock<BakedBytes> = std::sync::OnceLock::new();
    FALLBACK.get_or_init(|| BakedBytes {
        overlays: std::array::from_fn(|i| OverlayBytes {
            rgba: OVERLAY_RGBA[i].to_vec(),
            w: OVERLAY_W,
            h: OVERLAY_H[i],
        }),
        nav: std::array::from_fn(|i| NAV_BINS[i].to_vec()),
        nav_open: std::array::from_fn(|i| NAV_OPEN_BINS[i].to_vec()),
        solid: std::array::from_fn(|i| SOLID_BINS[i].to_vec()),
        stairs: STAIRS_BIN.to_vec(),
        items: ITEMS_BIN.to_vec(),
    })
}

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
// the map window. Floors with no traced art keep the Floor 1 frame so the
// procedural fallback pans and zooms exactly as before.
fn floor_frame(floor: usize, has_art: &[bool; NUM_FLOORS]) -> (f32, f32, f32, f32) {
    if has_art[floor] {
        FLOOR_FRAMES[floor]
    } else {
        FLOOR1_FRAME
    }
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
        max_vertices: 65_536,
        max_commands: 4_096,
        logger: sgl::Logger {
            func: Some(sokol::log::slog_func),
            ..Default::default()
        },
        ..Default::default()
    });
    state.font = Some(Font::new());
    state.floor_has_art = std::array::from_fn(|i| overlay_has_art(&state.overlay_data[i].rgba));
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
}

// Viewed-floor change (selector, arrows). The player stays where they are; only
// taking stairs moves `player_floor`.
fn change_floor(state: &mut State, floor: usize) {
    if floor < NUM_FLOORS && floor != state.floor && state.pending_floor.is_none() {
        state.pending_floor = Some(floor);
        state.transition_t = 0.0;
        // Selection indices and link endpoints are floor-local.
        state.selection.clear();
        state.pending_link = None;
        state.drag_mode = DragMode::None;
    }
}

fn take_stairs(state: &mut State, to_floor: usize, to_pos: (f32, f32)) {
    if to_floor >= NUM_FLOORS || state.pending_floor.is_some() {
        return;
    }
    state.player_floor = to_floor;
    state.pending_spawn = Some(to_pos);
    state.stair_lock = true;
    state.player_vel = (0.0, 0.0);
    state.target = None;
    state.path.clear();
    state.path_red.clear();
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
    let frame = floor_frame(state.player_floor, &state.floor_has_art);
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
fn walkable_center(nav: &Nav, sx: f32, sy: f32) -> bool {
    let (cx, cy) = source_to_cell(nav, sx, sy);
    nav.walkable(cx, cy)
}

// Resolve one movement step axis by axis, so the player slides along a blocked
// surface instead of stopping dead. Returns (position, x blocked, y blocked).
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

// Arrow-key player movement: eased velocity, smooth turning toward the movement
// direction, and circle collision that slides along walls.
fn update_player(state: &mut State, delta: f32) {
    // The player only exists on their own floor; viewing another floor is
    // read-only until they take stairs back. Editing pauses the player.
    if state.edit || state.floor != state.player_floor {
        return;
    }
    let floor = state.player_floor;
    // Direction + magnitude from the thumbstick, else the arrow keys.
    let stick = state.stick_vec;
    let stick_mag = (stick.0 * stick.0 + stick.1 * stick.1).sqrt();
    let (dir, mag) = if stick_mag > 0.0 {
        (
            (stick.0 / stick_mag, stick.1 / stick_mag),
            stick_mag.min(1.0),
        )
    } else {
        let mut ix: f32 = 0.0;
        let mut iy: f32 = 0.0;
        if state.holding[0] {
            iy -= 1.0;
        }
        if state.holding[1] {
            iy += 1.0;
        }
        if state.holding[2] {
            ix -= 1.0;
        }
        if state.holding[3] {
            ix += 1.0;
        }
        let len = (ix * ix + iy * iy).sqrt();
        if len > 0.0 {
            ((ix / len, iy / len), 1.0)
        } else {
            ((0.0, 0.0), 0.0)
        }
    };
    let (target_vx, target_vy) = if mag > 0.0 {
        state.facing_target = dir.0.atan2(-dir.1);
        (dir.0 * PLAYER_SPEED * mag, dir.1 * PLAYER_SPEED * mag)
    } else {
        (0.0, 0.0)
    };
    let ease = (delta * PLAYER_ACCEL).min(1.0);
    state.player_vel.0 += (target_vx - state.player_vel.0) * ease;
    state.player_vel.1 += (target_vy - state.player_vel.1) * ease;

    // Turn smoothly toward the movement direction (shortest arc).
    let turn = wrap_angle(state.facing_target - state.facing);
    state.facing += turn * (delta * PLAYER_TURN_RATE).min(1.0);

    // Substep so fast movement cannot tunnel through a wall in one frame.
    let mut remaining = (state.player_vel.0 * delta, state.player_vel.1 * delta);
    while remaining.0.abs() > 1e-4 || remaining.1.abs() > 1e-4 {
        let step = (
            remaining.0.clamp(-MOVE_SUBSTEP, MOVE_SUBSTEP),
            remaining.1.clamp(-MOVE_SUBSTEP, MOVE_SUBSTEP),
        );
        remaining.0 -= step.0;
        remaining.1 -= step.1;
        let (pos, blocked_x, blocked_y) =
            resolve_move_terrain(&state.nav[floor], &state.solid[floor], state.player, step);
        state.player = pos;
        if blocked_x {
            state.player_vel.0 = 0.0;
        }
        if blocked_y {
            state.player_vel.1 = 0.0;
        }
        if blocked_x && blocked_y {
            break;
        }
    }

    // Refresh the route from the player's current cell (realtime), but only for
    // a target that lives on the floor the player is standing on.
    let cell = source_to_cell(&state.nav[floor], state.player.0, state.player.1);
    if state.player_cell != Some(cell) {
        state.player_cell = Some(cell);
        if let Some(i) = state.target {
            if state.items[i].floor == floor {
                let nav = &state.nav[floor];
                if let Some(start) = snap_source(nav, state.player.0, state.player.1) {
                    ensure_reachable(state, floor, start);
                    let to = state.items[i].pos;
                    let (green, red) = route_to(
                        &mut state.astar,
                        &state.nav[floor],
                        &state.nav_open[floor],
                        &state.reachable[floor],
                        state.player,
                        to,
                    );
                    state.path = green;
                    state.path_red = red;
                }
            }
        }
    }

    // Taking a stair X wins over anything else this frame.
    check_stairs(state);
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
    let frame = floor_frame(state.floor, &state.floor_has_art);
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
    set_status(state, if on { "EDIT MODE" } else { "PLAY MODE" });
}

// Reference coords -> source-composite pixels on the viewed floor.
fn ref_to_source(state: &State, p: (f32, f32)) -> (f32, f32) {
    let frame = floor_frame(state.floor, &state.floor_has_art);
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

// Re-bake the scene and swap the running map's assets in place.
fn rebuild_assets(state: &mut State) {
    let baked = bake(&state.scene, embedded_bytes());
    let BakedBytes {
        overlays,
        nav,
        nav_open,
        solid,
        stairs,
        items,
    } = baked;
    state.nav = std::array::from_fn(|i| Nav::from_bytes(&nav[i], FLOOR_FRAMES[i]));
    state.nav_open = std::array::from_fn(|i| Nav::from_bytes(&nav_open[i], FLOOR_FRAMES[i]));
    state.solid = std::array::from_fn(|i| Solid::from_bytes(&solid[i], FLOOR_FRAMES[i]));
    state.stairs = parse_stairs(&stairs);
    state.items = parse_items(&items);
    for (i, overlay) in overlays.into_iter().enumerate() {
        sg::destroy_view(state.overlay_views[i]);
        state.floor_has_art[i] = overlay_has_art(&overlay.rgba);
        state.overlay_views[i] = overlay_texture(&overlay.rgba, overlay.w, overlay.h);
        state.overlay_data[i] = overlay;
    }
    // Navigation changed: reset reachability and re-snap the player.
    state.reachable = std::array::from_fn(|_| Vec::new());
    state.target = None;
    state.path.clear();
    state.path_red.clear();
    let pf = state.player_floor;
    if let Some(cell) = snap_source(&state.nav[pf], state.player.0, state.player.1) {
        state.player = cell_to_source(&state.nav[pf], cell.0, cell.1);
        state.player_cell = Some(cell);
        state.reachable[pf] = reachable_from(&state.nav[pf], cell);
    }
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
    floor.source = FloorSource::Vector;
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
        Tool::Obstacle => floor.obstacles.push(Box2 {
            id,
            center,
            size: (w, h),
            rot: 0.0,
        }),
        Tool::DoorLocked | Tool::DoorUnlocked | Tool::DoorUnknown => {
            let kind = match tool {
                Tool::DoorLocked => DoorKind::Locked,
                Tool::DoorUnlocked => DoorKind::Unlocked,
                _ => DoorKind::Unknown,
            };
            floor.doors.push(Door {
                id,
                kind,
                center,
                size: (w, h),
                rot: 0.0,
            });
        }
        _ => {}
    }
    rebuild_assets(state);
    set_status(state, format!("{} placed", tool.label()));
}

fn place_point(state: &mut State, p: (f32, f32)) {
    push_undo(state);
    let id = state.next_id;
    state.next_id += 1;
    let tool = state.tool;
    let floor = &mut state.scene.floors[state.floor];
    floor.source = FloorSource::Vector;
    match tool {
        Tool::Stair => floor.stairs.push(StairNode { id, pos: p }),
        Tool::Item => floor.items.push(ItemDef {
            id,
            kind: ItemKind::Key,
            name: format!("Item {id}"),
            pos: p,
        }),
        _ => {}
    }
    rebuild_assets(state);
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
    let floor = &scene.floors[floor_index];
    let mut best: Option<(f32, Selection)> = None;
    let mut consider = |d: f32, sel: Selection| {
        if d <= REACH && best.as_ref().is_none_or(|(bd, _)| d < *bd) {
            best = Some((d, sel));
        }
    };
    for (i, w) in floor.walls.iter().enumerate() {
        consider(dist_to_rect(p, w.rect), Selection::Wall(i));
    }
    for (i, o) in floor.obstacles.iter().enumerate() {
        consider(
            dist_to_box(p, o.center, o.size, o.rot),
            Selection::Obstacle(i),
        );
    }
    for (i, d) in floor.doors.iter().enumerate() {
        consider(dist_to_box(p, d.center, d.size, d.rot), Selection::Door(i));
    }
    for (i, s) in floor.stairs.iter().enumerate() {
        consider(
            ((p.0 - s.pos.0).powi(2) + (p.1 - s.pos.1).powi(2)).sqrt(),
            Selection::Stair(i),
        );
    }
    for (i, it) in floor.items.iter().enumerate() {
        consider(
            ((p.0 - it.pos.0).powi(2) + (p.1 - it.pos.1).powi(2)).sqrt(),
            Selection::Item(i),
        );
    }
    best.map(|(_, sel)| sel)
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
                size: d.size,
                rot: d.rot,
            }
        }
        Selection::Stair(i) => SelGeom::Point {
            pos: floor.stairs.get(i)?.pos,
        },
        Selection::Item(i) => SelGeom::Point {
            pos: floor.items.get(i)?.pos,
        },
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
        (Selection::Obstacle(i), SelGeom::Box { center, size, rot }) => {
            if let Some(o) = floor.obstacles.get_mut(i) {
                o.center = center;
                o.size = size;
                o.rot = rot;
            }
        }
        (Selection::Door(i), SelGeom::Box { center, size, rot }) => {
            if let Some(d) = floor.doors.get_mut(i) {
                d.center = center;
                d.size = size;
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
    let frame = floor_frame(state.floor, &state.floor_has_art);
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
}

fn select_press(state: &mut State, p: (f32, f32), shift: bool) {
    let floor_index = state.floor;
    let tol = handle_tol(state);
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
                if geom_hit(geom, p, tol) {
                    start_drag(state, DragMode::Move, p);
                    return;
                }
            }
        }
    }
    match pick_object(&state.scene, floor_index, p) {
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
            }
            state.drag_mode = DragMode::None;
        }
    }
}

#[derive(Clone, Copy)]
enum LinkTarget {
    Stair(u32),
    Item(u32),
    Door(u32),
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
            dist_to_box(p, d.center, d.size, d.rot),
            LinkTarget::Door(d.id),
        );
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
            push_undo(state);
            state.scene.floors[floor_index].links.push(Link::Stair {
                a_floor: f as u8,
                a_id: a,
                b_floor: floor_index as u8,
                b_id: b,
            });
            state.pending_link = None;
            rebuild_assets(state);
            set_status(state, "stairs linked");
        }
        (Some(PendingLink::Item(f, a)), LinkTarget::Door(d)) => {
            push_undo(state);
            state.scene.floors[floor_index].links.push(Link::KeyDoor {
                item_floor: f as u8,
                item_id: a,
                door_floor: floor_index as u8,
                door_id: d,
            });
            state.pending_link = None;
            rebuild_assets(state);
            set_status(state, "key -> door linked");
        }
        (_, LinkTarget::Stair(id)) => {
            state.pending_link = Some(PendingLink::Stair(floor_index, id));
            set_status(state, "stair picked - pick another");
        }
        (_, LinkTarget::Item(id)) => {
            state.pending_link = Some(PendingLink::Item(floor_index, id));
            set_status(state, "item picked - pick a door");
        }
        (_, LinkTarget::Door(_)) => set_status(state, "pick a key item first"),
    }
}

fn delete_selection(state: &mut State) {
    if state.selection.is_empty() {
        return;
    }
    push_undo(state);
    let selected = state.selection.clone();
    let floor = &mut state.scene.floors[state.floor];
    let mut walls = Vec::new();
    let mut obstacles = Vec::new();
    let mut doors = Vec::new();
    let mut stairs = Vec::new();
    let mut items = Vec::new();
    for sel in selected {
        match sel {
            Selection::Wall(i) => walls.push(i),
            Selection::Obstacle(i) => obstacles.push(i),
            Selection::Door(i) => doors.push(i),
            Selection::Stair(i) => stairs.push(i),
            Selection::Item(i) => items.push(i),
        }
    }
    remove_desc(&mut floor.walls, walls);
    remove_desc(&mut floor.obstacles, obstacles);
    remove_desc(&mut floor.doors, doors);
    remove_desc(&mut floor.stairs, stairs);
    remove_desc(&mut floor.items, items);
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
            Selection::Obstacle(i) => floor.obstacles.get(i).map(|o| Clip::Obstacle(*o)),
            Selection::Door(i) => floor.doors.get(i).map(|d| Clip::Door(*d)),
            Selection::Stair(i) => floor.stairs.get(i).map(|s| Clip::Stair(*s)),
            Selection::Item(i) => floor.items.get(i).map(|it| Clip::Item(it.clone())),
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
        floor.source = FloorSource::Vector;
        match clip {
            Clip::Wall(mut w) => {
                let c = (w.rect.x + w.rect.w * 0.5, w.rect.y + w.rect.h * 0.5);
                let to = at.unwrap_or((c.0 + 24.0 + step, c.1 + 24.0 + step));
                w.rect.x += to.0 - c.0;
                w.rect.y += to.1 - c.1;
                floor.walls.push(w);
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
        }
    }
    rebuild_assets(state);
    set_status(state, "pasted");
}

fn start_rename(state: &mut State) {
    if let Some(Selection::Item(i)) = primary_selection(state) {
        if let Some(it) = state.scene.floors[state.floor].items.get(i) {
            state.rename = Some(it.name.clone());
            set_status(state, "type a name, Enter to accept");
        }
    } else {
        set_status(state, "select an item to rename");
    }
}

fn commit_rename(state: &mut State) {
    let Some(name) = state.rename.take() else {
        return;
    };
    if let Some(Selection::Item(i)) = primary_selection(state) {
        if let Some(it) = state.scene.floors[state.floor].items.get_mut(i) {
            it.name = name;
        }
        rebuild_assets(state);
        set_status(state, "renamed");
    }
}

fn editor_clear_floor(state: &mut State) {
    push_undo(state);
    let floor = &mut state.scene.floors[state.floor];
    floor.source = FloorSource::Vector;
    floor.walls.clear();
    floor.obstacles.clear();
    floor.doors.clear();
    floor.stairs.clear();
    floor.items.clear();
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
        set_status(state, format!("saved scene ({} bytes)", bytes.len()));
    } else {
        set_status(state, "save failed");
    }
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
    std::fs::write("scene.bin", bytes).is_ok()
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
    std::fs::read("scene.bin").ok()
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
fn select_at(state: &mut State, x: f32, y: f32) {
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    // Routing needs the player and the item on the floor being viewed.
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
    let frame = floor_frame(state.floor, &state.floor_has_art);
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);
    let sx = frame.0 + (hx - ox) * frame.2 / iw;
    let sy = frame.1 + (hy - oy) * frame.3 / ih;
    let hit = state.items.iter().position(|item| {
        if item.floor != state.floor {
            return false;
        }
        let (dx, dy) = (sx - item.pos.0, sy - item.pos.1);
        dx * dx + dy * dy <= CLICK_RADIUS * CLICK_RADIUS
    });
    match hit {
        Some(i) if state.target == Some(i) => {
            state.target = None;
            state.path.clear();
            state.path_red.clear();
        }
        Some(i) => {
            state.target = Some(i);
            let floor = state.player_floor;
            let to = state.items[i].pos;
            if let Some(start) = snap_source(&state.nav[floor], state.player.0, state.player.1) {
                ensure_reachable(state, floor, start);
            }
            let (green, red) = route_to(
                &mut state.astar,
                &state.nav[floor],
                &state.nav_open[floor],
                &state.reachable[floor],
                state.player,
                to,
            );
            state.path = green;
            state.path_red = red;
        }
        None => {
            // Clicking off the item hides the route.
            state.target = None;
            state.path.clear();
            state.path_red.clear();
        }
    }
}

extern "C" fn event(event: *const sapp::Event, user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    let event = unsafe { &*event };
    match event._type {
        sapp::EventType::MouseMove => {
            let (mx, my) = screen_to_ref(&state.layout, event.mouse_x, event.mouse_y);
            state.mouse = (mx, my);
            state.circle_cursor_hidden = false;
            state.mouse_in_map = in_map(&state.layout, (mx, my));
            if state.edit {
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
                if let Some(i) = editor_toolbar_hit(x, y) {
                    state.tool = Tool::ALL[i];
                    state.drag_mode = DragMode::None;
                    set_status(state, format!("tool {}", state.tool.label()));
                    return;
                }
                let src = snap_point(state, ref_to_source(state, (x, y)));
                match state.tool {
                    Tool::Select => {
                        select_press(state, src, event.modifiers & sapp::MODIFIER_SHIFT != 0)
                    }
                    Tool::Connect => connect_press(state, src),
                    _ => {
                        state.drag_mode = DragMode::Create;
                        state.drag_from = Some(src);
                        state.drag_to = Some(src);
                    }
                }
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
                            rebuild_assets(state);
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
                let frame = floor_frame(state.floor, &state.floor_has_art);
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
                    _ => {
                        if (32..127).contains(&event.char_code) {
                            if let Some(c) = char::from_u32(event.char_code) {
                                if let Some(buffer) = state.rename.as_mut() {
                                    if buffer.chars().count() < 40 {
                                        buffer.push(c);
                                    }
                                }
                            }
                        }
                        return;
                    }
                }
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
fn floor_shapes(floor: usize) -> Vec<(f32, f32, f32, f32)> {
    const COUNT: usize = 22;
    const MARGIN: f32 = 200.0;
    let mut seed: u32 = 0x9E37_79B9 ^ (floor as u32).wrapping_mul(0x85EB_CA6B);
    let mut next = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 8) as f32 / 16_777_216.0
    };
    let mut out = Vec::with_capacity(COUNT);
    for i in 0..COUNT {
        // Half the shapes are squares, the rest rectangles.
        let w = 200.0 + next() * 620.0;
        let h = if i % 2 == 0 {
            w
        } else {
            150.0 + next() * 520.0
        };
        let x = FLOOR1_X + MARGIN + next() * (FLOOR1_W - w - MARGIN * 2.0).max(1.0);
        let y = FLOOR1_Y + MARGIN + next() * (FLOOR1_H - h - MARGIN * 2.0).max(1.0);
        out.push((x, y, w, h));
    }
    out
}

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
    let frame = floor_frame(state.floor, &state.floor_has_art);
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
    // A* on the nav grid, 4-neighbour with a Manhattan heuristic.
    fn search(
        &mut self,
        nav: &Nav,
        start: (i32, i32),
        goal: (i32, i32),
    ) -> Option<Vec<(i32, i32)>> {
        let w = nav.w;
        let n = (nav.w * nav.h) as usize;
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
                if !nav.walkable(nx, ny) {
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
type Route = Vec<(f32, f32)>;

// Route to a target. Returns (green reachable part, red part past the blocker).
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

// Reference player marker: a pale-yellow arrow with expanding pulse rings.
fn draw_player_marker(state: &State, cx: f32, cy: f32, radius: f32) {
    let period = 1.8f32;
    for k in 0..2 {
        let frac = (state.time / period + k as f32 * 0.5).fract();
        let ring = radius + 4.0 + frac * (radius + 16.0);
        let alpha = (1.0 - frac) * 0.45;
        sgl::c4f(C_ACCENT.0, C_ACCENT.1, C_ACCENT.2, alpha);
        outline_circle(cx, cy, ring);
    }
    // Rotate the arrow to face the direction of movement (0 rad = up).
    let (dx, dy) = facing_vector(state.facing);
    sgl::c4f(C_ACCENT.0, C_ACCENT.1, C_ACCENT.2, 1.0);
    triangle_dir(cx, cy, radius, dx, dy);
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
fn draw_procedural_floor(
    state: &State,
    width: f32,
    height: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
) {
    let shapes = &state.extra_floors[state.floor];
    if shapes.is_empty() {
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
    let frame = floor_frame(state.floor, &state.floor_has_art);
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);
    sgl::c4f(C_WALL.0, C_WALL.1, C_WALL.2, 1.0);
    for &(x, y, w, h) in shapes {
        let (x0, y0) = src_to_ref(frame, ox, oy, iw, ih, x, y);
        let (x1, y1) = src_to_ref(frame, ox, oy, iw, ih, x + w, y + h);
        outline_rect(x0, y0, x1 - x0, y1 - y0);
    }
    sgl::scissor_rectf(0.0, 0.0, width, height, true);
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
    // Floors still waiting to be drawn in Krita keep their procedural fallback.
    if !state.floor_has_art[state.floor] {
        draw_procedural_floor(state, width, height, left, right, top, bottom);
        return;
    }

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

    let frame = floor_frame(state.floor, &state.floor_has_art);
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y, frame);

    if state.show_grid {
        draw_nav_grid(&state.nav[state.floor], ox, oy, iw, ih);
    }

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

    // Key item dots: constant screen size, drawn on whichever floor they live on.
    sgl::c4f(C_ITEM.0, C_ITEM.1, C_ITEM.2, 1.0);
    for item in &state.items {
        if item.floor != state.floor {
            continue;
        }
        let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, item.pos.0, item.pos.1);
        filled_circle(rx, ry, ITEM_RADIUS);
    }

    // Computed route and selected target ring, if the target is on this floor.
    if state
        .target
        .is_some_and(|i| state.items[i].floor == state.floor)
    {
        if !state.path.is_empty() {
            let route: Vec<(f32, f32)> = state
                .path
                .iter()
                .map(|&(sx, sy)| src_to_ref(frame, ox, oy, iw, ih, sx, sy))
                .collect();
            sgl::c4f(C_ROUTE.0, C_ROUTE.1, C_ROUTE.2, 1.0);
            thick_polyline(&route, PATH_WIDTH);
        }
        if !state.path_red.is_empty() {
            let route: Vec<(f32, f32)> = state
                .path_red
                .iter()
                .map(|&(sx, sy)| src_to_ref(frame, ox, oy, iw, ih, sx, sy))
                .collect();
            sgl::c4f(C_LOCK.0, C_LOCK.1, C_LOCK.2, 1.0);
            thick_polyline(&route, PATH_WIDTH);
        }
        let i = state.target.unwrap();
        let (rx, ry) = src_to_ref(
            frame,
            ox,
            oy,
            iw,
            ih,
            state.items[i].pos.0,
            state.items[i].pos.1,
        );
        let color = if state.path_red.is_empty() {
            C_ROUTE
        } else {
            C_LOCK
        };
        sgl::c4f(color.0, color.1, color.2, 1.0);
        outline_circle(rx, ry, ITEM_RADIUS + 4.0);
    }

    // Player marker on whichever floor the player actually occupies.
    if state.floor == state.player_floor {
        let (px, py) = src_to_ref(frame, ox, oy, iw, ih, state.player.0, state.player.1);
        let collide_ref = PLAYER_COLLIDE_RADIUS * iw / frame.2;
        // Like the item dots, the arrow keeps a constant screen scale: use the
        // default zoom for the source->reference conversion, not the live zoom.
        let default_scale = if state.layout.portrait {
            state.layout.map_h * DEFAULT_ZOOM / frame.3
        } else {
            state.layout.map_w * DEFAULT_ZOOM / frame.2
        };
        let marker_ref = PLAYER_MARKER_RADIUS * default_scale;
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
    }

    // Room names, centred on their position (Floor 1 only).
    if state.floor == FLOOR1_INDEX {
        let font = state.font.as_ref().unwrap();
        for (name, sx, sy) in ROOMS {
            let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, sx, sy);
            if rx < MAP_X || rx > MAP_X + MAP_W || ry < MAP_Y || ry > MAP_Y + MAP_H {
                continue;
            }
            let scale = state.layout.text_scale;
            let width = font.text_width(name, 19.5 * scale);
            // Keep the (now larger) labels inside the map window instead of clipping.
            let max_x = (MAP_X + MAP_W - width).max(MAP_X);
            let tx = (rx - width * 0.5).clamp(MAP_X, max_x);
            draw_ui_text(font, name, tx, ry - 9.75 * scale, C_LABEL, false, scale);
        }
    }

    sgl::scissor_rectf(0.0, 0.0, width, height, true);
}

// A rotated box in reference space, for edit-mode obstacles/doors.
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
    let frame = floor_frame(state.floor, &state.floor_has_art);
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

    for w in &floor.walls {
        let (rx, ry) = src_to_ref(frame, ox, oy, iw, ih, w.rect.x, w.rect.y);
        let (rx1, ry1) = src_to_ref(
            frame,
            ox,
            oy,
            iw,
            ih,
            w.rect.x + w.rect.w,
            w.rect.y + w.rect.h,
        );
        let c = if w.mode == BoolOp::Add {
            (0.55, 0.70, 0.55)
        } else {
            (0.85, 0.35, 0.35)
        };
        sgl::c4f(c.0, c.1, c.2, 0.9);
        outline_rect(rx, ry, rx1 - rx, ry1 - ry);
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
        let c = match d.kind {
            DoorKind::Locked => (0.85, 0.35, 0.45),
            DoorKind::Unlocked => (0.35, 0.75, 0.85),
            DoorKind::Unknown => (0.65, 0.65, 0.75),
        };
        draw_box_rot(
            frame, ox, oy, iw, ih, d.center, d.size, d.rot, c, 0.85, true,
        );
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
        sgl::c4f(C_ITEM.0, C_ITEM.1, C_ITEM.2, 1.0);
        filled_circle(rx, ry, ITEM_RADIUS);
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
            bx + 7.0,
            by + 12.0,
            if active { C_HILITE } else { C_LABEL },
            false,
            0.8,
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
        "walls {}  obstacles {}  doors {}  stairs {}  items {}  links {}   [Tab] exit  [Z] undo  [X] clear  [S] save  [L] load  [Space] snap:{}  [C] link  [R] rename  [Del] delete  [Shift+click] multi  [Ctrl+C/V] copy/paste",
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
    if let Some(buffer) = &state.rename {
        let text = format!("NAME: {buffer}_");
        draw_ui_text(
            font,
            &text,
            12.0,
            EDITOR_BAR_Y + EDITOR_BAR_H + 60.0,
            C_HILITE,
            false,
            1.0,
        );
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
    const STEP: f32 = 32.0;
    sgl::c4f(GRID_RGB.0, GRID_RGB.1, GRID_RGB.2, 1.0);
    let mut x = (left / STEP).floor() * STEP;
    while x <= right + 0.1 {
        line(x, top, x, bottom);
        x += STEP;
    }
    let mut y = (top / STEP).floor() * STEP;
    while y <= bottom + 0.1 {
        line(left, y, right, y);
        y += STEP;
    }
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
    update_player(state, delta);
    let ease = (delta * 14.0).min(1.0);
    state.zoom += (state.zoom_target - state.zoom) * ease;
    if let Some(a) = state.zoom_anchor {
        let l = state.layout;
        // Google-Maps style: keep the anchored map point under the cursor.
        let frame = floor_frame(state.floor, &state.floor_has_art);
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
        && state.floor == state.player_floor
        && state.zoom_anchor.is_none()
        && !state.dragging
        && !state.pinching;
    if following {
        let frame = floor_frame(state.player_floor, &state.floor_has_art);
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
        let frame = floor_frame(state.floor, &state.floor_has_art);
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
    // Load a saved scene if there is one; otherwise start from the embedded
    // raster fallback. Vector floors are re-baked, legacy floors keep the
    // compiled-in Krita/Python output.
    let scene = load_scene_bytes()
        .and_then(|b| Scene::from_bytes(&b))
        .unwrap_or_default();
    let next_id = max_id(&scene) + 1;
    let baked = bake(&scene, embedded_bytes());
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
        stairs: parse_stairs(&stairs),
        items: parse_items(&items),
        astar: Astar::new(),
        // Floors without traced art get procedural walls; Floor 1 has art.
        extra_floors: [floor_shapes(0), floor_shapes(1), Vec::new()],
        floor_has_art: [false; NUM_FLOORS],
        scene,
        edit: false,
        tool: Tool::WallAdd,
        snap: true,
        drag_from: None,
        drag_to: None,
        selection: Vec::new(),
        drag_mode: DragMode::None,
        drag_orig: None,
        drag_all: Vec::new(),
        drag_grab: (0.0, 0.0),
        drag_dirty: false,
        pending_link: None,
        clipboard: Vec::new(),
        rename: None,
        undo: Vec::new(),
        next_id,
        status: String::new(),
        status_t: 0.0,
        reachable: std::array::from_fn(|_| Vec::new()),
        path_red: Vec::new(),
        target: None,
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

    // Legacy reference coordinates, kept to exercise the routing/gating logic
    // independently of whatever is currently drawn in the Krita item layers.
    const CHECK_ITEMS: [(&str, f32, f32); 6] = [
        ("Pantry Key", 3432.0, 3899.0),
        ("ID Wristband (Level 2)", 4751.0, 4416.0),
        ("ID Wristband (Level 3)", 6134.0, 4397.0),
        ("East Wing Keycard", 3309.0, 4590.0),
        ("Star Quartz", 4658.0, 5138.0),
        ("West Wing Keycard", 3530.0, 5162.0),
    ];

    #[test]
    fn nav_reachability_is_a_subset_of_the_open_grid() {
        // Making locked doors passable can only ever add connectivity, so every
        // cell reachable on the nav grid must also be reachable on nav_open.
        let nav = Nav::from_bytes(NAV_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let nav_open = Nav::from_bytes(NAV_OPEN_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let start = snap_source(&nav, PLAYER.0, PLAYER.1).expect("player start is walkable");
        let nav_reach = reachable_from(&nav, start);
        let open_reach = reachable_from(&nav_open, start);
        for y in 0..nav.h {
            for x in 0..nav.w {
                if is_reachable(&nav_reach, &nav, x, y) {
                    assert!(
                        is_reachable(&open_reach, &nav, x, y),
                        "cell ({x},{y}) reachable on nav but not on nav_open"
                    );
                }
            }
        }
    }

    #[test]
    fn demo_route_is_axis_aligned() {
        let nav = Nav::from_bytes(NAV_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let mut astar = Astar::new();
        let (_, sx, sy) = CHECK_ITEMS[1]; // ID Wristband (Level 2)
        let route = compute_path(&mut astar, &nav, PLAYER, (sx, sy));
        assert!(route.len() >= 2, "demo route should have endpoints");
        for pair in route.windows(2) {
            let (dx, dy) = (pair[1].0 - pair[0].0, pair[1].1 - pair[0].1);
            assert!(
                dx.abs() < 0.01 || dy.abs() < 0.01,
                "route segment is not horizontal/vertical"
            );
        }
    }

    #[test]
    fn locked_items_have_a_red_segment() {
        // The green/red split from route_to must agree with ground-truth
        // reachability, independent of where the items currently sit.
        let nav = Nav::from_bytes(NAV_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let nav_open = Nav::from_bytes(NAV_OPEN_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let mut astar = Astar::new();
        let start = snap_source(&nav, PLAYER.0, PLAYER.1).expect("player start");
        let reachable = reachable_from(&nav, start);
        for (name, sx, sy) in CHECK_ITEMS {
            let (green, red) = route_to(&mut astar, &nav, &nav_open, &reachable, PLAYER, (sx, sy));
            let nav_reachable =
                snap_source(&nav, sx, sy).is_some_and(|g| astar.search(&nav, start, g).is_some());
            if nav_reachable {
                assert!(
                    red.is_empty() && !green.is_empty(),
                    "{name} is reachable, so the route must be fully green"
                );
            } else {
                let open_reachable = snap_source(&nav_open, sx, sy)
                    .is_some_and(|g| astar.search(&nav_open, start, g).is_some());
                if open_reachable {
                    assert!(
                        !red.is_empty(),
                        "{name} is gated, so it needs a red segment"
                    );
                } else {
                    assert!(
                        green.is_empty() && red.is_empty(),
                        "{name} is disconnected, so it has no route"
                    );
                }
            }
        }
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
    fn player_spawn_snaps_to_a_walkable_cell() {
        let nav = Nav::from_bytes(NAV_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let cell = snap_source(&nav, PLAYER.0, PLAYER.1).expect("player has a walkable cell");
        let (sx, sy) = cell_to_source(&nav, cell.0, cell.1);
        assert!(
            walkable_center(&nav, sx, sy),
            "the snapped spawn must be walkable"
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
    fn procedural_floor_shapes_fill_the_floor_frame() {
        for floor in [0usize, 1] {
            let shapes = floor_shapes(floor);
            assert_eq!(shapes.len(), 22);
            let mut squares = 0;
            for &(x, y, w, h) in &shapes {
                assert!(w > 0.0 && h > 0.0);
                assert!(x >= FLOOR1_X && y >= FLOOR1_Y);
                assert!(x + w <= FLOOR1_X + FLOOR1_W);
                assert!(y + h <= FLOOR1_Y + FLOOR1_H);
                if (w - h).abs() < 0.01 {
                    squares += 1;
                }
            }
            assert!(squares > 0, "expected some square shapes");
            assert_eq!(shapes, floor_shapes(floor), "layout must be deterministic");
        }
        assert_ne!(floor_shapes(0), floor_shapes(1), "floors must differ");
    }

    #[test]
    fn per_floor_frames_fall_back_until_traced() {
        let traced = [true; NUM_FLOORS];
        assert_eq!(floor_frame(FLOOR1_INDEX, &traced), FLOOR1_FRAME);
        assert_eq!(floor_frame(0, &traced), FLOOR_FRAMES[0]);
        assert_eq!(floor_frame(1, &traced), FLOOR_FRAMES[1]);

        // An untraced floor keeps the Floor 1 frame for the procedural fallback.
        let none = [false; NUM_FLOORS];
        assert_eq!(floor_frame(0, &none), FLOOR1_FRAME);

        // Each floor's on-screen image uses its own aspect ratio.
        let l = Layout::compute(1280.0, 720.0);
        for (floor, (_, _, w, h)) in FLOOR_FRAMES.iter().enumerate() {
            let (iw, ih) = image_size(&l, 1.0, floor_frame(floor, &traced));
            assert!(
                (iw / ih - w / h).abs() < 1e-3,
                "floor {floor} aspect drift: {iw}x{ih}"
            );
        }
    }

    #[test]
    fn blank_overlays_are_detected() {
        assert!(!overlay_has_art(&[0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(!overlay_has_art(&[255, 0, 0, 0, 0, 0, 0, 0]));
        assert!(overlay_has_art(&[0, 0, 0, 0, 0, 0, 0, 1]));
        assert!(overlay_has_art(OVERLAY_RGBA[FLOOR1_INDEX]));
    }

    #[test]
    fn astar_reuse_matches_fresh_searches() {
        let nav = Nav::from_bytes(NAV_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let start = snap_source(&nav, PLAYER.0, PLAYER.1).expect("player start");
        let mut reused = Astar::new();
        for &(_, sx, sy) in CHECK_ITEMS.iter() {
            let goal = snap_source(&nav, sx, sy).unwrap();
            // Interleave an unrelated search so stale stamps would show up.
            let _ = reused.search(&nav, goal, start);
            let got = reused.search(&nav, start, goal);
            let fresh = Astar::new().search(&nav, start, goal);
            assert_eq!(got, fresh, "reused scratch diverged from a fresh search");
        }
    }

    #[test]
    fn astar_routes_are_followable() {
        let nav = Nav::from_bytes(NAV_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let solid = Solid::from_bytes(SOLID_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let mut astar = Astar::new();
        for (name, sx, sy) in CHECK_ITEMS {
            let route = compute_path(&mut astar, &nav, PLAYER, (sx, sy));
            if route.is_empty() {
                continue;
            }
            for &(x, y) in &route {
                assert!(
                    can_stand(&nav, &solid, x, y),
                    "{name} route passes through blocked space at ({x:.0}, {y:.0})"
                );
            }
        }
    }

    #[test]
    fn player_cannot_enter_locked_doors() {
        let nav = Nav::from_bytes(NAV_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let nav_open = Nav::from_bytes(NAV_OPEN_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        let solid = Solid::from_bytes(SOLID_BINS[FLOOR1_INDEX], FLOOR1_FRAME);
        // Locked-door ink: solid, open in the optimistic grid, closed in nav.
        let mut door = None;
        'outer: for y in 0..nav.h {
            for x in 0..nav.w {
                let (sx, sy) = cell_to_source(&nav, x, y);
                if solid.blocked_source(sx, sy) && nav_open.walkable(x, y) && !nav.walkable(x, y) {
                    door = Some((x, y));
                    break 'outer;
                }
            }
        }
        let (dx, dy) = door.expect("a locked-door cell should exist");
        let center = cell_to_source(&nav, dx, dy);
        assert!(
            !can_stand(&nav, &solid, center.0, center.1),
            "a locked door must not be standable"
        );

        // Walk toward the door from the nearest open cell; the disc must stop
        // at the ink instead of crossing it.
        let start_cell = nearest_walkable(&nav, dx, dy).expect("an open neighbour");
        let from = cell_to_source(&nav, start_cell.0, start_cell.1);
        let (mut dxn, mut dyn_) = (center.0 - from.0, center.1 - from.1);
        let len = (dxn * dxn + dyn_ * dyn_).sqrt().max(1e-6);
        dxn /= len;
        dyn_ /= len;
        let mut pos = from;
        for _ in 0..200 {
            let (next, _, _) = resolve_move_terrain(&nav, &solid, pos, (dxn * 4.0, dyn_ * 4.0));
            if (next.0 - pos.0).abs() < 1e-4 && (next.1 - pos.1).abs() < 1e-4 {
                break;
            }
            pos = next;
        }
        let dist = ((center.0 - pos.0).powi(2) + (center.1 - pos.1).powi(2)).sqrt();
        assert!(dist > 1.0, "the player reached the locked door");
        assert!(
            !solid.blocked_source(pos.0, pos.1),
            "the player ended inside the locked door ink"
        );
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
    fn stair_endpoints_are_walkable() {
        let stairs = parse_stairs(STAIRS_BIN);
        assert!(!stairs.is_empty(), "expected at least one baked connection");
        let navs: [Nav; NUM_FLOORS] =
            std::array::from_fn(|i| Nav::from_bytes(NAV_BINS[i], FLOOR_FRAMES[i]));
        for s in &stairs {
            for (floor, pos) in [(s.a_floor, s.a_pos), (s.b_floor, s.b_pos)] {
                assert!(
                    snap_source(&navs[floor], pos.0, pos.1).is_some(),
                    "stair endpoint {pos:?} on floor {floor} has no walkable cell"
                );
            }
        }
    }

    #[test]
    fn items_parse_round_trip() {
        // header count=2, then a floor-2 item and a floor-1 item.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u32.to_le_bytes());
        for (floor, x, y, name) in [
            (1u32, 100.0f32, 200.0f32, "ID Wristband (Level 2)"),
            (2u32, 300.0f32, 400.0f32, "Pantry Key"),
        ] {
            let n = name.as_bytes();
            bytes.extend_from_slice(&floor.to_le_bytes());
            bytes.extend_from_slice(&x.to_le_bytes());
            bytes.extend_from_slice(&y.to_le_bytes());
            bytes.extend_from_slice(&(n.len() as u32).to_le_bytes());
            bytes.extend_from_slice(n);
        }
        let items = parse_items(&bytes);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].floor, 1);
        assert_eq!(items[0].name, "ID Wristband (Level 2)");
        assert_eq!(items[0].pos, (100.0, 200.0));
        assert_eq!(items[1].floor, 2);
        assert_eq!(items[1].name, "Pantry Key");
        assert_eq!(items[1].pos, (300.0, 400.0));
        assert!(parse_items(&[]).is_empty());
    }

    #[test]
    fn item_marks_are_walkable() {
        let items = parse_items(ITEMS_BIN);
        let navs: [Nav; NUM_FLOORS] =
            std::array::from_fn(|i| Nav::from_bytes(NAV_BINS[i], FLOOR_FRAMES[i]));
        for item in &items {
            assert!(
                snap_source(&navs[item.floor], item.pos.0, item.pos.1).is_some(),
                "item {:?} on floor {} has no walkable cell",
                item.name,
                item.floor
            );
        }
    }

    #[test]
    fn remove_desc_removes_high_indices_first() {
        let mut v = vec![0, 1, 2, 3, 4];
        remove_desc(&mut v, vec![1, 3]);
        assert_eq!(v, vec![0, 2, 4]);
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
}
