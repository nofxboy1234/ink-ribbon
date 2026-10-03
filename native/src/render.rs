use sokol::gl as sgl;

use crate::game::Game;
use crate::geom::Layout;
use crate::grid;
use crate::theme::{self, Rgba};

const TAU: f32 = std::f32::consts::TAU;

const GRACE_RADIUS: f32 = 0.20;
const PULSE_RADIUS: f32 = 0.85;
const PULSE_PERIOD: f32 = 1.6;
const DOOR_THICKNESS: f32 = 0.24;
const DOOR_INSET: f32 = 0.18;
const WALL_THICKNESS: f32 = 0.05;

fn color(c: Rgba) {
    sgl::c4b(c[0], c[1], c[2], c[3]);
}

fn bar(a: (f32, f32), b: (f32, f32), thickness: f32, c: Rgba) {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let len = (dx * dx + dy * dy).sqrt().max(0.0001);
    let px = -dy / len * thickness * 0.5;
    let py = dx / len * thickness * 0.5;
    sgl::begin_quads();
    color(c);
    sgl::v2f(a.0 + px, a.1 + py);
    sgl::v2f(b.0 + px, b.1 + py);
    sgl::v2f(b.0 - px, b.1 - py);
    sgl::v2f(a.0 - px, a.1 - py);
    sgl::end();
}

fn disc(cx: f32, cy: f32, radius: f32, c: Rgba) {
    let segments = 40;
    sgl::begin_triangles();
    color(c);
    for i in 0..segments {
        let a0 = TAU * i as f32 / segments as f32;
        let a1 = TAU * (i + 1) as f32 / segments as f32;
        sgl::v2f(cx, cy);
        sgl::v2f(cx + radius * a0.cos(), cy + radius * a0.sin());
        sgl::v2f(cx + radius * a1.cos(), cy + radius * a1.sin());
    }
    sgl::end();
}

fn ring(cx: f32, cy: f32, radius: f32, c: Rgba) {
    let segments = 64;
    sgl::begin_line_strip();
    color(c);
    for i in 0..=segments {
        let a = TAU * i as f32 / segments as f32;
        sgl::v2f(cx + radius * a.cos(), cy + radius * a.sin());
    }
    sgl::end();
}

fn draw_grid(layout: &Layout) {
    sgl::begin_lines();
    color(theme::GRID_LINE);
    for x in 1..layout.cols {
        let gx = layout.ox + x as f32 * layout.cell;
        sgl::v2f(gx, layout.oy);
        sgl::v2f(gx, layout.oy + layout.room_h());
    }
    for y in 1..layout.rows {
        let gy = layout.oy + y as f32 * layout.cell;
        sgl::v2f(layout.ox, gy);
        sgl::v2f(layout.ox + layout.room_w(), gy);
    }
    sgl::end();
}

fn draw_walls(game: &Game, layout: &Layout) {
    let thickness = (layout.cell * WALL_THICKNESS).max(2.0);
    for y in 0..game.grid.rows {
        for x in 0..game.grid.cols {
            let cell = game.grid.cell(x, y);
            for side in grid::SIDES {
                if cell.is_blocked(side) {
                    let (a, b) = layout.edge(x, y, side);
                    bar(a, b, thickness, theme::WALL);
                }
            }
        }
    }
}

fn draw_doors(game: &Game, layout: &Layout) {
    let thickness = layout.cell * DOOR_THICKNESS;
    for door in &game.doors {
        let (a, b) = layout.edge(door.x, door.y, door.side);
        let start = (
            a.0 + (b.0 - a.0) * DOOR_INSET,
            a.1 + (b.1 - a.1) * DOOR_INSET,
        );
        let end = (
            b.0 + (a.0 - b.0) * DOOR_INSET,
            b.1 + (a.1 - b.1) * DOOR_INSET,
        );
        let c = if door.locked {
            theme::DOOR_LOCKED
        } else {
            theme::DOOR_UNLOCKED
        };
        bar(start, end, thickness, c);
    }
}

fn draw_player(game: &Game, layout: &Layout, elapsed: f32) {
    let (cx, cy) = layout.cell_center(game.player.0, game.player.1);
    let grace = layout.cell * GRACE_RADIUS;
    let pulse_max = layout.cell * PULSE_RADIUS;

    let phase = (elapsed / PULSE_PERIOD).fract();
    let eased = 1.0 - (1.0 - phase) * (1.0 - phase);
    let radius = grace + (pulse_max - grace) * eased;
    let alpha = ((1.0 - phase) * 210.0) as u8;

    ring(
        cx,
        cy,
        radius,
        theme::with_alpha(theme::PLAYER_PULSE, alpha),
    );
    ring(
        cx,
        cy,
        (radius - 1.5).max(grace + 1.0),
        theme::with_alpha(theme::PLAYER_PULSE, alpha / 2),
    );
    disc(cx, cy, grace, theme::PLAYER);
}

pub fn draw(game: &Game, layout: &Layout, elapsed: f32) {
    draw_grid(layout);
    draw_walls(game, layout);
    draw_doors(game, layout);
    draw_player(game, layout, elapsed);
}
