//! Bake a [`Scene`] into the binary assets the running map consumes:
//! per-floor overlay RGBA + nav/nav-open/solid grids, plus `stairs.bin` and
//! `items.bin`.
//!
//! The nav algorithm: impassable geometry
//! (walls + obstacles + locked doors) is grown by a clearance, the exterior is
//! flood-filled, and only then are unlocked/unknown doors carved through.

use crate::raster::Mask;
use crate::scene::{
    BoolOp, DoorKind, Floor, ItemKind, Link, Scene, DOOR_LONG_PX, DOOR_THICK_PX, NUM_FLOORS,
};

pub const CELL_PX: u32 = 8;
pub const SOLID_CELL_PX: u32 = 2;
pub const CLEARANCE_CELLS: i32 = 2;
pub const DOOR_DILATION_CELLS: i32 = 1;
// Before the exterior flood-fill, the geometry is closed by this much so that
// doorways and corridor mouths don't let the "outside" leak into the rooms. The
// radius must exceed half the widest opening but stay under the gap to the map
// frame.
pub const SEAL_CELLS: i32 = 16;
pub const OVERLAY_WIDTH: i32 = 2048;

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

/// Bake every floor of `scene`, plus its stair links and items.
pub fn bake(scene: &Scene) -> BakedBytes {
    let mut out = BakedBytes {
        overlays: std::array::from_fn(|_| OverlayBytes {
            rgba: Vec::new(),
            w: 0,
            h: 0,
        }),
        nav: std::array::from_fn(|_| Vec::new()),
        nav_open: std::array::from_fn(|_| Vec::new()),
        solid: std::array::from_fn(|_| Vec::new()),
        stairs: bake_stairs(scene).unwrap_or_else(empty_bin),
        items: bake_items(scene).unwrap_or_else(empty_bin),
    };
    for (index, floor) in scene.floors.iter().enumerate() {
        bake_floor(floor, index, &mut out);
    }
    out
}

fn empty_bin() -> Vec<u8> {
    0u32.to_le_bytes().to_vec()
}

fn bake_floor(floor: &Floor, index: usize, out: &mut BakedBytes) {
    let (fx, fy, fw, fh) = floor.frame;

    let w = (fw / CELL_PX as f32).round() as i32;
    let h = (fh / CELL_PX as f32).round() as i32;
    let sx = w as f32 / fw;
    let sy = h as f32 / fh;

    let walls = wall_band_mask(floor, fx, fy, sx, sy, w, h);

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

    // Unknown doors block until revealed, so they join the locked mask; only
    // Locked/unknown doors block; unlocked doors are carved through.
    let mut locked = door_mask(floor, fx, fy, sx, sy, w, h, DoorKind::Locked);
    locked.or_with(&door_mask(floor, fx, fy, sx, sy, w, h, DoorKind::Unknown));
    let unlocked = door_mask(floor, fx, fy, sx, sy, w, h, DoorKind::Unlocked);

    // Unlocked doors are carved through, but only where there is no real geometry.
    let mut doors = unlocked.dilate(DOOR_DILATION_CELLS);
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
    let mut solid = wall_band_mask(floor, fx, fy, ssx, ssy, sw, sh);
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
        if matches!(d.kind, DoorKind::Locked | DoorKind::Unknown) {
            solid.fill_box(
                (d.center.0 - fx) * ssx,
                (d.center.1 - fy) * ssy,
                DOOR_LONG_PX * ssx,
                DOOR_THICK_PX * ssy,
                d.rot,
                true,
            );
        }
    }
    out.solid[index] = solid.to_bytes(SOLID_CELL_PX);

    out.overlays[index] = bake_overlay(floor, fx, fy, fw, fh);
}

/// The wall band: the room union (`Add` minus `Sub`) minus its eroded interior,
/// plus interior partitions. Unlocked doors cut an opening through it.
fn wall_band_mask(floor: &Floor, fx: f32, fy: f32, sx: f32, sy: f32, w: i32, h: i32) -> Mask {
    let fill = |mask: &mut Mask, ops: &[(BoolOp, crate::scene::Rect)]| {
        for (mode, r) in ops {
            mask.fill_rect(
                (r.x - fx) * sx,
                (r.y - fy) * sy,
                r.w * sx,
                r.h * sy,
                *mode == BoolOp::Add,
            );
        }
    };
    let mut walls = Mask::new(w, h);
    fill(&mut walls, &floor.wall_ops());
    let mut interior = Mask::new(w, h);
    fill(&mut interior, &floor.interior_ops());
    walls.subtract(&interior);
    // Interior partitions block their whole rect.
    let mut partitions = Mask::new(w, h);
    fill(&mut partitions, &floor.partition_ops());
    walls.or_with(&partitions);
    walls.subtract(&door_mask(floor, fx, fy, sx, sy, w, h, DoorKind::Unlocked));
    walls
}

/// The door prop rects of one kind, at the fixed prop size.
#[allow(clippy::too_many_arguments)]
fn door_mask(
    floor: &Floor,
    fx: f32,
    fy: f32,
    sx: f32,
    sy: f32,
    w: i32,
    h: i32,
    kind: DoorKind,
) -> Mask {
    let mut mask = Mask::new(w, h);
    for d in &floor.doors {
        if d.kind != kind {
            continue;
        }
        mask.fill_box(
            (d.center.0 - fx) * sx,
            (d.center.1 - fy) * sy,
            DOOR_LONG_PX * sx,
            DOOR_THICK_PX * sy,
            d.rot,
            true,
        );
    }
    mask
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
    let free = base.dilate(CLEARANCE_CELLS).not();
    // Close the wall network into a solid footprint before deciding what the
    // "outside" is, so the exterior flood can't leak through doorways or corridor
    // mouths into the rooms. Navigation still uses the unsealed `free`, so those
    // gaps stay walkable.
    let sealed = base.dilate(SEAL_CELLS).erode(SEAL_CELLS);
    let exterior = sealed.not().flood_from_border();
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

    // Walls are not baked: the app draws them as vector double-lines (see
    // native/src/walls.rs).
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

    // Doors are drawn as vector props (see the map example), not baked here.

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

#[allow(clippy::type_complexity)]
fn bake_items(scene: &Scene) -> Option<Vec<u8>> {
    // (floor, id, kind, name, pos); the id lets the runtime match a collected
    // item to its KeyDoor links, and the kind separates keys, ink-ribbons and
    // typewriters.
    let mut records: Vec<(usize, u32, ItemKind, &str, (f32, f32))> = Vec::new();
    for (index, floor) in scene.floors.iter().enumerate() {
        for item in &floor.items {
            records.push((index, item.id, item.kind, item.name.as_str(), item.pos));
        }
    }
    if records.is_empty() {
        return None;
    }
    records.sort_by_key(|r| (r.0, r.1));
    let mut out = Vec::new();
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    for (floor, id, kind, name, pos) in records {
        let name = name.as_bytes();
        out.extend_from_slice(&id.to_le_bytes());
        out.extend_from_slice(&(floor as u32).to_le_bytes());
        out.push(kind.to_u8());
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
    use crate::scene::{Door, Floor, Rect, WallOp};

    #[test]
    fn empty_scene_bakes_empty_assets() {
        let baked = bake(&Scene::default());
        for floor in 0..NUM_FLOORS {
            assert!(!baked.overlays[floor].rgba.is_empty());
            // A floor with no walls is entirely exterior -> nothing walkable.
            assert_eq!(
                u32::from_le_bytes([
                    baked.nav[floor][0],
                    baked.nav[floor][1],
                    baked.nav[floor][2],
                    baked.nav[floor][3]
                ]),
                CELL_PX
            );
        }
        assert_eq!(baked.stairs, vec![0, 0, 0, 0]);
        assert_eq!(baked.items, vec![0, 0, 0, 0]);
    }

    #[test]
    fn a_room_rectangle_is_walkable_inside() {
        // A drawn rectangle is a room: walkable floor inside its wall band.
        let mut scene = Scene::default();
        let mut floor = Floor::new(crate::scene::FLOOR1_INDEX);
        let (fx, fy, _, _) = crate::scene::FLOOR1_FRAME;
        let room = Rect {
            x: fx + 2000.0,
            y: fy + 1000.0,
            w: 600.0,
            h: 600.0,
        };
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: room,
        });
        scene.floors[crate::scene::FLOOR1_INDEX] = floor;

        let baked = bake(&scene);
        let nav = &baked.nav[crate::scene::FLOOR1_INDEX];
        let w = u32::from_le_bytes([nav[4], nav[5], nav[6], nav[7]]) as i32;
        let bit = |x: i32, y: i32| {
            let i = (y * w + x) as usize;
            (nav[12 + (i >> 3)] >> (i & 7)) & 1 == 1
        };
        let cell = |sx: f32, sy: f32| {
            (
                ((sx - fx) / CELL_PX as f32) as i32,
                ((sy - fy) / CELL_PX as f32) as i32,
            )
        };
        let (ix, iy) = cell(room.x + 300.0, room.y + 300.0);
        let (bx, by) = cell(room.x + 4.0, room.y + 300.0);
        // Inside is walkable; the band edge and the outside are not.
        assert!(bit(ix, iy), "room interior should be walkable");
        assert!(!bit(bx, by), "the wall band should not be walkable");
        assert!(!bit(0, 0), "outside the room should be exterior");
    }

    #[test]
    fn overlapping_rooms_are_one_walkable_space() {
        // A second room over the first's right edge merges with it.
        let mut scene = Scene::default();
        let mut floor = Floor::new(crate::scene::FLOOR1_INDEX);
        let (fx, fy, _, _) = crate::scene::FLOOR1_FRAME;
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect {
                x: fx + 2000.0,
                y: fy + 1000.0,
                w: 600.0,
                h: 600.0,
            },
        });
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect {
                x: fx + 2500.0,
                y: fy + 1200.0,
                w: 400.0,
                h: 200.0,
            },
        });
        scene.floors[crate::scene::FLOOR1_INDEX] = floor;

        let nav = &bake(&scene).nav[crate::scene::FLOOR1_INDEX];
        let w = u32::from_le_bytes([nav[4], nav[5], nav[6], nav[7]]) as i32;
        let bit = |sx: f32, sy: f32| {
            let x = ((sx - fx) / CELL_PX as f32) as i32;
            let y = ((sy - fy) / CELL_PX as f32) as i32;
            let i = (y * w + x) as usize;
            (nav[12 + (i >> 3)] >> (i & 7)) & 1 == 1
        };
        assert!(bit(fx + 2300.0, fy + 1300.0), "first room interior");
        assert!(bit(fx + 2700.0, fy + 1300.0), "second room interior");
        assert!(bit(fx + 2540.0, fy + 1300.0), "rooms should connect");
        assert!(!bit(fx + 2200.0, fy + 1010.0), "wall band");
    }

    #[test]
    fn a_rectangle_thinner_than_the_band_is_solid_wall() {
        // Too thin to hold a room floor, so it is just a wall: nothing walkable.
        let mut scene = Scene::default();
        let mut floor = Floor::new(crate::scene::FLOOR1_INDEX);
        let (fx, fy, _, _) = crate::scene::FLOOR1_FRAME;
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect {
                x: fx + 2000.0,
                y: fy + 1000.0,
                w: 400.0,
                h: 12.0,
            },
        });
        scene.floors[crate::scene::FLOOR1_INDEX] = floor;

        let nav = &bake(&scene).nav[crate::scene::FLOOR1_INDEX];
        let any = (12..nav.len()).any(|i| nav[i] != 0);
        assert!(
            !any,
            "a sub-band rectangle should not create walkable floor"
        );
    }

    #[test]
    fn an_unlocked_door_opens_the_wall_band() {
        let mut scene = Scene::default();
        let mut floor = Floor::new(crate::scene::FLOOR1_INDEX);
        let (fx, fy, fw, fh) = crate::scene::FLOOR1_FRAME;
        let room = Rect {
            x: fx + 2000.0,
            y: fy + 1000.0,
            w: 600.0,
            h: 600.0,
        };
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: room,
        });
        floor.doors.push(Door {
            id: 1,
            kind: DoorKind::Unlocked,
            reveals_as: DoorKind::Locked,
            center: (room.x + 300.0, room.y),
            size: (DOOR_LONG_PX, DOOR_THICK_PX),
            rot: 0.0,
        });
        scene.floors[crate::scene::FLOOR1_INDEX] = floor;

        let w = (fw / CELL_PX as f32).round() as i32;
        let h = (fh / CELL_PX as f32).round() as i32;
        let band = wall_band_mask(
            &scene.floors[crate::scene::FLOOR1_INDEX],
            fx,
            fy,
            w as f32 / fw,
            h as f32 / fh,
            w,
            h,
        );
        let at = |sx: f32, sy: f32| {
            band.get(
                ((sx - fx) / CELL_PX as f32) as i32,
                ((sy - fy) / CELL_PX as f32) as i32,
            )
        };
        assert!(
            !at(room.x + 300.0, room.y + 6.0),
            "unlocked door opens the band"
        );
        assert!(
            at(room.x + 30.0, room.y + 6.0),
            "wall away from the door stays solid"
        );
    }

    #[test]
    fn scene_links_bake_into_stairs_and_items() {
        use crate::scene::{ItemDef, ItemKind, Link, StairNode};
        let mut scene = Scene::default();
        let f1 = crate::scene::FLOOR1_INDEX;
        let f2 = 1;
        scene.floors[f1].stairs.push(StairNode {
            id: 1,
            pos: (100.0, 200.0),
        });
        scene.floors[f2].stairs.push(StairNode {
            id: 2,
            pos: (300.0, 400.0),
        });
        scene.floors[f1].links.push(Link::Stair {
            a_floor: f1 as u8,
            a_id: 1,
            b_floor: f2 as u8,
            b_id: 2,
        });
        scene.floors[f1].items.push(ItemDef {
            id: 5,
            kind: ItemKind::Key,
            name: "Key".into(),
            pos: (10.0, 20.0),
        });

        let baked = bake(&scene);
        assert_eq!(baked.stairs.len(), 4 + 24);
        assert_eq!(
            u32::from_le_bytes([
                baked.stairs[0],
                baked.stairs[1],
                baked.stairs[2],
                baked.stairs[3]
            ]),
            1
        );
        // record: id(4) floor(4) kind(1) x(4) y(4) name_len(4) + "Key"(3)
        assert_eq!(baked.items.len(), 4 + 4 + 4 + 1 + 4 + 4 + 4 + 3);
        assert_eq!(
            u32::from_le_bytes([
                baked.items[0],
                baked.items[1],
                baked.items[2],
                baked.items[3]
            ]),
            1
        );
        assert_eq!(
            u32::from_le_bytes([
                baked.items[4],
                baked.items[5],
                baked.items[6],
                baked.items[7]
            ]),
            5
        );
        assert_eq!(
            u32::from_le_bytes([
                baked.items[8],
                baked.items[9],
                baked.items[10],
                baked.items[11]
            ]),
            f1 as u32
        );
    }

    #[test]
    fn unknown_doors_block_until_revealed() {
        use crate::scene::{Door, DoorKind, FLOOR1_FRAME};
        let mut scene = Scene::default();
        let (fx, fy, _, _) = FLOOR1_FRAME;
        let f1 = crate::scene::FLOOR1_INDEX;
        scene.floors[f1].doors.push(Door {
            id: 1,
            kind: DoorKind::Unknown,
            reveals_as: DoorKind::Unlocked,
            center: (fx + 2000.0, fy + 1200.0),
            size: (80.0, 16.0),
            rot: 0.0,
        });
        let blocked = bake(&scene);
        let revealed = {
            let mut s = scene.clone();
            s.floors[f1].doors[0].kind = DoorKind::Unlocked;
            bake(&s)
        };

        let nav = &blocked.nav[f1];
        let w = u32::from_le_bytes([nav[4], nav[5], nav[6], nav[7]]) as i32;
        let walkable = |b: &[u8], x: i32, y: i32| {
            let i = (y * w + x) as usize;
            (b[12 + (i >> 3)] >> (i & 7)) & 1 == 1
        };
        let (cx, cy) = (((2000.0) / 8.0) as i32, ((1200.0) / 8.0) as i32);
        // Unresolved Unknown blocks; revealed-Unlocked is carved through.
        assert!(!walkable(nav, cx, cy), "unknown door should block");
        assert!(
            walkable(&revealed.nav[f1], cx, cy),
            "revealed unlocked door should be walkable"
        );
    }
}
