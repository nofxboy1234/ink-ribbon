export type Vec3 = [number, number, number];

export type Floor = {
  index: number;
  level: number;
  label: string;
};

export type Room = {
  name: string;
  floor: number;
  level: number;
  x: number;
  y: number;
  z: number;
  zone: number;
};

export type Item = {
  id: string;
  name: string;
  location: string;
  region: string;
  category: string;
  shape: "sphere" | "cube" | "pyramid" | "cylinder";
  color: string;
  rgb: [number, number, number];
  x: number;
  y: number;
  z: number;
  links: string[];
  itemLinks: string[];
  requires: string[];
  options: string[][];
};

export type DoorState = "locked" | "unlocked" | "unknown";

export type Door = {
  id: string;
  from: string;
  to: string;
  x: number;
  y: number;
  z: number;
  state: DoorState;
  requires: string[];
  options: string[][];
  label: string;
  oneWay: boolean;
  yaw: number;
  puzzle: boolean;
};

export type Edge = {
  from: string;
  to: string;
  door: string | null;
};

export type Quest = {
  spawn: Vec3;
  floors: Floor[];
  rooms: Room[];
  items: Item[];
  doors: Door[];
  edges: Edge[];
  source: string;
};

export const SHAPES = {
  sphere: 0,
  cube: 1,
  pyramid: 2,
  cylinder: 3,
  capsule: 5,
} as const;

export const DOOR_SHAPE = 4;

export const DOOR_COLOURS: Record<DoorState, [number, number, number]> = {
  locked: [214, 40, 40],
  unlocked: [31, 119, 180],
  unknown: [127, 127, 127],
};

export const CATEGORY_LABELS: Record<string, string> = {
  key: "Key",
  gating: "Key item",
  healing: "Healing",
  ammo: "Ammo",
  powder: "Gunpowder",
  weapon: "Weapon",
  subweapon: "Subweapon",
  upgrade: "Upgrade",
  consumable: "Consumable",
  ink: "Ink ribbon",
  equipment: "Equipment",
  lore: "File",
  misc: "Item",
};

export function itemRadius(category: string): number {
  return category === "key" || category === "gating" ? 0.42 : 0.34;
}

export function nearbyRoom(quest: Quest, point: Vec3): Room {
  if (quest.rooms.length === 0) {
    return { name: "RPD", floor: 0, level: point[1], x: point[0], y: point[1], z: point[2], zone: 1 };
  }
  if (point[1] < -2.4) {
    const base = quest.rooms[0];
    return { ...base, name: "B1 Parking Garage", floor: 4, level: -5.2 };
  }
  if (point[1] > 13.2) {
    const base = quest.rooms[0];
    return { ...base, name: "Clock Tower", floor: 3, level: 15.6 };
  }
  let best = quest.rooms[0];
  let bestDistance = Infinity;
  for (const room of quest.rooms) {
    const dx = room.x - point[0];
    const dy = room.level - point[1];
    const dz = room.z - point[2];
    const distance = dx * dx + dz * dz + dy * dy * 2.0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = room;
    }
  }
  return best;
}

export function itemSatisfied(item: Item, inventory: Set<string>): boolean {
  if (item.options.length === 0) return true;
  return item.options.some((option) => option.every((name) => inventory.has(name)));
}

export function keyForDoor(door: Door, inventory: Set<string>): string | null {
  for (const option of door.options) {
    if (option.length === 1 && inventory.has(option[0])) return option[0];
  }
  for (const option of door.options) {
    if (option.every((name) => inventory.has(name))) return option[0];
  }
  return null;
}

export function pathLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2],
    );
  }
  return total;
}

export function pointAt(points: Vec3[], distance: number): Vec3 {
  let remaining = distance;
  for (let i = 1; i < points.length; i++) {
    const segment = Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2],
    );
    if (remaining <= segment && segment > 0) {
      const t = remaining / segment;
      return [
        points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
        points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
        points[i - 1][2] + (points[i][2] - points[i - 1][2]) * t,
      ];
    }
    remaining -= segment;
  }
  return points[points.length - 1];
}
