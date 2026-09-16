use std::ffi;

use sokol::{app as sapp, gfx as sg, gl as sgl, glue as sglue};

const ZOOM_MIN: f32 = 0.7;
const ZOOM_MAX: f32 = 1.6;
const DEFAULT_ZOOM: f32 = 1.15;
const PAN_MARGIN: f32 = 700.0;
const NUM_FLOORS: usize = 3;

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
                text_scale: 2.0,
            }
        } else {
            let ref_w = 1920.0;
            let ref_h = 1080.0;
            let panel_w = 46.0;
            let name_h = 52.0;
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
                name_y: map_h + 14.0,
                in_pos: (ref_w - panel_w * 0.5 + 11.0, 34.0),
                out_pos: (ref_w - panel_w * 0.5 + 6.0, map_h - 56.0),
                show_zoom: true,
                text_scale: 1.0,
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
const C_LABEL: (f32, f32, f32) = (0.58, 0.58, 0.55); // #94948c room labels
const C_TITLE: (f32, f32, f32) = (0.72, 0.72, 0.70); // #b8b8b3 title
const C_ITEM: (f32, f32, f32) = (0.54, 0.40, 0.82); // #8a65d1 item markers
const C_ROUTE: (f32, f32, f32) = (0.63, 0.90, 0.67); // #a0e6aa route green
const C_FLOOR_YELLOW: (f32, f32, f32) = (0.55, 0.52, 0.14); // selected floor border
const C_LOCK: (f32, f32, f32) = (0.63, 0.27, 0.34); // #a04457 locked-door red

// Near-black background and faint map backing grid.
const BACKGROUND: (f32, f32, f32) = (0.047, 0.047, 0.047); // #0c0c0c
const GRID_RGB: (f32, f32, f32) = (0.10, 0.10, 0.10); // backing grid

// Floor 1 frame in source-composite pixels (see artifacts/care-center/README.md).
const FLOOR1_X: f32 = 1600.0;
const FLOOR1_Y: f32 = 3420.0;
const FLOOR1_W: f32 = 4750.0;
const FLOOR1_H: f32 = 2730.0;

// Floor index for "FLOOR 1" (0 = Floor 3, 1 = Floor 2, 2 = Floor 1).
const FLOOR1_INDEX: usize = 2;

// Hand-traced overlay (walls, obstacles, doors) composited to one raw RGBA texture.
const OVERLAY_W: i32 = 2048;
const OVERLAY_H: i32 = 1177;
const OVERLAY_RGBA: &[u8] = include_bytes!("../../assets/floor-1-overlay.rgba");

// Polygon "Key Item" positions for Floor 1, in source-composite pixels.
const KEY_ITEMS: [(&str, f32, f32); 6] = [
    ("Pantry Key", 3432.0, 3899.0),
    ("ID Wristband (Level 2)", 4751.0, 4416.0),
    ("ID Wristband (Level 3)", 6134.0, 4397.0),
    ("East Wing Keycard", 3309.0, 4590.0),
    ("Star Quartz", 4658.0, 5138.0),
    ("West Wing Keycard", 3530.0, 5162.0),
];
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

// Navigation grid generated by native/prepare-nav.py from the wall trace.
const NAV_BIN: &[u8] = include_bytes!("../../assets/floor-1-nav.bin");
const NAV_OPEN_BIN: &[u8] = include_bytes!("../../assets/floor-1-nav-open.bin");
const FONT_RGBA: &[u8] = include_bytes!("../../assets/font.rgba");
const FONT_BIN: &[u8] = include_bytes!("../../assets/font.bin");
// Player start (Guard Office), click tolerance (source px) and route styling (reference units).
const PLAYER: (f32, f32) = (3840.0, 5008.0);
const CLICK_RADIUS: f32 = 70.0;
const PLAYER_RADIUS: f32 = 8.0;
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

// Walkable grid parsed from floor-1-nav.bin (see native/prepare-nav.py).
struct Nav {
    w: i32,
    h: i32,
    bits: &'static [u8],
}

impl Nav {
    fn from_bytes(bytes: &'static [u8]) -> Nav {
        // header: u32 LE cell_px, u32 LE width, u32 LE height
        let w = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as i32;
        let h = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as i32;
        Nav {
            w,
            h,
            bits: &bytes[12..],
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
            .chunks_exact(4)
            .map(|p| u32::from_ne_bytes([p[0], p[1], p[2], p[3]]))
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
    overlay_view: sg::View,
    overlay_sampler: sg::Sampler,
    font: Option<Font>,
    nav: Nav,
    nav_open: Nav,
    reachable: Vec<u8>,
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

fn overlay_texture() -> sg::View {
    assert_eq!(OVERLAY_RGBA.len(), (OVERLAY_W * OVERLAY_H * 4) as usize);
    let pixels: Vec<u32> = OVERLAY_RGBA
        .chunks_exact(4)
        .map(|p| u32::from_ne_bytes([p[0], p[1], p[2], p[3]]))
        .collect();
    let mut data = sg::ImageData::new();
    data.mip_levels[0] = sg::slice_as_range(&pixels);
    let image = sg::make_image(&sg::ImageDesc {
        width: OVERLAY_W,
        height: OVERLAY_H,
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
    state.overlay_view = overlay_texture();
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
    state.reachable = match snap_source(&state.nav, PLAYER.0, PLAYER.1) {
        Some(start) => reachable_from(&state.nav, start),
        None => Vec::new(),
    };
}

fn change_floor(state: &mut State, floor: usize) {
    if floor < NUM_FLOORS && floor != state.floor && state.pending_floor.is_none() {
        state.pending_floor = Some(floor);
        state.transition_t = 0.0;
        state.target = None;
        state.path.clear();
        state.path_red.clear();
    }
}

fn floor_slot(floor: usize) -> usize {
    match floor {
        0 => 0,
        1 => 1,
        _ => 2,
    }
}

fn recenter(state: &mut State) {
    state.zoom_anchor = None;
    state.zoom_target = DEFAULT_ZOOM;
    state.pan_target_x = 0.0;
    state.pan_target_y = 0.0;
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
    state.pan_x += dx;
    state.pan_y += dy;
    state.pan_target_x = state.pan_x;
    state.pan_target_y = state.pan_y;
}

fn pan_to_center_player(state: &mut State) {
    let l = state.layout;
    // Computed for the default zoom so the player ends centred once zoom settles.
    let (iw, ih) = if l.portrait {
        let ih = l.map_h * DEFAULT_ZOOM;
        (ih * FLOOR1_W / FLOOR1_H, ih)
    } else {
        let iw = l.map_w * DEFAULT_ZOOM;
        (iw, iw * FLOOR1_H / FLOOR1_W)
    };
    let (cx, cy) = cursor_center(&l);
    state.pan_target_x =
        cx - (PLAYER.0 - FLOOR1_X) * iw / FLOOR1_W - l.map_x - (l.map_w - iw) * 0.5;
    state.pan_target_y =
        cy - (PLAYER.1 - FLOOR1_Y) * ih / FLOOR1_H - l.map_y - (l.map_h - ih) * 0.5;
}

fn recenter_on_player(state: &mut State) {
    // Change to the player's floor (animated), reset to the default zoom, and
    // pan so the player ends centred.
    if state.floor != FLOOR1_INDEX {
        change_floor(state, FLOOR1_INDEX);
    }
    state.zoom_anchor = None;
    state.zoom_target = DEFAULT_ZOOM;
    pan_to_center_player(state);
}

fn hover_item_at(state: &State, cx: f32, cy: f32) -> Option<usize> {
    #[allow(non_snake_case)]
    let (MAP_X, MAP_Y, MAP_W, MAP_H, _, _, _) = state.layout.vars();
    if state.floor != FLOOR1_INDEX
        || cx < MAP_X
        || cx > MAP_X + MAP_W
        || cy < MAP_Y
        || cy > MAP_Y + MAP_H
    {
        return None;
    }
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y);
    let sx = FLOOR1_X + (cx - ox) * FLOOR1_W / iw;
    let sy = FLOOR1_Y + (cy - oy) * FLOOR1_H / ih;
    KEY_ITEMS.iter().position(|&(_, kx, ky)| {
        let (dx, dy) = (sx - kx, sy - ky);
        dx * dx + dy * dy <= CLICK_RADIUS * CLICK_RADIUS
    })
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
    if state.floor != FLOOR1_INDEX
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
    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y);
    let sx = FLOOR1_X + (hx - ox) * FLOOR1_W / iw;
    let sy = FLOOR1_Y + (hy - oy) * FLOOR1_H / ih;
    let hit = KEY_ITEMS.iter().position(|&(_, kx, ky)| {
        let (dx, dy) = (sx - kx, sy - ky);
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
            let (tx, ty) = (KEY_ITEMS[i].1, KEY_ITEMS[i].2);
            let (green, red) = route_to(
                &state.nav,
                &state.nav_open,
                &state.reachable,
                PLAYER,
                (tx, ty),
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
            if state.dragging {
                if (mx - state.down_ref.0).abs() > 6.0 || (my - state.down_ref.1).abs() > 6.0 {
                    state.moved = true;
                }
                drag_by(state, event.mouse_dx, event.mouse_dy);
            }
            state.mouse_in_map = in_map(&state.layout, (mx, my));
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
            if panel_click(state, x, y) {
                state.dragging = false;
            } else {
                state.down_ref = (x, y);
                state.moved = false;
                state.dragging = true;
            }
        }
        sapp::EventType::MouseUp => {
            let was_drag = state.moved;
            state.dragging = false;
            if !was_drag {
                let (x, y) = screen_to_ref(&state.layout, event.mouse_x, event.mouse_y);
                select_at(state, x, y);
            }
        }
        sapp::EventType::TouchesBegan => {
            if event.num_touches >= 2 {
                // Two fingers: pinch to zoom (and pan with the midpoint).
                let (mid_px, dist) = touch_pinch(&event.touches[..2]);
                state.pinching = true;
                state.dragging = false;
                state.moved = true;
                state.pinch_dist = dist.max(1.0);
                state.pinch_base_zoom = state.zoom_target;
                let mid = screen_to_ref(&state.layout, mid_px.0, mid_px.1);
                let (ox, oy, iw, ih) =
                    map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y);
                state.pinch_src = (
                    FLOOR1_X + (mid.0 - ox) * FLOOR1_W / iw,
                    FLOOR1_Y + (mid.1 - oy) * FLOOR1_H / ih,
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
            } else if event.num_touches > 0 {
                let t = event.touches[0];
                state.touch_last = (t.pos_x, t.pos_y);
                let (x, y) = screen_to_ref(&state.layout, t.pos_x, t.pos_y);
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
            if state.pinching && event.num_touches >= 2 {
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
            } else if !state.pinching && event.num_touches > 0 {
                let t = event.touches[0];
                if state.dragging {
                    let dx = t.pos_x - state.touch_last.0;
                    let dy = t.pos_y - state.touch_last.1;
                    if dx.abs() + dy.abs() > 3.0 {
                        state.moved = true;
                    }
                    drag_by(state, dx, dy);
                }
                state.touch_last = (t.pos_x, t.pos_y);
                let (x, y) = screen_to_ref(&state.layout, t.pos_x, t.pos_y);
                state.mouse = (x, y);
            }
        }
        sapp::EventType::TouchesEnded | sapp::EventType::TouchesCancelled => {
            if state.pinching {
                state.pinching = false;
            } else if !state.moved {
                select_at(state, state.mouse.0, state.mouse.1);
            }
            state.dragging = false;
        }
        sapp::EventType::MouseScroll => {
            state.zoom_target =
                (state.zoom_target + event.scroll_y * 0.08).clamp(ZOOM_MIN, ZOOM_MAX);
            capture_zoom_anchor(state);
        }
        sapp::EventType::KeyDown => match event.key_code {
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
            sapp::Keycode::W | sapp::Keycode::Up => state.pan_target_y += 22.0,
            sapp::Keycode::S | sapp::Keycode::Down => state.pan_target_y -= 22.0,
            sapp::Keycode::A | sapp::Keycode::Left => state.pan_target_x += 22.0,
            sapp::Keycode::D | sapp::Keycode::Right => state.pan_target_x -= 22.0,
            sapp::Keycode::Equal | sapp::Keycode::KpAdd => {
                state.zoom_target = (state.zoom_target + 0.12).min(ZOOM_MAX);
                capture_zoom_anchor(state);
            }
            sapp::Keycode::Minus | sapp::Keycode::KpSubtract => {
                state.zoom_target = (state.zoom_target - 0.12).max(ZOOM_MIN);
                capture_zoom_anchor(state);
            }
            sapp::Keycode::C | sapp::Keycode::Home => recenter(state),
            _ => {}
        },
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

// Floor 1 art frame inside the fixed map window, centred and scaled by zoom.
fn image_size(l: &Layout, zoom: f32) -> (f32, f32) {
    // Landscape fits the floor width; portrait fits the floor height.
    if l.portrait {
        let ih = l.map_h * zoom;
        (ih * FLOOR1_W / FLOOR1_H, ih)
    } else {
        let iw = l.map_w * zoom;
        (iw, iw * FLOOR1_H / FLOOR1_W)
    }
}

fn map_rect(l: &Layout, zoom: f32, pan_x: f32, pan_y: f32) -> (f32, f32, f32, f32) {
    let (image_width, image_height) = image_size(l, zoom);
    let x = l.map_x + (l.map_w - image_width) * 0.5 + pan_x;
    let y = l.map_y + (l.map_h - image_height) * 0.5 + pan_y;
    (x, y, image_width, image_height)
}

// Capture the map point under the circle cursor when a zoom starts.
fn capture_zoom_anchor(state: &mut State) {
    if state.floor != FLOOR1_INDEX {
        state.zoom_anchor = None;
        return;
    }
    let l = state.layout;
    let cursor = active_cursor(state);
    if !in_map(&l, cursor) {
        state.zoom_anchor = None;
        return;
    }
    let (ox, oy, iw, ih) = map_rect(&l, state.zoom, state.pan_x, state.pan_y);
    let sx = FLOOR1_X + (cursor.0 - ox) * FLOOR1_W / iw;
    let sy = FLOOR1_Y + (cursor.1 - oy) * FLOOR1_H / ih;
    state.zoom_anchor = Some(ZoomAnchor {
        src: (sx, sy),
        cursor_ref: cursor,
        end: state.zoom_target,
    });
}

// Pan that places `src` at `ref_point` for the given zoom.
fn anchor_pan(l: &Layout, zoom: f32, src: (f32, f32), ref_point: (f32, f32)) -> (f32, f32) {
    let (iw, ih) = image_size(l, zoom);
    (
        ref_point.0 - l.map_x - (l.map_w - iw) * 0.5 - (src.0 - FLOOR1_X) * iw / FLOOR1_W,
        ref_point.1 - l.map_y - (l.map_h - ih) * 0.5 - (src.1 - FLOOR1_Y) * ih / FLOOR1_H,
    )
}

// Source-composite pixel -> reference coordinates.
fn src_to_ref(ox: f32, oy: f32, iw: f32, ih: f32, sx: f32, sy: f32) -> (f32, f32) {
    (
        ox + (sx - FLOOR1_X) * iw / FLOOR1_W,
        oy + (sy - FLOOR1_Y) * ih / FLOOR1_H,
    )
}

fn source_to_cell(nav: &Nav, sx: f32, sy: f32) -> (i32, i32) {
    (
        ((sx - FLOOR1_X) / FLOOR1_W * nav.w as f32).floor() as i32,
        ((sy - FLOOR1_Y) / FLOOR1_H * nav.h as f32).floor() as i32,
    )
}

fn cell_to_source(nav: &Nav, cx: i32, cy: i32) -> (f32, f32) {
    (
        FLOOR1_X + (cx as f32 + 0.5) / nav.w as f32 * FLOOR1_W,
        FLOOR1_Y + (cy as f32 + 0.5) / nav.h as f32 * FLOOR1_H,
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

// A* on the nav grid, 4-neighbour with a Manhattan heuristic.
fn astar(nav: &Nav, start: (i32, i32), goal: (i32, i32)) -> Option<Vec<(i32, i32)>> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let w = nav.w;
    let n = (nav.w * nav.h) as usize;
    let sidx = (start.1 * w + start.0) as usize;
    let gidx = (goal.1 * w + goal.0) as usize;
    let heuristic = |x: i32, y: i32| (x - goal.0).unsigned_abs() + (y - goal.1).unsigned_abs();

    let mut g = vec![u32::MAX; n];
    let mut came = vec![-1i32; n];
    let mut heap: BinaryHeap<Reverse<(u32, i32)>> = BinaryHeap::new();
    g[sidx] = 0;
    heap.push(Reverse((heuristic(start.0, start.1), sidx as i32)));
    while let Some(Reverse((_f, cur))) = heap.pop() {
        let cur = cur as usize;
        if cur == gidx {
            break;
        }
        let cx = (cur as i32) % w;
        let cy = (cur as i32) / w;
        let cg = g[cur];
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (cx + dx, cy + dy);
            if !nav.walkable(nx, ny) {
                continue;
            }
            let ni = (ny * w + nx) as usize;
            let ng = cg + 1;
            if ng < g[ni] {
                g[ni] = ng;
                came[ni] = cur as i32;
                heap.push(Reverse((ng + heuristic(nx, ny), ni as i32)));
            }
        }
    }
    if g[gidx] == u32::MAX {
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
        cur = came[ci];
        if cur < 0 {
            return None;
        }
    }
    cells.reverse();
    Some(cells)
}

// Shortest route in source px between two source px points, or empty on failure.
fn compute_path(nav: &Nav, from: (f32, f32), to: (f32, f32)) -> Vec<(f32, f32)> {
    let (start, goal) = match (
        snap_source(nav, from.0, from.1),
        snap_source(nav, to.0, to.1),
    ) {
        (Some(s), Some(g)) => (s, g),
        _ => return Vec::new(),
    };
    match astar(nav, start, goal) {
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
    let mut bits = vec![0u8; (n + 7) / 8];
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

fn is_reachable(bits: &[u8], nav: &Nav, x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x >= nav.w || y >= nav.h || bits.is_empty() {
        return false;
    }
    let i = (y * nav.w + x) as usize;
    (bits[i >> 3] >> (i & 7)) & 1 == 1
}

// Route to a target. Returns (green reachable part, red part past the blocker).
fn route_to(
    nav: &Nav,
    nav_open: &Nav,
    reachable: &[u8],
    from: (f32, f32),
    to: (f32, f32),
) -> (Vec<(f32, f32)>, Vec<(f32, f32)>) {
    if let Some(goal) = snap_source(nav, to.0, to.1) {
        if is_reachable(reachable, nav, goal.0, goal.1) {
            let green = compute_path(nav, from, to);
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
        if let Some(cells) = astar(nav_open, start, goal) {
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
    if state.cursor_mode == CursorMode::Free && !state.mouse_in_map {
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
        let text = KEY_ITEMS[i].0;
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
fn draw_player_marker(state: &State, cx: f32, cy: f32) {
    let period = 1.8f32;
    for k in 0..2 {
        let frac = (state.time / period + k as f32 * 0.5).fract();
        let radius = PLAYER_RADIUS + 4.0 + frac * (PLAYER_RADIUS + 16.0);
        let alpha = (1.0 - frac) * 0.45;
        sgl::c4f(C_ACCENT.0, C_ACCENT.1, C_ACCENT.2, alpha);
        outline_circle(cx, cy, radius);
    }
    sgl::c4f(C_ACCENT.0, C_ACCENT.1, C_ACCENT.2, 1.0);
    triangle(cx, cy, PLAYER_RADIUS, true);
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

fn draw_floor1(
    state: &State,
    width: f32,
    height: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
) {
    // Only Floor 1 has art for now; Floors 2 and 3 stay blank.
    if state.floor != FLOOR1_INDEX {
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

    let (ox, oy, iw, ih) = map_rect(&state.layout, state.zoom, state.pan_x, state.pan_y);

    if state.show_grid {
        draw_nav_grid(&state.nav, ox, oy, iw, ih);
    }

    sgl::enable_texture();
    sgl::texture(state.overlay_view, state.overlay_sampler);
    sgl::c4f(1.0, 1.0, 1.0, 1.0);
    sgl::begin_quads();
    sgl::v2f_t2f(ox, oy, 0.0, 0.0);
    sgl::v2f_t2f(ox + iw, oy, 1.0, 0.0);
    sgl::v2f_t2f(ox + iw, oy + ih, 1.0, 1.0);
    sgl::v2f_t2f(ox, oy + ih, 0.0, 1.0);
    sgl::end();
    sgl::disable_texture();

    // Key item dots: constant screen size (reference units).
    sgl::c4f(C_ITEM.0, C_ITEM.1, C_ITEM.2, 1.0);
    for (_name, sx, sy) in KEY_ITEMS {
        let (rx, ry) = src_to_ref(ox, oy, iw, ih, sx, sy);
        filled_circle(rx, ry, ITEM_RADIUS);
    }

    // Computed route, player marker and selected target ring.
    if !state.path.is_empty() {
        let route: Vec<(f32, f32)> = state
            .path
            .iter()
            .map(|&(sx, sy)| src_to_ref(ox, oy, iw, ih, sx, sy))
            .collect();
        sgl::c4f(C_ROUTE.0, C_ROUTE.1, C_ROUTE.2, 1.0);
        thick_polyline(&route, PATH_WIDTH);
    }
    if !state.path_red.is_empty() {
        let route: Vec<(f32, f32)> = state
            .path_red
            .iter()
            .map(|&(sx, sy)| src_to_ref(ox, oy, iw, ih, sx, sy))
            .collect();
        sgl::c4f(C_LOCK.0, C_LOCK.1, C_LOCK.2, 1.0);
        thick_polyline(&route, PATH_WIDTH);
    }
    if let Some(i) = state.target {
        let (rx, ry) = src_to_ref(ox, oy, iw, ih, KEY_ITEMS[i].1, KEY_ITEMS[i].2);
        let color = if state.path_red.is_empty() {
            C_ROUTE
        } else {
            C_LOCK
        };
        sgl::c4f(color.0, color.1, color.2, 1.0);
        outline_circle(rx, ry, ITEM_RADIUS + 4.0);
    }
    let (px, py) = src_to_ref(ox, oy, iw, ih, PLAYER.0, PLAYER.1);
    draw_player_marker(state, px, py);

    // Room names, centred on their position.
    let font = state.font.as_ref().unwrap();
    for (name, sx, sy) in ROOMS {
        let (rx, ry) = src_to_ref(ox, oy, iw, ih, sx, sy);
        if rx < MAP_X || rx > MAP_X + MAP_W || ry < MAP_Y || ry > MAP_Y + MAP_H {
            continue;
        }
        let scale = state.layout.text_scale;
        let width = font.text_width(name, 19.5 * scale);
        draw_ui_text(
            font,
            name,
            rx - width * 0.5,
            ry - 9.75 * scale,
            C_LABEL,
            false,
            scale,
        );
    }

    sgl::scissor_rectf(0.0, 0.0, width, height, true);
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

fn draw_map_overlay(l: &Layout) {
    let right = l.map_x + l.map_w;
    let bottom = l.map_y + l.map_h;
    let hud_right = right - 18.0;

    sgl::c4f(C_DIM.0, C_DIM.1, C_DIM.2, 0.62);
    let rows = [l.map_y + 20.0, l.map_y + 32.0, l.map_y + 44.0];
    for y in rows {
        line(right - 118.0, y + 4.0, hud_right, y + 4.0);
        sgl::begin_points();
        sgl::point_size(2.0);
        sgl::v2f(hud_right, y + 4.0);
        sgl::end();
    }
    line(hud_right, l.map_y + 58.0, hud_right, bottom - 44.0);

    sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.9);
    outline_rect(right - 108.0, bottom - 43.0, 88.0, 22.0);

    if !l.portrait {
        // Two short registration lines continue below the lower-right corner.
        line(right - 34.0, bottom + 4.0, right - 34.0, bottom + 48.0);
        line(right - 20.0, bottom + 4.0, right - 20.0, bottom + 48.0);
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

    if l.portrait {
        // Right-align the status labels so the larger portrait text stays on screen.
        let right_label = |text: &str, y: f32, color: (f32, f32, f32)| {
            let w = font.text_width(text, 19.5 * l.text_scale);
            draw_ui_text(font, text, right - 24.0 - w, y, color, false, l.text_scale);
        };
        let line_h = 13.0 * l.text_scale;
        right_label("BATTERY", l.map_y + line_h, C_DIM);
        right_label("MEMORY", l.map_y + line_h * 2.0, C_DIM);
        right_label("DISC", l.map_y + line_h * 3.0, C_DIM);
        right_label("AREA MAP", bottom - 30.0 * l.text_scale, C_HILITE);
    } else {
        label("BATTERY", right - 154.0, l.map_y + 20.0, C_DIM, false);
        label("MEMORY", right - 154.0, l.map_y + 32.0, C_DIM, false);
        label("DISC", right - 154.0, l.map_y + 44.0, C_DIM, false);
        label("AREA MAP", right - 103.0, bottom - 38.0, C_HILITE, false);
        label("In", l.in_pos.0, l.in_pos.1, C_LABEL, false);
        label("Out", l.out_pos.0, l.out_pos.1, C_LABEL, false);

        // Care Center name, in its bracketed nameplate.
        let name = "Care Center";
        let name_x = l.name_x - font.text_width(name, 28.6 * l.text_scale) * 0.5;
        label(name, name_x, l.name_y, C_TITLE, true);
    }

    if !l.portrait {
        let name_left = l.map_x;
        let name_left_inner = l.map_x + 14.0;
        let name_right = l.map_x + 242.0;
        sgl::c4f(C_LINE.0, C_LINE.1, C_LINE.2, 0.9);
        line(name_left, bottom + 4.0, name_left, bottom + 48.0);
        line(
            name_left_inner,
            bottom + 4.0,
            name_left_inner,
            bottom + 48.0,
        );
        line(name_right, bottom + 4.0, name_right, bottom + 48.0);
    }
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
    state.time += delta;
    let ease = (delta * 14.0).min(1.0);
    state.zoom += (state.zoom_target - state.zoom) * ease;
    if let Some(a) = state.zoom_anchor {
        let l = state.layout;
        // Google-Maps style: keep the anchored map point under the cursor.
        let (pan_x, pan_y) = anchor_pan(&l, state.zoom, a.src, a.cursor_ref);
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
        let (iw, ih) = if l.portrait {
            let ih = l.map_h * state.zoom;
            (ih * FLOOR1_W / FLOOR1_H, ih)
        } else {
            let iw = l.map_w * state.zoom;
            (iw, iw * FLOOR1_H / FLOOR1_W)
        };
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
    let show_cursor = !(state.cursor_mode == CursorMode::Free && !state.mouse_in_map);
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
        }
        if state.transition_t >= 1.0 {
            state.pending_floor = None;
        }
    }
    state.fps_elapsed += delta;
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
    draw_floor1(state, width, height, left, right, top, bottom);
    draw_floor_fade(state, width, height, left, right, top, bottom);
    draw_map_frame(&state.layout);
    draw_map_overlay(&state.layout);
    draw_map_labels(state.font.as_ref().unwrap(), &state.layout);
    draw_cursor(state, width, height, left, right, top, bottom);
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
    let state = Box::new(State {
        layout: Layout::compute(1920.0, 1080.0),
        zoom_anchor: None,
        pass_action: sg::PassAction::new(),
        pipeline: sgl::Pipeline::new(),
        overlay_view: sg::View::new(),
        overlay_sampler: sg::Sampler::new(),
        font: None,
        nav: Nav::from_bytes(NAV_BIN),
        nav_open: Nav::from_bytes(NAV_OPEN_BIN),
        reachable: Vec::new(),
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

    // Key items that sit behind locked doors are intentionally unreachable.
    const LOCKED_GATED: [&str; 2] = ["ID Wristband (Level 3)", "Star Quartz"];

    #[test]
    fn nav_grid_reachability_matches_locked_doors() {
        let nav = Nav::from_bytes(NAV_BIN);
        assert!(nav.w > 0 && nav.h > 0, "nav grid header");
        let start = snap_source(&nav, PLAYER.0, PLAYER.1).expect("player start is walkable");
        for (name, sx, sy) in KEY_ITEMS {
            let reachable =
                snap_source(&nav, sx, sy).is_some_and(|goal| astar(&nav, start, goal).is_some());
            if LOCKED_GATED.contains(&name) {
                assert!(!reachable, "{name} should be blocked by a locked door");
            } else {
                assert!(reachable, "{name} should be reachable");
            }
        }
    }

    #[test]
    fn demo_route_is_axis_aligned() {
        let nav = Nav::from_bytes(NAV_BIN);
        let (_, sx, sy) = KEY_ITEMS[1]; // ID Wristband (Level 2)
        let route = compute_path(&nav, PLAYER, (sx, sy));
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
        let nav = Nav::from_bytes(NAV_BIN);
        let nav_open = Nav::from_bytes(NAV_OPEN_BIN);
        let start = snap_source(&nav, PLAYER.0, PLAYER.1).expect("player start");
        let reachable = reachable_from(&nav, start);
        for (name, sx, sy) in KEY_ITEMS {
            let (green, red) = route_to(&nav, &nav_open, &reachable, PLAYER, (sx, sy));
            if LOCKED_GATED.contains(&name) {
                assert!(!red.is_empty(), "{name} should route up to a red blocker");
            } else {
                assert!(
                    red.is_empty() && !green.is_empty(),
                    "{name} should be fully green"
                );
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
            let (ox, oy, iw, ih) = map_rect(&l, DEFAULT_ZOOM, 0.0, 0.0);
            let sx = FLOOR1_X + (cursor.0 - ox) * FLOOR1_W / iw;
            let sy = FLOOR1_Y + (cursor.1 - oy) * FLOOR1_H / ih;
            // Google style: the anchored point stays under the cursor.
            let (px, py) = anchor_pan(&l, 1.5, (sx, sy), cursor);
            let (ox1, oy1, iw1, ih1) = map_rect(&l, 1.5, px, py);
            let (rx, ry) = src_to_ref(ox1, oy1, iw1, ih1, sx, sy);
            assert!(
                (rx - cursor.0).abs() < 1.0 && (ry - cursor.1).abs() < 1.0,
                "portrait={portrait} anchored point drifted from the cursor"
            );
        }
    }
}
