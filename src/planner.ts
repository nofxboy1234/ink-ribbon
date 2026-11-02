import {
  blockedDoorEdges,
  findBlocker,
  findNavPath,
  nearestNode,
  nodePoint,
  routeFromPath,
  type NavGraph,
} from "./nav";
import {
  itemSatisfied,
  keyForDoor,
  type Door,
  type DoorState,
  type Item,
  type Vec3,
} from "./quest";

export type Target =
  | { kind: "item"; id: string }
  | { kind: "door"; id: string }
  | { kind: "cell"; node: number };

export type PlanStep =
  | { type: "move"; label: string; points: Vec3[]; endNode: number }
  | { type: "pickup"; label: string; itemId: string; node: number }
  | {
      type: "use-key";
      label: string;
      doorId: string;
      itemName: string;
      node: number;
    };

export type PlanState = {
  inventory: Set<string>;
  picked: Set<string>;
  doorStates: Map<string, DoorState>;
  cursorNode: number;
  cursor: Vec3;
};

export type PlanChoice = {
  kind: "move" | "pickup" | "use-key" | "info";
  label: string;
  itemId?: string;
  doorId?: string;
  itemName?: string;
};

export type Preview = {
  target: Target;
  label: string;
  anchor: Vec3;
  goalNode: number;
  points: Vec3[];
  steps: PlanStep[];
  choices: PlanChoice[];
};

type PlanStateArgs = {
  plan: readonly PlanStep[];
  inventory: ReadonlySet<string>;
  picked: ReadonlySet<string>;
  doorStates: ReadonlyMap<string, DoorState>;
  player: Vec3;
  nav: NavGraph;
  itemLookup: ReadonlyMap<string, Item>;
};

type PreviewArgs = {
  target: Target;
  state: PlanState;
  nav: NavGraph;
  doors: Door[];
  itemLookup: ReadonlyMap<string, Item>;
  itemNodes: ReadonlyMap<number, readonly Item[]>;
  cellLabel?: (node: number) => string;
  report?: (problem: string) => void;
};

type Segment = {
  steps: PlanStep[];
  points: Vec3[];
  inventory: Set<string>;
  doorStates: Map<string, DoorState>;
};

type SegmentResult =
  | { ok: true; segment: Segment }
  | { ok: false; problem: string };

const VERTICAL_WEIGHT = 1.15;
const CURSOR_LIFT = 0.45;
const DOOR_STOP_RADIUS = 1.5;
const DOOR_STOP_HEIGHT = 2.0;

function neighbors(nav: NavGraph, node: number): number[] {
  const result: number[] = [];
  for (let k = nav.first[node]; k < nav.first[node + 1]; k++) {
    result.push(nav.adjacency[k]);
  }
  return result;
}

function pathCost(nav: NavGraph, path: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    total += Math.hypot(
      nav.x[a] - nav.x[b],
      (nav.y[a] - nav.y[b]) * VERTICAL_WEIGHT,
      nav.z[a] - nav.z[b],
    );
  }
  return total;
}

function itemNodeOf(
  itemNodes: ReadonlyMap<number, readonly Item[]>,
  itemId: string,
): number | null {
  for (const [node, items] of itemNodes) {
    if (items.some((item) => item.id === itemId)) return node;
  }
  return null;
}

function occupiedNodes(
  itemNodes: ReadonlyMap<number, readonly Item[]>,
  picked: ReadonlySet<string>,
): Set<number> {
  const occupied = new Set<number>();
  for (const [node, items] of itemNodes) {
    if (items.some((item) => !picked.has(item.id))) occupied.add(node);
  }
  return occupied;
}

function bestApproach(
  nav: NavGraph,
  state: PlanState,
  candidates: readonly number[],
  blocked: Set<number>,
): number | null {
  let best: { node: number; cost: number } | null = null;
  for (const candidate of candidates) {
    const path = findNavPath(nav, state.cursorNode, candidate, blocked);
    if (!path) continue;
    const cost = pathCost(nav, path);
    if (!best || cost < best.cost) best = { node: candidate, cost };
  }
  return best?.node ?? null;
}

function blockerProblem(
  nav: NavGraph,
  state: PlanState,
  doors: Door[],
  goals: readonly number[],
  label: string,
): string {
  for (const goal of goals) {
    const blocker = findBlocker(
      nav,
      state.cursorNode,
      goal,
      doors,
      state.doorStates,
      state.inventory,
    );
    if (blocker) {
      return `No route to ${label}. ${blocker.label} is locked and needs ${blocker.requires.join(" / ")}.`;
    }
  }
  return `No route to ${label}.`;
}

function segmentPoints(
  nav: NavGraph,
  state: PlanState,
  path: readonly number[],
  fromIndex: number,
  toIndex: number,
): Vec3[] {
  const from =
    fromIndex === 0 ? state.cursor : nodePoint(nav, path[fromIndex], CURSOR_LIFT);
  return [
    from,
    ...routeFromPath(nav, path.slice(fromIndex, toIndex + 1), CURSOR_LIFT),
  ];
}

function planSegment(
  nav: NavGraph,
  doors: Door[],
  state: PlanState,
  goalNode: number,
  label: string,
): SegmentResult {
  const inventory = new Set(state.inventory);
  const doorStates = new Map(state.doorStates);
  const blocked = blockedDoorEdges(nav, doors, doorStates, inventory);
  const path = findNavPath(nav, state.cursorNode, goalNode, blocked);
  if (!path) {
    return {
      ok: false,
      problem: blockerProblem(nav, state, doors, [goalNode], label),
    };
  }

  const steps: PlanStep[] = [];
  const usedDoors = new Set<string>();
  let last = 0;
  for (let i = 0; i < path.length; i++) {
    for (const door of doors) {
      if (usedDoors.has(door.id)) continue;
      const stateForDoor = doorStates.get(door.id) ?? door.state;
      if (stateForDoor !== "locked") continue;
      if (Math.abs(nav.y[path[i]] - door.y) > DOOR_STOP_HEIGHT) continue;
      const distance = Math.hypot(
        nav.x[path[i]] - door.x,
        nav.z[path[i]] - door.z,
      );
      if (distance >= DOOR_STOP_RADIUS) continue;
      const key = keyForDoor({ ...door, state: stateForDoor }, inventory);
      if (!key) continue;
      if (i > last) {
        steps.push({
          type: "move",
          label: `Move to ${door.label}`,
          points: segmentPoints(nav, state, path, last, i),
          endNode: path[i],
        });
        last = i;
      }
      steps.push({
        type: "use-key",
        label: `Use ${key} on ${door.label}`,
        doorId: door.id,
        itemName: key,
        node: path[i],
      });
      inventory.delete(key);
      doorStates.set(door.id, "unlocked");
      usedDoors.add(door.id);
    }
  }
  if (last < path.length - 1) {
    steps.push({
      type: "move",
      label: `Move to ${label}`,
      points: segmentPoints(nav, state, path, last, path.length - 1),
      endNode: path[path.length - 1],
    });
  }

  return {
    ok: true,
    segment: {
      steps,
      points: [state.cursor, ...routeFromPath(nav, path, CURSOR_LIFT)],
      inventory,
      doorStates,
    },
  };
}

export function planStateFor(args: PlanStateArgs): PlanState {
  const inventory = new Set(args.inventory);
  const picked = new Set(args.picked);
  const doorStates = new Map(args.doorStates);
  const start = nearestNode(args.nav, args.player, 3.5);
  let cursorNode = start;
  let cursor = args.player;
  for (const step of args.plan) {
    if (step.type === "move") {
      cursorNode = step.endNode;
      cursor = nodePoint(args.nav, step.endNode, CURSOR_LIFT);
    } else if (step.type === "pickup") {
      const item = args.itemLookup.get(step.itemId);
      if (item) {
        inventory.add(item.name);
        picked.add(item.id);
      }
    } else {
      doorStates.set(step.doorId, "unlocked");
      inventory.delete(step.itemName);
    }
  }
  return { inventory, picked, doorStates, cursorNode, cursor };
}

export function buildPreview(args: PreviewArgs): Preview | null {
  const { target, state, nav, doors, itemLookup, itemNodes, cellLabel } = args;
  const problem = (reason: string): null => {
    args.report?.(reason);
    return null;
  };
  if (state.cursorNode < 0 || state.cursorNode >= nav.count) {
    return problem("Claire is not standing on a navigation cell.");
  }

  const occupied = occupiedNodes(itemNodes, state.picked);
  const blocked = blockedDoorEdges(
    nav,
    doors,
    state.doorStates,
    state.inventory,
  );
  let goalNode: number;
  let label: string;
  let anchor: Vec3;
  let moveLabel: string;
  let itemId: string | null = null;
  let door: Door | null = null;

  if (target.kind === "item") {
    const item = itemLookup.get(target.id);
    if (!item) return problem("No route.");
    const node = itemNodeOf(itemNodes, item.id);
    if (node === null) return problem(`No route to ${item.name}.`);
    const candidates = [...new Set(neighbors(nav, node))].filter(
      (candidate) => candidate !== node && !occupied.has(candidate),
    );
    if (candidates.length === 0) return problem("No adjacent walkable cell.");
    const approach = bestApproach(nav, state, candidates, blocked);
    if (approach === null) {
      return problem(blockerProblem(nav, state, doors, candidates, item.name));
    }
    goalNode = approach;
    label = item.name;
    anchor = [item.x, item.y, item.z];
    moveLabel = `Move to ${item.name}`;
    itemId = item.id;
  } else if (target.kind === "door") {
    door = doors.find((entry) => entry.id === target.id) ?? null;
    if (!door) return problem("No route.");
    label = door.label;
    anchor = [door.x, door.y, door.z];
    moveLabel = `Move to ${door.label}`;
    const nearest = nearestNode(nav, [door.x, door.y, door.z], 3.0);
    if (nearest < 0) return problem(`No route to ${door.label}.`);
    if (occupied.has(nearest)) {
      const candidates = [...new Set(neighbors(nav, nearest))].filter(
        (candidate) => candidate !== nearest && !occupied.has(candidate),
      );
      if (candidates.length === 0) return problem("No adjacent walkable cell.");
      const approach = bestApproach(nav, state, candidates, blocked);
      if (approach === null) {
        return problem(
          blockerProblem(nav, state, doors, candidates, door.label),
        );
      }
      goalNode = approach;
    } else {
      goalNode = nearest;
    }
  } else {
    const node = target.node;
    if (node < 0 || node >= nav.count) return problem("No route.");
    const room = cellLabel?.(node);
    label = room ? `${room} cell` : "Move here";
    anchor = [nav.x[node], nav.y[node] + CURSOR_LIFT, nav.z[node]];
    moveLabel = room ? `Move to ${label}` : "Move here";
    if (occupied.has(node)) {
      const candidates = [...new Set(neighbors(nav, node))].filter(
        (candidate) => candidate !== node && !occupied.has(candidate),
      );
      if (candidates.length === 0) return problem("No adjacent walkable cell.");
      const approach = bestApproach(nav, state, candidates, blocked);
      if (approach === null) {
        return problem(blockerProblem(nav, state, doors, [node], label));
      }
      goalNode = approach;
    } else {
      goalNode = node;
    }
  }

  const result = planSegment(nav, doors, state, goalNode, label);
  if (!result.ok) return problem(result.problem);
  const segment = result.segment;
  const choices: PlanChoice[] = [{ kind: "move", label: moveLabel }];

  if (target.kind === "item" && itemId !== null) {
    const item = itemLookup.get(itemId);
    if (item) {
      if (state.picked.has(item.id)) {
        choices.push({
          kind: "info",
          label: `Pick up ${item.name} (planned)`,
          itemId: item.id,
        });
      } else if (itemSatisfied(item, segment.inventory)) {
        choices.push({
          kind: "pickup",
          label: `Pick up ${item.name}`,
          itemId: item.id,
        });
      } else {
        choices.push({
          kind: "info",
          label: `Pick up ${item.name} · needs ${item.requires.join(" / ")}`,
          itemId: item.id,
        });
      }
    }
  } else if (door) {
    const stateForDoor = segment.doorStates.get(door.id) ?? door.state;
    if (door.puzzle) {
      choices.push({
        kind: "info",
        label: `Puzzle · requires ${door.requires.join(" / ")}`,
        doorId: door.id,
      });
    } else if (stateForDoor === "unknown") {
      choices.push({
        kind: "info",
        label: "Door state unknown",
        doorId: door.id,
      });
    } else if (stateForDoor === "locked") {
      const key = keyForDoor({ ...door, state: stateForDoor }, segment.inventory);
      if (key) {
        choices.push({
          kind: "use-key",
          label: `Use ${key} on ${door.label}`,
          doorId: door.id,
          itemName: key,
        });
      } else {
        choices.push({
          kind: "info",
          label: `Locked · needs ${door.requires.join(" / ") || "a key"}`,
          doorId: door.id,
        });
      }
    }
  }

  return {
    target,
    label,
    anchor,
    goalNode,
    points: segment.points,
    steps: segment.steps,
    choices,
  };
}

export function appendChoiceSteps(
  preview: Preview,
  choice: PlanChoice,
): PlanStep[] {
  if (choice.kind === "info") return [];
  if (choice.kind === "move") return preview.steps;
  if (choice.kind === "pickup" && choice.itemId) {
    return [
      ...preview.steps,
      {
        type: "pickup",
        label: choice.label,
        itemId: choice.itemId,
        node: preview.goalNode,
      },
    ];
  }
  if (choice.kind === "use-key" && choice.doorId && choice.itemName) {
    return [
      ...preview.steps,
      {
        type: "use-key",
        label: choice.label,
        doorId: choice.doorId,
        itemName: choice.itemName,
        node: preview.goalNode,
      },
    ];
  }
  return [];
}

export function planPath(plan: readonly PlanStep[]): Vec3[] {
  const points: Vec3[] = [];
  for (const step of plan) {
    if (step.type !== "move") continue;
    for (let i = points.length === 0 ? 0 : 1; i < step.points.length; i++) {
      points.push(step.points[i]);
    }
  }
  return points;
}
