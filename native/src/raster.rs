//! Small 1-bit raster helpers used by the scene baker: rectangle/box fills,
//! dilation and exterior flood fill.

/// A width x height 1-bit mask. Bit set = "on" (solid, walkable, exterior...).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Mask {
    pub w: i32,
    pub h: i32,
    bits: Vec<u8>,
}

impl Mask {
    pub fn new(w: i32, h: i32) -> Mask {
        let w = w.max(0);
        let h = h.max(0);
        let bytes = (w as usize * h as usize).div_ceil(8);
        Mask {
            w,
            h,
            bits: vec![0; bytes],
        }
    }

    #[inline]
    fn index(&self, x: i32, y: i32) -> usize {
        (y * self.w + x) as usize
    }

    #[inline]
    pub fn get(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return false;
        }
        let i = self.index(x, y);
        (self.bits[i >> 3] >> (i & 7)) & 1 == 1
    }

    #[inline]
    pub fn set(&mut self, x: i32, y: i32, on: bool) {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return;
        }
        let i = self.index(x, y);
        if on {
            self.bits[i >> 3] |= 1 << (i & 7);
        } else {
            self.bits[i >> 3] &= !(1 << (i & 7));
        }
    }

    /// True if any cell is set.
    pub fn any(&self) -> bool {
        self.bits.iter().any(|&b| b != 0)
    }

    /// Fill (or clear) an axis-aligned rectangle in mask cells.
    pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32, on: bool) {
        let x0 = x.floor() as i32;
        let y0 = y.floor() as i32;
        let x1 = (x + w).ceil() as i32;
        let y1 = (y + h).ceil() as i32;
        for cy in y0..y1 {
            for cx in x0..x1 {
                self.set(cx, cy, on);
            }
        }
    }

    /// Fill (or clear) a rotated box: centre `(cx, cy)`, size `(sx, sy)`,
    /// rotation `rot` radians.
    pub fn fill_box(&mut self, cx: f32, cy: f32, sx: f32, sy: f32, rot: f32, on: bool) {
        let hw = sx * 0.5;
        let hh = sy * 0.5;
        let (s, c) = rot.sin_cos();
        let ext_x = hw * c.abs() + hh * s.abs();
        let ext_y = hw * s.abs() + hh * c.abs();
        let x0 = (cx - ext_x).floor().max(0.0) as i32;
        let y0 = (cy - ext_y).floor().max(0.0) as i32;
        let x1 = (cx + ext_x).ceil().min(self.w as f32) as i32;
        let y1 = (cy + ext_y).ceil().min(self.h as f32) as i32;
        for y in y0..y1 {
            for x in x0..x1 {
                let dx = x as f32 + 0.5 - cx;
                let dy = y as f32 + 0.5 - cy;
                let lx = dx * c + dy * s;
                let ly = -dx * s + dy * c;
                if lx.abs() <= hw && ly.abs() <= hh {
                    self.set(x, y, on);
                }
            }
        }
    }

    /// Square min-filter erosion by `radius` cells: a cell stays set only if
    /// every neighbour within `radius` is set.
    pub fn erode(&self, radius: i32) -> Mask {
        if radius <= 0 {
            return self.clone();
        }
        self.not().dilate(radius).not()
    }

    /// Complement of every cell.
    pub fn not(&self) -> Mask {
        let mut out = Mask::new(self.w, self.h);
        for y in 0..self.h {
            for x in 0..self.w {
                out.set(x, y, !self.get(x, y));
            }
        }
        out
    }

    pub fn or_with(&mut self, other: &Mask) {
        for i in 0..self.bits.len().min(other.bits.len()) {
            self.bits[i] |= other.bits[i];
        }
    }

    /// Clear every cell that is set in `other`.
    pub fn subtract(&mut self, other: &Mask) {
        for i in 0..self.bits.len().min(other.bits.len()) {
            self.bits[i] &= !other.bits[i];
        }
    }

    /// Square max-filter dilation by `radius` cells. Separable (a horizontal then
    /// a vertical pass), so a large radius stays cheap.
    pub fn dilate(&self, radius: i32) -> Mask {
        if radius <= 0 {
            return self.clone();
        }
        let mut tmp = Mask::new(self.w, self.h);
        for y in 0..self.h {
            for x in 0..self.w {
                let mut on = false;
                for dx in -radius..=radius {
                    let xx = x + dx;
                    if xx >= 0 && xx < self.w && self.get(xx, y) {
                        on = true;
                        break;
                    }
                }
                tmp.set(x, y, on);
            }
        }
        let mut out = Mask::new(self.w, self.h);
        for y in 0..self.h {
            for x in 0..self.w {
                let mut on = false;
                for dy in -radius..=radius {
                    let yy = y + dy;
                    if yy >= 0 && yy < self.h && tmp.get(x, yy) {
                        on = true;
                        break;
                    }
                }
                out.set(x, y, on);
            }
        }
        out
    }

    /// Cells reachable from the border through set cells of `self`.
    pub fn flood_from_border(&self) -> Mask {
        let mut out = Mask::new(self.w, self.h);
        if self.w == 0 || self.h == 0 {
            return out;
        }
        let mut stack: Vec<(i32, i32)> = Vec::new();
        let push = |m: &Mask, out: &mut Mask, stack: &mut Vec<(i32, i32)>, x: i32, y: i32| {
            if m.get(x, y) && !out.get(x, y) {
                out.set(x, y, true);
                stack.push((x, y));
            }
        };
        for x in 0..self.w {
            push(self, &mut out, &mut stack, x, 0);
            push(self, &mut out, &mut stack, x, self.h - 1);
        }
        for y in 0..self.h {
            push(self, &mut out, &mut stack, 0, y);
            push(self, &mut out, &mut stack, self.w - 1, y);
        }
        while let Some((x, y)) = stack.pop() {
            push(self, &mut out, &mut stack, x + 1, y);
            push(self, &mut out, &mut stack, x - 1, y);
            push(self, &mut out, &mut stack, x, y + 1);
            push(self, &mut out, &mut stack, x, y - 1);
        }
        out
    }

    /// Pack to the little-endian bit format used by `floor-N-nav.bin` /
    /// `floor-N-solid.bin`: `u32 cell_px, u32 width, u32 height`, then bits
    /// row-major, LSB first per byte.
    pub fn to_bytes(&self, cell_px: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + self.bits.len());
        out.extend_from_slice(&cell_px.to_le_bytes());
        out.extend_from_slice(&(self.w as u32).to_le_bytes());
        out.extend_from_slice(&(self.h as u32).to_le_bytes());
        out.extend_from_slice(&self.bits);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_fill_and_clear() {
        let mut m = Mask::new(10, 10);
        m.fill_rect(2.0, 2.0, 4.0, 4.0, true);
        assert!(m.get(2, 2) && m.get(5, 5) && !m.get(6, 6));
        m.fill_rect(3.0, 3.0, 2.0, 2.0, false);
        assert!(m.get(2, 2) && !m.get(3, 3) && m.get(5, 5));
    }

    #[test]
    fn rotated_box_covers_centre_only() {
        let mut m = Mask::new(20, 20);
        m.fill_box(10.0, 10.0, 2.0, 8.0, std::f32::consts::FRAC_PI_2, true);
        // Rotated 90 degrees: now wide, not tall.
        assert!(m.get(6, 10) && m.get(13, 10));
        assert!(!m.get(10, 6) && !m.get(10, 13));
    }

    #[test]
    fn dilation_and_flood() {
        let mut m = Mask::new(9, 9);
        m.set(4, 4, true);
        let d = m.dilate(1);
        assert!(d.get(3, 3) && d.get(5, 5) && !d.get(2, 2));

        // A closed box: the enclosed centre stays dry, the border floods.
        let mut free = Mask::new(5, 5);
        for y in 0..5 {
            for x in 0..5 {
                free.set(x, y, true);
            }
        }
        for x in 1..=3 {
            free.set(x, 1, false);
            free.set(x, 3, false);
        }
        for y in 1..=3 {
            free.set(1, y, false);
            free.set(3, y, false);
        }
        let ext = free.flood_from_border();
        assert!(ext.get(0, 0), "the border floods");
        assert!(!ext.get(2, 2), "the enclosed centre stays dry");
    }

    #[test]
    fn to_bytes_header() {
        let mut m = Mask::new(10, 3);
        m.set(0, 0, true);
        let b = m.to_bytes(8);
        assert_eq!(&b[0..4], &8u32.to_le_bytes());
        assert_eq!(&b[4..8], &10u32.to_le_bytes());
        assert_eq!(&b[8..12], &3u32.to_le_bytes());
        assert_eq!(b[12], 1);
    }
}
