use std::ffi;

use sokol::{app as sapp, debugtext as sdtx, gfx as sg, gl as sgl, glue as sglue};

const REF_W: f32 = 1920.0;
const REF_H: f32 = 1080.0;
const MAP_X: f32 = 266.0;
const MAP_Y: f32 = 228.0;
const MAP_W: f32 = 1387.0;
const MAP_H: f32 = 720.0;
const FLOOR_PANEL_X: f32 = 220.0;
const ZOOM_PANEL_X: f32 = MAP_X + MAP_W;
const PANEL_W: f32 = 46.0;
const ZOOM_MIN: f32 = 0.72;
const ZOOM_MAX: f32 = 2.4;
const DEBUG_FONT: usize = 0;

const GRID_RGB: (f32, f32, f32) = (0.44, 0.44, 0.42);
const GOLD_RGB: (f32, f32, f32) = (0.42, 0.38, 0.24);
const FRAME_RGB: (f32, f32, f32) = (0.48, 0.50, 0.47);

const MAPS: [(&[u8], i32, i32); 4] = [
    (include_bytes!("../../assets/floor-3.rgba"), 2048, 662),
    (include_bytes!("../../assets/floor-2.rgba"), 2048, 966),
    (include_bytes!("../../assets/floor-1.rgba"), 2048, 1177),
    (include_bytes!("../../assets/basement.rgba"), 2048, 859),
];

#[derive(Clone, Copy)]
struct FloorTransition {
    from: usize,
    to: usize,
    elapsed: f32,
}

struct State {
    pass_action: sg::PassAction,
    views: [sg::View; 4],
    sampler: sg::Sampler,
    pipeline: sgl::Pipeline,
    floor: usize,
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
    dragging: bool,
    transition: Option<FloorTransition>,
    debug_mode: bool,
    fps: f32,
    fps_elapsed: f32,
    fps_frames: u32,
}

fn texture(bytes: &[u8], width: i32, height: i32) -> sg::View {
    assert_eq!(bytes.len(), (width * height * 4) as usize);
    let pixels: Vec<u32> = bytes
        .chunks_exact(4)
        .map(|p| u32::from_ne_bytes([p[0], p[1], p[2], p[3]]))
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
    let mut debug_text = sdtx::Desc::new();
    debug_text.fonts[DEBUG_FONT] = sdtx::font_kc853();
    debug_text.context.sample_count = 4;
    sdtx::setup(&debug_text);

    for (i, (bytes, width, height)) in MAPS.iter().enumerate() {
        state.views[i] = texture(bytes, *width, *height);
    }
    state.sampler = sg::make_sampler(&sg::SamplerDesc {
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
            r: 0.005,
            g: 0.007,
            b: 0.009,
            a: 1.0,
        },
        ..Default::default()
    };
}

fn change_floor(state: &mut State, floor: usize) {
    if floor == state.floor || floor >= MAPS.len() || state.transition.is_some() {
        return;
    }
    state.transition = Some(FloorTransition {
        from: state.floor,
        to: floor,
        elapsed: 0.0,
    });
}

fn floor_slot(floor: usize) -> usize {
    match floor {
        0 => 0,
        1 => 1,
        _ => 2,
    }
}

fn recenter(state: &mut State) {
    state.zoom = 1.0;
    state.pan_x = 0.0;
    state.pan_y = 0.0;
}

extern "C" fn event(event: *const sapp::Event, user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    let event = unsafe { &*event };
    match event._type {
        sapp::EventType::MouseMove => {
            if state.dragging {
                state.pan_x += event.mouse_dx;
                state.pan_y += event.mouse_dy;
            }
        }
        sapp::EventType::MouseDown => {
            let width = sapp::widthf();
            let height = sapp::heightf();
            let (left, right, top, bottom) = reference_projection(width, height);
            let x = left + event.mouse_x / width.max(1.0) * (right - left);
            let y = top + event.mouse_y / height.max(1.0) * (bottom - top);

            if (FLOOR_PANEL_X..MAP_X).contains(&x) {
                let marker_y = [543.0, 587.0, 631.0];
                if let Some((slot, _)) = marker_y
                    .iter()
                    .enumerate()
                    .min_by(|(_, a), (_, b)| ((*a - y).abs()).total_cmp(&(*b - y).abs()))
                {
                    if (y - marker_y[slot]).abs() < 24.0 {
                        change_floor(state, slot);
                    }
                }
                state.dragging = false;
            } else if (ZOOM_PANEL_X..ZOOM_PANEL_X + PANEL_W).contains(&x) {
                if (400.0..430.0).contains(&y) {
                    state.zoom = (state.zoom + 0.12).min(ZOOM_MAX);
                } else if (735.0..765.0).contains(&y) {
                    state.zoom = (state.zoom - 0.12).max(ZOOM_MIN);
                } else if (438.0..=730.0).contains(&y) {
                    let normalized = ((y - 730.0) / (438.0 - 730.0)).clamp(0.0, 1.0);
                    state.zoom = ZOOM_MIN + (ZOOM_MAX - ZOOM_MIN) * normalized;
                }
                state.dragging = false;
            } else {
                state.dragging = true;
            }
        }
        sapp::EventType::MouseUp => state.dragging = false,
        sapp::EventType::MouseScroll => {
            state.zoom = (state.zoom + event.scroll_y * 0.08).clamp(ZOOM_MIN, ZOOM_MAX);
        }
        sapp::EventType::KeyDown => match event.key_code {
            sapp::Keycode::F1 if !event.key_repeat => state.debug_mode = !state.debug_mode,
            sapp::Keycode::Q => change_floor(state, state.floor.saturating_sub(1)),
            sapp::Keycode::E => change_floor(state, (state.floor + 1).min(MAPS.len() - 1)),
            sapp::Keycode::W | sapp::Keycode::Up => state.pan_y += 22.0,
            sapp::Keycode::S | sapp::Keycode::Down => state.pan_y -= 22.0,
            sapp::Keycode::A | sapp::Keycode::Left => state.pan_x += 22.0,
            sapp::Keycode::D | sapp::Keycode::Right => state.pan_x -= 22.0,
            sapp::Keycode::Equal | sapp::Keycode::KpAdd => {
                state.zoom = (state.zoom + 0.12).min(ZOOM_MAX)
            }
            sapp::Keycode::Minus | sapp::Keycode::KpSubtract => {
                state.zoom = (state.zoom - 0.12).max(ZOOM_MIN)
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

fn draw_grid(left: f32, right: f32, top: f32, bottom: f32) {
    let point_start_x = (left / 16.0).floor() as i32 * 16 - 16;
    let point_end_x = (right / 16.0).ceil() as i32 * 16 + 16;
    let point_start_y = (top / 16.0).floor() as i32 * 16 - 16;
    let point_end_y = (bottom / 16.0).ceil() as i32 * 16 + 16;

    sgl::c4f(GRID_RGB.0, GRID_RGB.1, GRID_RGB.2, 0.26);
    sgl::point_size(1.2);
    sgl::begin_points();
    for y in (point_start_y..=point_end_y).step_by(16) {
        for x in (point_start_x..=point_end_x).step_by(16) {
            sgl::v2f(x as f32, y as f32);
        }
    }
    sgl::end();

    sgl::c4f(GRID_RGB.0, GRID_RGB.1, GRID_RGB.2, 0.11);
    let major_start_x = (left / 96.0).floor() as i32 * 96 - 96;
    let major_end_x = (right / 96.0).ceil() as i32 * 96 + 96;
    let major_start_y = (top / 96.0).floor() as i32 * 96 - 96;
    let major_end_y = (bottom / 96.0).ceil() as i32 * 96 + 96;
    for x in (major_start_x..=major_end_x).step_by(96) {
        line(x as f32, top, x as f32, bottom);
    }
    for y in (major_start_y..=major_end_y).step_by(96) {
        line(left, y as f32, right, y as f32);
    }
}

fn map_rect(width: i32, height: i32, zoom: f32, pan_x: f32, pan_y: f32) -> (f32, f32, f32, f32) {
    let image_width = MAP_W * zoom;
    let image_height = image_width * height as f32 / width as f32;
    let x = MAP_X + (MAP_W - image_width) * 0.5 + pan_x;
    let y = MAP_Y + (MAP_H - image_height) * 0.5 + pan_y;
    (x, y, image_width, image_height)
}

fn draw_map(state: &State, floor: usize, alpha: f32, pan_x: f32, pan_y: f32) {
    let width = MAPS[floor].1;
    let height = MAPS[floor].2;
    let (x, y, width, height) = map_rect(width, height, state.zoom, pan_x, pan_y);
    sgl::enable_texture();
    sgl::texture(state.views[floor], state.sampler);
    sgl::c4f(1.0, 1.0, 1.0, alpha);
    sgl::begin_quads();
    sgl::v2f_t2f(x, y, 0.0, 0.0);
    sgl::v2f_t2f(x + width, y, 1.0, 0.0);
    sgl::v2f_t2f(x + width, y + height, 1.0, 1.0);
    sgl::v2f_t2f(x, y + height, 0.0, 1.0);
    sgl::end();
    sgl::disable_texture();
}

fn draw_floor_selector(state: &State) {
    let top = MAP_Y;
    let center = FLOOR_PANEL_X + PANEL_W * 0.5;

    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.08);
    rect(FLOOR_PANEL_X, top, PANEL_W, MAP_H);
    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.75);
    outline_rect(FLOOR_PANEL_X, top, PANEL_W, MAP_H);
    line(FLOOR_PANEL_X, 463.0, FLOOR_PANEL_X + PANEL_W, 463.0);
    line(FLOOR_PANEL_X, 512.0, FLOOR_PANEL_X + PANEL_W, 512.0);
    line(FLOOR_PANEL_X, 661.0, FLOOR_PANEL_X + PANEL_W, 661.0);
    line(FLOOR_PANEL_X, 710.0, FLOOR_PANEL_X + PANEL_W, 710.0);

    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.92);
    triangle(center, 489.0, 6.0, true);
    triangle(center, 684.0, 6.0, false);

    let marker_y = [543.0, 587.0, 631.0];
    let selected_slot = floor_slot(state.floor);
    for (slot, y) in marker_y.into_iter().enumerate() {
        let selected = slot == selected_slot;
        sgl::c4f(
            GOLD_RGB.0 + if selected { 0.20 } else { 0.0 },
            GOLD_RGB.1 + if selected { 0.18 } else { 0.0 },
            GOLD_RGB.2 + if selected { 0.12 } else { 0.0 },
            if selected { 1.0 } else { 0.8 },
        );
        diamond(center, y, 9.0, selected);
    }
}

fn draw_zoom_selector(state: &State) {
    let top = MAP_Y;
    let center = ZOOM_PANEL_X + PANEL_W * 0.5;
    let line_top = 438.0;
    let line_bottom = 730.0;

    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.08);
    rect(ZOOM_PANEL_X, top, PANEL_W, MAP_H);
    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.75);
    outline_rect(ZOOM_PANEL_X, top, PANEL_W, MAP_H);

    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.86);
    outline_rect(center - 8.0, 406.0, 16.0, 16.0);
    line(center - 4.0, 414.0, center + 4.0, 414.0);
    line(center, 410.0, center, 418.0);
    outline_rect(center - 8.0, 742.0, 16.0, 16.0);
    line(center - 4.0, 750.0, center + 4.0, 750.0);

    line(center, line_top, center, line_bottom);
    let default_zoom = (line_top + line_bottom) * 0.5;
    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.72);
    rect(center - 8.0, default_zoom - 1.0, 16.0, 2.0);
    // The reference UI places the default zoom (1.0) at the halfway mark.
    // Keep the indicator anchored there while preserving the full zoom range.
    let normalized = if state.zoom >= 1.0 {
        0.5 + (state.zoom - 1.0) / (ZOOM_MAX - 1.0) * 0.5
    } else {
        (state.zoom - ZOOM_MIN) / (1.0 - ZOOM_MIN) * 0.5
    }
    .clamp(0.0, 1.0);
    let marker_y = line_bottom + (line_top - line_bottom) * normalized;
    sgl::c4f(GOLD_RGB.0 + 0.14, GOLD_RGB.1 + 0.12, GOLD_RGB.2 + 0.08, 1.0);
    rect(center - 10.0, marker_y - 2.0, 20.0, 4.0);
}

fn draw_map_frame() {
    let right = MAP_X + MAP_W;
    let bottom = MAP_Y + MAP_H;

    sgl::c4f(FRAME_RGB.0, FRAME_RGB.1, FRAME_RGB.2, 0.86);
    outline_rect(MAP_X, MAP_Y, MAP_W, MAP_H);

    sgl::c4f(FRAME_RGB.0, FRAME_RGB.1, FRAME_RGB.2, 0.66);
    let mut x = MAP_X + 5.0;
    while x < right - 4.0 {
        rect(x, MAP_Y + 3.0, 1.0, 6.0);
        rect(x, bottom - 9.0, 1.0, 6.0);
        x += 6.0;
    }
    let mut y = MAP_Y + 5.0;
    while y < bottom - 4.0 {
        rect(MAP_X + 3.0, y, 6.0, 1.0);
        rect(right - 9.0, y, 6.0, 1.0);
        y += 8.0;
    }
}

fn draw_map_overlay() {
    let right = MAP_X + MAP_W;
    let bottom = MAP_Y + MAP_H;
    let hud_right = right - 18.0;

    sgl::c4f(FRAME_RGB.0, FRAME_RGB.1, FRAME_RGB.2, 0.58);
    let rows = [MAP_Y + 20.0, MAP_Y + 32.0, MAP_Y + 44.0];
    for y in rows {
        line(right - 118.0, y + 4.0, hud_right, y + 4.0);
        sgl::begin_points();
        sgl::point_size(2.0);
        sgl::v2f(hud_right, y + 4.0);
        sgl::end();
    }
    line(hud_right, MAP_Y + 58.0, hud_right, bottom - 44.0);

    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.9);
    outline_rect(right - 108.0, bottom - 43.0, 88.0, 22.0);

    // Two short registration lines continue below the lower-right corner.
    line(right - 34.0, bottom + 4.0, right - 34.0, bottom + 48.0);
    line(right - 20.0, bottom + 4.0, right - 20.0, bottom + 48.0);
}

fn text_position(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
    glyph_pixels: f32,
) -> (f32, f32) {
    let screen_x = (x - left) / (right - left).max(0.0001) * width;
    let screen_y = (y - top) / (bottom - top).max(0.0001) * height;
    (screen_x / glyph_pixels, screen_y / glyph_pixels)
}

fn draw_ui_text(
    text: &str,
    x: f32,
    y: f32,
    color: (u8, u8, u8),
    large: bool,
    width: f32,
    height: f32,
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
) {
    let glyph_pixels = if large { 16.0 } else { 8.0 };
    if large {
        sdtx::canvas(width * 0.5, height * 0.5);
    } else {
        sdtx::canvas(width, height);
    }
    let (tx, ty) = text_position(x, y, width, height, left, right, top, bottom, glyph_pixels);
    sdtx::font(DEBUG_FONT);
    sdtx::color3b(color.0, color.1, color.2);
    sdtx::pos(tx, ty);
    sdtx::puts(text);
}

fn draw_map_labels(width: f32, height: f32, left: f32, right: f32, top: f32, bottom: f32) {
    draw_ui_text(
        "BATTERY",
        MAP_X + MAP_W - 154.0,
        MAP_Y + 20.0,
        (112, 111, 94),
        false,
        width,
        height,
        left,
        right,
        top,
        bottom,
    );
    draw_ui_text(
        "MEMORY",
        MAP_X + MAP_W - 154.0,
        MAP_Y + 32.0,
        (112, 111, 94),
        false,
        width,
        height,
        left,
        right,
        top,
        bottom,
    );
    draw_ui_text(
        "DISC",
        MAP_X + MAP_W - 154.0,
        MAP_Y + 44.0,
        (112, 111, 94),
        false,
        width,
        height,
        left,
        right,
        top,
        bottom,
    );
    draw_ui_text(
        "AREA MAP",
        MAP_X + MAP_W - 103.0,
        MAP_Y + MAP_H - 38.0,
        (132, 125, 91),
        false,
        width,
        height,
        left,
        right,
        top,
        bottom,
    );
    draw_ui_text(
        "In",
        ZOOM_PANEL_X + 13.0,
        MAP_Y + 140.0,
        (135, 119, 69),
        false,
        width,
        height,
        left,
        right,
        top,
        bottom,
    );
    draw_ui_text(
        "Out",
        ZOOM_PANEL_X + 8.0,
        MAP_Y + 570.0,
        (135, 119, 69),
        false,
        width,
        height,
        left,
        right,
        top,
        bottom,
    );
    draw_ui_text(
        "Care Center",
        MAP_X + 76.0,
        MAP_Y + MAP_H + 23.0,
        (174, 163, 113),
        true,
        width,
        height,
        left,
        right,
        top,
        bottom,
    );

    let name_left = MAP_X;
    let name_left_inner = MAP_X + 14.0;
    let name_right = MAP_X + 242.0;
    sgl::c4f(GOLD_RGB.0, GOLD_RGB.1, GOLD_RGB.2, 0.9);
    line(
        name_left,
        MAP_Y + MAP_H + 4.0,
        name_left,
        MAP_Y + MAP_H + 48.0,
    );
    line(
        name_left_inner,
        MAP_Y + MAP_H + 4.0,
        name_left_inner,
        MAP_Y + MAP_H + 48.0,
    );
    line(
        name_right,
        MAP_Y + MAP_H + 4.0,
        name_right,
        MAP_Y + MAP_H + 48.0,
    );
}

fn draw_debug_overlay(state: &State, width: f32, height: f32) {
    if !state.debug_mode {
        return;
    }
    // Use a half-size virtual canvas so the 8x8 debug glyphs remain readable
    // on a high-resolution fullscreen display.
    let canvas_width = width * 0.5;
    let canvas_height = height * 0.5;
    sdtx::canvas(canvas_width, canvas_height);
    sdtx::font(DEBUG_FONT);
    sdtx::color3b(0, 255, 0);
    // Debugtext positions are character-grid cells, not virtual pixels.
    sdtx::pos((canvas_width / 8.0 - 12.0).max(0.0), 1.0);
    sdtx::puts(&format!("FPS: {:5.1}", state.fps));
}

fn reference_projection(width: f32, height: f32) -> (f32, f32, f32, f32) {
    // Fill the resized viewport without distorting the fixed reference map.
    // If the viewport is not 16:9, expose a little more reference space on
    // the longer axis so the excess is cropped instead of shown as a gap.
    let aspect = if height > 0.0 {
        width / height
    } else {
        REF_W / REF_H
    };
    let reference_aspect = REF_W / REF_H;
    if aspect >= reference_aspect {
        let visible_width = REF_H * aspect;
        let crop = (visible_width - REF_W) * 0.5;
        (-crop, REF_W + crop, 0.0, REF_H)
    } else {
        let visible_height = REF_W / aspect.max(0.0001);
        let crop = (visible_height - REF_H) * 0.5;
        (0.0, REF_W, -crop, REF_H + crop)
    }
}

extern "C" fn frame(user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    let delta = (sapp::frame_duration() as f32).clamp(0.0, 0.1);
    state.fps_elapsed += delta;
    state.fps_frames += 1;
    if state.fps_elapsed >= 0.25 {
        state.fps = state.fps_frames as f32 / state.fps_elapsed.max(0.0001);
        state.fps_elapsed = 0.0;
        state.fps_frames = 0;
    }
    if let Some(mut transition) = state.transition {
        transition.elapsed += delta;
        if transition.elapsed >= 0.72 {
            state.floor = transition.to;
            state.transition = None;
        } else {
            state.transition = Some(transition);
        }
    }

    let width = sapp::widthf();
    let height = sapp::heightf();
    let (left, right, top, bottom) = reference_projection(width, height);

    sgl::viewportf(0.0, 0.0, width, height, true);
    sgl::defaults();
    sgl::matrix_mode_projection();
    sgl::ortho(left, right, bottom, top, -1.0, 1.0);
    sgl::matrix_mode_modelview();
    sgl::load_identity();
    sgl::load_pipeline(state.pipeline);

    draw_grid(left, right, top, bottom);
    draw_floor_selector(state);
    draw_zoom_selector(state);

    // Keep the pannable map inside the main map window. The surrounding
    // selectors and grid remain visible while the map moves and zooms.
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
    if let Some(transition) = state.transition {
        let progress = (transition.elapsed / 0.72).clamp(0.0, 1.0);
        let smooth = progress * progress * (3.0 - 2.0 * progress);
        draw_map(
            state,
            transition.from,
            1.0 - smooth,
            state.pan_x,
            state.pan_y,
        );
        draw_map(state, transition.to, smooth, state.pan_x, state.pan_y);
    } else {
        draw_map(state, state.floor, 1.0, state.pan_x, state.pan_y);
    }
    sgl::scissor_rectf(0.0, 0.0, width, height, true);
    draw_map_frame();
    draw_map_overlay();
    draw_map_labels(width, height, left, right, top, bottom);
    draw_debug_overlay(state, width, height);

    sg::begin_pass(&sg::Pass {
        action: state.pass_action,
        swapchain: sglue::swapchain(),
        ..Default::default()
    });
    sgl::draw();
    sdtx::draw();
    sg::end_pass();
    sg::commit();
}

extern "C" fn cleanup(user_data: *mut ffi::c_void) {
    sdtx::shutdown();
    sgl::shutdown();
    sg::shutdown();
    let _ = unsafe { Box::from_raw(user_data as *mut State) };
}

fn main() {
    let state = Box::new(State {
        pass_action: sg::PassAction::new(),
        views: [sg::View::new(); 4],
        sampler: sg::Sampler::new(),
        pipeline: sgl::Pipeline::new(),
        floor: 2,
        zoom: 1.0,
        pan_x: 0.0,
        pan_y: 0.0,
        dragging: false,
        transition: None,
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
        // web target remains inside the React shell's map canvas.
        fullscreen: true,
        sample_count: 4,
        swap_interval: 1,
        html5: sapp::Html5Desc {
            canvas_selector: c"#map-canvas".as_ptr(),
            canvas_resize: true,
            ..Default::default()
        },
        logger: sapp::Logger {
            func: Some(sokol::log::slog_func),
            ..Default::default()
        },
        ..Default::default()
    });
}
