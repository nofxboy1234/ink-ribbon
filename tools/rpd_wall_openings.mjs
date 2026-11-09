#!/usr/bin/env node
// The paper plan draws walls as continuous runs, but the navigation lattice
// passes through several of them: a 1 m lattice edge can cross a hairline wall
// that no cell-clearance test sees. Split those wall boxes where a flat nav
// edge crosses them so the rendered wall matches the grey nav the route uses.
//
// Idempotent: rerunning after the openings exist finds no crossings and leaves
// the file untouched.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const planPath = resolve(root, "public/rpd/plan.json");
const navPath = resolve(root, "public/rpd/nav.json");
const OPENING = 2.0;
const SAMPLE = 0.05;
const HEIGHT = 1.7;
const MIN_PART = 0.05;

const plan = JSON.parse(readFileSync(planPath, "utf8"));
const nav = JSON.parse(readFileSync(navPath, "utf8"));

const boxes = [];
for (const floor of plan.floors) {
  let index = 0;
  for (const box of floor.boxes) {
    if (box.faces === "top") continue;
    boxes.push({ floor: floor.index, index, box });
    index += 1;
  }
}

function boxesOnFloor(floor) {
  return boxes.filter((entry) => entry.floor === floor);
}

const cuts = new Map();
const seen = new Set();
let crossingEdges = 0;
let nodes = nav.nodes;
for (let a = 0; a < nodes.length; a += 1) {
  const na = nodes[a];
  if ((na.kind ?? "floor") !== "floor") continue;
  for (const b of na.n) {
    const key = Math.min(a, b) * nodes.length + Math.max(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    if (b < a) continue;
    const nb = nodes[b];
    if ((nb.kind ?? "floor") !== "floor" || nb.floor !== na.floor) continue;
    const dx = nb.x - na.x;
    const dy = nb.y - na.y;
    const dz = nb.z - na.z;
    const length = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(length / SAMPLE));
    let crossed = false;
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = na.x + dx * t;
      const y = na.y + dy * t;
      const z = na.z + dz * t;
      for (const entry of boxesOnFloor(na.floor)) {
        const box = entry.box;
        if (!(box.y1 > y + 1e-4 && box.y0 < y + HEIGHT)) continue;
        if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) continue;
        const alongX = box.x1 - box.x0 >= box.z1 - box.z0;
        const key = `${entry.floor}:${entry.index}`;
        if (!cuts.has(key)) cuts.set(key, []);
        cuts.get(key).push(alongX ? x : z);
        crossed = true;
      }
    }
    if (crossed) crossingEdges += 1;
  }
}

if (cuts.size === 0) {
  console.log("render wall openings: none needed");
  process.exit(0);
}

let split = 0;
for (const floor of plan.floors) {
  let index = 0;
  const next = [];
  for (const box of floor.boxes) {
    if (box.faces === "top") {
      next.push(box);
      continue;
    }
    const list = cuts.get(`${floor.index}:${index}`);
    index += 1;
    if (!list) {
      next.push(box);
      continue;
    }
    const alongX = box.x1 - box.x0 >= box.z1 - box.z0;
    const intervals = list
      .map((at) => [at - OPENING / 2, at + OPENING / 2])
      .sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const lo = alongX ? box.x0 : box.z0;
    const hi = alongX ? box.x1 : box.z1;
    let cursor = lo;
    const parts = [];
    for (const [start, end] of merged) {
      const clamped = Math.min(end, hi);
      if (start > cursor) parts.push([cursor, Math.min(start, hi)]);
      cursor = Math.max(cursor, clamped);
    }
    if (cursor < hi) parts.push([cursor, hi]);
    for (const [start, end] of parts) {
      if (end - start < MIN_PART) continue;
      const part = { ...box };
      if (alongX) {
        part.x0 = round(start);
        part.x1 = round(end);
      } else {
        part.z0 = round(start);
        part.z1 = round(end);
      }
      next.push(part);
      split += 1;
    }
  }
  floor.boxes = next;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
console.log(
  `render wall openings: ${crossingEdges} crossed nav edges, ${cuts.size} wall boxes split into ${split} pieces`,
);
