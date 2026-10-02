use std::ffi;

use ink_ribbon_native::bridge;
use ink_ribbon_native::game::Game;
use ink_ribbon_native::geom::Layout;
use ink_ribbon_native::render;
use ink_ribbon_native::theme;
use sokol::{app as sapp, gfx as sg, gl as sgl, glue as sglue};

struct State {
    game: Game,
    pipeline: sgl::Pipeline,
    pass_action: sg::PassAction,
    elapsed: f32,
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
        max_vertices: 1 << 18,
        max_commands: 4096,
        logger: sgl::Logger {
            func: Some(sokol::log::slog_func),
            ..Default::default()
        },
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

    let background = theme::to_f32(theme::BACKGROUND);
    state.pass_action.colors[0] = sg::ColorAttachmentAction {
        load_action: sg::LoadAction::Clear,
        clear_value: sg::Color {
            r: background[0],
            g: background[1],
            b: background[2],
            a: background[3],
        },
        ..Default::default()
    };
}

extern "C" fn frame(user_data: *mut ffi::c_void) {
    let state = unsafe { &mut *(user_data as *mut State) };
    state.elapsed += sapp::frame_duration() as f32;
    bridge::poll(&mut state.game);

    let width = sapp::widthf();
    let height = sapp::heightf();
    let layout = Layout::compute(width, height, state.game.grid.cols, state.game.grid.rows);

    sgl::defaults();
    sgl::viewportf(0.0, 0.0, width, height, true);
    sgl::matrix_mode_projection();
    sgl::ortho(0.0, width, height, 0.0, -1.0, 1.0);
    sgl::matrix_mode_modelview();
    sgl::load_identity();
    sgl::load_pipeline(state.pipeline);
    render::draw(&state.game, &layout, state.elapsed);

    sg::begin_pass(&sg::Pass {
        action: state.pass_action,
        swapchain: sglue::swapchain(),
        ..Default::default()
    });
    sgl::draw();
    sg::end_pass();
    sg::commit();

    bridge::notify(&state.game);
}

extern "C" fn event(_event: *const sapp::Event, _user_data: *mut ffi::c_void) {}

extern "C" fn cleanup(user_data: *mut ffi::c_void) {
    sgl::shutdown();
    sg::shutdown();
    let _ = unsafe { Box::from_raw(user_data as *mut State) };
}

fn main() {
    let state = Box::new(State {
        game: Game::new(),
        pipeline: sgl::Pipeline::new(),
        pass_action: sg::PassAction::new(),
        elapsed: 0.0,
    });
    let user_data = Box::into_raw(state) as *mut ffi::c_void;

    sapp::run(&sapp::Desc {
        init_userdata_cb: Some(init),
        frame_userdata_cb: Some(frame),
        event_userdata_cb: Some(event),
        cleanup_userdata_cb: Some(cleanup),
        user_data,
        width: 1280,
        height: 720,
        window_title: c"ink-ribbon".as_ptr(),
        logger: sapp::Logger {
            func: Some(sokol::log::slog_func),
            ..Default::default()
        },
        icon: sapp::IconDesc {
            sokol_default: true,
            ..Default::default()
        },
        ..Default::default()
    });
}
