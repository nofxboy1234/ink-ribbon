use crate::grid::{Direction, Grid};

#[derive(Clone, Copy, Debug)]
pub struct Door {
    pub x: usize,
    pub y: usize,
    pub side: Direction,
    pub locked: bool,
}

pub struct Game {
    pub grid: Grid,
    pub doors: Vec<Door>,
    pub player: (usize, usize),
}

impl Game {
    pub fn new() -> Self {
        let cols = 6;
        let rows = 4;
        let mut grid = Grid::new(cols, rows);
        for x in 0..cols {
            grid.set_blocked(x, 0, Direction::North);
            grid.set_blocked(x, rows - 1, Direction::South);
        }
        for y in 0..rows {
            grid.set_blocked(0, y, Direction::West);
            grid.set_blocked(cols - 1, y, Direction::East);
        }
        let doors = vec![
            Door {
                x: cols - 1,
                y: 1,
                side: Direction::East,
                locked: false,
            },
            Door {
                x: 2,
                y: rows - 1,
                side: Direction::South,
                locked: true,
            },
        ];
        Self {
            grid,
            doors,
            player: (2, 2),
        }
    }
}

impl Default for Game {
    fn default() -> Self {
        Self::new()
    }
}
