use std::ffi;

use sokol::{app as sapp, gfx as sg, gl as sgl, glue as sglue};

const REF_W: f32 = 1920.0;
const REF_H: f32 = 1080.0;
const MAP_X: f32 = 266.0;
const MAP_Y: f32 = 228.0;
const MAP_W: f32 = 1387.0;
const MAP_H: f32 = 720.0;

const MAPS: [(&[u8], i32, i32); 4] = [
    (include_bytes!("../../assets/floor-3.rgba"), 2048, 662),
    (include_bytes!("../../assets/floor-2.rgba"), 2048, 966),
    (include_bytes!("../../assets/floor-1.rgba"), 2048, 1177),
    (include_bytes!("../../assets/basement.rgba"), 2048, 859),
];

const HUD: &[u8] = include_bytes!("../../assets/map-hud.rgba");

#[derive(Clone, Copy)]
struct FloorTransition {
    from: usize,
    to: usize,
    elapsed: f32,
}

struct State {
    pass_action: sg::PassAction,
    views: [sg::View; 4],
    hud: sg::View,
    sampler: sg::Sampler,
    pipeline: sgl::Pipeline,
    floor: usize,
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
    mouse_x: f32,
    mouse_y: f32,
    dragging: bool,
    time: f32,
    transition: Option<FloorTransition>,
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

    for (i, (bytes, width, height)) in MAPS.iter().enumerate() {
        state.views[i] = texture(bytes, *width, *height);
    }
    state.hud = texture(HUD, 1920, 1080);
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

fn recenter(state: &mut State) {
    state.zoom = 1.0;
    state.pan_x = 0.0;
    state.pan_y = 0.0;
}

fn reference_pointer(x: f32, y: f32) -> Option<(f32, f32)> {
    let width = sapp::widthf();
    let height = sapp::heightf();
    let scale = (width / REF_W).min(height / REF_H);
    if scale <= 0.0 {
        return None;
    }
    let viewport_x = (width - REF_W * scale) * 0.5;
    let viewport_y = (height - REF_H * scale) * 0.5;
    Some(((x - viewport_x) / scale, (y - viewport_y) / scale))
}

extern "C" fn event(event: *const sapp::Event, user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    let event = unsafe { &*event };
    match event._type {
        sapp::EventType::MouseMove => {
            state.mouse_x = event.mouse_x;
            state.mouse_y = event.mouse_y;
            if state.dragging {
                state.pan_x += event.mouse_dx;
                state.pan_y += event.mouse_dy;
            }
        }
        sapp::EventType::MouseDown => {
            if let Some((x, y)) = reference_pointer(event.mouse_x, event.mouse_y) {
                let floors = [543.0, 587.0, 631.0, 675.0];
                for (index, floor_y) in floors.iter().enumerate() {
                    if (x - 242.0).abs() <= 24.0 && (y - floor_y).abs() <= 20.0 {
                        change_floor(state, index);
                    }
                }
                if (x - 1676.0).abs() <= 24.0 {
                    if (y - 415.0).abs() <= 22.0 {
                        state.zoom = (state.zoom + 0.12).min(2.4);
                    } else if (y - 813.0).abs() <= 22.0 {
                        state.zoom = (state.zoom - 0.12).max(0.72);
                    }
                }
            }
            state.dragging = true;
        }
        sapp::EventType::MouseUp => state.dragging = false,
        sapp::EventType::MouseScroll => {
            state.zoom = (state.zoom + event.scroll_y * 0.08).clamp(0.72, 2.4);
        }
        sapp::EventType::KeyDown => match event.key_code {
            sapp::Keycode::Q => change_floor(state, state.floor.saturating_sub(1)),
            sapp::Keycode::E => change_floor(state, (state.floor + 1).min(MAPS.len() - 1)),
            sapp::Keycode::W | sapp::Keycode::Up => state.pan_y += 22.0,
            sapp::Keycode::S | sapp::Keycode::Down => state.pan_y -= 22.0,
            sapp::Keycode::A | sapp::Keycode::Left => state.pan_x += 22.0,
            sapp::Keycode::D | sapp::Keycode::Right => state.pan_x -= 22.0,
            sapp::Keycode::Equal | sapp::Keycode::KpAdd => {
                state.zoom = (state.zoom + 0.12).min(2.4)
            }
            sapp::Keycode::Minus | sapp::Keycode::KpSubtract => {
                state.zoom = (state.zoom - 0.12).max(0.72)
            }
            sapp::Keycode::C | sapp::Keycode::Home => recenter(state),
            _ => {}
        },
        _ => {}
    }
}

fn quad(x: f32, y: f32, width: f32, height: f32) {
    sgl::begin_quads();
    sgl::v2f(x, y);
    sgl::v2f(x + width, y);
    sgl::v2f(x + width, y + height);
    sgl::v2f(x, y + height);
    sgl::end();
}

fn line(x1: f32, y1: f32, x2: f32, y2: f32) {
    sgl::begin_lines();
    sgl::v2f(x1, y1);
    sgl::v2f(x2, y2);
    sgl::end();
}

fn circle(x: f32, y: f32, radius: f32, segments: usize) {
    sgl::begin_line_strip();
    for i in 0..=segments {
        let angle = i as f32 / segments as f32 * std::f32::consts::TAU;
        sgl::v2f(x + angle.cos() * radius, y + angle.sin() * radius);
    }
    sgl::end();
}

fn diamond(x: f32, y: f32, radius: f32, fill: bool) {
    if fill {
        sgl::begin_triangles();
        sgl::v2f(x, y - radius);
        sgl::v2f(x + radius, y);
        sgl::v2f(x, y + radius);
        sgl::v2f(x, y - radius);
        sgl::v2f(x, y + radius);
        sgl::v2f(x - radius, y);
        sgl::end();
    } else {
        sgl::begin_line_strip();
        sgl::v2f(x, y - radius);
        sgl::v2f(x + radius, y);
        sgl::v2f(x, y + radius);
        sgl::v2f(x - radius, y);
        sgl::v2f(x, y - radius);
        sgl::end();
    }
}

fn triangle(x: f32, y: f32, up: bool) {
    let direction = if up { 1.0 } else { -1.0 };
    sgl::begin_triangles();
    sgl::v2f(x, y - 9.0 * direction);
    sgl::v2f(x - 7.0, y + 6.0 * direction);
    sgl::v2f(x + 7.0, y + 6.0 * direction);
    sgl::end();
}

fn draw_grid() {
    sgl::c4f(0.62, 0.56, 0.38, 0.16);
    sgl::begin_points();
    for y in (0..=1080).step_by(16) {
        for x in (0..=1920).step_by(16) {
            sgl::v2f(x as f32, y as f32);
        }
    }
    sgl::end();

    sgl::c4f(0.62, 0.56, 0.38, 0.08);
    for x in (0..=1920).step_by(96) {
        line(x as f32, 0.0, x as f32, REF_H);
    }
    for y in (0..=1080).step_by(96) {
        line(0.0, y as f32, REF_W, y as f32);
    }
}

fn draw_hud(state: &State) {
    sgl::enable_texture();
    sgl::texture(state.hud, state.sampler);
    sgl::c4f(1.0, 1.0, 1.0, 1.0);
    sgl::begin_quads();
    sgl::v2f_t2f(0.0, 0.0, 0.0, 0.0);
    sgl::v2f_t2f(REF_W, 0.0, 1.0, 0.0);
    sgl::v2f_t2f(REF_W, REF_H, 1.0, 1.0);
    sgl::v2f_t2f(0.0, REF_H, 0.0, 1.0);
    sgl::end();
    sgl::disable_texture();
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
    sgl::c4f(0.66, 0.57, 0.34, 0.85);
    line(220.0, 450.0, 220.0, 720.0);
    line(266.0, 450.0, 266.0, 720.0);
    line(220.0, 508.0, 266.0, 508.0);
    line(220.0, 711.0, 266.0, 711.0);
    triangle(242.0, 488.0, true);
    triangle(242.0, 684.0, false);

    let positions = [543.0, 587.0, 631.0, 675.0];
    for (index, y) in positions.iter().enumerate() {
        let active = index == state.floor;
        sgl::c4f(0.68, 0.61, 0.42, if active { 1.0 } else { 0.78 });
        diamond(242.0, *y, 13.0, active);
        if active {
            sgl::c4f(0.88, 0.82, 0.61, 1.0);
            diamond(242.0, *y, 10.0, false);
        }
    }
}

fn draw_zoom_selector(state: &State) {
    sgl::c4f(0.66, 0.57, 0.34, 0.85);
    line(1676.0, 438.0, 1676.0, 790.0);
    line(1668.0, 438.0, 1684.0, 438.0);
    line(1668.0, 790.0, 1684.0, 790.0);
    line(1670.0, 415.0, 1682.0, 415.0);
    line(1676.0, 409.0, 1676.0, 421.0);
    line(1670.0, 813.0, 1682.0, 813.0);
    let position = 790.0 - ((state.zoom - 0.72) / (2.4 - 0.72)).clamp(0.0, 1.0) * 352.0;
    sgl::c4f(0.88, 0.76, 0.36, 1.0);
    diamond(1676.0, position, 9.0, false);
}

fn map_point(state: &State, u: f32, v: f32) -> (f32, f32) {
    let width = MAPS[state.floor].1;
    let height = MAPS[state.floor].2;
    let (x, y, w, h) = map_rect(width, height, state.zoom, state.pan_x, state.pan_y);
    (x + u * w, y + v * h)
}

fn draw_markers(state: &State) {
    let blue = map_point(state, 0.239, 0.416);
    sgl::c4f(0.10, 0.63, 0.82, 0.95);
    diamond(blue.0, blue.1, 23.0, true);
    sgl::c4f(0.32, 0.82, 0.94, 1.0);
    diamond(blue.0, blue.1, 15.0, false);

    for (u, v) in [(0.391, 0.526), (0.423, 0.591)] {
        let point = map_point(state, u, v);
        sgl::c4f(0.91, 0.72, 0.05, 1.0);
        diamond(point.0, point.1, 22.0, true);
        sgl::c4f(0.18, 0.15, 0.04, 1.0);
        line(point.0 - 8.0, point.1 - 18.0, point.0 - 8.0, point.1 + 18.0);
        line(point.0 + 1.0, point.1 - 18.0, point.0 + 1.0, point.1 + 18.0);
    }

    for (u, v) in [
        (0.349, 0.335),
        (0.700, 0.416),
        (0.766, 0.189),
        (0.560, 0.140),
    ] {
        let point = map_point(state, u, v);
        sgl::c4f(0.68, 0.70, 0.70, 0.95);
        diamond(point.0, point.1, 17.0, false);
        sgl::c4f(0.91, 0.92, 0.86, 1.0);
        triangle(point.0, point.1, true);
    }

    let center = (959.5, 588.0);
    let pulse = 1.0 + (state.time * 1.8).sin() * 0.08;
    sgl::c4f(0.72, 0.68, 0.49, 0.72);
    circle(center.0, center.1, 36.0 * pulse, 48);
    circle(center.0, center.1, 3.0, 16);

    let save = map_point(state, 0.490, 0.480);
    sgl::c4f(0.93, 0.90, 0.72, 0.95);
    quad(save.0 - 22.0, save.1 - 13.0, 44.0, 25.0);
    sgl::c4f(0.13, 0.14, 0.14, 1.0);
    triangle(save.0 + 28.0, save.1, false);
}

extern "C" fn frame(user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    let delta = (sapp::frame_duration() as f32).clamp(0.0, 0.1);
    state.time += delta;
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
    let scale = (width / REF_W).min(height / REF_H);
    let viewport_width = REF_W * scale;
    let viewport_height = REF_H * scale;
    let viewport_x = (width - viewport_width) * 0.5;
    let viewport_y = (height - viewport_height) * 0.5;

    sgl::viewportf(
        viewport_x,
        viewport_y,
        viewport_width,
        viewport_height,
        true,
    );
    sgl::defaults();
    sgl::matrix_mode_projection();
    sgl::ortho(0.0, REF_W, REF_H, 0.0, -1.0, 1.0);
    sgl::matrix_mode_modelview();
    sgl::load_identity();
    sgl::load_pipeline(state.pipeline);

    draw_grid();
    draw_hud(state);
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
    draw_floor_selector(state);
    draw_zoom_selector(state);
    draw_markers(state);

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
    sgl::shutdown();
    sg::shutdown();
    let _ = unsafe { Box::from_raw(user_data as *mut State) };
}

fn main() {
    let state = Box::new(State {
        pass_action: sg::PassAction::new(),
        views: [sg::View::new(); 4],
        hud: sg::View::new(),
        sampler: sg::Sampler::new(),
        pipeline: sgl::Pipeline::new(),
        floor: 2,
        zoom: 1.0,
        pan_x: 0.0,
        pan_y: 0.0,
        mouse_x: 0.0,
        mouse_y: 0.0,
        dragging: false,
        time: 0.0,
        transition: None,
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
