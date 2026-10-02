pub const NORTH: u8 = 1 << 0;
pub const EAST: u8 = 1 << 1;
pub const SOUTH: u8 = 1 << 2;
pub const WEST: u8 = 1 << 3;

pub const DIRECTIONS: [(u8, i32, i32); 4] =
    [(NORTH, 0, -1), (EAST, 1, 0), (SOUTH, 0, 1), (WEST, -1, 0)];

pub const SIDES: [u8; 4] = [NORTH, EAST, SOUTH, WEST];

pub fn opposite(dir: u8) -> u8 {
    match dir {
        NORTH => SOUTH,
        SOUTH => NORTH,
        EAST => WEST,
        WEST => EAST,
        _ => 0,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CellKind {
    Floor,
    Wall,
}

#[derive(Clone, Copy, Debug)]
pub struct Cell {
    pub kind: CellKind,
    pub blocked: u8,
}

impl Cell {
    pub const fn floor() -> Self {
        Self {
            kind: CellKind::Floor,
            blocked: 0,
        }
    }

    pub fn is_blocked(&self, dir: u8) -> bool {
        self.blocked & dir != 0
    }
}

pub struct Grid {
    pub cols: usize,
    pub rows: usize,
    cells: Vec<Cell>,
}

impl Grid {
    pub fn new(cols: usize, rows: usize) -> Self {
        Self {
            cols,
            rows,
            cells: vec![Cell::floor(); cols * rows],
        }
    }

    pub fn idx(&self, x: usize, y: usize) -> usize {
        y * self.cols + x
    }

    pub fn coords(&self, index: usize) -> (usize, usize) {
        (index % self.cols, index / self.cols)
    }

    pub fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as usize) < self.cols && (y as usize) < self.rows
    }

    pub fn cell(&self, x: usize, y: usize) -> Cell {
        self.cells[self.idx(x, y)]
    }

    pub fn cell_mut(&mut self, x: usize, y: usize) -> &mut Cell {
        let index = self.idx(x, y);
        &mut self.cells[index]
    }

    pub fn set_blocked(&mut self, x: usize, y: usize, dir: u8) {
        self.cell_mut(x, y).blocked |= dir;
    }

    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_round_trips() {
        let grid = Grid::new(6, 4);
        for y in 0..grid.rows {
            for x in 0..grid.cols {
                assert_eq!(grid.coords(grid.idx(x, y)), (x, y));
            }
        }
    }

    #[test]
    fn bounds_are_exclusive() {
        let grid = Grid::new(6, 4);
        assert!(grid.in_bounds(0, 0));
        assert!(grid.in_bounds(5, 3));
        assert!(!grid.in_bounds(6, 0));
        assert!(!grid.in_bounds(0, 4));
        assert!(!grid.in_bounds(-1, 0));
    }

    #[test]
    fn opposite_inverts_side() {
        assert_eq!(opposite(NORTH), SOUTH);
        assert_eq!(opposite(EAST), WEST);
    }
}
