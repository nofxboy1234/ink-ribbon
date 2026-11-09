#!/usr/bin/env node
// Prove every key a navigation gate, container or code lock needs is itself
// obtainable along the route graph. The graph and the door obstacles use the
// same inputs and radius as the wasm route: nav.json, item_registry.json and
// the spawn from quest.json.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const registry = read("public/rpd/item_registry.json");
const nav = read("public/rpd/nav.json");
const quest = read("public/rpd/quest.json");
const radius = registry.block_radius;
const items = registry.items;
const byId = new Map(items.map((item) => [item.id, item]));
const nodes = nav.nodes;
const count = nodes.length;

const adjacency = Array.from({ length: count }, () => []);
for (let i = 0; i < count; i++) {
  for (const j of nodes[i].n) {
    adjacency[i].push(j);
    adjacency[j].push(i);
  }
}

const spawnNode = nearestNode(quest.spawn[0], 0, quest.spawn[2], 12);
if (spawnNode < 0) throw new Error("no spawn node on floor 0");

function nearestNode(x, floor, z, maxDistance) {
  let best = -1;
  let bestDistance = maxDistance * maxDistance;
  for (let i = 0; i < count; i++) {
    if (nodes[i].floor !== floor) continue;
    const dx = nodes[i].x - x;
    const dz = nodes[i].z - z;
    const distance = dx * dx + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function approachNode(item) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < count; i++) {
    if (nodes[i].floor !== item.floor) continue;
    const dx = nodes[i].x - item.x;
    const dy = (nodes[i].y - item.y) * 1.4;
    const dz = nodes[i].z - item.z;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

const approaches = new Map(items.map((item) => [item.id, approachNode(item)]));

// The floors only meet at the explicit stair chains. Every other edge stays on
// its own floor, and every floor's main component joins the spawn component.
const portalPairs = new Set(
  (nav.portals ?? []).map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`),
);
const neighbours = Array.from({ length: count }, () => []);
const parent = Array.from({ length: count }, (_, index) => index);
const find = (node) => {
  while (parent[node] !== node) {
    parent[node] = parent[parent[node]];
    node = parent[node];
  }
  return node;
};
const union = (a, b) => {
  const rootA = find(a);
  const rootB = find(b);
  if (rootA !== rootB) parent[rootB] = rootA;
};
for (let i = 0; i < count; i++) {
  for (const j of nodes[i].n) {
    if (!Number.isInteger(j) || j < 0 || j >= count) {
      throw new Error(`node ${i} points at missing node ${j}`);
    }
    if (nodes[i].floor !== nodes[j].floor) {
      const stair = nodes[i].kind === "stair" && nodes[j].kind === "stair";
      const portal = portalPairs.has(`${Math.min(i, j)}:${Math.max(i, j)}`);
      if (!stair && !portal) {
        throw new Error(`node ${i} on floor ${nodes[i].floor} links to node ${j} on floor ${nodes[j].floor} without a portal`);
      }
    }
    neighbours[i].push(j);
    union(i, j);
  }
}
for (let i = 0; i < count; i++) {
  for (const j of neighbours[i]) {
    if (!neighbours[j].includes(i)) throw new Error(`edge ${i}->${j} is one-way`);
  }
}
const spawnRoot = find(spawnNode);
for (const floor of nav.floors) {
  const sizes = new Map();
  for (let i = 0; i < count; i++) {
    if (nodes[i].floor !== floor.index) continue;
    const root = find(i);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  const sorted = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted[0][0] !== spawnRoot) {
    throw new Error(`floor ${floor.label} has no component reachable from spawn`);
  }
  const isolated = sorted.slice(1).reduce((total, [, size]) => total + size, 0);
  if (isolated) {
    console.warn(`warning: floor ${floor.label} has ${isolated} cells in ${sorted.length - 1} wall-separated components`);
  }
}
for (const id of [544665, 545830]) {
  const approach = approaches.get(id);
  if (approach === undefined || approach < 0 || find(approach) !== spawnRoot) {
    throw new Error(`gate ${id} has no approach node reachable from spawn`);
  }
}
console.log("nav graph ok: floor edges stay on their floor, every floor joins the spawn component");

function reachable(opened) {
  const blocked = new Set();
  for (const door of items) {
    if (!door.blocks || opened.has(door.id)) continue;
    for (let i = 0; i < count; i++) {
      if (nodes[i].floor !== door.floor) continue;
      const dx = nodes[i].x - door.x;
      const dz = nodes[i].z - door.z;
      if (dx * dx + dz * dz <= radius * radius) blocked.add(i);
    }
  }
  const seen = new Uint8Array(count);
  const stack = [spawnNode];
  seen[spawnNode] = 1;
  while (stack.length) {
    const current = stack.pop();
    for (const next of adjacency[current]) {
      if (seen[next] || blocked.has(next)) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
  return seen;
}

const ITEM_REACH = 2.5;

function distance2(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = (ay - by) * 1.4;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

function inReach(item, seen) {
  const approach = approaches.get(item.id);
  if (approach >= 0 && seen[approach]) return true;
  // Unlocking is an item action, so the player must stand within the item's
  // interaction reach. The 8 m walk-next retarget only picks the cell to walk
  // to; it does not put the door in range.
  for (let i = 0; i < count; i++) {
    if (!seen[i] || nodes[i].floor !== item.floor) continue;
    if (distance2(nodes[i].x, nodes[i].y, nodes[i].z, item.x, item.y, item.z) <= ITEM_REACH * ITEM_REACH) {
      return true;
    }
  }
  return false;
}

const external = items.filter((item) => item.external_requires.length > 0);
const obtained = new Set();
const opened = new Set();
const openOrder = [];
let changed = true;
while (changed) {
  changed = false;
  const seen = reachable(opened);
  for (const item of items) {
    if (opened.has(item.id)) continue;
    if (item.hidden_by !== null && !opened.has(item.hidden_by)) continue;
    if (!inReach(item, seen)) continue;
    if (item.requires.some((id) => !obtained.has(id))) continue;
    if (item.requires_open.some((id) => !opened.has(id))) continue;
    if (item.external_requires.some((entry) => !externalCarried(entry.id))) continue;
    if (item.action === "take") {
      obtained.add(item.id);
      opened.add(item.id);
    } else if (item.action !== "none") {
      opened.add(item.id);
    } else {
      continue;
    }
    openOrder.push(item.id);
    changed = true;
  }
}

function externalCarried() {
  return false;
}

const failures = [];
const gates = items.filter((item) => item.blocks || item.contents.length > 0);
for (const gate of gates) {
  for (const id of gate.requires) {
    if (obtained.has(id)) continue;
    failures.push(`${gate.title} (${gate.id}) needs ${byId.get(id)?.title ?? id}, which is not obtainable`);
  }
  for (const id of gate.requires_open) {
    if (opened.has(id)) continue;
    failures.push(`${gate.title} (${gate.id}) needs ${byId.get(id)?.title ?? id} open, which never opens`);
  }
}

function nearestReachable(item, seen) {
  let best = Infinity;
  for (let i = 0; i < count; i++) {
    if (!seen[i] || nodes[i].floor !== item.floor) continue;
    const distance = distance2(nodes[i].x, nodes[i].y, nodes[i].z, item.x, item.y, item.z);
    if (distance < best) best = distance;
  }
  return best;
}

function threshold(item, seen) {
  let total = 0;
  let reachableCells = 0;
  for (let i = 0; i < count; i++) {
    if (nodes[i].floor !== item.floor) continue;
    const dx = nodes[i].x - item.x;
    const dz = nodes[i].z - item.z;
    if (dx * dx + dz * dz > radius * radius) continue;
    total += 1;
    if (seen[i]) reachableCells += 1;
  }
  return { total, reachable: reachableCells };
}

const openIndex = new Map(openOrder.map((id, index) => [id, index]));
for (const door of items.filter((item) => item.blocks)) {
  const at = openIndex.get(door.id);
  if (at === undefined) continue;
  const before = new Set(openOrder.slice(0, at));
  const lockedSeen = reachable(before);
  const locked = threshold(door, lockedSeen);
  if (locked.total === 0) {
    failures.push(`${door.title} (${door.id}) blocks no nav cells`);
  } else if (locked.reachable !== 0) {
    failures.push(`${door.title} (${door.id}) does not block its threshold while locked`);
  }
  const nearest = nearestReachable(door, lockedSeen);
  if (nearest > ITEM_REACH * ITEM_REACH) {
    failures.push(
      `${door.title} (${door.id}) has no reachable cell within ${ITEM_REACH} m while locked (nearest ${Math.sqrt(nearest).toFixed(2)} m)`,
    );
  }
  for (const id of door.requires) {
    if (before.has(id)) continue;
    failures.push(`${door.title} (${door.id}) opened without ${byId.get(id)?.title ?? id}`);
  }
  const after = new Set(before);
  after.add(door.id);
  if (threshold(door, reachable(after)).reachable === 0) {
    failures.push(`${door.title} (${door.id}) does not reopen its threshold when unlocked`);
  }
}

const boltCutters = openIndex.get(544408);
const chainedDoor = openIndex.get(544407);
if (boltCutters !== undefined && chainedDoor !== undefined && boltCutters > chainedDoor) {
  failures.push("Chained Door (544407) opened before the Bolt Cutters (544408)");
}

const unreachableDoors = items.filter((item) => item.blocks && !opened.has(item.id));
if (unreachableDoors.length) {
  console.warn(
    `warning: ${unreachableDoors.length} mapped doors sit outside the walkable component: ${unreachableDoors
      .map((item) => `${item.title} (${item.id})`)
      .join(", ")}`,
  );
}

for (const failure of failures) console.error(`FAIL ${failure}`);
if (failures.length) process.exit(1);

console.log(
  `item reachability ok: ${gates.length} gates, ${items.filter((item) => item.blocks).length} mapped doors, ${obtained.size} obtainable items, ${external.length} external requirement left out of the route graph`,
);
