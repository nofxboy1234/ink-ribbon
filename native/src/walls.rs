//! Boundary extraction for the wall union.
//!
//! Walls are axis-aligned rectangles with an ordered `Add`/`Sub` boolean. The
//! map draws them as a thin double line: the outline of the union, plus the
//! outline of the union eroded by a small gap, so a thick wall block still reads
//! as two close parallel lines. Internal edges (where quads overlap or abut) and
//! gaps at corners are handled here.

use crate::scene::{BoolOp, Floor, Rect};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EdgeDir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct WallEdge {
    pub dir: EdgeDir,
    /// Span in source-composite pixels: for `Up`/`Down` this is the horizontal
    /// run `(x0, y)`–`(x1, y)`; for `Left`/`Right` the vertical run `(x, y0)`–`(x, y1)`.
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    /// True for the inset copy (the inner line), false for the union outline.
    pub inset: bool,
}

/// A miter fill at a boundary vertex, as a unit square scaled by the line
/// thickness: spans `x .. x + sx*t` and `y .. y + sy*t` with `sx`/`sy` ±1.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct WallCorner {
    pub x: f32,
    pub y: f32,
    pub sx: f32,
    pub sy: f32,
    pub inset: bool,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct WallPlan {
    pub edges: Vec<WallEdge>,
    pub corners: Vec<WallCorner>,
}

/// The wall lines for a floor: the room union's boundary (outer, brighter) plus
/// the boundary of its eroded interior (inner, dimmer). Because rooms union,
/// overlapping rectangles merge and leave no internal wall.
pub fn wall_plan(floor: &Floor) -> WallPlan {
    let mut plan = boundary(&floor.wall_ops());
    let mut inner = boundary(&floor.interior_ops());
    for e in &mut inner.edges {
        e.inset = true;
    }
    for c in &mut inner.corners {
        c.inset = true;
    }
    plan.edges.extend(inner.edges);
    plan.corners.extend(inner.corners);
    plan
}

/// Boundary of an ordered `Add`/`Sub` rectangle set, as merged faces plus miter
/// corners.
fn boundary(ops: &[(BoolOp, Rect)]) -> WallPlan {
    // Coordinate compression: every rectangle edge becomes a grid line, so each
    // cell is uniformly inside or outside the union.
    let mut xs: Vec<f32> = Vec::new();
    let mut ys: Vec<f32> = Vec::new();
    for (_, r) in ops {
        xs.push(r.x);
        xs.push(r.x + r.w);
        ys.push(r.y);
        ys.push(r.y + r.h);
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    xs.dedup();
    ys.dedup();
    if xs.len() < 2 || ys.len() < 2 {
        return WallPlan::default();
    }
    let nx = xs.len() - 1;
    let ny = ys.len() - 1;

    let cell = |j: usize, i: usize| -> bool {
        let cx = (xs[i] + xs[i + 1]) * 0.5;
        let cy = (ys[j] + ys[j + 1]) * 0.5;
        let mut on = false;
        for (mode, r) in ops {
            if cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h {
                on = *mode == BoolOp::Add;
            }
        }
        on
    };

    let mut edges = Vec::new();

    // Horizontal faces: Up on a top edge, Down on a bottom edge, merged along x.
    for j in 0..ny {
        for (dir, test_below) in [(EdgeDir::Up, false), (EdgeDir::Down, true)] {
            let y = if test_below { ys[j + 1] } else { ys[j] };
            let mut start: Option<usize> = None;
            for i in 0..=nx {
                let on = i < nx
                    && cell(j, i)
                    && if test_below {
                        j + 1 >= ny || !cell(j + 1, i)
                    } else {
                        j == 0 || !cell(j - 1, i)
                    };
                match (start, on) {
                    (None, true) => start = Some(i),
                    (Some(s), false) => {
                        edges.push(WallEdge {
                            dir,
                            x0: xs[s],
                            y0: y,
                            x1: xs[i],
                            y1: y,
                            inset: false,
                        });
                        start = None;
                    }
                    _ => {}
                }
            }
        }
    }

    // Vertical faces: Left on a left edge, Right on a right edge, merged along y.
    for i in 0..nx {
        for (dir, test_right) in [(EdgeDir::Left, false), (EdgeDir::Right, true)] {
            let x = if test_right { xs[i + 1] } else { xs[i] };
            let mut start: Option<usize> = None;
            for j in 0..=ny {
                let on = j < ny
                    && cell(j, i)
                    && if test_right {
                        i + 1 >= nx || !cell(j, i + 1)
                    } else {
                        i == 0 || !cell(j, i - 1)
                    };
                match (start, on) {
                    (None, true) => start = Some(j),
                    (Some(s), false) => {
                        edges.push(WallEdge {
                            dir,
                            x0: x,
                            y0: ys[s],
                            x1: x,
                            y1: ys[j],
                            inset: false,
                        });
                        start = None;
                    }
                    _ => {}
                }
            }
        }
    }

    let corners = miter_corners(&edges);
    WallPlan { edges, corners }
}

// At every vertex where a horizontal and a vertical face meet, fill the square
// on the wall side of both. Convex corners already overlap there; concave
// corners (and T-junctions) leave a gap, which these fill.
fn miter_corners(edges: &[WallEdge]) -> Vec<WallCorner> {
    let horizontal = |d: EdgeDir| matches!(d, EdgeDir::Up | EdgeDir::Down);
    let mut corners = Vec::new();
    for h in edges.iter().filter(|e| horizontal(e.dir)) {
        let sy = if h.dir == EdgeDir::Up { 1.0 } else { -1.0 };
        for (px, py) in [(h.x0, h.y0), (h.x1, h.y1)] {
            for v in edges.iter().filter(|e| !horizontal(e.dir)) {
                if v.x0 != px {
                    continue;
                }
                let (vy0, vy1) = (v.y0.min(v.y1), v.y0.max(v.y1));
                if py < vy0 || py > vy1 {
                    continue;
                }
                let sx = if v.dir == EdgeDir::Left { 1.0 } else { -1.0 };
                corners.push(WallCorner {
                    x: px,
                    y: py,
                    sx,
                    sy,
                    inset: false,
                });
            }
        }
    }
    // A vertical face can also dead-end onto a horizontal face's interior.
    for v in edges.iter().filter(|e| !horizontal(e.dir)) {
        let sx = if v.dir == EdgeDir::Left { 1.0 } else { -1.0 };
        for (px, py) in [(v.x0, v.y0), (v.x1, v.y1)] {
            for h in edges.iter().filter(|e| horizontal(e.dir)) {
                if h.y0 != py {
                    continue;
                }
                let (hx0, hx1) = (h.x0.min(h.x1), h.x0.max(h.x1));
                if px < hx0 || px > hx1 {
                    continue;
                }
                let sy = if h.dir == EdgeDir::Up { 1.0 } else { -1.0 };
                corners.push(WallCorner {
                    x: px,
                    y: py,
                    sx,
                    sy,
                    inset: false,
                });
            }
        }
    }
    corners.sort_by(|a, b| {
        (a.x, a.y, a.sx, a.sy)
            .partial_cmp(&(b.x, b.y, b.sx, b.sy))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    corners.dedup();
    corners
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{Floor, WallOp, FLOOR1_INDEX, ROOM_WALL_PX};

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }
    fn add(r: Rect) -> WallOp {
        WallOp {
            mode: BoolOp::Add,
            rect: r,
        }
    }
    fn sub(r: Rect) -> WallOp {
        WallOp {
            mode: BoolOp::Sub,
            rect: r,
        }
    }
    fn ops(ws: &[WallOp]) -> Vec<(BoolOp, Rect)> {
        ws.iter().map(|w| (w.mode, w.rect)).collect()
    }

    fn count(edges: &[WallEdge], dir: EdgeDir) -> usize {
        edges.iter().filter(|e| e.dir == dir).count()
    }

    #[test]
    fn a_room_draws_two_parallel_lines() {
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(add(rect(0.0, 0.0, 200.0, 120.0)));
        let plan = wall_plan(&floor);
        // Outer contour plus the inset (room) contour.
        assert_eq!(plan.edges.len(), 8);
        assert_eq!(count(&plan.edges, EdgeDir::Up), 2);
        let mut ys: Vec<(f32, bool)> = plan
            .edges
            .iter()
            .filter(|e| matches!(e.dir, EdgeDir::Up | EdgeDir::Down))
            .map(|e| (e.y0, e.inset))
            .collect();
        ys.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        ys.dedup();
        // Outer lines at the rect edges (bright); inner lines inset by the band
        // (dim).
        assert_eq!(
            ys,
            vec![
                (0.0, false),
                (ROOM_WALL_PX, true),
                (120.0 - ROOM_WALL_PX, true),
                (120.0, false),
            ]
        );
    }

    #[test]
    fn a_room_thinner_than_the_band_is_solid() {
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(add(rect(0.0, 0.0, 20.0, 100.0)));
        let plan = wall_plan(&floor);
        // No room floor, so the whole rect is wall: a single outline.
        assert_eq!(plan.edges.len(), 4);
        assert_eq!(plan.corners.len(), 4);
    }

    #[test]
    fn overlapping_rooms_merge_without_an_internal_wall() {
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(add(rect(0.0, 0.0, 200.0, 200.0)));
        floor.walls.push(add(rect(150.0, 50.0, 200.0, 100.0)));
        let plan = wall_plan(&floor);
        // The second room's left edge falls inside the first: no wall there.
        let internal = plan
            .edges
            .iter()
            .any(|e| matches!(e.dir, EdgeDir::Left | EdgeDir::Right) && e.x0 == 150.0);
        assert!(
            !internal,
            "overlapping rooms must not leave an internal wall"
        );
    }

    #[test]
    fn union_boundary_drops_shared_and_internal_edges() {
        // Two abutting bars -> one outline (the low-level boolean still unions).
        let plan = boundary(&ops(&[
            add(rect(0.0, 0.0, 100.0, 40.0)),
            add(rect(100.0, 0.0, 100.0, 40.0)),
        ]));
        assert_eq!(plan.edges.len(), 4);
        assert_eq!(count(&plan.edges, EdgeDir::Up), 1);
        assert_eq!(plan.corners.len(), 4);

        // Overlapping bars union the same way.
        let plan = boundary(&ops(&[
            add(rect(0.0, 0.0, 100.0, 40.0)),
            add(rect(50.0, 0.0, 100.0, 40.0)),
        ]));
        assert_eq!(plan.edges.len(), 4);
    }

    #[test]
    fn sub_carves_a_hole() {
        let plan = boundary(&ops(&[
            add(rect(0.0, 0.0, 100.0, 100.0)),
            sub(rect(40.0, 40.0, 20.0, 20.0)),
        ]));
        // Outer boundary (4) plus the four faces of the hole.
        assert_eq!(plan.edges.len(), 8);
        assert_eq!(count(&plan.edges, EdgeDir::Up), 2);
        assert_eq!(plan.corners.len(), 8);
    }

    #[test]
    fn a_sub_room_carve_keeps_the_remaining_wall() {
        // A room with a Sub carved out of one edge: the band gains an opening.
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(add(rect(0.0, 0.0, 200.0, 200.0)));
        floor.walls.push(sub(rect(80.0, -10.0, 40.0, 40.0)));
        let plan = wall_plan(&floor);
        // Still an outer and inner contour, now with extra faces round the gap.
        assert!(plan.edges.len() > 8);
    }
}
