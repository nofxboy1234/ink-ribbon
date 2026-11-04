import type { NavGraph } from "../nav";
import { DOOR_COLOURS, type DoorState, type Quest, type Vec3 } from "../quest";
import type { PlanStep, Preview } from "../planner";

type RGBA = [number, number, number, number];

export type MapGeometryInput = {
  nav: NavGraph;
  quest: Quest;
  floor: number;
  discovered: ReadonlySet<string>;
  doorStates: ReadonlyMap<string, DoorState>;
  plan: readonly PlanStep[];
  planPath: readonly Vec3[];
  preview: Preview | null;
  hoverNode: number | null;
};

const FLOOR: RGBA = [0.38, 0.48, 0.6, 0.1];
const STAIR: RGBA = [0.78, 0.59, 0.28, 0.26];
const RAMP: RGBA = [0.35, 0.69, 0.85, 0.26];
const NAV_BORDER: RGBA = [0.37, 0.65, 0.9, 0.5];
const HOVER: RGBA = [0.22, 1.0, 0.08, 0.3];
const HOVER_EDGE: RGBA = [0.22, 1.0, 0.08, 0.95];
const ROUTE: RGBA = [0.26, 1.0, 0.45, 0.95];
const PREVIEW: RGBA = [1.0, 0.62, 0.24, 0.9];
const WAYPOINT: RGBA = [0.13, 0.83, 0.93, 0.42];

function pushQuad(
  out: number[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
  colour: RGBA,
) {
  const [r, g, b, a] = colour;
  out.push(
    ax, az, r, g, b, a,
    bx, bz, r, g, b, a,
    cx, cz, r, g, b, a,
    ax, az, r, g, b, a,
    cx, cz, r, g, b, a,
    dx, dz, r, g, b, a,
  );
}

function pushRect(out: number[], x: number, z: number, w: number, h: number, colour: RGBA) {
  pushQuad(
    out,
    x - w / 2, z - h / 2,
    x + w / 2, z - h / 2,
    x + w / 2, z + h / 2,
    x - w / 2, z + h / 2,
    colour,
  );
}

function pushSegment(
  out: number[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  width: number,
  colour: RGBA,
) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-5) return;
  const nx = (-dz / len) * width * 0.5;
  const nz = (dx / len) * width * 0.5;
  pushQuad(out, ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz, ax - nx, az - nz, colour);
}

function pushDisc(out: number[], x: number, z: number, r: number, colour: RGBA, segments = 14) {
  const [cr, cg, cb, ca] = colour;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    out.push(
      x, z, cr, cg, cb, ca,
      x + Math.cos(a0) * r, z + Math.sin(a0) * r, cr, cg, cb, ca,
      x + Math.cos(a1) * r, z + Math.sin(a1) * r, cr, cg, cb, ca,
    );
  }
}

export function buildMapGeometry({
  nav,
  quest,
  floor,
  discovered,
  doorStates,
  plan,
  planPath,
  preview,
  hoverNode,
}: MapGeometryInput): Float32Array {
  const out: number[] = [];
  const active: number[] = [];
  for (let i = 0; i < nav.count; i++) {
    if (nav.floor[i] === floor) active.push(i);
  }
  const half = nav.half;
  const step = nav.step;

  for (const node of active) {
    const x = nav.x[node];
    const z = nav.z[node];
    const colour = nav.kind[node] === 1 ? STAIR : nav.kind[node] === 2 ? RAMP : FLOOR;
    pushRect(out, x, z, step, step, colour);
    const edge = Math.max(0.035, step * 0.035);
    pushRect(out, x, z - half, step, edge, NAV_BORDER);
    pushRect(out, x, z + half, step, edge, NAV_BORDER);
    pushRect(out, x - half, z, edge, step, NAV_BORDER);
    pushRect(out, x + half, z, edge, step, NAV_BORDER);
  }

  if (hoverNode !== null && hoverNode >= 0 && hoverNode < nav.count && nav.floor[hoverNode] === floor) {
    const x = nav.x[hoverNode];
    const z = nav.z[hoverNode];
    pushRect(out, x, z, step, step, HOVER);
    const edge = Math.max(0.04, step * 0.04);
    pushRect(out, x, z - half, step, edge, HOVER_EDGE);
    pushRect(out, x, z + half, step, edge, HOVER_EDGE);
    pushRect(out, x - half, z, edge, step, HOVER_EDGE);
    pushRect(out, x + half, z, edge, step, HOVER_EDGE);
  }

  const floorLevel = quest.floors[floor]?.level ?? 0;
  const floorPoints = planPath.filter((point) => Math.abs(point[1] - floorLevel) < 2.5);
  for (let i = 1; i < floorPoints.length; i++) {
    pushSegment(
      out,
      floorPoints[i - 1][0], floorPoints[i - 1][2],
      floorPoints[i][0], floorPoints[i][2],
      0.22,
      ROUTE,
    );
  }

  if (preview) {
    const previewPoints = preview.points.filter((point) => Math.abs(point[1] - floorLevel) < 2.5);
    for (let i = 1; i < previewPoints.length; i++) {
      pushSegment(
        out,
        previewPoints[i - 1][0], previewPoints[i - 1][2],
        previewPoints[i][0], previewPoints[i][2],
        0.18,
        PREVIEW,
      );
    }
  }

  for (const planStep of plan) {
    const node = planStep.type === "move" ? planStep.endNode : planStep.node;
    if (node < 0 || node >= nav.count || nav.floor[node] !== floor) continue;
    pushRect(out, nav.x[node], nav.z[node], step, step, WAYPOINT);
  }

  for (const door of quest.doors) {
    if (Math.abs(door.y - floorLevel) >= 2.5) continue;
    const rgb = DOOR_COLOURS[doorStates.get(door.id) ?? door.state];
    pushRect(out, door.x, door.z, 0.22, 0.22, [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1]);
  }

  for (const item of quest.items) {
    if (!discovered.has(item.id)) continue;
    if (Math.abs(item.y - floorLevel - 0.36) >= 0.8) continue;
    const rgb = item.rgb;
    pushDisc(out, item.x, item.z, 0.2, [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1]);
  }

  return new Float32Array(out);
}
