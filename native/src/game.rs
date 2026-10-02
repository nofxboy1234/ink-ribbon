use crate::grid::{self, Grid};

#[derive(Clone, Copy, Debug)]
pub struct Door {
    pub x: usize,
    pub y: usize,
    pub side: u8,
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
            grid.set_blocked(x, 0, grid::NORTH);
            grid.set_blocked(x, rows - 1, grid::SOUTH);
        }
        for y in 0..rows {
            grid.set_blocked(0, y, grid::WEST);
            grid.set_blocked(cols - 1, y, grid::EAST);
        }
        let doors = vec![
            Door {
                x: cols - 1,
                y: 1,
                side: grid::EAST,
                locked: false,
            },
            Door {
                x: 2,
                y: rows - 1,
                side: grid::SOUTH,
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
