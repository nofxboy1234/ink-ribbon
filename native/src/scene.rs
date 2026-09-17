//! Editable map scene: the vector source of truth for the Sokol map.
//!
//! A [`Scene`] is a fixed set of floors, each either still backed by the legacy
//! baked raster (`FloorSource::LegacyRaster`) or fully authored from vector
//! objects (`FloorSource::Vector`). `native/src/bake.rs` turns a scene into the
//! binary assets the running map consumes.
//!
//! `scene.bin` layout (all little-endian):
//!
//! ```text
//! magic  "IRSC"
//! u16    version
//! u8     floor_count
//! u8     reserved
//! floor*:
//!   u8   source (0 = legacy raster, 1 = vector)
//!   f32  frame x, y, w, h
//!   u32  wall_count     -> { u8 mode, f32 x, y, w, h }
//!   u32  obstacle_count -> { u32 id, f32 cx, cy, sx, sy, rot }
//!   u32  door_count     -> { u32 id, u8 kind, f32 cx, cy, sx, sy, rot }
//!   u32  stair_count    -> { u32 id, f32 x, y }
//!   u32  item_count     -> { u32 id, u8 kind, f32 x, y, u16 name_len, name }
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
pub const VERSION: u16 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FloorSource {
    LegacyRaster,
    Vector,
}

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
}

#[derive(Clone, PartialEq, Debug)]
pub struct Floor {
    pub source: FloorSource,
    pub frame: Frame,
    pub walls: Vec<WallOp>,
    pub obstacles: Vec<Box2>,
    pub doors: Vec<Door>,
    pub stairs: Vec<StairNode>,
    pub items: Vec<ItemDef>,
    pub links: Vec<Link>,
}

impl Floor {
    pub fn legacy(index: usize) -> Floor {
        Floor {
            source: FloorSource::LegacyRaster,
            frame: FLOOR_FRAMES[index],
            walls: Vec::new(),
            obstacles: Vec::new(),
            doors: Vec::new(),
            stairs: Vec::new(),
            items: Vec::new(),
            links: Vec::new(),
        }
    }

    pub fn vector(index: usize) -> Floor {
        Floor {
            source: FloorSource::Vector,
            ..Floor::legacy(index)
        }
    }

    pub fn is_empty(&self) -> bool {
        self.walls.is_empty()
            && self.obstacles.is_empty()
            && self.doors.is_empty()
            && self.stairs.is_empty()
            && self.items.is_empty()
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct Scene {
    pub version: u16,
    pub floors: [Floor; NUM_FLOORS],
}

impl Default for Scene {
    /// All floors still on the legacy raster, with no vector objects.
    fn default() -> Scene {
        Scene {
            version: VERSION,
            floors: std::array::from_fn(Floor::legacy),
        }
    }
}

impl Scene {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        put_u16(&mut out, self.version);
        put_u8(&mut out, NUM_FLOORS as u8);
        put_u8(&mut out, 0);
        for floor in &self.floors {
            put_u8(
                &mut out,
                match floor.source {
                    FloorSource::LegacyRaster => 0,
                    FloorSource::Vector => 1,
                },
            );
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
                put_u8(&mut out, 0); // ItemKind::Key
                put_f32(&mut out, it.pos.0);
                put_f32(&mut out, it.pos.1);
                let name = it.name.as_bytes();
                put_u16(&mut out, name.len().min(u16::MAX as usize) as u16);
                out.extend_from_slice(&name[..name.len().min(u16::MAX as usize)]);
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
        let mut floors = std::array::from_fn(Floor::legacy);
        for floor in floors.iter_mut() {
            floor.source = match c.u8()? {
                0 => FloorSource::LegacyRaster,
                1 => FloorSource::Vector,
                _ => return None,
            };
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
                floor.doors.push(Door {
                    id,
                    kind,
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
                c.u8()?; // kind (Key only for now)
                let pos = (c.f32()?, c.f32()?);
                let len = c.u16()? as usize;
                let name = String::from_utf8_lossy(c.take(len)?).into_owned();
                floor.items.push(ItemDef {
                    id,
                    kind: ItemKind::Key,
                    name,
                    pos,
                });
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
        assert!(back
            .floors
            .iter()
            .all(|f| f.source == FloorSource::LegacyRaster));
    }

    #[test]
    fn populated_scene_round_trips() {
        let mut scene = Scene::default();
        let floor = &mut scene.floors[FLOOR1_INDEX];
        floor.source = FloorSource::Vector;
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
        floor.obstacles.push(Box2 {
            id: 7,
            center: (2000.0, 4000.0),
            size: (64.0, 32.0),
            rot: 0.5,
        });
        floor.doors.push(Door {
            id: 3,
            kind: DoorKind::Locked,
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

        let bytes = scene.to_bytes();
        let back = Scene::from_bytes(&bytes).expect("decode");
        assert_eq!(back, scene);
    }

    #[test]
    fn rejects_bad_magic_and_truncation() {
        assert!(Scene::from_bytes(b"nope").is_none());
        let bytes = Scene::default().to_bytes();
        assert!(Scene::from_bytes(&bytes[..bytes.len() - 1]).is_none());
    }
}
