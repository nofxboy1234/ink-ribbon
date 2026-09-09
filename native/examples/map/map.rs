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
        sapp::EventType::MouseDown => state.dragging = true,
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

fn line(x1: f32, y1: f32, x2: f32, y2: f32) {
    sgl::begin_lines();
    sgl::v2f(x1, y1);
    sgl::v2f(x2, y2);
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

fn reference_viewport(width: f32, height: f32) -> (f32, f32, f32, f32) {
    // Keep the map in its fixed reference coordinate system. Browser/native
    // resizing changes only this letterboxed viewport, never map geometry.
    let scale = (width / REF_W).min(height / REF_H).max(0.0);
    let viewport_width = REF_W * scale;
    let viewport_height = REF_H * scale;
    let viewport_x = (width - viewport_width) * 0.5;
    let viewport_y = (height - viewport_height) * 0.5;
    (viewport_x, viewport_y, viewport_width, viewport_height)
}

extern "C" fn frame(user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    let delta = (sapp::frame_duration() as f32).clamp(0.0, 0.1);
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
    let (viewport_x, viewport_y, viewport_width, viewport_height) =
        reference_viewport(width, height);

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
        sampler: sg::Sampler::new(),
        pipeline: sgl::Pipeline::new(),
        floor: 2,
        zoom: 1.0,
        pan_x: 0.0,
        pan_y: 0.0,
        dragging: false,
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
