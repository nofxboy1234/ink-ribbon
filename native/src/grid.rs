#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    North,
    East,
    South,
    West,
}

impl Direction {
    pub const ALL: [Direction; 4] = [
        Direction::North,
        Direction::East,
        Direction::South,
        Direction::West,
    ];

    pub const fn bit(self) -> u8 {
        1_u8 << self as u8
    }

    pub const fn delta(self) -> (i32, i32) {
        match self {
            Direction::North => (0, -1),
            Direction::East => (1, 0),
            Direction::South => (0, 1),
            Direction::West => (-1, 0),
        }
    }

    pub const fn opposite(self) -> Direction {
        match self {
            Direction::North => Direction::South,
            Direction::South => Direction::North,
            Direction::East => Direction::West,
            Direction::West => Direction::East,
        }
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
    blocked: u8,
}

impl Cell {
    pub const fn floor() -> Self {
        Self {
            kind: CellKind::Floor,
            blocked: 0,
        }
    }

    pub fn is_blocked(&self, dir: Direction) -> bool {
        self.blocked & dir.bit() != 0
    }

    fn block(&mut self, dir: Direction) {
        self.blocked |= dir.bit();
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

    pub fn set_blocked(&mut self, x: usize, y: usize, dir: Direction) {
        self.cell_mut(x, y).block(dir);
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
    fn opposite_inverts_direction() {
        for dir in Direction::ALL {
            assert_eq!(dir.opposite().opposite(), dir);
        }
    }

    #[test]
    fn direction_bits_are_distinct() {
        let mut seen = 0u8;
        for dir in Direction::ALL {
            assert_eq!(seen & dir.bit(), 0);
            seen |= dir.bit();
        }
        assert_eq!(seen, 0b1111);
    }

    #[test]
    fn directions_point_the_right_way() {
        assert_eq!(Direction::North.delta(), (0, -1));
        assert_eq!(Direction::East.delta(), (1, 0));
        assert_eq!(Direction::South.delta(), (0, 1));
        assert_eq!(Direction::West.delta(), (-1, 0));
    }
}
