export type WaypointMenuState = {
  x: number;
  y: number;
  node: number;
  waypoints: number;
  route: number;
  moving: boolean;
};

export type WaypointCommand = "add" | "remove" | "run";

export type WaypointMenuItem = {
  command: WaypointCommand;
  label: string;
  enabled: boolean;
};

const COMMANDS: {
  command: WaypointCommand;
  label: string;
  enabled: (menu: WaypointMenuState) => boolean;
}[] = [
  { command: "add", label: "Add waypoint", enabled: (menu) => !menu.moving && menu.node >= 0 },
  {
    command: "remove",
    label: "Remove waypoint",
    enabled: (menu) => !menu.moving && menu.waypoints > 0,
  },
  { command: "run", label: "Run route", enabled: (menu) => !menu.moving && menu.route >= 2 },
];

export function waypointMenuItems(menu: WaypointMenuState): WaypointMenuItem[] {
  return COMMANDS.map(({ command, label, enabled }) => ({
    command,
    label,
    enabled: enabled(menu),
  }));
}
