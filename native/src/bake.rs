//! Bake a [`Scene`] into the binary assets the running map consumes:
//! per-floor overlay RGBA + nav/nav-open/solid grids, plus `stairs.bin` and
//! `items.bin`.
//!
//! The nav algorithm mirrors the original `prepare-nav.py`: impassable geometry
//! (walls + obstacles + locked doors) is grown by a clearance, the exterior is
//! flood-filled, and only then are unlocked/unknown doors carved through.
//! Floors still marked `LegacyRaster` are copied from the supplied fallback.

use crate::raster::Mask;
use crate::scene::{BoolOp, DoorKind, Floor, FloorSource, Link, Scene, NUM_FLOORS};

pub const CELL_PX: u32 = 8;
pub const SOLID_CELL_PX: u32 = 2;
pub const CLEARANCE_CELLS: i32 = 2;
pub const DOOR_DILATION_CELLS: i32 = 1;
pub const OVERLAY_WIDTH: i32 = 2048;

pub const TINT_WALLS: (u8, u8, u8) = (92, 96, 96);
pub const TINT_STAIRS: (u8, u8, u8) = (120, 126, 126);
pub const TINT_OBSTACLES: (u8, u8, u8) = (58, 58, 58);
pub const TINT_LOCKED: (u8, u8, u8) = (160, 68, 87);
pub const TINT_UNKNOWN: (u8, u8, u8) = (106, 106, 106);
pub const TINT_UNLOCKED: (u8, u8, u8) = (78, 160, 170);

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct OverlayBytes {
    pub rgba: Vec<u8>,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BakedBytes {
    pub overlays: [OverlayBytes; NUM_FLOORS],
    pub nav: [Vec<u8>; NUM_FLOORS],
    pub nav_open: [Vec<u8>; NUM_FLOORS],
    pub solid: [Vec<u8>; NUM_FLOORS],
    pub stairs: Vec<u8>,
    pub items: Vec<u8>,
}

/// Bake `scene`, copying `fallback` for any floor that is still legacy raster
/// and for stairs/items when the scene defines none.
pub fn bake(scene: &Scene, fallback: &BakedBytes) -> BakedBytes {
    let mut out = fallback.clone();
    for (index, floor) in scene.floors.iter().enumerate() {
        if floor.source == FloorSource::Vector {
            bake_floor(floor, index, &mut out);
        }
    }
    if let Some(stairs) = bake_stairs(scene) {
        out.stairs = stairs;
    }
    if let Some(items) = bake_items(scene) {
        out.items = items;
    }
    out
}

fn bake_floor(floor: &Floor, index: usize, out: &mut BakedBytes) {
    let (fx, fy, fw, fh) = floor.frame;

    let w = (fw / CELL_PX as f32).round() as i32;
    let h = (fh / CELL_PX as f32).round() as i32;
    let sx = w as f32 / fw;
    let sy = h as f32 / fh;

    let mut walls = Mask::new(w, h);
    for op in &floor.walls {
        let on = op.mode == BoolOp::Add;
        walls.fill_rect(
            (op.rect.x - fx) * sx,
            (op.rect.y - fy) * sy,
            op.rect.w * sx,
            op.rect.h * sy,
            on,
        );
    }

    let mut obstacles = Mask::new(w, h);
    for o in &floor.obstacles {
        obstacles.fill_box(
            (o.center.0 - fx) * sx,
            (o.center.1 - fy) * sy,
            o.size.0 * sx,
            o.size.1 * sy,
            o.rot,
            true,
        );
    }

    let (mut locked, mut unlocked, mut unknown) =
        (Mask::new(w, h), Mask::new(w, h), Mask::new(w, h));
    for d in &floor.doors {
        let target = match d.kind {
            DoorKind::Locked => &mut locked,
            DoorKind::Unlocked => &mut unlocked,
            DoorKind::Unknown => &mut unknown,
        };
        target.fill_box(
            (d.center.0 - fx) * sx,
            (d.center.1 - fy) * sy,
            d.size.0 * sx,
            d.size.1 * sy,
            d.rot,
            true,
        );
    }

    // Doors are carved through, but only where there is no real geometry.
    let mut doors = or(&unlocked, &unknown).dilate(DOOR_DILATION_CELLS);
    for y in 0..h {
        for x in 0..w {
            if doors.get(x, y) && (walls.get(x, y) || obstacles.get(x, y) || locked.get(x, y)) {
                doors.set(x, y, false);
            }
        }
    }

    let walk = build_walk(&walls, &obstacles, &locked, &doors, true, w, h);
    let walk_open = build_walk(&walls, &obstacles, &locked, &doors, false, w, h);

    out.nav[index] = walk.to_bytes(CELL_PX);
    out.nav_open[index] = walk_open.to_bytes(CELL_PX);

    // Solid collision mask at 2px: walls + obstacles + locked doors, no padding.
    let sw = (fw / SOLID_CELL_PX as f32).round() as i32;
    let sh = (fh / SOLID_CELL_PX as f32).round() as i32;
    let (ssx, ssy) = (sw as f32 / fw, sh as f32 / fh);
    let mut solid = Mask::new(sw, sh);
    for op in &floor.walls {
        let on = op.mode == BoolOp::Add;
        solid.fill_rect(
            (op.rect.x - fx) * ssx,
            (op.rect.y - fy) * ssy,
            op.rect.w * ssx,
            op.rect.h * ssy,
            on,
        );
    }
    for o in &floor.obstacles {
        solid.fill_box(
            (o.center.0 - fx) * ssx,
            (o.center.1 - fy) * ssy,
            o.size.0 * ssx,
            o.size.1 * ssy,
            o.rot,
            true,
        );
    }
    for d in &floor.doors {
        if d.kind == DoorKind::Locked {
            solid.fill_box(
                (d.center.0 - fx) * ssx,
                (d.center.1 - fy) * ssy,
                d.size.0 * ssx,
                d.size.1 * ssy,
                d.rot,
                true,
            );
        }
    }
    out.solid[index] = solid.to_bytes(SOLID_CELL_PX);

    out.overlays[index] = bake_overlay(floor, fx, fy, fw, fh);
}

fn build_walk(
    walls: &Mask,
    obstacles: &Mask,
    locked: &Mask,
    doors: &Mask,
    include_locked: bool,
    w: i32,
    h: i32,
) -> Mask {
    let mut base = or(walls, obstacles);
    if include_locked {
        base = or(&base, locked);
    }
    let impassable = base.dilate(CLEARANCE_CELLS);
    let mut free = Mask::new(w, h);
    for y in 0..h {
        for x in 0..w {
            free.set(x, y, !impassable.get(x, y));
        }
    }
    let exterior = free.flood_from_border();
    let mut walk = Mask::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let inside = free.get(x, y) && !exterior.get(x, y);
            walk.set(x, y, inside || doors.get(x, y));
        }
    }
    walk
}

fn bake_overlay(floor: &Floor, fx: f32, fy: f32, fw: f32, fh: f32) -> OverlayBytes {
    let w = OVERLAY_WIDTH;
    let h = (fh * OVERLAY_WIDTH as f32 / fw).round() as i32;
    let sx = w as f32 / fw;
    let sy = h as f32 / fh;
    let mut canvas = vec![0u8; (w * h * 4) as usize];

    let mut walls = Mask::new(w, h);
    for op in &floor.walls {
        let on = op.mode == BoolOp::Add;
        walls.fill_rect(
            (op.rect.x - fx) * sx,
            (op.rect.y - fy) * sy,
            op.rect.w * sx,
            op.rect.h * sy,
            on,
        );
    }
    composite(&mut canvas, w, &walls, TINT_WALLS);

    let mut obstacles = Mask::new(w, h);
    for o in &floor.obstacles {
        obstacles.fill_box(
            (o.center.0 - fx) * sx,
            (o.center.1 - fy) * sy,
            o.size.0 * sx,
            o.size.1 * sy,
            o.rot,
            true,
        );
    }
    composite(&mut canvas, w, &obstacles, TINT_OBSTACLES);

    for (kind, tint) in [
        (DoorKind::Locked, TINT_LOCKED),
        (DoorKind::Unknown, TINT_UNKNOWN),
        (DoorKind::Unlocked, TINT_UNLOCKED),
    ] {
        let mut mask = Mask::new(w, h);
        for d in &floor.doors {
            if d.kind == kind {
                mask.fill_box(
                    (d.center.0 - fx) * sx,
                    (d.center.1 - fy) * sy,
                    d.size.0 * sx,
                    d.size.1 * sy,
                    d.rot,
                    true,
                );
            }
        }
        composite(&mut canvas, w, &mask, tint);
    }

    OverlayBytes { rgba: canvas, w, h }
}

fn composite(canvas: &mut [u8], w: i32, mask: &Mask, tint: (u8, u8, u8)) {
    for y in 0..mask.h {
        for x in 0..w {
            if mask.get(x, y) {
                let i = ((y * w + x) * 4) as usize;
                canvas[i] = tint.0;
                canvas[i + 1] = tint.1;
                canvas[i + 2] = tint.2;
                canvas[i + 3] = 255;
            }
        }
    }
}

fn or(a: &Mask, b: &Mask) -> Mask {
    let mut out = a.clone();
    out.or_with(b);
    out
}

fn find_stair(scene: &Scene, floor: usize, id: u32) -> Option<(f32, f32)> {
    scene
        .floors
        .get(floor)?
        .stairs
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.pos)
}

fn bake_stairs(scene: &Scene) -> Option<Vec<u8>> {
    let mut records = Vec::new();
    for floor in &scene.floors {
        for link in &floor.links {
            if let Link::Stair {
                a_floor,
                a_id,
                b_floor,
                b_id,
            } = *link
            {
                let a = find_stair(scene, a_floor as usize, a_id);
                let b = find_stair(scene, b_floor as usize, b_id);
                if let (Some(a), Some(b)) = (a, b) {
                    records.push((a_floor, b_floor, a, b));
                }
            }
        }
    }
    if records.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    for (a_floor, b_floor, a, b) in records {
        out.extend_from_slice(&(a_floor as u32).to_le_bytes());
        out.extend_from_slice(&(b_floor as u32).to_le_bytes());
        for v in [a.0, a.1, b.0, b.1] {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    Some(out)
}

fn bake_items(scene: &Scene) -> Option<Vec<u8>> {
    let mut records: Vec<(usize, &str, (f32, f32))> = Vec::new();
    for (index, floor) in scene.floors.iter().enumerate() {
        for item in &floor.items {
            records.push((index, item.name.as_str(), item.pos));
        }
    }
    if records.is_empty() {
        return None;
    }
    records.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    let mut out = Vec::new();
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    for (floor, name, pos) in records {
        let name = name.as_bytes();
        out.extend_from_slice(&(floor as u32).to_le_bytes());
        out.extend_from_slice(&pos.0.to_le_bytes());
        out.extend_from_slice(&pos.1.to_le_bytes());
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(name);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{Floor, FloorSource, Rect, WallOp};

    fn blank_fallback() -> BakedBytes {
        BakedBytes {
            overlays: std::array::from_fn(|_| OverlayBytes {
                rgba: vec![0; 4],
                w: 1,
                h: 1,
            }),
            nav: std::array::from_fn(|_| vec![0; 12]),
            nav_open: std::array::from_fn(|_| vec![0; 12]),
            solid: std::array::from_fn(|_| vec![0; 12]),
            stairs: vec![0, 0, 0, 0],
            items: vec![0, 0, 0, 0],
        }
    }

    #[test]
    fn legacy_floors_copy_the_fallback() {
        let scene = Scene::default();
        let fallback = blank_fallback();
        let baked = bake(&scene, &fallback);
        assert_eq!(baked, fallback);
    }

    #[test]
    fn a_wall_ring_leaves_a_walkable_interior() {
        // A hollow square wall in the middle of Floor 1.
        let mut scene = Scene::default();
        let mut floor = Floor::vector(crate::scene::FLOOR1_INDEX);
        floor.source = FloorSource::Vector;
        let (fx, fy, _, _) = crate::scene::FLOOR1_FRAME;
        let outer = Rect {
            x: fx + 2000.0,
            y: fy + 1000.0,
            w: 600.0,
            h: 600.0,
        };
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: outer,
        });
        floor.walls.push(WallOp {
            mode: BoolOp::Sub,
            rect: Rect {
                x: outer.x + 40.0,
                y: outer.y + 40.0,
                w: outer.w - 80.0,
                h: outer.h - 80.0,
            },
        });
        scene.floors[crate::scene::FLOOR1_INDEX] = floor;

        let baked = bake(&scene, &blank_fallback());
        let nav = &baked.nav[crate::scene::FLOOR1_INDEX];
        let w = u32::from_le_bytes([nav[4], nav[5], nav[6], nav[7]]) as i32;
        let h = u32::from_le_bytes([nav[8], nav[9], nav[10], nav[11]]) as i32;
        assert_eq!(w, 594);
        assert_eq!(h, 341);
        let bit = |x: i32, y: i32| {
            let i = (y * w + x) as usize;
            (nav[12 + (i >> 3)] >> (i & 7)) & 1 == 1
        };
        // Interior of the ring is walkable; the wall band and the outside are not.
        let interior = ((outer.x + 300.0 - fx) / 8.0, (outer.y + 300.0 - fy) / 8.0);
        assert!(
            bit(interior.0 as i32, interior.1 as i32),
            "ring interior should be walkable"
        );
        assert!(!bit(0, 0), "outside the building should be exterior");
    }
}
