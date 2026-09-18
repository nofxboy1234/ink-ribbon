//! Exact boundary extraction for the wall union.
//!
//! Walls are axis-aligned rectangles with an ordered `Add`/`Sub` boolean. The
//! map draws them as a floor-plan double line: a dim face on the up/left sides
//! and a bright face on the down/right sides, with internal edges (where quads
//! overlap or abut) removed. This module turns the boolean into that boundary.

use crate::scene::{BoolOp, Floor};

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
}

/// The exact boundary of the wall union as merged axis-aligned segments.
pub fn wall_edges(floor: &Floor) -> Vec<WallEdge> {
    // Coordinate compression: every rectangle edge becomes a grid line, so each
    // cell is uniformly inside or outside the union.
    let mut xs: Vec<f32> = Vec::new();
    let mut ys: Vec<f32> = Vec::new();
    for w in &floor.walls {
        xs.push(w.rect.x);
        xs.push(w.rect.x + w.rect.w);
        ys.push(w.rect.y);
        ys.push(w.rect.y + w.rect.h);
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    xs.dedup();
    ys.dedup();
    if xs.len() < 2 || ys.len() < 2 {
        return Vec::new();
    }
    let nx = xs.len() - 1;
    let ny = ys.len() - 1;

    let filled = |cx: f32, cy: f32| {
        let mut on = false;
        for w in &floor.walls {
            let r = w.rect;
            if cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h {
                on = w.mode == BoolOp::Add;
            }
        }
        on
    };

    let cell = |j: usize, i: usize| -> bool {
        let cx = (xs[i] + xs[i + 1]) * 0.5;
        let cy = (ys[j] + ys[j + 1]) * 0.5;
        filled(cx, cy)
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
                        });
                        start = None;
                    }
                    _ => {}
                }
            }
        }
    }

    edges
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{BoolOp, Floor, Rect, WallOp, FLOOR1_INDEX};

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

    fn count(edges: &[WallEdge], dir: EdgeDir) -> usize {
        edges.iter().filter(|e| e.dir == dir).count()
    }

    #[test]
    fn single_rect_has_four_faces() {
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(add(rect(0.0, 0.0, 100.0, 40.0)));
        let e = wall_edges(&floor);
        assert_eq!(e.len(), 4);
        assert_eq!(count(&e, EdgeDir::Up), 1);
        assert_eq!(count(&e, EdgeDir::Down), 1);
        assert_eq!(count(&e, EdgeDir::Left), 1);
        assert_eq!(count(&e, EdgeDir::Right), 1);
    }

    #[test]
    fn abutting_rects_drop_the_shared_edge() {
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(add(rect(0.0, 0.0, 100.0, 40.0)));
        floor.walls.push(add(rect(100.0, 0.0, 100.0, 40.0)));
        let e = wall_edges(&floor);
        // A 200x40 bar: two long faces plus two end caps.
        assert_eq!(e.len(), 4, "internal shared edge must be gone: {e:?}");
        assert_eq!(count(&e, EdgeDir::Up), 1);
        assert_eq!(count(&e, EdgeDir::Down), 1);
    }

    #[test]
    fn overlapping_rects_union_cleanly() {
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(add(rect(0.0, 0.0, 100.0, 40.0)));
        floor.walls.push(add(rect(50.0, 0.0, 100.0, 40.0)));
        let e = wall_edges(&floor);
        assert_eq!(e.len(), 4);
    }

    #[test]
    fn sub_carves_a_hole() {
        let mut floor = Floor::new(FLOOR1_INDEX);
        floor.walls.push(add(rect(0.0, 0.0, 100.0, 100.0)));
        floor.walls.push(sub(rect(40.0, 40.0, 20.0, 20.0)));
        let e = wall_edges(&floor);
        // Outer boundary (4) plus the four faces of the hole.
        assert_eq!(e.len(), 8, "hole boundary expected: {e:?}");
        assert_eq!(count(&e, EdgeDir::Up), 2);
        assert_eq!(count(&e, EdgeDir::Down), 2);
        assert_eq!(count(&e, EdgeDir::Left), 2);
        assert_eq!(count(&e, EdgeDir::Right), 2);
    }
}
