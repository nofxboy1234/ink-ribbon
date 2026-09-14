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
const NUM_FLOORS: usize = 3;
const DEBUG_FONT: usize = 0;

// Dracula theme palette: https://draculatheme.com
const DRACULA_COMMENT: (f32, f32, f32) = (0.384, 0.447, 0.643); // #6272a4
const DRACULA_CYAN: (f32, f32, f32) = (0.545, 0.914, 0.992); // #8be9fd
const DRACULA_GREEN: (f32, f32, f32) = (0.314, 0.980, 0.482); // #50fa7b
const DRACULA_PURPLE: (f32, f32, f32) = (0.741, 0.576, 0.976); // #bd93f9
const DRACULA_PINK: (f32, f32, f32) = (1.0, 0.475, 0.776); // #ff79c6

// Dracula background: https://draculatheme.com
const BACKGROUND: (f32, f32, f32) = (0.157, 0.165, 0.212); // #282a36

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

struct State {
    pass_action: sg::PassAction,
    pipeline: sgl::Pipeline,
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
}

fn change_floor(state: &mut State, floor: usize) {
    if floor < NUM_FLOORS {
        state.floor = floor;
        notify_floor(floor);
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
            sapp::Keycode::E => change_floor(state, (state.floor + 1).min(NUM_FLOORS - 1)),
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

fn draw_floor_selector(state: &State) {
    let top = MAP_Y;
    let center = FLOOR_PANEL_X + PANEL_W * 0.5;

    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.08);
    rect(FLOOR_PANEL_X, top, PANEL_W, MAP_H);
    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.75);
    outline_rect(FLOOR_PANEL_X, top, PANEL_W, MAP_H);
    line(FLOOR_PANEL_X, 463.0, FLOOR_PANEL_X + PANEL_W, 463.0);
    line(FLOOR_PANEL_X, 512.0, FLOOR_PANEL_X + PANEL_W, 512.0);
    line(FLOOR_PANEL_X, 661.0, FLOOR_PANEL_X + PANEL_W, 661.0);
    line(FLOOR_PANEL_X, 710.0, FLOOR_PANEL_X + PANEL_W, 710.0);

    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.92);
    triangle(center, 489.0, 6.0, true);
    triangle(center, 684.0, 6.0, false);

    let marker_y = [543.0, 587.0, 631.0];
    let selected_slot = floor_slot(state.floor);
    for (slot, y) in marker_y.into_iter().enumerate() {
        let selected = slot == selected_slot;
        if selected {
            sgl::c4f(DRACULA_CYAN.0, DRACULA_CYAN.1, DRACULA_CYAN.2, 1.0);
        } else {
            sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.8);
        }
        diamond(center, y, 9.0, selected);
    }
}

fn draw_zoom_selector(state: &State) {
    let top = MAP_Y;
    let center = ZOOM_PANEL_X + PANEL_W * 0.5;
    let line_top = 438.0;
    let line_bottom = 730.0;

    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.08);
    rect(ZOOM_PANEL_X, top, PANEL_W, MAP_H);
    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.75);
    outline_rect(ZOOM_PANEL_X, top, PANEL_W, MAP_H);

    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.86);
    outline_rect(center - 8.0, 406.0, 16.0, 16.0);
    line(center - 4.0, 414.0, center + 4.0, 414.0);
    line(center, 410.0, center, 418.0);
    outline_rect(center - 8.0, 742.0, 16.0, 16.0);
    line(center - 4.0, 750.0, center + 4.0, 750.0);

    line(center, line_top, center, line_bottom);
    let default_zoom = (line_top + line_bottom) * 0.5;
    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.72);
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
    sgl::c4f(DRACULA_CYAN.0, DRACULA_CYAN.1, DRACULA_CYAN.2, 1.0);
    rect(center - 10.0, marker_y - 2.0, 20.0, 4.0);
}

fn draw_map_frame() {
    let right = MAP_X + MAP_W;
    let bottom = MAP_Y + MAP_H;

    sgl::c4f(DRACULA_COMMENT.0, DRACULA_COMMENT.1, DRACULA_COMMENT.2, 0.9);
    outline_rect(MAP_X, MAP_Y, MAP_W, MAP_H);

    sgl::c4f(DRACULA_COMMENT.0, DRACULA_COMMENT.1, DRACULA_COMMENT.2, 0.7);
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

    sgl::c4f(
        DRACULA_COMMENT.0,
        DRACULA_COMMENT.1,
        DRACULA_COMMENT.2,
        0.62,
    );
    let rows = [MAP_Y + 20.0, MAP_Y + 32.0, MAP_Y + 44.0];
    for y in rows {
        line(right - 118.0, y + 4.0, hud_right, y + 4.0);
        sgl::begin_points();
        sgl::point_size(2.0);
        sgl::v2f(hud_right, y + 4.0);
        sgl::end();
    }
    line(hud_right, MAP_Y + 58.0, hud_right, bottom - 44.0);

    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.9);
    outline_rect(right - 108.0, bottom - 43.0, 88.0, 22.0);

    // Two short registration lines continue below the lower-right corner.
    line(right - 34.0, bottom + 4.0, right - 34.0, bottom + 48.0);
    line(right - 20.0, bottom + 4.0, right - 20.0, bottom + 48.0);
}

fn draw_ui_text(
    text: &str,
    x: f32,
    y: f32,
    color: (f32, f32, f32),
    large: bool,
    left: f32,
    top: f32,
    visible_width: f32,
    visible_height: f32,
) {
    // Size the debugtext virtual canvas from the visible reference region
    // (not the framebuffer) so glyph size is identical on native and wasm
    // regardless of the actual window or canvas resolution.
    let glyph_pixels = if large { 16.0 } else { 8.0 };
    let scale = 8.0 / glyph_pixels;
    sdtx::canvas(visible_width * scale, visible_height * scale);
    sdtx::font(DEBUG_FONT);
    sdtx::color3f(color.0, color.1, color.2);
    sdtx::pos((x - left) / glyph_pixels, (y - top) / glyph_pixels);
    sdtx::puts(text);
}

fn draw_map_labels(left: f32, right: f32, top: f32, bottom: f32) {
    let visible_width = right - left;
    let visible_height = bottom - top;
    let label = |text: &str, x: f32, y: f32, color: (f32, f32, f32), large: bool| {
        draw_ui_text(
            text,
            x,
            y,
            color,
            large,
            left,
            top,
            visible_width,
            visible_height,
        )
    };

    label(
        "BATTERY",
        MAP_X + MAP_W - 154.0,
        MAP_Y + 20.0,
        DRACULA_COMMENT,
        false,
    );
    label(
        "MEMORY",
        MAP_X + MAP_W - 154.0,
        MAP_Y + 32.0,
        DRACULA_COMMENT,
        false,
    );
    label(
        "DISC",
        MAP_X + MAP_W - 154.0,
        MAP_Y + 44.0,
        DRACULA_COMMENT,
        false,
    );
    label(
        "AREA MAP",
        MAP_X + MAP_W - 103.0,
        MAP_Y + MAP_H - 38.0,
        DRACULA_CYAN,
        false,
    );
    label(
        "In",
        ZOOM_PANEL_X + 13.0,
        MAP_Y + 140.0,
        DRACULA_GREEN,
        false,
    );
    label(
        "Out",
        ZOOM_PANEL_X + 8.0,
        MAP_Y + 570.0,
        DRACULA_GREEN,
        false,
    );
    // The nameplate is framed by the outer left/right lines below the map.
    let name_left = MAP_X;
    let name_left_inner = MAP_X + 14.0;
    let name_right = MAP_X + 242.0;
    // Center the label between those lines using the large glyph width.
    let large_glyph = 16.0;
    let name = "Care Center";
    let name_x = (name_left + name_right) * 0.5 - name.len() as f32 * large_glyph * 0.5;
    label(name, name_x, MAP_Y + MAP_H + 23.0, DRACULA_PINK, true);

    sgl::c4f(DRACULA_PURPLE.0, DRACULA_PURPLE.1, DRACULA_PURPLE.2, 0.9);
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

fn draw_debug_overlay(state: &State, top: f32, visible_width: f32, visible_height: f32) {
    if !state.debug_mode {
        return;
    }
    let glyph_pixels = 16.0;
    sdtx::canvas(visible_width * 0.5, visible_height * 0.5);
    sdtx::font(DEBUG_FONT);
    sdtx::color3f(DRACULA_GREEN.0, DRACULA_GREEN.1, DRACULA_GREEN.2);
    sdtx::pos(
        (visible_width / glyph_pixels - 12.0).max(0.0),
        (-top) / glyph_pixels + 1.0,
    );
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

    draw_floor_selector(state);
    draw_zoom_selector(state);
    draw_map_frame();
    draw_map_overlay();
    draw_map_labels(left, right, top, bottom);
    draw_debug_overlay(state, top, right - left, bottom - top);

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
        pipeline: sgl::Pipeline::new(),
        floor: 2,
        zoom: 1.0,
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
