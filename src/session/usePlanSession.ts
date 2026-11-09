import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { buildNavGraph, nearestNode, type NavFile } from "../nav";
import type { Floor, Quest, Vec3 } from "../quest";
import { createRpdClient, type RpdClient } from "../wasm/client";
import { CACHE_VERSION, fetchScene } from "./scene";

export type InventoryEntry = {
  name: string;
  r: number;
  g: number;
  b: number;
};

export type CodeLock = {
  item: number;
  title: string;
  hint: string;
  hintKnown: boolean;
};

export type PlanSession = {
  state: {
    loaded: boolean;
    error: string | null;
    progress: number;
    floors: Floor[];
    activeFloor: number;
    view2D: boolean;
    planCount: number;
    moving: boolean;
    room: string;
    inventory: (InventoryEntry | null)[];
    codeLock: CodeLock | null;
  };
  ref: { canvas: RefObject<HTMLCanvasElement | null> };
  set: { activeFloor: (index: number) => void };
  actions: {
    setFloor: (index: number) => void;
    toggleView: () => void;
    clearRoute: () => void;
    resetView: () => void;
    recenter: () => void;
    enterCode: (code: string) => number;
    closeCodeEntry: () => void;
  };
};

function projectPoint(
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

export function usePlanSession(
  assetUrl = "/rpd/rpd.bin",
  onLoaded?: (client: RpdClient, graph: ReturnType<typeof buildNavGraph>) => void,
): PlanSession {
  const canvas = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<RpdClient | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [activeFloor, setActiveFloor] = useState(0);
  const [view2D, setView2D] = useState(false);
  const [planCount, setPlanCount] = useState(0);
  const [moving, setMoving] = useState(false);
  const [room, setRoom] = useState("RPD");
  const [inventory, setInventory] = useState<(InventoryEntry | null)[]>(() =>
    Array.from({ length: 8 }, () => null),
  );
  const [codeLock, setCodeLock] = useState<CodeLock | null>(null);
  const graphRef = useRef<ReturnType<typeof buildNavGraph> | null>(null);
  const roomsRef = useRef<Quest["rooms"]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timer = 0;
    (async () => {
      try {
        let version = CACHE_VERSION;
        try {
          const manifest = await fetch(`/rpd/version.json?t=${Date.now()}`, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (manifest.ok) {
            const parsed = (await manifest.json()) as { version?: string };
            if (parsed.version) version = parsed.version;
          }
        } catch {}
        const [asset, questResponse, navResponse, client] = await Promise.all([
          fetchScene(`${assetUrl}?v=${version}`, controller.signal, (fraction) => {
            if (!disposed) setProgress(fraction);
          }),
          fetch(`/rpd/quest.json?v=${version}`, { signal: controller.signal, cache: "no-store" }).then(
            (response) => {
              if (!response.ok) throw new Error("could not load the quest data");
              return response.json() as Promise<Quest>;
            },
          ),
          fetch(`/rpd/nav.json?v=${version}`, { signal: controller.signal, cache: "no-store" }).then(
            (response) => {
              if (!response.ok) throw new Error("could not load the navigation graph");
              return response.json() as Promise<NavFile>;
            },
          ),
          createRpdClient({
            canvas: canvas.current as HTMLCanvasElement,
            locateFile: (path: string) => `/rpd/${path}?v=${version}`,
          }),
        ]);
        if (disposed) {
          client.dispose();
          return;
        }
        clientRef.current = client;
        if (import.meta.env.DEV) {
          (window as unknown as { __rpd?: RpdClient }).__rpd = client;
        }
        if (client.loadScene(asset) !== 0) throw new Error("the RPD scene could not be loaded");
        if (disposed) return;
        const graph = buildNavGraph(navResponse);
        graphRef.current = graph;
        const maxFloor = graph.floors.reduce((top, floor) => Math.max(top, floor.index), 0);
        const levels = new Float32Array(maxFloor + 1);
        const bounds = new Float32Array((maxFloor + 1) * 4);
        for (const floor of graph.floors) {
          levels[floor.index] = floor.level;
          const b = floor.bounds;
          if (b && b.length === 4) {
            bounds[floor.index * 4 + 0] = b[0];
            bounds[floor.index * 4 + 1] = b[1];
            bounds[floor.index * 4 + 2] = b[2];
            bounds[floor.index * 4 + 3] = b[3];
          }
        }
        client.planSetFloors(levels, bounds);

        const rooms = questResponse.rooms;
        roomsRef.current = rooms;
        const rx = new Float32Array(rooms.length);
        const ry = new Float32Array(rooms.length);
        const rz = new Float32Array(rooms.length);
        const rf = new Uint8Array(rooms.length);
        const offsets = new Int32Array(rooms.length);
        const encoded = rooms.map((entry) => new TextEncoder().encode(`${entry.name}\0`));
        const names = new Uint8Array(encoded.reduce((sum, entry) => sum + entry.length, 0));
        let cursor = 0;
        for (let i = 0; i < rooms.length; i += 1) {
          rx[i] = rooms[i].x;
          ry[i] = rooms[i].y;
          rz[i] = rooms[i].z;
          rf[i] = rooms[i].floor;
          offsets[i] = cursor;
          names.set(encoded[i], cursor);
          cursor += encoded[i].length;
        }
        client.planSetRooms(rooms.length, rx, ry, rz, rf, names, offsets);
        const adjacencyCost = new Float32Array(graph.adjacency.length);
        for (let i = 0; i < adjacencyCost.length; i += 1) {
          adjacencyCost[i] = graph.edgeCost[graph.edgeId[i]];
        }
        client.planSetGraph(
          graph.count,
          graph.x,
          graph.y,
          graph.z,
          graph.floor,
          graph.kind,
          graph.first,
          graph.adjacency,
          adjacencyCost,
        );
        const spawnNode = nearestNode(graph, questResponse.spawn, 8.0);
        const spawn: Vec3 =
          spawnNode >= 0
            ? [graph.x[spawnNode], graph.y[spawnNode], graph.z[spawnNode]]
            : questResponse.spawn;
        client.planSetSpawn(spawn[0], spawn[1], spawn[2]);
        client.planSetFloor(0);
        client.setViewMode(0);
        setFloors(
          graph.floors
            .map((floor) => ({ index: floor.index, level: floor.level, label: floor.label }))
            .sort((a, b) => b.level - a.level),
        );
        setLoaded(true);
        onLoaded?.(client, graph);

        timer = window.setInterval(() => {
          if (disposed || !clientRef.current) return;
          const count = clientRef.current.planCount();
          const isMoving = clientRef.current.planMoving() !== 0;
          const nextRoom = clientRef.current.planRoom();
          const slots = clientRef.current.inventory();
          const nextInventory = Array.from({ length: 8 }, (_, index) => {
            if (slots[index * 4] === 0) return null;
            const itemIndex = clientRef.current!.inventoryItem(index);
            const item = itemIndex >= 0 ? clientRef.current!.item(itemIndex) : null;
            return {
              name: item?.name ?? "",
              r: Math.round(slots[index * 4 + 1] * 255),
              g: Math.round(slots[index * 4 + 2] * 255),
              b: Math.round(slots[index * 4 + 3] * 255),
            };
          });
          setPlanCount((current) => (current === count ? current : count));
          setMoving((current) => (current === isMoving ? current : isMoving));
          setRoom((current) => (current === nextRoom ? current : nextRoom));
          const nativeFloor = clientRef.current.planActiveFloor();
          setActiveFloor((current) => (current === nativeFloor ? current : nativeFloor));
          setInventory((current) => {
            const same = nextInventory.every((slot, index) => {
              const previous = current[index];
              if (!slot || !previous) return slot === previous;
              return (
                slot.name === previous.name &&
                slot.r === previous.r &&
                slot.g === previous.g &&
                slot.b === previous.b
              );
            });
            return same ? current : nextInventory;
          });
          const popup = clientRef.current.popupState();
          const popupItem = popup[7] === 1 ? popup[2] : -1;
          let nextCodeLock: CodeLock | null = null;
          if (popupItem >= 0 && clientRef.current.itemHasCode(popupItem)) {
            const item = clientRef.current.item(popupItem);
            const hint = clientRef.current.itemHint(popupItem);
            nextCodeLock = {
              item: popupItem,
              title: item?.name ?? "Lock",
              hint,
              hintKnown: hint === "CODE REQUIRED",
            };
          }
          setCodeLock((current) => {
            if (!current || !nextCodeLock) return current === nextCodeLock ? current : nextCodeLock;
            if (
              current.item === nextCodeLock.item &&
              current.title === nextCodeLock.title &&
              current.hint === nextCodeLock.hint &&
              current.hintKnown === nextCodeLock.hintKnown
            ) {
              return current;
            }
            return nextCodeLock;
          });
        }, 250);
      } catch (loadError) {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) window.clearInterval(timer);
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, [assetUrl, onLoaded]);

  useEffect(() => {
    if (!import.meta.env.DEV || !loaded) return;
    const client = clientRef.current;
    const graph = graphRef.current;
    if (!client || !graph) return;
    const api = {
      debug: () => {
        const p = client.planPlayer();
        return {
          player: [p[0], p[1], p[2]] as Vec3,
          plan: Array.from({ length: client.planCount() }, () => 0),
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
      walkableCell: () => {
        const blocked = new Set(
          Array.from({ length: client.itemCount() }, (_, i) => client.item(i))
            .filter((entry) => entry && !entry.taken)
            .map((entry) => entry!.node),
        );
        const rect = canvas.current?.getBoundingClientRect();
        if (!rect) return null;
        const playerArray = client.planPlayer();
        const player: Vec3 = [playerArray[0], playerArray[1], playerArray[2]];
        const viewProj = client.getViewProj();
        const playerScreen = projectPoint(player, viewProj, rect.width, rect.height);
        const itemScreens = Array.from({ length: client.itemCount() }, (_, index) => {
          const item = client.item(index);
          if (!item || item.hidden || item.floor !== activeFloor) return null;
          return projectPoint([item.x, item.y + 0.45, item.z], viewProj, rect.width, rect.height);
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
      rooms: () => roomsRef.current,
      nearestCell: (x: number, z: number) => {
        const rect = canvas.current?.getBoundingClientRect();
        if (!rect) return null;
        const blocked = new Set(
          Array.from({ length: client.itemCount() }, (_, i) => client.item(i))
            .filter((entry) => entry && !entry.taken)
            .map((entry) => entry!.node),
        );
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
        let bad = 0;
        let samples = 0;
        let worst = 0;
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
            let nearest = Infinity;
            for (const floor of graph.floors) {
              const node = cells.get(cellKey(floor.index, ix, iz));
              if (node === undefined) continue;
              if (Math.abs(graph.y[node] + lift - py) > 0.9) continue;
              found = true;
              nearest = Math.min(nearest, Math.hypot(graph.x[node] - px, graph.z[node] - pz));
            }
            samples += 1;
            if (!found) bad += 1;
            else if (nearest > worst) worst = nearest;
          }
        }
        return {
          points,
          samples,
          bad,
          worst,
          nodes: graph.count,
          edges: graph.edgeCount,
        };
      },
      project: (x: number, y: number, z: number) => {
        const rect = canvas.current?.getBoundingClientRect();
        if (!rect) return null;
        return projectPoint([x, y, z], client.getViewProj(), rect.width, rect.height);
      },
    };
    (window as unknown as { __quest?: typeof api }).__quest = api;
    return () => {
      delete (window as unknown as { __quest?: typeof api }).__quest;
    };
  }, [loaded, activeFloor]);

  return {
    state: { loaded, error, progress, floors, activeFloor, view2D, planCount, moving, room, inventory, codeLock },
    ref: { canvas },
    set: { activeFloor: setActiveFloor },
    actions: {
      setFloor(index) {
        clientRef.current?.planSetFloor(index);
        setActiveFloor(index);
      },
      toggleView() {
        const next = !view2D;
        clientRef.current?.setViewMode(next ? 1 : 0);
        setView2D(next);
      },
      clearRoute() {
        clientRef.current?.planClearRoute();
      },
      resetView() {
        clientRef.current?.resetView();
      },
      recenter() {
        clientRef.current?.recenter();
      },
      enterCode(code) {
        if (!codeLock) return -3;
        const result = clientRef.current?.itemEnterCode(codeLock.item, code) ?? -3;
        if (result === 0) {
          clientRef.current?.popupClose();
          setCodeLock(null);
        }
        return result;
      },
      closeCodeEntry() {
        clientRef.current?.popupClose();
        setCodeLock(null);
      },
    },
  };
}
