//! Editable map scene: the vector source of truth for the Sokol map.
//!
//! A [`Scene`] is a fixed set of floors, each authored from vector objects.
//! `native/src/bake.rs` turns a scene into the binary assets the running map
//! consumes; `scene.bin` is the committed, editable source.
//!
//! `scene.bin` layout (all little-endian):
//!
//! ```text
//! magic  "IRSC"
//! u16    version
//! u8     floor_count
//! u8     reserved
//! floor*:
//!   f32  frame x, y, w, h
//!   u32  wall_count     -> { u8 mode, f32 x, y, w, h }
//!   u32  obstacle_count -> { u32 id, f32 cx, cy, sx, sy, rot }
//!   u32  door_count     -> { u32 id, u8 kind, f32 cx, cy, sx, sy, rot }
//!   u32  stair_count    -> { u32 id, f32 x, y }
//!   u32  item_count     -> { u32 id, u8 kind, f32 x, y, [f32 rot], u16 name_len, name }
//!   u32  label_count    -> { f32 x, y, u16 name_len, name }             (v4)
//!   u32  region_count   -> { u32 id, u16 name_len, name, f32 x, y, w, h, u8 initial } (v5)
//!   u32  trigger_count  -> { u32 id, f32 x, y, w, h }                   (v5)
//!   u32  link_count     -> { u8 kind, u8 a_floor, u32 a_id, u8 b_floor, u32 b_id }
//! ```

/// Floor index order used everywhere: 0 = Floor 3, 1 = Floor 2, 2 = Floor 1.
pub const NUM_FLOORS: usize = 3;
pub const FLOOR1_INDEX: usize = 2;

/// Source-composite pixel frame `(x, y, width, height)` for each floor.
pub type Frame = (f32, f32, f32, f32);
pub const FLOOR_FRAMES: [Frame; NUM_FLOORS] = [
    (1600.0, 0.0, 4750.0, 1536.0),    // Floor 3
    (1600.0, 1500.0, 4750.0, 2240.0), // Floor 2
    (1600.0, 3420.0, 4750.0, 2730.0), // Floor 1
];
pub const FLOOR1_FRAME: Frame = FLOOR_FRAMES[FLOOR1_INDEX];
pub const FLOOR1_X: f32 = FLOOR_FRAMES[FLOOR1_INDEX].0;
pub const FLOOR1_Y: f32 = FLOOR_FRAMES[FLOOR1_INDEX].1;
pub const FLOOR1_W: f32 = FLOOR_FRAMES[FLOOR1_INDEX].2;
pub const FLOOR1_H: f32 = FLOOR_FRAMES[FLOOR1_INDEX].3;

const MAGIC: &[u8; 4] = b"IRSC";
/// v1 stored doors without `reveals_as`; v2 adds it; v3 adds interior-wall
/// partitions; v4 adds room name labels; v5 adds fog-of-war regions, reveal
/// triggers and their links; v6 adds item rotation (the Player spawn facing).
/// Reading still accepts v1-v5.
pub const VERSION: u16 = 6;

/// Thickness in source pixels of the wall band drawn inside each room rectangle
/// (the gap between the two parallel lines).
pub const ROOM_WALL_PX: f32 = 20.0;

/// A door prop is a fixed-size rectangle: 62x22 reference px over a ~16px band,
/// i.e. 3.875 x 1.375 of the wall band.
pub const DOOR_LONG_PX: f32 = ROOM_WALL_PX * 3.875;
pub const DOOR_THICK_PX: f32 = ROOM_WALL_PX * 1.375;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BoolOp {
    Add,
    Sub,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DoorKind {
    Locked,
    Unlocked,
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ItemKind {
    Key,
    InkRibbon,
    /// A fixed interactable (save point), not collected on touch.
    Typewriter,
    /// A fixed interactable that opens the item box, not collected on touch.
    ItemBox,
    /// The player's initial spawn marker; not a real item.
    Player,
}

impl ItemKind {
    pub fn to_u8(self) -> u8 {
        match self {
            ItemKind::Key => 0,
            ItemKind::InkRibbon => 1,
            ItemKind::Typewriter => 2,
            ItemKind::ItemBox => 3,
            ItemKind::Player => 4,
        }
    }

    pub fn from_u8(v: u8) -> Option<ItemKind> {
        match v {
            0 => Some(ItemKind::Key),
            1 => Some(ItemKind::InkRibbon),
            2 => Some(ItemKind::Typewriter),
            3 => Some(ItemKind::ItemBox),
            4 => Some(ItemKind::Player),
            _ => None,
        }
    }

    /// Whether touching this item picks it up.
    pub fn is_collectible(self) -> bool {
        matches!(self, ItemKind::Key | ItemKind::InkRibbon)
    }

    /// Whether this is a real item (as opposed to an editor-only marker).
    pub fn is_baked(self) -> bool {
        !matches!(self, ItemKind::Player)
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct WallOp {
    pub mode: BoolOp,
    pub rect: Rect,
}

/// A transformable box: centre, size and rotation (radians).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Box2 {
    pub id: u32,
    pub center: (f32, f32),
    pub size: (f32, f32),
    pub rot: f32,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Door {
    pub id: u32,
    pub kind: DoorKind,
    /// What an `Unknown` door becomes when the player gets close. Ignored for
    /// doors that are already Locked/Unlocked.
    pub reveals_as: DoorKind,
    pub center: (f32, f32),
    pub size: (f32, f32),
    pub rot: f32,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct StairNode {
    pub id: u32,
    pub pos: (f32, f32),
}

#[derive(Clone, PartialEq, Debug)]
pub struct ItemDef {
    pub id: u32,
    pub kind: ItemKind,
    pub name: String,
    pub pos: (f32, f32),
    /// Facing (radians) for items that show a direction; only the Player spawn
    /// marker uses it today. 0 = up.
    pub rot: f32,
}

/// A room name label (v4): centred text at a source position.
#[derive(Clone, PartialEq, Debug)]
pub struct RoomLabel {
    pub name: String,
    pub pos: (f32, f32),
}

/// Visibility of a fog-of-war region. `Visited` is runtime-only; an authored
/// region starts `Hidden` or `Revealed`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RegionState {
    Hidden,
    Revealed,
    Visited,
}

impl RegionState {
    pub fn to_u8(self) -> u8 {
        match self {
            RegionState::Hidden => 0,
            RegionState::Revealed => 1,
            RegionState::Visited => 2,
        }
    }

    pub fn from_u8(v: u8) -> Option<RegionState> {
        match v {
            0 => Some(RegionState::Hidden),
            1 => Some(RegionState::Revealed),
            2 => Some(RegionState::Visited),
            _ => None,
        }
    }
}

/// A fog-of-war region (v5): a rectangle that owns the geometry whose centre it
/// contains (smallest region wins). Hidden regions are neither drawn nor
/// walkable until revealed.
#[derive(Clone, PartialEq, Debug)]
pub struct Region {
    pub id: u32,
    pub name: String,
    pub rect: Rect,
    pub initial: RegionState,
}

/// A reveal trigger (v5): stepping inside the rectangle fires it (once), which
/// reveals any region it is linked to.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Trigger {
    pub id: u32,
    pub rect: Rect,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Link {
    /// Two stair endpoints on (possibly) different floors.
    Stair {
        a_floor: u8,
        a_id: u32,
        b_floor: u8,
        b_id: u32,
    },
    /// A key item that opens one or more doors (metadata only for now).
    KeyDoor {
        item_floor: u8,
        item_id: u32,
        door_floor: u8,
        door_id: u32,
    },
    /// Revealing/unlocking a door reveals a region.
    DoorRegion {
        door_floor: u8,
        door_id: u32,
        region_floor: u8,
        region_id: u32,
    },
    /// Touching a trigger reveals a region.
    TriggerRegion {
        trigger_floor: u8,
        trigger_id: u32,
        region_floor: u8,
        region_id: u32,
    },
    /// Picking up an item reveals a region.
    ItemRegion {
        item_floor: u8,
        item_id: u32,
        region_floor: u8,
        region_id: u32,
    },
}

#[derive(Clone, PartialEq, Debug)]
pub struct Floor {
    pub frame: Frame,
    pub walls: Vec<WallOp>,
    /// Interior-wall partitions (v3): walls placed inside rooms. Rendered dim on
    /// both lines and blocking, unlike room walls.
    pub partitions: Vec<WallOp>,
    pub obstacles: Vec<Box2>,
    pub doors: Vec<Door>,
    pub stairs: Vec<StairNode>,
    pub items: Vec<ItemDef>,
    /// Room name labels (v4).
    pub labels: Vec<RoomLabel>,
    /// Fog-of-war regions (v5).
    pub regions: Vec<Region>,
    /// Reveal triggers (v5).
    pub triggers: Vec<Trigger>,
    pub links: Vec<Link>,
}

impl Floor {
    pub fn new(index: usize) -> Floor {
        Floor {
            frame: FLOOR_FRAMES[index],
            walls: Vec::new(),
            partitions: Vec::new(),
            obstacles: Vec::new(),
            doors: Vec::new(),
            stairs: Vec::new(),
            items: Vec::new(),
            labels: Vec::new(),
            regions: Vec::new(),
            triggers: Vec::new(),
            links: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.walls.is_empty()
            && self.partitions.is_empty()
            && self.obstacles.is_empty()
            && self.doors.is_empty()
            && self.stairs.is_empty()
            && self.items.is_empty()
            && self.labels.is_empty()
            && self.regions.is_empty()
            && self.triggers.is_empty()
    }

    /// The partition ops, as the same ordered `Add`/`Sub` boolean as rooms.
    pub fn partition_ops(&self) -> Vec<(BoolOp, Rect)> {
        self.partitions
            .iter()
            .map(|w| (w.mode, clamp_rect(w.rect, self.frame)))
            .collect()
    }

    /// A drawn rectangle is a room. Rooms union, so overlapping rectangles merge
    /// into one space with no internal wall. The wall band is the outer boundary
    /// of that union minus its inset ([`interior_ops`]).
    pub fn wall_ops(&self) -> Vec<(BoolOp, Rect)> {
        self.walls
            .iter()
            .map(|w| (w.mode, clamp_rect(w.rect, self.frame)))
            .collect()
    }

    /// The walkable interior: the room union eroded by the wall band. Erosion
    /// distributes over union, so each `Add` room shrinks and each `Sub` grows.
    pub fn interior_ops(&self) -> Vec<(BoolOp, Rect)> {
        self.walls
            .iter()
            .filter_map(|w| {
                let off = if w.mode == BoolOp::Add {
                    ROOM_WALL_PX
                } else {
                    -ROOM_WALL_PX
                };
                let r = inset_rect(clamp_rect(w.rect, self.frame), off);
                (r.w > 0.0 && r.h > 0.0).then_some((w.mode, r))
            })
            .collect()
    }
}

// Clamp a rectangle to the floor frame. A room that crosses the crop edge would
// otherwise have its wall band outside the baked grid, leaving its interior open
// to the exterior flood (non-walkable). Clamping makes the frame edge act as the
// wall there.
fn clamp_rect(r: Rect, frame: Frame) -> Rect {
    let x0 = r.x.max(frame.0);
    let y0 = r.y.max(frame.1);
    let x1 = (r.x + r.w).min(frame.0 + frame.2);
    let y1 = (r.y + r.h).min(frame.1 + frame.3);
    Rect {
        x: x0,
        y: y0,
        w: (x1 - x0).max(0.0),
        h: (y1 - y0).max(0.0),
    }
}

fn inset_rect(r: Rect, t: f32) -> Rect {
    Rect {
        x: r.x + t,
        y: r.y + t,
        w: r.w - 2.0 * t,
        h: r.h - 2.0 * t,
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct Scene {
    pub version: u16,
    pub floors: [Floor; NUM_FLOORS],
}

impl Default for Scene {
    fn default() -> Scene {
        Scene {
            version: VERSION,
            floors: std::array::from_fn(Floor::new),
        }
    }
}

impl Scene {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        // Always write the current format version, even for a scene loaded from
        // an older one, so the bytes match what we emit below.
        put_u16(&mut out, VERSION);
        put_u8(&mut out, NUM_FLOORS as u8);
        put_u8(&mut out, 0);
        for floor in &self.floors {
            for v in [floor.frame.0, floor.frame.1, floor.frame.2, floor.frame.3] {
                put_f32(&mut out, v);
            }
            put_u32(&mut out, floor.walls.len() as u32);
            for w in &floor.walls {
                put_u8(
                    &mut out,
                    match w.mode {
                        BoolOp::Add => 0,
                        BoolOp::Sub => 1,
                    },
                );
                for v in [w.rect.x, w.rect.y, w.rect.w, w.rect.h] {
                    put_f32(&mut out, v);
                }
            }
            put_u32(&mut out, floor.partitions.len() as u32);
            for w in &floor.partitions {
                put_u8(
                    &mut out,
                    match w.mode {
                        BoolOp::Add => 0,
                        BoolOp::Sub => 1,
                    },
                );
                for v in [w.rect.x, w.rect.y, w.rect.w, w.rect.h] {
                    put_f32(&mut out, v);
                }
            }
            put_u32(&mut out, floor.obstacles.len() as u32);
            for o in &floor.obstacles {
                put_u32(&mut out, o.id);
                for v in [o.center.0, o.center.1, o.size.0, o.size.1, o.rot] {
                    put_f32(&mut out, v);
                }
            }
            put_u32(&mut out, floor.doors.len() as u32);
            for d in &floor.doors {
                put_u32(&mut out, d.id);
                put_u8(
                    &mut out,
                    match d.kind {
                        DoorKind::Locked => 0,
                        DoorKind::Unlocked => 1,
                        DoorKind::Unknown => 2,
                    },
                );
                put_u8(
                    &mut out,
                    match d.reveals_as {
                        DoorKind::Locked => 0,
                        DoorKind::Unlocked => 1,
                        DoorKind::Unknown => 2,
                    },
                );
                for v in [d.center.0, d.center.1, d.size.0, d.size.1, d.rot] {
                    put_f32(&mut out, v);
                }
            }
            put_u32(&mut out, floor.stairs.len() as u32);
            for s in &floor.stairs {
                put_u32(&mut out, s.id);
                put_f32(&mut out, s.pos.0);
                put_f32(&mut out, s.pos.1);
            }
            put_u32(&mut out, floor.items.len() as u32);
            for it in &floor.items {
                put_u32(&mut out, it.id);
                put_u8(&mut out, it.kind.to_u8());
                put_f32(&mut out, it.pos.0);
                put_f32(&mut out, it.pos.1);
                put_f32(&mut out, it.rot);
                let name = it.name.as_bytes();
                put_u16(&mut out, name.len().min(u16::MAX as usize) as u16);
                out.extend_from_slice(&name[..name.len().min(u16::MAX as usize)]);
            }
            put_u32(&mut out, floor.labels.len() as u32);
            for l in &floor.labels {
                put_f32(&mut out, l.pos.0);
                put_f32(&mut out, l.pos.1);
                let name = l.name.as_bytes();
                put_u16(&mut out, name.len().min(u16::MAX as usize) as u16);
                out.extend_from_slice(&name[..name.len().min(u16::MAX as usize)]);
            }
            put_u32(&mut out, floor.regions.len() as u32);
            for r in &floor.regions {
                put_u32(&mut out, r.id);
                let name = r.name.as_bytes();
                put_u16(&mut out, name.len().min(u16::MAX as usize) as u16);
                out.extend_from_slice(&name[..name.len().min(u16::MAX as usize)]);
                for v in [r.rect.x, r.rect.y, r.rect.w, r.rect.h] {
                    put_f32(&mut out, v);
                }
                put_u8(&mut out, r.initial.to_u8());
            }
            put_u32(&mut out, floor.triggers.len() as u32);
            for t in &floor.triggers {
                put_u32(&mut out, t.id);
                for v in [t.rect.x, t.rect.y, t.rect.w, t.rect.h] {
                    put_f32(&mut out, v);
                }
            }
            put_u32(&mut out, floor.links.len() as u32);
            for link in &floor.links {
                match *link {
                    Link::Stair {
                        a_floor,
                        a_id,
                        b_floor,
                        b_id,
                    } => {
                        put_u8(&mut out, 0);
                        put_u8(&mut out, a_floor);
                        put_u32(&mut out, a_id);
                        put_u8(&mut out, b_floor);
                        put_u32(&mut out, b_id);
                    }
                    Link::KeyDoor {
                        item_floor,
                        item_id,
                        door_floor,
                        door_id,
                    } => {
                        put_u8(&mut out, 1);
                        put_u8(&mut out, item_floor);
                        put_u32(&mut out, item_id);
                        put_u8(&mut out, door_floor);
                        put_u32(&mut out, door_id);
                    }
                    Link::DoorRegion {
                        door_floor,
                        door_id,
                        region_floor,
                        region_id,
                    } => {
                        put_u8(&mut out, 2);
                        put_u8(&mut out, door_floor);
                        put_u32(&mut out, door_id);
                        put_u8(&mut out, region_floor);
                        put_u32(&mut out, region_id);
                    }
                    Link::TriggerRegion {
                        trigger_floor,
                        trigger_id,
                        region_floor,
                        region_id,
                    } => {
                        put_u8(&mut out, 3);
                        put_u8(&mut out, trigger_floor);
                        put_u32(&mut out, trigger_id);
                        put_u8(&mut out, region_floor);
                        put_u32(&mut out, region_id);
                    }
                    Link::ItemRegion {
                        item_floor,
                        item_id,
                        region_floor,
                        region_id,
                    } => {
                        put_u8(&mut out, 4);
                        put_u8(&mut out, item_floor);
                        put_u32(&mut out, item_id);
                        put_u8(&mut out, region_floor);
                        put_u32(&mut out, region_id);
                    }
                }
            }
        }
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<Scene> {
        let mut c = Cursor { bytes, pos: 0 };
        if c.take(4)? != MAGIC {
            return None;
        }
        let version = c.u16()?;
        let floor_count = c.u8()? as usize;
        c.u8()?;
        if floor_count != NUM_FLOORS {
            return None;
        }
        let mut floors = std::array::from_fn(Floor::new);
        for floor in floors.iter_mut() {
            floor.frame = (c.f32()?, c.f32()?, c.f32()?, c.f32()?);
            let n = c.u32()? as usize;
            for _ in 0..n {
                let mode = match c.u8()? {
                    0 => BoolOp::Add,
                    1 => BoolOp::Sub,
                    _ => return None,
                };
                floor.walls.push(WallOp {
                    mode,
                    rect: Rect {
                        x: c.f32()?,
                        y: c.f32()?,
                        w: c.f32()?,
                        h: c.f32()?,
                    },
                });
            }
            // v3 added interior-wall partitions.
            if version >= 3 {
                let n = c.u32()? as usize;
                for _ in 0..n {
                    let mode = match c.u8()? {
                        0 => BoolOp::Add,
                        1 => BoolOp::Sub,
                        _ => return None,
                    };
                    floor.partitions.push(WallOp {
                        mode,
                        rect: Rect {
                            x: c.f32()?,
                            y: c.f32()?,
                            w: c.f32()?,
                            h: c.f32()?,
                        },
                    });
                }
            }
            let n = c.u32()? as usize;
            for _ in 0..n {
                floor.obstacles.push(Box2 {
                    id: c.u32()?,
                    center: (c.f32()?, c.f32()?),
                    size: (c.f32()?, c.f32()?),
                    rot: c.f32()?,
                });
            }
            let n = c.u32()? as usize;
            for _ in 0..n {
                let id = c.u32()?;
                let kind = match c.u8()? {
                    0 => DoorKind::Locked,
                    1 => DoorKind::Unlocked,
                    2 => DoorKind::Unknown,
                    _ => return None,
                };
                // v1 had no reveals_as; default it to Locked.
                let reveals_as = if version >= 3 {
                    match c.u8()? {
                        0 => DoorKind::Locked,
                        1 => DoorKind::Unlocked,
                        2 => DoorKind::Unknown,
                        _ => return None,
                    }
                } else {
                    DoorKind::Locked
                };
                floor.doors.push(Door {
                    id,
                    kind,
                    reveals_as,
                    center: (c.f32()?, c.f32()?),
                    size: (c.f32()?, c.f32()?),
                    rot: c.f32()?,
                });
            }
            let n = c.u32()? as usize;
            for _ in 0..n {
                floor.stairs.push(StairNode {
                    id: c.u32()?,
                    pos: (c.f32()?, c.f32()?),
                });
            }
            let n = c.u32()? as usize;
            for _ in 0..n {
                let id = c.u32()?;
                let kind = ItemKind::from_u8(c.u8()?)?;
                let pos = (c.f32()?, c.f32()?);
                // v6 added item rotation.
                let rot = if version >= 6 { c.f32()? } else { 0.0 };
                let len = c.u16()? as usize;
                let name = String::from_utf8_lossy(c.take(len)?).into_owned();
                floor.items.push(ItemDef {
                    id,
                    kind,
                    name,
                    pos,
                    rot,
                });
            }
            // v4 added room name labels.
            if version >= 4 {
                let n = c.u32()? as usize;
                for _ in 0..n {
                    let pos = (c.f32()?, c.f32()?);
                    let len = c.u16()? as usize;
                    let name = String::from_utf8_lossy(c.take(len)?).into_owned();
                    floor.labels.push(RoomLabel { name, pos });
                }
            }
            // v5 added fog-of-war regions and reveal triggers.
            if version >= 5 {
                let n = c.u32()? as usize;
                for _ in 0..n {
                    let id = c.u32()?;
                    let len = c.u16()? as usize;
                    let name = String::from_utf8_lossy(c.take(len)?).into_owned();
                    let rect = Rect {
                        x: c.f32()?,
                        y: c.f32()?,
                        w: c.f32()?,
                        h: c.f32()?,
                    };
                    let initial = RegionState::from_u8(c.u8()?)?;
                    floor.regions.push(Region {
                        id,
                        name,
                        rect,
                        initial,
                    });
                }
                let n = c.u32()? as usize;
                for _ in 0..n {
                    floor.triggers.push(Trigger {
                        id: c.u32()?,
                        rect: Rect {
                            x: c.f32()?,
                            y: c.f32()?,
                            w: c.f32()?,
                            h: c.f32()?,
                        },
                    });
                }
            }
            let n = c.u32()? as usize;
            for _ in 0..n {
                let kind = c.u8()?;
                let a_floor = c.u8()?;
                let a_id = c.u32()?;
                let b_floor = c.u8()?;
                let b_id = c.u32()?;
                floor.links.push(match kind {
                    0 => Link::Stair {
                        a_floor,
                        a_id,
                        b_floor,
                        b_id,
                    },
                    1 => Link::KeyDoor {
                        item_floor: a_floor,
                        item_id: a_id,
                        door_floor: b_floor,
                        door_id: b_id,
                    },
                    2 => Link::DoorRegion {
                        door_floor: a_floor,
                        door_id: a_id,
                        region_floor: b_floor,
                        region_id: b_id,
                    },
                    3 => Link::TriggerRegion {
                        trigger_floor: a_floor,
                        trigger_id: a_id,
                        region_floor: b_floor,
                        region_id: b_id,
                    },
                    4 => Link::ItemRegion {
                        item_floor: a_floor,
                        item_id: a_id,
                        region_floor: b_floor,
                        region_id: b_id,
                    },
                    _ => return None,
                });
            }
        }
        Some(Scene { version, floors })
    }
}

fn put_u8(out: &mut Vec<u8>, v: u8) {
    out.push(v);
}
fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let slice = self.bytes.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        let b = self.take(4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn f32(&mut self) -> Option<f32> {
        let b = self.take(4)?;
        Some(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_scene_round_trips() {
        let scene = Scene::default();
        let bytes = scene.to_bytes();
        assert_eq!(&bytes[..4], MAGIC);
        let back = Scene::from_bytes(&bytes).expect("decode");
        assert_eq!(back, scene);
        assert!(back.floors.iter().all(|f| f.is_empty()));
    }

    #[test]
    fn saving_always_writes_the_current_version() {
        // A scene loaded from an older file keeps that `version`; saving must
        // still emit the current format (the bytes always include partitions).
        let mut scene = Scene {
            version: 1,
            ..Scene::default()
        };
        scene.floors[FLOOR1_INDEX].partitions.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect {
                x: 10.0,
                y: 20.0,
                w: 30.0,
                h: 40.0,
            },
        });
        let bytes = scene.to_bytes();
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), VERSION);
        let back = Scene::from_bytes(&bytes).expect("decode");
        assert_eq!(
            back.floors[FLOOR1_INDEX].partitions,
            scene.floors[FLOOR1_INDEX].partitions
        );
    }

    #[test]
    fn populated_scene_round_trips() {
        let mut scene = Scene::default();
        let floor = &mut scene.floors[FLOOR1_INDEX];
        floor.walls.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect {
                x: 1600.0,
                y: 3420.0,
                w: 100.0,
                h: 40.0,
            },
        });
        floor.walls.push(WallOp {
            mode: BoolOp::Sub,
            rect: Rect {
                x: 1640.0,
                y: 3420.0,
                w: 20.0,
                h: 40.0,
            },
        });
        floor.partitions.push(WallOp {
            mode: BoolOp::Add,
            rect: Rect {
                x: 1700.0,
                y: 3420.0,
                w: 120.0,
                h: 20.0,
            },
        });
        floor.labels.push(RoomLabel {
            name: "Medication Room".into(),
            pos: (3504.0, 5145.0),
        });
        floor.regions.push(Region {
            id: 11,
            name: "Ward".into(),
            rect: Rect {
                x: 3400.0,
                y: 5000.0,
                w: 500.0,
                h: 400.0,
            },
            initial: RegionState::Hidden,
        });
        floor.triggers.push(Trigger {
            id: 12,
            rect: Rect {
                x: 3600.0,
                y: 5100.0,
                w: 80.0,
                h: 80.0,
            },
        });
        floor.obstacles.push(Box2 {
            id: 7,
            center: (2000.0, 4000.0),
            size: (64.0, 32.0),
            rot: 0.5,
        });
        floor.doors.push(Door {
            id: 3,
            kind: DoorKind::Locked,
            reveals_as: DoorKind::Unlocked,
            center: (2100.0, 4100.0),
            size: (48.0, 12.0),
            rot: 0.0,
        });
        floor.stairs.push(StairNode {
            id: 1,
            pos: (2719.0, 5210.0),
        });
        floor.items.push(ItemDef {
            id: 9,
            kind: ItemKind::Key,
            name: "West Keycard".into(),
            pos: (3554.0, 5196.0),
            rot: 0.5,
        });
        floor.links.push(Link::Stair {
            a_floor: 1,
            a_id: 1,
            b_floor: 2,
            b_id: 2,
        });
        floor.links.push(Link::KeyDoor {
            item_floor: 2,
            item_id: 9,
            door_floor: 2,
            door_id: 3,
        });
        floor.links.push(Link::DoorRegion {
            door_floor: 2,
            door_id: 3,
            region_floor: 2,
            region_id: 11,
        });
        floor.links.push(Link::TriggerRegion {
            trigger_floor: 2,
            trigger_id: 12,
            region_floor: 2,
            region_id: 11,
        });
        floor.links.push(Link::ItemRegion {
            item_floor: 2,
            item_id: 9,
            region_floor: 2,
            region_id: 11,
        });

        let bytes = scene.to_bytes();
        let back = Scene::from_bytes(&bytes).expect("decode");
        assert_eq!(back, scene);
    }

    #[test]
    fn v4_scene_has_no_regions_or_triggers() {
        // A version-4 payload stops after labels: the reader must not look for
        // regions/triggers.
        let mut b = Vec::new();
        b.extend_from_slice(MAGIC);
        put_u16(&mut b, 4);
        put_u8(&mut b, NUM_FLOORS as u8);
        put_u8(&mut b, 0);
        for &frame in FLOOR_FRAMES.iter() {
            for v in [frame.0, frame.1, frame.2, frame.3] {
                put_f32(&mut b, v);
            }
            put_u32(&mut b, 0); // walls
            put_u32(&mut b, 0); // partitions
            put_u32(&mut b, 0); // obstacles
            put_u32(&mut b, 0); // doors
            put_u32(&mut b, 0); // stairs
            put_u32(&mut b, 0); // items
            put_u32(&mut b, 0); // labels
            put_u32(&mut b, 0); // links
        }
        let scene = Scene::from_bytes(&b).expect("v4 should parse");
        assert_eq!(scene.version, 4);
        assert!(scene
            .floors
            .iter()
            .all(|f| f.regions.is_empty() && f.triggers.is_empty()));
    }

    #[test]
    fn rejects_bad_magic_and_truncation() {
        assert!(Scene::from_bytes(b"nope").is_none());
        let bytes = Scene::default().to_bytes();
        assert!(Scene::from_bytes(&bytes[..bytes.len() - 1]).is_none());
    }

    #[test]
    fn v1_scene_defaults_reveals_as_locked() {
        // Hand-build a version-1 scene with one door (no reveals_as byte).
        let mut b = Vec::new();
        b.extend_from_slice(MAGIC);
        put_u16(&mut b, 1);
        put_u8(&mut b, NUM_FLOORS as u8);
        put_u8(&mut b, 0);
        for (index, &frame) in FLOOR_FRAMES.iter().enumerate() {
            for v in [frame.0, frame.1, frame.2, frame.3] {
                put_f32(&mut b, v);
            }
            put_u32(&mut b, 0); // walls
            put_u32(&mut b, 0); // obstacles
            if index == FLOOR1_INDEX {
                put_u32(&mut b, 1); // doors
                put_u32(&mut b, 7); // id
                put_u8(&mut b, 0); // kind Locked
                for v in [100.0f32, 200.0, 10.0, 4.0, 0.0] {
                    put_f32(&mut b, v);
                }
            } else {
                put_u32(&mut b, 0);
            }
            put_u32(&mut b, 0); // stairs
            put_u32(&mut b, 0); // items
            put_u32(&mut b, 0); // links
        }
        let scene = Scene::from_bytes(&b).expect("v1 should parse");
        assert_eq!(scene.version, 1);
        let door = scene.floors[FLOOR1_INDEX].doors[0];
        assert_eq!(door.kind, DoorKind::Locked);
        assert_eq!(door.reveals_as, DoorKind::Locked);
    }
}
