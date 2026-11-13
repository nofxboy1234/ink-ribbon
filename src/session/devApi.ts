import type { RefObject } from "react";
import type { buildNavGraph } from "../nav";
import type { Quest, Vec3 } from "../quest";
import type { RpdClient } from "../wasm/client";

type NavGraph = ReturnType<typeof buildNavGraph>;

export function projectPoint(
  point: Vec3,
  vp: Float32Array,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const [x, y, z] = point;
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (cw <= 0.0001) return null;
  return {
    x: (cx / cw * 0.5 + 0.5) * width,
    y: (1 - (cy / cw * 0.5 + 0.5)) * height,
  };
}

export function createDevApi(options: {
  client: RpdClient;
  graph: NavGraph;
  canvas: RefObject<HTMLCanvasElement | null>;
  rooms: Quest["rooms"];
  activeFloor: number;
  setActiveFloor: (index: number) => void;
}) {
  const { client, graph, canvas, rooms, activeFloor, setActiveFloor } = options;
return {
  debug: () => {
    const p = client.planPlayer();
    return {
      player: [p[0], p[1], p[2]] as Vec3,
      plan: Array.from({ length: client.planCount() }, () => 0),
      waypoints: Array.from({ length: client.planCount() }, (_, index) => client.planWaypoint(index)),
      moving: client.planMoving() !== 0,
      routePoints: client.planRouteCount(),
      move: Array.from(client.planMoveState()),
      room: client.planRoom(),
      activeFloor,
      playerFloor: (() => {
        let best = -1;
        let bestDistance = Infinity;
        for (let i = 0; i < graph.count; i += 1) {
          const distance = Math.hypot(
            graph.x[i] - p[0],
            graph.y[i] - p[1],
            graph.z[i] - p[2],
          );
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }
        return best >= 0 ? graph.floor[best] : -1;
      })(),
    };
  },
  setFloor: (index: number) => {
    client.planSetFloor(index);
    setActiveFloor(index);
  },
  setPlayer: (x: number, y: number, z: number) => client.planSetPlayer(x, y, z),
  addTarget: (x: number, z: number) => client.planAddTarget(x, 0, z),
  addTargetNode: (node: number) => client.planAddTargetNode(node),
  hover: () => client.planHover(),
  hoverItem: () => client.planHoverItem(),
  cellBlocked: (node: number) => client.planNodeBlocked(node) !== 0,
  items: () => {
    const out = [];
    for (let i = 0; i < client.itemCount(); i += 1) {
      const item = client.item(i);
      if (item) out.push({ index: i, ...item });
    }
    return out;
  },
  inventory: () => {
    const slots = client.inventory();
    return Array.from({ length: 8 }, (_, index) => {
      if (slots[index * 4] === 0) return null;
      const itemIndex = client.inventoryItem(index);
      const item = itemIndex >= 0 ? client.item(itemIndex) : null;
      return {
        name: item?.name ?? "",
        r: Math.round(slots[index * 4 + 1] * 255),
        g: Math.round(slots[index * 4 + 2] * 255),
        b: Math.round(slots[index * 4 + 3] * 255),
      };
    });
  },
  itemByName: (title: string) => {
    for (let i = 0; i < client.itemCount(); i += 1) {
      const item = client.item(i);
      if (item?.name === title) return i;
    }
    return -1;
  },
  actItem: (index: number) => client.itemAct(index),
  itemDebugTake: (index: number) => client.itemDebugTake(index),
  itemDebugOpen: (index: number) => client.itemDebugOpen(index),
  itemDebugSolve: (index: number) => client.itemDebugSolve(index),
  itemRelated: (index: number) => client.itemRelated(index),
  itemDebugHighlight: (index: number) => client.itemDebugHighlight(index),
  itemDebugHighlighted: () => client.itemDebugHighlighted(),
  discardItem: (index: number) => client.itemDiscard(index),
  boxStore: (index: number) => client.boxStore(index),
  boxTake: (slot: number) => client.boxTake(slot),
  saveSnapshot: () => Array.from(client.saveSnapshot()),
  doorsCount: () => client.doorsCount(),
  enemies: () => Array.from({ length: client.enemyCount() }, (_, index) => {
    const position = client.enemyPosition(index);
    return { index, health: client.enemyHealth(index), visible: client.enemyVisible(index) !== 0, x: position[0], y: position[1], z: position[2] };
  }),
  doorsDiscovered: (index: number) => client.doorsDiscovered(index),
  goToItem: (index: number) => client.planTeleportItem(index),
  itemTransitionTarget: (index: number) => client.itemTransitionTarget(index),
  enemyAlive: () => client.enemyAlive(),
  health: () => client.health(),
  ending: () => client.ending(),
  shoot: (index: number, stationary: boolean) => client.shoot(index, stationary),
  stab: (index: number) => client.stab(index),
  craftResult: (first: number, second: number) => client.craftResult(first, second),
  craftCombine: (first: number, second: number) => client.craftCombine(first, second),
  saveRestore: (bytes: number[]) => client.saveRestore(Uint8Array.from(bytes)),
  box: () => {
    const count = client.boxCount();
    return Array.from({ length: count }, (_, slot) => {
      const itemIndex = client.boxItem(slot);
      const item = itemIndex >= 0 ? client.item(itemIndex) : null;
      return { slot, index: itemIndex, name: item?.name ?? "" };
    });
  },
  toggleDebug: () => client.toggleDebug(),
  debugEnabled: () => client.debugEnabled(),
  enterCode: (index: number, code: string) => client.itemEnterCode(index, code),
  grantExternal: (id: number) => client.itemGrantExternal(id),
  itemBlocked: (index: number) => client.itemBlocked(index),
  itemHasCode: (index: number) => client.itemHasCode(index),
  itemHint: (index: number) => client.itemHint(index),
  standAt: (index: number) => {
    const item = client.item(index);
    if (!item) return false;
    client.planSetPlayer(item.x + 0.9, item.y, item.z);
    return true;
  },
  standNextTo: (index: number) => {
    const item = client.item(index);
    if (!item) return false;
    client.planSetPlayer(item.x + 0.9, item.y, item.z);
    return true;
  },
  run: () => client.gameRun() !== 0,
  setRun: (on: boolean) => client.gameSetRun(on),
  walkableCell: () => {
    const blocked = new Set<number>();
    for (let i = 0; i < graph.count; i += 1) {
      if (client.planNodeBlocked(i)) blocked.add(i);
    }
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return null;
    const playerArray = client.planPlayer();
    const player: Vec3 = [playerArray[0], playerArray[1], playerArray[2]];
    const viewProj = client.getViewProj();
    const playerScreen = projectPoint(player, viewProj, rect.width, rect.height);
    const itemScreens = Array.from({ length: client.itemCount() }, (_, index) => {
      const item = client.item(index);
      if (!item || item.hidden || item.floor !== activeFloor) return null;
      return projectPoint([item.cubeX, item.cubeY, item.cubeZ], viewProj, rect.width, rect.height);
    }).filter(Boolean);
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < graph.count; i += 1) {
      if (graph.floor[i] !== activeFloor || blocked.has(i)) continue;
      if (playerScreen) {
        const screen = projectPoint(
          [graph.x[i], graph.y[i] + 0.06, graph.z[i]],
          viewProj,
          rect.width,
          rect.height,
        );
        if (screen && Math.hypot(screen.x - playerScreen.x, screen.y - playerScreen.y) < 90) {
          continue;
        }
        if (screen && itemScreens.some((item) => item && Math.hypot(screen.x - item.x, screen.y - item.y) < 26)) {
          continue;
        }
      }
      const distance = Math.hypot(graph.x[i], graph.z[i] - 4);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    if (best < 0) return null;
    return {
      node: best,
      world: [graph.x[best], graph.y[best], graph.z[best]],
      screen: projectPoint(
        [graph.x[best], graph.y[best] + 0.06, graph.z[best]],
        client.getViewProj(),
        rect.width,
        rect.height,
      ),
    };
  },
  popup: () => {
    const state = client.popupState();
    const choices: unknown[] = [];
    for (let i = 0; i < state[6]; i += 1) {
      const choice = client.popupChoice(i);
      if (choice) choices.push(choice);
    }
    return {
      open: state[7] === 1,
      menu: state[8] === 1,
      node: state[1],
      item: state[2],
      hover: state[3],
      anchor: [state[4], state[5]],
      message: client.popupMessage(),
      choices,
    };
  },
  reset: () => client.planClearRoute(),
  clearRoute: () => client.planClearRoute(),
  openPopupAt: (x: number, z: number) => client.openPopupAt(x, z) !== 0,
  resetView: () => client.resetView(),
  recenter: () => client.recenter(),
  camera: () => Array.from(client.planCamera()),
  cameraPose: () => Array.from(client.getCamera()),
  cameraModel: () => Array.from(client.cameraModel()),
  debugFloors: () => Array.from(client.debugFloors()),
  overlayStats: () => Array.from(client.overlayStats()),
  rooms: () => rooms,
  nearestCell: (x: number, z: number) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return null;
    const blocked = new Set<number>();
    for (let i = 0; i < graph.count; i += 1) {
      if (client.planNodeBlocked(i)) blocked.add(i);
    }
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < graph.count; i += 1) {
      if (graph.floor[i] !== activeFloor || blocked.has(i)) continue;
      const distance = Math.hypot(graph.x[i] - x, graph.z[i] - z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    if (best < 0) return null;
    return {
      node: best,
      world: [graph.x[best], graph.y[best], graph.z[best]],
      screen: projectPoint(
        [graph.x[best], graph.y[best] + 0.06, graph.z[best]],
        client.getViewProj(),
        rect.width,
        rect.height,
      ),
    };
  },
  checkPath: () => {
    const route = client.planRoute();
    const points = route.length / 3;
    const cellKey = (floor: number, ix: number, iz: number) => `${floor}:${ix}:${iz}`;
    const cells = new Map<string, number>();
    for (let i = 0; i < graph.count; i += 1) {
      cells.set(
        cellKey(graph.floor[i], Math.floor(graph.x[i]), Math.floor(graph.z[i])),
        i,
      );
    }
    const radius = client.routeRadius();
    const visualRadius = client.playerRadius();
    const portalNodes = new Set<number>();
    for (const [a, b] of graph.portals) {
      portalNodes.add(a);
      portalNodes.add(b);
    }
    let bad = 0;
    let samples = 0;
    let worst = 0;
    let clearance = Infinity;
    let clearanceAt: number[] | null = null;
    const lift = 0.08;
    for (let i = 0; i + 1 < points; i += 1) {
      const ax = route[i * 3];
      const ay = route[i * 3 + 1];
      const az = route[i * 3 + 2];
      const bx = route[i * 3 + 3];
      const by = route[i * 3 + 4];
      const bz = route[i * 3 + 5];
      const length = Math.hypot(bx - ax, by - ay, bz - az);
      const steps = Math.max(1, Math.ceil(length / 0.1));
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        const px = ax + (bx - ax) * t;
        const py = ay + (by - ay) * t;
        const pz = az + (bz - az) * t;
        const ix = Math.floor(px);
        const iz = Math.floor(pz);
        let found = false;
        let foundNode = -1;
        let nearest = Infinity;
        for (const floor of graph.floors) {
          const node = cells.get(cellKey(floor.index, ix, iz));
          if (node === undefined) continue;
          if (Math.abs(graph.y[node] + lift - py) > 0.9) continue;
          found = true;
          foundNode = node;
          nearest = Math.min(nearest, Math.hypot(graph.x[node] - px, graph.z[node] - pz));
        }
        samples += 1;
        if (!found) bad += 1;
        else {
          if (nearest > worst) worst = nearest;
          const node = foundNode;
          const exempt =
            node < 0 ||
            portalNodes.has(node) ||
            Math.abs(graph.x[node] * 2 - Math.round(graph.x[node] * 2)) > 1e-3 ||
            Math.abs(graph.z[node] * 2 - Math.round(graph.z[node] * 2)) > 1e-3;
          if (!exempt) {
            let wall = Infinity;
            for (let gx = ix - 1; gx <= ix + 1; gx += 1) {
              for (let gz = iz - 1; gz <= iz + 1; gz += 1) {
                const owner = cells.get(cellKey(graph.floor[node], gx, gz));
                if (owner !== undefined && !client.planNodeBlocked(owner)) continue;
                const cx = Math.min(Math.max(px, gx), gx + 1);
                const cz = Math.min(Math.max(pz, gz), gz + 1);
                wall = Math.min(wall, Math.hypot(cx - px, cz - pz));
              }
            }
            if (wall - radius < clearance) {
              clearance = wall - radius;
              clearanceAt = [px, py, pz];
            }
          }
        }
      }
    }
    return {
      points,
      samples,
      bad,
      worst,
      clearance: Number.isFinite(clearance) ? clearance : 0,
      clearanceAt,
      radius,
      visualRadius,
      nodes: graph.count,
      edges: graph.edgeCount,
    };
  },
  navNode: (index: number) =>
    index < 0 || index >= graph.count
      ? null
      : { index, x: graph.x[index], y: graph.y[index], z: graph.z[index], floor: graph.floor[index] },
  nearestNavNode: (floor: number, x: number, y: number, z: number) => {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < graph.count; i += 1) {
      if (graph.floor[i] !== floor) continue;
      const dx = graph.x[i] - x;
      const dy = (graph.y[i] - y) * 1.4;
      const dz = graph.z[i] - z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    return best < 0 ? null : { index: best, x: graph.x[best], y: graph.y[best], z: graph.z[best] };
  },
  hoverRoute: () => client.planHoverRoute(),
  mapDoors: (floor: number) => client.mapDoors(floor),
  mapRevealed: (floor: number) => client.mapRevealed(floor),
  waypointRun: (index: number) => client.planWaypointRun(index),
  moveRun: () => client.planMoveRun(),
  project: (x: number, y: number, z: number) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return null;
    return projectPoint([x, y, z], client.getViewProj(), rect.width, rect.height);
  },
};
}
