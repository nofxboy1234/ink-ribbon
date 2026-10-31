import type { Door, DoorState, Vec3 } from "./quest";
import { keyForDoor } from "./quest";

export type NavFile = {
  version: number;
  step: number;
  half: number;
  floors: { index: number; label: string; level: number }[];
  nodes: {
    x: number;
    y: number;
    z: number;
    floor: number;
    kind?: string;
    n: number[];
  }[];
  portals?: [number, number, string?][];
};

export type NavGraph = {
  version: number;
  step: number;
  half: number;
  floors: NavFile["floors"];
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  floor: Uint8Array;
  kind: Uint8Array;
  first: Int32Array;
  adjacency: Int32Array;
  edgeId: Int32Array;
  edgeA: Int32Array;
  edgeB: Int32Array;
  edgeCost: Float32Array;
  edgeCount: number;
  portals: [number, number, string?][];
  doorPortalEdges: Map<number, string>;
  scratch: {
    g: Float64Array;
    f: Float64Array;
    from: Int32Array;
    closed: Uint8Array;
    heap: Int32Array;
  };
};

const KIND_FLOOR = 0;
const KIND_STAIR = 1;
const KIND_RAMP = 2;
const VERTICAL_WEIGHT = 1.15;

function kindValue(kind: string | undefined): number {
  if (kind === "stair") return KIND_STAIR;
  if (kind === "ramp") return KIND_RAMP;
  return KIND_FLOOR;
}

export function buildNavGraph(file: NavFile): NavGraph {
  const count = file.nodes.length;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  const floor = new Uint8Array(count);
  const kind = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const node = file.nodes[i];
    x[i] = node.x;
    y[i] = node.y;
    z[i] = node.z;
    floor[i] = node.floor;
    kind[i] = kindValue(node.kind);
  }

  const pairIds = new Map<number, number>();
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const pushEdge = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * count + hi;
    if (pairIds.has(key)) return;
    pairIds.set(key, edgeA.length);
    edgeA.push(lo);
    edgeB.push(hi);
  };
  for (let i = 0; i < count; i++) {
    for (const j of file.nodes[i].n) {
      if (j >= 0 && j < count) pushEdge(i, j);
    }
  }
  const edgeCount = edgeA.length;
  const edgeCost = new Float32Array(edgeCount);
  const degree = new Int32Array(count);
  for (let e = 0; e < edgeCount; e++) {
    const a = edgeA[e];
    const b = edgeB[e];
    const dx = x[a] - x[b];
    const dy = (y[a] - y[b]) * VERTICAL_WEIGHT;
    const dz = z[a] - z[b];
    edgeCost[e] = Math.hypot(dx, dy, dz);
    degree[a] += 1;
    degree[b] += 1;
  }
  const first = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) first[i + 1] = first[i] + degree[i];
  const cursor = Int32Array.from(first);
  const adjacency = new Int32Array(edgeCount * 2);
  const edgeId = new Int32Array(edgeCount * 2);
  for (let e = 0; e < edgeCount; e++) {
    const a = edgeA[e];
    const b = edgeB[e];
    adjacency[cursor[a]] = b;
    edgeId[cursor[a]] = e;
    cursor[a] += 1;
    adjacency[cursor[b]] = a;
    edgeId[cursor[b]] = e;
    cursor[b] += 1;
  }

  const doorPortalEdges = new Map<number, string>();
  for (const portal of file.portals ?? []) {
    if (!portal[2]) continue;
    const lo = Math.min(portal[0], portal[1]);
    const hi = Math.max(portal[0], portal[1]);
    const edge = pairIds.get(lo * count + hi);
    if (edge !== undefined) doorPortalEdges.set(edge, portal[2]);
  }

  return {
    version: file.version,
    step: file.step,
    half: file.half,
    floors: file.floors,
    count,
    x,
    y,
    z,
    floor,
    kind,
    first,
    adjacency,
    edgeId,
    edgeA: Int32Array.from(edgeA),
    edgeB: Int32Array.from(edgeB),
    edgeCost,
    edgeCount,
    portals: file.portals ?? [],
    doorPortalEdges,
    scratch: {
      g: new Float64Array(count),
      f: new Float64Array(count),
      from: new Int32Array(count),
      closed: new Uint8Array(count),
      heap: new Int32Array(edgeCount * 2 + 1),
    },
  };
}

export function nearestNode(
  graph: NavGraph,
  point: Vec3,
  maxDistance = 2.0,
): number {
  let best = -1;
  let bestDistance = maxDistance * maxDistance;
  for (let i = 0; i < graph.count; i++) {
    const dx = graph.x[i] - point[0];
    const dy = (graph.y[i] - point[1]) * 1.4;
    const dz = graph.z[i] - point[2];
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export function nearestNodeOnFloor(
  graph: NavGraph,
  point: Vec3,
  floor: number,
  maxDistance = 3.0,
): number {
  let best = -1;
  let bestDistance = maxDistance * maxDistance;
  for (let i = 0; i < graph.count; i++) {
    if (graph.floor[i] !== floor) continue;
    const dx = graph.x[i] - point[0];
    const dy = (graph.y[i] - point[1]) * 1.4;
    const dz = graph.z[i] - point[2];
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export function nodePoint(graph: NavGraph, id: number, eyeHeight = 0): Vec3 {
  return [graph.x[id], graph.y[id] + eyeHeight, graph.z[id]];
}

function pointSegmentDistance2(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const length = dx * dx + dz * dz;
  let t = 0;
  if (length > 1e-8) {
    t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / length));
  }
  const qx = ax + dx * t;
  const qz = az + dz * t;
  return (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
}

export function blockedDoorEdges(
  graph: NavGraph,
  doors: Door[],
  doorStates: Map<string, DoorState>,
  inventory: Set<string>,
): Set<number> {
  const blocked = new Set<number>();
  for (const door of doors) {
    const state = doorStates.get(door.id) ?? door.state;
    if (state !== "locked") continue;
    if (keyForDoor({ ...door, state }, inventory) !== null) continue;
    const radius = 1.2;
    for (let e = 0; e < graph.edgeCount; e++) {
      if (graph.doorPortalEdges.get(e) === door.id) {
        blocked.add(e);
        continue;
      }
      const a = graph.edgeA[e];
      const b = graph.edgeB[e];
      const midY = (graph.y[a] + graph.y[b]) * 0.5;
      if (Math.abs(midY - door.y) > 1.8) continue;
      const distance2 = pointSegmentDistance2(
        door.x,
        door.z,
        graph.x[a],
        graph.z[a],
        graph.x[b],
        graph.z[b],
      );
      if (distance2 <= radius * radius) blocked.add(e);
    }
  }
  return blocked;
}

function heapPush(heap: Int32Array, size: number, value: number, score: Float64Array): number {
  let i = size;
  heap[i] = value;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (score[heap[parent]] <= score[heap[i]]) break;
    const tmp = heap[parent];
    heap[parent] = heap[i];
    heap[i] = tmp;
    i = parent;
  }
  return size + 1;
}

function heapPop(heap: Int32Array, size: number, score: Float64Array): number {
  const top = heap[0];
  heap[0] = heap[size - 1];
  let i = 0;
  const last = size - 1;
  for (;;) {
    const left = i * 2 + 1;
    if (left >= last) break;
    const right = left + 1;
    let child = left;
    if (right < last && score[heap[right]] < score[heap[left]]) child = right;
    if (score[heap[i]] <= score[heap[child]]) break;
    const tmp = heap[i];
    heap[i] = heap[child];
    heap[child] = tmp;
    i = child;
  }
  return top;
}

export function findNavPath(
  graph: NavGraph,
  start: number,
  goal: number,
  blockedEdges?: Set<number>,
  maxExpansions = 250000,
): number[] | null {
  if (start < 0 || goal < 0) return null;
  if (start === goal) return [start];
  const { g, f, from, closed, heap } = graph.scratch;
  g.fill(Infinity);
  f.fill(Infinity);
  from.fill(-1);
  closed.fill(0);
  let heapSize = 1;
  heap[0] = start;
  g[start] = 0;
  f[start] = Math.hypot(graph.x[start] - graph.x[goal], graph.y[start] - graph.y[goal], graph.z[start] - graph.z[goal]);
  let expansions = 0;
  while (heapSize > 0) {
    const current = heapPop(heap, heapSize, f);
    heapSize -= 1;
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goal) break;
    expansions += 1;
    if (expansions > maxExpansions) return null;
    const currentG = g[current];
    for (let k = graph.first[current]; k < graph.first[current + 1]; k++) {
      const edge = graph.edgeId[k];
      if (blockedEdges?.has(edge)) continue;
      const next = graph.adjacency[k];
      if (closed[next]) continue;
      const candidate = currentG + graph.edgeCost[edge];
      if (candidate >= g[next]) continue;
      g[next] = candidate;
      from[next] = current;
      f[next] = candidate + Math.hypot(
        graph.x[next] - graph.x[goal],
        graph.y[next] - graph.y[goal],
        graph.z[next] - graph.z[goal],
      );
      heapSize = heapPush(heap, heapSize, next, f);
    }
  }
  if (from[goal] === -1 && start !== goal) return null;
  const path: number[] = [];
  let cursor = goal;
  while (cursor !== -1) {
    path.push(cursor);
    if (cursor === start) break;
    cursor = from[cursor];
  }
  if (path[path.length - 1] !== start) return null;
  path.reverse();
  return path;
}

export function routeFromPath(graph: NavGraph, path: number[], lift = 0.08): Vec3[] {
  if (path.length === 0) return [];
  if (path.length === 1) {
    const p = nodePoint(graph, path[0], lift);
    return [p];
  }
  // Remove straight-through nodes.
  const simplified: number[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = simplified[simplified.length - 1];
    const b = path[i];
    const c = path[i + 1];
    const abx = graph.x[b] - graph.x[a];
    const abz = graph.z[b] - graph.z[a];
    const bcx = graph.x[c] - graph.x[b];
    const bcz = graph.z[c] - graph.z[b];
    const cross = abx * bcz - abz * bcx;
    const change = Math.abs(graph.y[c] - graph.y[a]);
    if (Math.abs(cross) > 0.02 || change > 0.08) simplified.push(b);
  }
  simplified.push(path[path.length - 1]);

  const points: Vec3[] = [];
  for (let i = 0; i < simplified.length; i++) {
    const node = simplified[i];
    const p: Vec3 = [graph.x[node], graph.y[node] + lift, graph.z[node]];
    if (i === 0 || i === simplified.length - 1) {
      points.push(p);
      continue;
    }
    const prev = simplified[i - 1];
    const next = simplified[i + 1];
    const ax = graph.x[prev] - graph.x[node];
    const az = graph.z[prev] - graph.z[node];
    const bx = graph.x[next] - graph.x[node];
    const bz = graph.z[next] - graph.z[node];
    const al = Math.hypot(ax, az);
    const bl = Math.hypot(bx, bz);
    if (al < 1e-5 || bl < 1e-5) {
      points.push(p);
      continue;
    }
    const d = Math.min(0.12, al * 0.35, bl * 0.35);
    const start: Vec3 = [graph.x[node] + (ax / al) * d, graph.y[node] + lift, graph.z[node] + (az / al) * d];
    const end: Vec3 = [graph.x[node] + (bx / bl) * d, graph.y[node] + lift, graph.z[node] + (bz / bl) * d];
    for (let step = 0; step <= 5; step++) {
      const t = step / 5;
      const u = 1 - t;
      points.push([
        u * u * start[0] + 2 * u * t * p[0] + t * t * end[0],
        u * u * start[1] + 2 * u * t * p[1] + t * t * end[1],
        u * u * start[2] + 2 * u * t * p[2] + t * t * end[2],
      ]);
    }
  }
  return points;
}

export function findBlocker(
  graph: NavGraph,
  start: number,
  goal: number,
  doors: Door[],
  doorStates: Map<string, DoorState>,
  inventory: Set<string>,
): Door | null {
  const path = findNavPath(graph, start, goal);
  if (!path) return null;
  for (const node of path) {
    for (const door of doors) {
      const state = doorStates.get(door.id) ?? door.state;
      if (state !== "locked") continue;
      if (keyForDoor({ ...door, state }, inventory) !== null) continue;
      if (Math.hypot(graph.x[node] - door.x, graph.z[node] - door.z) < 1.3 && Math.abs(graph.y[node] - door.y) < 2.0) {
        return door;
      }
    }
  }
  return null;
}
