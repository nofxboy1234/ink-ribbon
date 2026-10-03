use crate::grid::Direction;

pub struct Layout {
    pub ox: f32,
    pub oy: f32,
    pub cell: f32,
    pub cols: usize,
    pub rows: usize,
}

impl Layout {
    pub fn compute(width: f32, height: f32, cols: usize, rows: usize) -> Self {
        let pad = (width.min(height) * 0.08).max(16.0);
        let avail_w = (width - pad * 2.0).max(1.0);
        let avail_h = (height - pad * 2.0).max(1.0);
        let cell = (avail_w / cols as f32).min(avail_h / rows as f32);
        let room_w = cell * cols as f32;
        let room_h = cell * rows as f32;
        Self {
            ox: (width - room_w) * 0.5,
            oy: (height - room_h) * 0.5,
            cell,
            cols,
            rows,
        }
    }

    pub fn room_w(&self) -> f32 {
        self.cell * self.cols as f32
    }

    pub fn room_h(&self) -> f32 {
        self.cell * self.rows as f32
    }

    pub fn cell_origin(&self, x: usize, y: usize) -> (f32, f32) {
        (
            self.ox + x as f32 * self.cell,
            self.oy + y as f32 * self.cell,
        )
    }

    pub fn cell_center(&self, x: usize, y: usize) -> (f32, f32) {
        let (cx, cy) = self.cell_origin(x, y);
        (cx + self.cell * 0.5, cy + self.cell * 0.5)
    }

    pub fn edge(&self, x: usize, y: usize, side: Direction) -> ((f32, f32), (f32, f32)) {
        let (x0, y0) = self.cell_origin(x, y);
        let x1 = x0 + self.cell;
        let y1 = y0 + self.cell;
        match side {
            Direction::East => ((x1, y0), (x1, y1)),
            Direction::South => ((x1, y1), (x0, y1)),
            Direction::West => ((x0, y1), (x0, y0)),
            Direction::North => ((x0, y0), (x1, y0)),
        }
    }
}
