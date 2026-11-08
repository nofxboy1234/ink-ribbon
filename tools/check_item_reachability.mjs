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

function inReach(item, seen) {
  const approach = approaches.get(item.id);
  if (approach >= 0 && seen[approach]) return true;
  // A locked door retargets its walk-next cell outside the blocked threshold,
  // so any reachable cell within its 8 m retarget radius unlocks it.
  const reach = item.blocks ? 8 : 2.5;
  for (let i = 0; i < count; i++) {
    if (!seen[i] || nodes[i].floor !== item.floor) continue;
    const dx = nodes[i].x - item.x;
    const dz = nodes[i].z - item.z;
    if (dx * dx + dz * dz <= reach * reach) return true;
  }
  return false;
}

const external = items.filter((item) => item.external_requires.length > 0);
const obtained = new Set();
const opened = new Set();
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
