//! Per-slot player save: progress that lives outside the authored scene.
//!
//! `scene.bin` is the map; this is the player's state within it: which floor and
//! where they are, what they've picked up, which doors they've revealed or
//! unlocked, their inventory, how long they've played and when they saved.
//!
//! Layout (little-endian):
//!
//! ```text
//! magic  "IRSV"
//! u16    version
//! u8     player_floor
//! f32    player_x, player_y
//! u32    collected_count -> u32 id*
//! u32    revealed_count  -> { u8 floor, u32 door_id }*
//! u32    unlocked_count  -> { u8 floor, u32 door_id }*
//! u32    inventory_count -> { u32 id, u8 kind, u16 name_len, name }*
//! u32    item_box_count  -> { u32 id, u8 kind, u16 name_len, name }*   (v2)
//! f32    play_time (seconds)
//! u64    saved_at (unix seconds, UTC; 0 if unavailable)
//! ```

use crate::scene::ItemDef;

const MAGIC: &[u8; 4] = b"IRSV";
/// v1 had no item box; v2 adds it. Reading still accepts v1.
pub const VERSION: u16 = 2;

#[derive(Clone, PartialEq, Debug)]
pub struct PlayerSave {
    pub player_floor: usize,
    pub player: (f32, f32),
    pub collected: Vec<u32>,
    pub revealed: Vec<(usize, u32)>,
    pub unlocked: Vec<(usize, u32)>,
    pub inventory: Vec<ItemDef>,
    pub item_box: Vec<ItemDef>,
    pub play_time: f32,
    pub saved_at: u64,
}

impl PlayerSave {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        put_u16(&mut out, VERSION);
        put_u8(&mut out, self.player_floor as u8);
        put_f32(&mut out, self.player.0);
        put_f32(&mut out, self.player.1);

        put_u32(&mut out, self.collected.len() as u32);
        for id in &self.collected {
            put_u32(&mut out, *id);
        }

        put_u32(&mut out, self.revealed.len() as u32);
        for (floor, id) in &self.revealed {
            put_u8(&mut out, *floor as u8);
            put_u32(&mut out, *id);
        }

        put_u32(&mut out, self.unlocked.len() as u32);
        for (floor, id) in &self.unlocked {
            put_u8(&mut out, *floor as u8);
            put_u32(&mut out, *id);
        }

        put_u32(&mut out, self.inventory.len() as u32);
        for it in &self.inventory {
            put_u32(&mut out, it.id);
            put_u8(&mut out, it.kind.to_u8());
            let name = it.name.as_bytes();
            let n = name.len().min(u16::MAX as usize);
            put_u16(&mut out, n as u16);
            out.extend_from_slice(&name[..n]);
        }

        put_u32(&mut out, self.item_box.len() as u32);
        for it in &self.item_box {
            put_u32(&mut out, it.id);
            put_u8(&mut out, it.kind.to_u8());
            let name = it.name.as_bytes();
            let n = name.len().min(u16::MAX as usize);
            put_u16(&mut out, n as u16);
            out.extend_from_slice(&name[..n]);
        }

        put_f32(&mut out, self.play_time);
        out.extend_from_slice(&self.saved_at.to_le_bytes());
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<PlayerSave> {
        let mut c = Cursor { bytes, pos: 0 };
        if c.take(4)? != MAGIC {
            return None;
        }
        let version = c.u16()?;
        let player_floor = c.u8()? as usize;
        let player = (c.f32()?, c.f32()?);

        let n = c.u32()? as usize;
        let mut collected = Vec::with_capacity(n);
        for _ in 0..n {
            collected.push(c.u32()?);
        }

        let n = c.u32()? as usize;
        let mut revealed = Vec::with_capacity(n);
        for _ in 0..n {
            revealed.push((c.u8()? as usize, c.u32()?));
        }

        let n = c.u32()? as usize;
        let mut unlocked = Vec::with_capacity(n);
        for _ in 0..n {
            unlocked.push((c.u8()? as usize, c.u32()?));
        }

        let n = c.u32()? as usize;
        let mut inventory = Vec::with_capacity(n);
        for _ in 0..n {
            let id = c.u32()?;
            let kind = crate::scene::ItemKind::from_u8(c.u8()?)?;
            let len = c.u16()? as usize;
            let name = String::from_utf8_lossy(c.take(len)?).into_owned();
            inventory.push(ItemDef {
                id,
                kind,
                name,
                pos: (0.0, 0.0),
            });
        }

        // v2 added the item box.
        let mut item_box = Vec::new();
        if version >= 2 {
            let n = c.u32()? as usize;
            for _ in 0..n {
                let id = c.u32()?;
                let kind = crate::scene::ItemKind::from_u8(c.u8()?)?;
                let len = c.u16()? as usize;
                let name = String::from_utf8_lossy(c.take(len)?).into_owned();
                item_box.push(ItemDef {
                    id,
                    kind,
                    name,
                    pos: (0.0, 0.0),
                });
            }
        }

        let play_time = c.f32()?;
        let saved_at = c.u64()?;
        Some(PlayerSave {
            player_floor,
            player,
            collected,
            revealed,
            unlocked,
            inventory,
            item_box,
            play_time,
            saved_at,
        })
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
    fn u64(&mut self) -> Option<u64> {
        let b = self.take(8)?;
        Some(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
    fn f32(&mut self) -> Option<f32> {
        let b = self.take(4)?;
        Some(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// Format unix seconds as `YYYY-MM-DD HH:MM` in UTC. `0` shows as `--`.
pub fn format_unix_utc(secs: u64) -> String {
    if secs == 0 {
        return "--".to_string();
    }
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute) = (rem / 3600, (rem % 3600) / 60);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02} {hour:02}:{minute:02}")
}

// Howard Hinnant's days-from-civil, inverted.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::ItemKind;

    fn sample() -> PlayerSave {
        PlayerSave {
            player_floor: 2,
            player: (1234.5, 678.0),
            collected: vec![3, 9, 12],
            revealed: vec![(2, 1), (2, 4)],
            unlocked: vec![(2, 4)],
            inventory: vec![
                ItemDef {
                    id: 3,
                    kind: ItemKind::Key,
                    name: "Pantry Key".into(),
                    pos: (0.0, 0.0),
                },
                ItemDef {
                    id: 9,
                    kind: ItemKind::InkRibbon,
                    name: "Ink Ribbon".into(),
                    pos: (0.0, 0.0),
                },
            ],
            item_box: vec![ItemDef {
                id: 5,
                kind: ItemKind::Key,
                name: "Spare Key".into(),
                pos: (0.0, 0.0),
            }],
            play_time: 123.5,
            saved_at: 1_726_000_000,
        }
    }

    #[test]
    fn round_trips() {
        let save = sample();
        let back = PlayerSave::from_bytes(&save.to_bytes()).expect("decode");
        assert_eq!(back, save);
    }

    #[test]
    fn v1_save_has_no_item_box() {
        // A v1 payload has no item box: drop that block and stamp v1. The reader
        // must not look for a box and should leave it empty.
        let mut bytes = sample().to_bytes();
        let tail = 4 + 8; // play_time + saved_at
        let box_block = 4 + (4 + 1 + 2 + "Spare Key".len());
        let start = bytes.len() - tail - box_block;
        bytes.drain(start..bytes.len() - tail);
        bytes[4..6].copy_from_slice(&1u16.to_le_bytes());
        let back = PlayerSave::from_bytes(&bytes).expect("decode v1");
        assert!(back.item_box.is_empty());
        assert_eq!(back.inventory.len(), 2);
    }

    #[test]
    fn rejects_bad_magic_and_truncation() {
        assert!(PlayerSave::from_bytes(b"nope").is_none());
        let bytes = sample().to_bytes();
        assert!(PlayerSave::from_bytes(&bytes[..bytes.len() - 1]).is_none());
    }

    #[test]
    fn formats_utc_dates() {
        // 2024-09-10 20:26:40 UTC
        assert_eq!(format_unix_utc(1_726_000_000), "2024-09-10 20:26");
        assert_eq!(format_unix_utc(0), "--");
        // Epoch.
        assert_eq!(format_unix_utc(1), "1970-01-01 00:00");
    }
}
