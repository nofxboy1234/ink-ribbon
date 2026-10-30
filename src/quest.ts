export type Vec3 = [number, number, number];

export type Floor = {
  index: number;
  level: number;
  label: string;
  cells: [number, number, number][];
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

export type PathResult = {
  points: Vec3[];
  rooms: string[];
  doors: Door[];
};

export const SHAPES = {
  sphere: 0,
  cube: 1,
  pyramid: 2,
  cylinder: 3,
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

export function roomByName(quest: Quest, name: string): Room | undefined {
  return quest.rooms.find((room) => room.name === name);
}

export function nearbyRoom(quest: Quest, point: Vec3): Room {
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

export function roomForCell(quest: Quest, cell: [number, number, number]): Room {
  let best = quest.rooms[0];
  let bestDistance = Infinity;
  for (const room of quest.rooms) {
    if (Math.abs(room.level - cell[2]) > 1.2) continue;
    const dx = room.x - cell[0];
    const dz = room.z - cell[1];
    const distance = dx * dx + dz * dz;
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

export function doorSatisfied(door: Door, inventory: Set<string>): boolean {
  if (door.state === "unlocked" || door.state === "unknown") return true;
  return door.options.some((option) => option.every((name) => inventory.has(name)));
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

export function findRoomPath(
  quest: Quest,
  from: string,
  to: string,
  passable: (door: Door) => boolean,
): { rooms: string[]; doors: Door[] } | null {
  if (from === to) return { rooms: [from], doors: [] };
  const doorById = new Map(quest.doors.map((door) => [door.id, door]));
  const graph = new Map<string, { to: string; door: Door | null; cost: number }[]>();
  for (const room of quest.rooms) graph.set(room.name, []);
  for (const edge of quest.edges) {
    const fromRoom = roomByName(quest, edge.from);
    const toRoom = roomByName(quest, edge.to);
    if (!fromRoom || !toRoom) continue;
    const door = edge.door ? doorById.get(edge.door) ?? null : null;
    const cost = Math.hypot(
      fromRoom.x - toRoom.x,
      fromRoom.z - toRoom.z,
      (fromRoom.level - toRoom.level) * 2,
    );
    graph.get(edge.from)?.push({ to: edge.to, door, cost });
    graph.get(edge.to)?.push({ to: edge.from, door, cost });
  }

  const distance = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, { room: string; door: Door | null }>();
  const open = new Set<string>([from]);
  while (open.size > 0) {
    let current = "";
    let currentDistance = Infinity;
    for (const room of open) {
      const value = distance.get(room) ?? Infinity;
      if (value < currentDistance) {
        current = room;
        currentDistance = value;
      }
    }
    if (!current) break;
    open.delete(current);
    if (current === to) break;
    for (const next of graph.get(current) ?? []) {
      if (next.door && !passable(next.door)) continue;
      const candidate = currentDistance + next.cost;
      if (candidate < (distance.get(next.to) ?? Infinity)) {
        distance.set(next.to, candidate);
        previous.set(next.to, { room: current, door: next.door });
        open.add(next.to);
      }
    }
  }
  if (!distance.has(to)) return null;
  const rooms: string[] = [];
  const doors: Door[] = [];
  let cursor = to;
  while (cursor !== from) {
    rooms.unshift(cursor);
    const prior = previous.get(cursor);
    if (!prior) return null;
    if (prior.door) doors.unshift(prior.door);
    cursor = prior.room;
  }
  rooms.unshift(from);
  return { rooms, doors };
}

export function planPath(
  quest: Quest,
  player: Vec3,
  playerRoom: string,
  target: Vec3,
  targetRoom: string,
  inventory: Set<string>,
  doorStates: Map<string, DoorState>,
): PathResult | null {
  const passable = (door: Door) => {
    const state = doorStates.get(door.id) ?? door.state;
    if (state !== "locked") return true;
    return keyForDoor({ ...door, state }, inventory) !== null;
  };
  const route = findRoomPath(quest, playerRoom, targetRoom, passable);
  if (!route) return null;
  const points: Vec3[] = [player];
  for (let i = 1; i < route.rooms.length; i++) {
    const door = route.doors[i - 1];
    if (door) {
      points.push([door.x, door.y + 0.7, door.z]);
    }
    const room = roomByName(quest, route.rooms[i]);
    if (room) {
      points.push([room.x, room.level + 0.45, room.z]);
    }
  }
  points.push(target);
  return { points, rooms: route.rooms, doors: route.doors };
}

function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] =
      0.5 *
      (2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }
  return out;
}

export function smoothPath(points: Vec3[], perSegment = 14): Vec3[] {
  if (points.length < 2) return points;
  if (points.length === 2) {
    const [a, b] = points;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const length = Math.hypot(dx, dz);
    if (length < 0.01) return points;
    if (length < 6) return points;
    const offset = Math.min(1.6, length * 0.16);
    const control: Vec3 = [
      (a[0] + b[0]) / 2 - (dz / length) * offset,
      (a[1] + b[1]) / 2 + Math.min(0.35, length * 0.04),
      (a[2] + b[2]) / 2 + (dx / length) * offset,
    ];
    const curved: Vec3[] = [];
    for (let i = 0; i <= perSegment; i++) {
      const t = i / perSegment;
      const u = 1 - t;
      curved.push([
        u * u * a[0] + 2 * u * t * control[0] + t * t * b[0],
        u * u * a[1] + 2 * u * t * control[1] + t * t * b[1],
        u * u * a[2] + 2 * u * t * control[2] + t * t * b[2],
      ]);
    }
    return curved;
  }
  const padded: Vec3[] = [points[0], ...points, points[points.length - 1]];
  const out: Vec3[] = [];
  for (let i = 1; i < padded.length - 2; i++) {
    for (let step = 0; step < perSegment; step++) {
      out.push(catmullRom(padded[i - 1], padded[i], padded[i + 1], padded[i + 2], step / perSegment));
    }
  }
  out.push(points[points.length - 1]);
  return out;
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
