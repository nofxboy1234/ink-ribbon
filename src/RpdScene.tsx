import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CATEGORY_LABELS,
  DOOR_COLOURS,
  DOOR_SHAPE,
  SHAPES,
  itemRadius,
  itemSatisfied,
  keyForDoor,
  nearbyRoom,
  pathLength,
  pointAt,
  type Door,
  type DoorState,
  type Item,
  type Quest,
  type Vec3,
} from "./quest";
import {
  blockedDoorEdges,
  buildNavGraph,
  findBlocker,
  findNavPath,
  nearestNode,
  nearestNodeOnFloor,
  nodePoint,
  routeFromPath,
  type NavFile,
  type NavGraph,
} from "./nav";

type RpdModule = {
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _rpd_load_scene: (ptr: number, size: number) => number;
  _rpd_get_camera: (ptr: number) => number;
  _rpd_set_orbit: (
    tx: number,
    ty: number,
    tz: number,
    yaw: number,
    pitch: number,
    distance: number,
  ) => number;
  _rpd_get_view_proj: (ptr: number) => number;
  _rpd_marker_clear: () => void;
  _rpd_marker_add: (
    shape: number,
    x: number,
    y: number,
    z: number,
    size: number,
    r: number,
    g: number,
    b: number,
  ) => number;
  _rpd_marker_set_visible: (index: number, visible: number) => void;
  _rpd_marker_set_position: (index: number, x: number, y: number, z: number) => void;
  _rpd_marker_set_color: (index: number, r: number, g: number, b: number) => void;
  _rpd_marker_set_rotation: (index: number, radians: number) => void;
  _rpd_marker_count: () => number;
  _rpd_set_player_position: (x: number, y: number, z: number) => void;
};

type RpdFactory = (options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}) => Promise<RpdModule>;

type Target =
  | { kind: "item"; id: string }
  | { kind: "door"; id: string }
  | { kind: "cell"; node: number };

type Action =
  | { type: "move"; label: string; points: Vec3[] }
  | { type: "pickup"; label: string; itemId: string }
  | { type: "use-key"; label: string; doorId: string; itemName: string }
  | { type: "info"; label: string };

type Hover = {
  kind: "item" | "door" | "cell";
  label: string;
  detail: string;
  x: number;
  y: number;
};

const CACHE_VERSION = "20261102a";
const DISCOVER_RADIUS = 3.0;
const SPAWN_DISCOVER_RADIUS = 3.5;
const MOVE_SPEED = 7.0;

async function fetchScene(
  url: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok || !response.body) {
    throw new Error(`could not fetch ${url} (${response.status})`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(total > 0 ? received / total : 0);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function itemPoint(item: Item): Vec3 {
  return [item.x, item.y, item.z];
}

function projectPoint(
  point: Vec3,
  matrix: Float32Array,
  width: number,
  height: number,
): { x: number; y: number; depth: number } | null {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (w <= 0.0001) return null;
  const cx = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
  const cy = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
  return {
    x: (cx * 0.5 + 0.5) * width,
    y: (1 - (cy * 0.5 + 0.5)) * height,
    depth: w,
  };
}

function pointInQuad(
  x: number,
  y: number,
  quad: { x: number; y: number }[],
): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) < 1e-6) continue;
    const next = Math.sign(cross);
    if (sign === 0) sign = next;
    else if (next !== sign) return false;
  }
  return true;
}

function actionLabel(action: Action): string {
  return action.label;
}

type RpdSceneProps = {
  assetUrl?: string;
  label?: string;
};

export default function RpdScene({
  assetUrl = "/rpd/rpd.bin",
  label = "RPD floors one to three as a 3D model",
}: RpdSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const moduleRef = useRef<RpdModule | null>(null);
  const questRef = useRef<Quest | null>(null);
  const navRef = useRef<NavGraph | null>(null);
  const itemMarkers = useRef(new Map<string, number>());
  const doorMarkers = useRef(new Map<string, number>());
  const playerMarker = useRef(-1);
  const viewProjPtr = useRef(0);
  const viewProjRef = useRef<Float32Array>(new Float32Array(16));
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const clickHandled = useRef(false);
  const hoverCellRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const pausedRef = useRef(false);

  const [quest, setQuest] = useState<Quest | null>(null);
  const [nav, setNav] = useState<NavGraph | null>(null);
  const [progress, setProgress] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [player, setPlayer] = useState<Vec3>([0, 0, 0]);
  const [playerRoom, setPlayerRoom] = useState("Main Hall");
  const [inventory, setInventory] = useState<Set<string>>(new Set());
  const [discovered, setDiscovered] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [doorStates, setDoorStates] = useState<Map<string, DoorState>>(new Map());
  const [selected, setSelected] = useState<Target | null>(null);
  const [path, setPath] = useState<Vec3[]>([]);
  const [queue, setQueue] = useState<Action[]>([]);
  const [actionsAt, setActionsAt] = useState<Action[]>([]);
  const [moving, setMoving] = useState(false);
  const [paused, setPaused] = useState(false);
  const [toast, setToast] = useState<string>("");
  const [hover, setHover] = useState<Hover | null>(null);
  const [activeFloor, setActiveFloor] = useState(0);
  const [showInventory, setShowInventory] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [statusNote, setStatusNote] = useState(
    "Walk near items to discover them. Click anywhere in a blue grid cell to move.",
  );

  const playerRef = useRef(player);
  const roomRef = useRef(playerRoom);
  const inventoryRef = useRef(inventory);
  const discoveredRef = useRef(discovered);
  const pickedRef = useRef(picked);
  const doorStatesRef = useRef(doorStates);
  const pathRef = useRef(path);
  const queueRef = useRef(queue);
  const movingRef = useRef(moving);
  const selectedRef = useRef(selected);
  const activeFloorRef = useRef(activeFloor);
  const actionsRef = useRef(actionsAt);

  useEffect(() => {
    playerRef.current = player;
  }, [player]);
  useEffect(() => {
    roomRef.current = playerRoom;
  }, [playerRoom]);
  useEffect(() => {
    inventoryRef.current = inventory;
  }, [inventory]);
  useEffect(() => {
    discoveredRef.current = discovered;
  }, [discovered]);
  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);
  useEffect(() => {
    doorStatesRef.current = doorStates;
  }, [doorStates]);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    movingRef.current = moving;
  }, [moving]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    activeFloorRef.current = activeFloor;
  }, [activeFloor]);
  useEffect(() => {
    actionsRef.current = actionsAt;
  }, [actionsAt]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const floors = quest?.floors ?? [];
  const rooms = quest?.rooms ?? [];
  const items = quest?.items ?? [];
  const doors = quest?.doors ?? [];

  const currentFloor = useMemo(() => {
    if (nav) {
      const node = nearestNode(nav, playerRef.current, 3.0);
      if (node >= 0) return nav.floor[node];
    }
    if (!quest) return 0;
    return nearbyRoom(quest, playerRef.current).floor;
  }, [quest, nav, player]);

  useEffect(() => {
    if (quest && nav) setActiveFloor(currentFloor);
  }, [quest, nav, currentFloor]);

  const itemLookup = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const doorLookup = useMemo(() => new Map(doors.map((door) => [door.id, door])), [doors]);
  const roomLookup = useMemo(() => new Map(rooms.map((room) => [room.name, room])), [rooms]);

  const gridLines = useMemo(() => {
    const result = new Map<number, [Vec3, Vec3][]>();
    if (!nav) return result;
    const h = nav.half;
    const seen = new Map<number, Set<string>>();
    for (let i = 0; i < nav.count; i++) {
      const floor = nav.floor[i];
      let lines = result.get(floor);
      if (!lines) {
        lines = [];
        result.set(floor, lines);
      }
      let keys = seen.get(floor);
      if (!keys) {
        keys = new Set();
        seen.set(floor, keys);
      }
      const x = nav.x[i];
      const y = nav.y[i] + 0.02;
      const z = nav.z[i];
      const sides: [Vec3, Vec3][] = [
        [[x - h, y, z - h], [x + h, y, z - h]],
        [[x + h, y, z - h], [x + h, y, z + h]],
        [[x + h, y, z + h], [x - h, y, z + h]],
        [[x - h, y, z + h], [x - h, y, z - h]],
      ];
      for (const [a, b] of sides) {
        const ka = `${a[0].toFixed(2)},${a[1].toFixed(2)},${a[2].toFixed(2)}`;
        const kb = `${b[0].toFixed(2)},${b[1].toFixed(2)},${b[2].toFixed(2)}`;
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (keys.has(key)) continue;
        keys.add(key);
        lines.push([a, b]);
      }
    }
    return result;
  }, [nav]);

  const navNodesByFloor = useMemo(() => {
    const result: number[][] = [[], [], []];
    if (!nav) return result;
    for (let i = 0; i < nav.count; i++) {
      const floor = Math.min(2, Math.max(0, nav.floor[i]));
      result[floor].push(i);
    }
    return result;
  }, [nav]);

  const keyItems = useMemo(() => {
    const counts = new Map<string, number>();
    for (const name of inventory) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [inventory]);

  const discoveredItems = useMemo(
    () => items.filter((item) => discovered.has(item.id)),
    [items, discovered],
  );

  const currentActions = useMemo(() => {
    if (!quest) return [];
    const at = playerRef.current;
    const list: Action[] = [];
    for (const item of discoveredItems) {
      if (picked.has(item.id)) continue;
      if (distance3(at, itemPoint(item)) < 3.2) {
        if (itemSatisfied(item, inventory)) {
          list.push({ type: "pickup", label: `Pick up ${item.name}`, itemId: item.id });
        } else {
          list.push({
            type: "info",
            label: `Needs ${item.requires.join(" / ")} · ${item.name}`,
          });
        }
      }
    }
    for (const door of doors) {
      const state = doorStates.get(door.id) ?? door.state;
      const dx = door.x - at[0];
      const dz = door.z - at[2];
      if (dx * dx + dz * dz > 3.6 * 3.6) continue;
      if (Math.abs(door.y - at[1]) > 2.5) continue;
      if (state === "locked") {
        const key = keyForDoor({ ...door, state }, inventory);
        if (key) {
          list.push({
            type: "use-key",
            label: `Use ${key} on ${door.label}`,
            doorId: door.id,
            itemName: key,
          });
        }
      } else if (door.puzzle) {
        list.push({ type: "info", label: `Puzzle · requires ${door.requires.join(" / ")}` });
      } else if (state === "unknown") {
        list.push({ type: "info", label: "Door state unknown" });
      }
    }
    return list;
  }, [quest, discoveredItems, picked, doors, doorStates, inventory, player]);

  const allActions = useMemo(() => {
    const list = [...currentActions];
    for (const action of actionsAt) {
      if (!list.some((item) => item.label === action.label)) list.push(action);
    }
    return list;
  }, [currentActions, actionsAt]);

  useEffect(() => {
    if (!quest || !nav) return;
    const frame = (now: number) => {
      const module = moduleRef.current;
      if (!module || !canvasRef.current) return;
      if (!viewProjPtr.current) viewProjPtr.current = module._malloc(16 * 4);
      module._rpd_get_view_proj(viewProjPtr.current);
      viewProjRef.current = new Float32Array(
        module.HEAPU8.buffer,
        viewProjPtr.current,
        16,
      ).slice();
      const canvas = overlayRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const matrix = viewProjRef.current;

      // Grid: cell sides on the active floor, faint centres on the others.
      const activeNodes = navNodesByFloor[activeFloorRef.current] ?? [];
      const lines = gridLines.get(activeFloorRef.current) ?? [];
      ctx.save();
      ctx.strokeStyle = "rgba(70, 170, 255, 0.22)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const [a, b] of lines) {
        const pa = projectPoint(a, matrix, rect.width, rect.height);
        const pb = projectPoint(b, matrix, rect.width, rect.height);
        if (!pa || !pb) continue;
        if (pa.x < -20 || pa.x > rect.width + 20 || pa.y < -20 || pa.y > rect.height + 20) continue;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "rgba(151, 205, 255, 0.42)";
      for (const node of activeNodes) {
        const point = projectPoint([nav.x[node], nav.y[node] + 0.03, nav.z[node]], matrix, rect.width, rect.height);
        if (!point) continue;
        if (point.x < -10 || point.x > rect.width + 10 || point.y < -10 || point.y > rect.height + 10) continue;
        ctx.fillRect(point.x - 0.6, point.y - 0.6, 1.2, 1.2);
      }
      for (let floorIndex = 0; floorIndex < navNodesByFloor.length; floorIndex++) {
        if (floorIndex === activeFloorRef.current) continue;
        for (const node of navNodesByFloor[floorIndex]) {
          const point = projectPoint([nav.x[node], nav.y[node] + 0.03, nav.z[node]], matrix, rect.width, rect.height);
          if (!point) continue;
          if (point.x < 0 || point.x > rect.width || point.y < 0 || point.y > rect.height) continue;
          ctx.fillStyle = "rgba(151, 205, 255, 0.08)";
          ctx.fillRect(point.x - 0.6, point.y - 0.6, 1.2, 1.2);
        }
      }

      const playerNode = nearestNode(nav, playerRef.current, 3.0);
      const playerFloor = playerNode >= 0 ? nav.floor[playerNode] : nearbyRoom(quest, playerRef.current).floor;
      const activeLabel = nav.floors[activeFloorRef.current]?.label ?? "";
      const playerFloorLabel = nav.floors[playerFloor]?.label ?? "";
      ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = "rgba(151, 205, 255, 0.7)";
      ctx.fillText(`GRID ${activeLabel}`, 18, rect.height - 48);
      if (playerFloor !== activeFloorRef.current) {
        ctx.fillStyle = "rgba(255, 214, 102, 0.85)";
        ctx.fillText(`PLAYER ${playerFloorLabel}`, 18, rect.height - 28);
      }

      const hovered = hoverCellRef.current;
      if (hovered !== null) {
        const x = nav.x[hovered];
        const y = nav.y[hovered] + 0.02;
        const z = nav.z[hovered];
        const half = nav.half;
        const corners: { x: number; y: number }[] = [];
        let complete = true;
        for (const [dx, dz] of [
          [-half, -half],
          [half, -half],
          [half, half],
          [-half, half],
        ]) {
          const point = projectPoint([x + dx, y, z + dz], matrix, rect.width, rect.height);
          if (!point) {
            complete = false;
            break;
          }
          corners.push({ x: point.x, y: point.y });
        }
        if (complete) {
          ctx.beginPath();
          ctx.moveTo(corners[0].x, corners[0].y);
          for (const corner of corners.slice(1)) ctx.lineTo(corner.x, corner.y);
          ctx.closePath();
          ctx.fillStyle = "rgba(57, 255, 20, 0.22)";
          ctx.fill();
          ctx.strokeStyle = "rgba(57, 255, 20, 0.9)";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // Selected route.
      const route = pathRef.current;
      if (route.length > 1) {
        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.shadowColor = "#39ff14";
        ctx.shadowBlur = 12;
        ctx.strokeStyle = "#39ff14";
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        let started = false;
        for (const p of route) {
          const point = projectPoint(p, matrix, rect.width, rect.height);
          if (!point) continue;
          if (!started) {
            ctx.moveTo(point.x, point.y);
            started = true;
          } else {
            ctx.lineTo(point.x, point.y);
          }
        }
        ctx.stroke();
        ctx.restore();

        const selectedTarget = selectedRef.current;
        if (selectedTarget) {
          const end = route[route.length - 1];
          const point = projectPoint(end, matrix, rect.width, rect.height);
          if (point) {
            ctx.beginPath();
            ctx.fillStyle = "#39ff14";
            ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.9)";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
            ctx.fillStyle = "#d6ffd0";
            const labelText =
              selectedTarget.kind === "item"
                ? itemLookup.get(selectedTarget.id)?.name ?? "Item"
                : selectedTarget.kind === "door"
                  ? doorLookup.get(selectedTarget.id)?.label ?? "Door"
                  : "Floor cell";
            const width = ctx.measureText(labelText).width + 14;
            ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
            ctx.fillRect(point.x + 9, point.y - 22, width, 18);
            ctx.fillStyle = "#d6ffd0";
            ctx.fillText(labelText, point.x + 16, point.y - 9);
          }
        }
      }

      // Highlight doorway points along the selected route.
      if (pathRef.current.length > 1 && selectedRef.current) {
        for (const d of doors) {
          if (!pathRef.current.some((p) => Math.hypot(p[0] - d.x, p[2] - d.z) < 0.05)) continue;
          const point = projectPoint([d.x, d.y + 1.0, d.z], matrix, rect.width, rect.height);
          if (!point) continue;
          ctx.beginPath();
          ctx.fillStyle = "rgba(57, 255, 20, 0.16)";
          ctx.arc(point.x, point.y, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#39ff14";
          ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.fillText("door", point.x + 12, point.y + 3);
        }
      }

      requestAnimationFrame(frame);
    };
    let raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [quest, nav, activeFloor, itemLookup, doorLookup, doors, gridLines, navNodesByFloor]);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frames += 1;
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const revealItems = (position: Vec3, force = false): Set<string> => {
    const q = questRef.current;
    const module = moduleRef.current;
    if (!q || !module) return discoveredRef.current;
    let next = discoveredRef.current;
    let changed = false;
    for (const item of q.items) {
      if (next.has(item.id)) continue;
      if (pickedRef.current.has(item.id)) continue;
      const close = distance3(position, itemPoint(item)) < (force ? SPAWN_DISCOVER_RADIUS : DISCOVER_RADIUS);
      if (!close) continue;
      if (Math.abs(item.y - position[1]) > 1.9) continue;
      if (next === discoveredRef.current) next = new Set(next);
      next.add(item.id);
      changed = true;
      const marker = itemMarkers.current.get(item.id);
      if (marker !== undefined) module._rpd_marker_set_visible(marker, 1);
      setToast(`Discovered ${item.name} — ${item.location}`);
    }
    if (changed) {
      discoveredRef.current = next;
      setDiscovered(next);
    }
    return next;
  };

  useEffect(() => {
    const controller = new AbortController();
    cancelledRef.current = false;
    const boot = async () => {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const probe = document.createElement("canvas");
        if (!probe.getContext("webgl2")) {
          throw new Error("this browser does not provide WebGL2");
        }
        const [asset, questResponse, navResponse, factory] = await Promise.all([
          fetchScene(`${assetUrl}?v=${CACHE_VERSION}`, controller.signal, (fraction) => {
            if (!cancelledRef.current) setProgress(fraction);
          }),
          fetch(`/rpd/quest.json?v=${CACHE_VERSION}`, { signal: controller.signal }).then(
            (response) => {
              if (!response.ok) throw new Error("could not load the quest data");
              return response.json() as Promise<Quest>;
            },
          ),
          fetch(`/rpd/nav.json?v=${CACHE_VERSION}`, { signal: controller.signal }).then(
            (response) => {
              if (!response.ok) throw new Error("could not load the navigation graph");
              return response.json() as Promise<NavFile>;
            },
          ),
          import("./wasm/rpd.js").then(
            (imported) => (imported.default ?? imported) as unknown as RpdFactory,
          ),
        ]);
        if (cancelledRef.current) return;
        const module = await factory({
          canvas,
          locateFile: (path: string) => `/rpd/${path}?v=${CACHE_VERSION}`,
        });
        if (cancelledRef.current) return;
        moduleRef.current = module;
        if (import.meta.env.DEV) {
          (window as unknown as { __rpd?: RpdModule }).__rpd = module;
        }

        const ptr = module._malloc(asset.byteLength);
        module.HEAPU8.set(asset, ptr);
        const result = module._rpd_load_scene(ptr, asset.byteLength);
        module._free(ptr);
        if (result !== 0) throw new Error("the RPD scene could not be loaded");

        await nextFrame();
        await nextFrame();

        const graph = buildNavGraph(navResponse);
        navRef.current = graph;
        setNav(graph);
        const snappedItems = questResponse.items.map((item) => {
          const node = nearestNode(graph, [item.x, item.y - 0.36, item.z], 3.2);
          if (node < 0) return item;
          return {
            ...item,
            x: graph.x[node],
            y: graph.y[node] + 0.36,
            z: graph.z[node],
          };
        });
        const spawnNode = nearestNode(graph, questResponse.spawn, 4.0);
        const spawn: Vec3 =
          spawnNode >= 0
            ? [graph.x[spawnNode], graph.y[spawnNode] + 0.45, graph.z[spawnNode]]
            : questResponse.spawn;
        const questData: Quest = { ...questResponse, items: snappedItems, spawn };

        module._rpd_marker_clear();
        playerMarker.current = module._rpd_marker_add(
          SHAPES.sphere,
          spawn[0],
          spawn[1],
          spawn[2],
          0.9,
          189,
          147,
          249,
        );
        module._rpd_set_player_position(spawn[0], spawn[1], spawn[2]);
        for (const item of questData.items) {
          const shape = SHAPES[item.shape] ?? SHAPES.cube;
          const marker = module._rpd_marker_add(
            shape,
            item.x,
            item.y,
            item.z,
            itemRadius(item.category) * 2,
            item.rgb[0],
            item.rgb[1],
            item.rgb[2],
          );
          itemMarkers.current.set(item.id, marker);
          module._rpd_marker_set_visible(marker, 0);
        }
        for (const door of questResponse.doors) {
          const colour = DOOR_COLOURS[door.state];
          const marker = module._rpd_marker_add(
            DOOR_SHAPE,
            door.x,
            door.y + 1.05,
            door.z,
            1,
            colour[0],
            colour[1],
            colour[2],
          );
          module._rpd_marker_set_rotation(marker, door.yaw ?? 0);
          doorMarkers.current.set(door.id, marker);
        }
        questRef.current = questData;
        setQuest(questData);
        setPlayer(spawn);
        playerRef.current = spawn;
        const spawnRoom = nearbyRoom(questData, spawn);
        setPlayerRoom(spawnRoom.name);
        roomRef.current = spawnRoom.name;
        setActiveFloor(spawnNode >= 0 ? graph.floor[spawnNode] : spawnRoom.floor);
        const initialStates = new Map<string, DoorState>();
        for (const door of questData.doors) initialStates.set(door.id, door.state);
        doorStatesRef.current = initialStates;
        setDoorStates(initialStates);
        setHidden(true);
        revealItems(spawn, true);

        // Mirror the live view into the URL so a pose can be reopened or sent.
        const cameraPtr = module._malloc(6 * 4);
        let last = "";
        const syncCamera = () => {
          if (cancelledRef.current) return;
          module._rpd_get_camera(cameraPtr);
          const view = new Float32Array(module.HEAPU8.buffer, cameraPtr, 6);
          const text = [view[0], view[1], view[2], view[3], view[4]]
            .map((value) => (Math.round(value * 100) / 100).toString())
            .join(",");
          if (text !== last) {
            last = text;
            const url = `${location.pathname}${location.search}#cam=${text}`;
            history.replaceState(null, "", url);
          }
          window.setTimeout(syncCamera, 250);
        };
        syncCamera();
      } catch (cause) {
        if (cancelledRef.current || controller.signal.aborted) return;
        console.error(cause);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void boot();
    return () => {
      cancelledRef.current = true;
      controller.abort();
    };
  }, [assetUrl]);

  const targetPoint = (
    target: Target,
  ): { point: Vec3; node: number; room: string; label: string } | null => {
    const q = questRef.current;
    const graph = navRef.current;
    if (!q || !graph) return null;
    if (target.kind === "item") {
      const item = itemLookup.get(target.id);
      if (!item) return null;
      const node = nearestNode(graph, [item.x, item.y - 0.36, item.z], 3.2);
      if (node < 0) return null;
      return { point: itemPoint(item), node, room: item.region, label: item.name };
    }
    if (target.kind === "door") {
      const door = doorLookup.get(target.id);
      if (!door) return null;
      const node = nearestNode(graph, [door.x, door.y, door.z], 3.0);
      if (node < 0) return null;
      return {
        point: [door.x, door.y + 0.5, door.z],
        node,
        room: door.from,
        label: door.label,
      };
    }
    const point = nodePoint(graph, target.node, 0.45);
    const room = nearbyRoom(q, point).name;
    return {
      point,
      node: target.node,
      room,
      label: `${room} cell`,
    };
  };

  const buildActionsFor = (target: Target): Action[] => {
    const q = questRef.current;
    if (!q) return [];
    if (target.kind === "item") {
      const item = itemLookup.get(target.id);
      if (!item || pickedRef.current.has(item.id)) return [];
      if (!itemSatisfied(item, inventoryRef.current)) {
        return [
          {
            type: "info",
            label: `Locked · requires ${item.requires.join(" / ")}`,
          },
        ];
      }
      return [{ type: "pickup", label: `Pick up ${item.name}`, itemId: item.id }];
    }
    if (target.kind === "door") {
      const door = doorLookup.get(target.id);
      if (!door) return [];
      const state = doorStatesRef.current.get(door.id) ?? door.state;
      if (state !== "locked") {
        if (door.puzzle) {
          return [
            {
              type: "info",
              label: `Puzzle · requires ${door.requires.join(" / ")}`,
            },
          ];
        }
        if (state === "unknown") {
          return [{ type: "info", label: "Door state unknown" }];
        }
        return [];
      }
      const key = keyForDoor({ ...door, state }, inventoryRef.current);
      if (key) {
        return [
          {
            type: "use-key",
            label: `Use ${key} on ${door.label}`,
            doorId: door.id,
            itemName: key,
          },
        ];
      }
      return [
        {
          type: "info",
          label: `Locked · requires ${door.requires.join(" / ") || "a key"}`,
        },
      ];
    }
    return [];
  };

  const buildQueue = (nodes: number[], target: Target): Action[] => {
    const q = questRef.current;
    const graph = navRef.current;
    if (!q || !graph || nodes.length === 0) return [];
    const targetInfo = targetPoint(target);
    const stops: { index: number; door: Door; key: string }[] = [];
    for (const door of q.doors) {
      const state = doorStatesRef.current.get(door.id) ?? door.state;
      if (state !== "locked") continue;
      const key = keyForDoor({ ...door, state }, inventoryRef.current);
      if (!key) continue;
      let bestIndex = -1;
      let bestDistance = 1.5;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (Math.abs(graph.y[node] - door.y) > 2.0) continue;
        const distance = Math.hypot(graph.x[node] - door.x, graph.z[node] - door.z);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }
      if (bestIndex >= 0 && !stops.some((stop) => stop.door.id === door.id)) {
        stops.push({ index: bestIndex, door, key });
      }
    }
    stops.sort((a, b) => a.index - b.index);

    const steps: Action[] = [];
    let cursor: Vec3 = playerRef.current;
    let cursorIndex = 0;
    for (const stop of stops) {
      const segment = routeFromPath(graph, nodes.slice(cursorIndex, stop.index + 1), 0.45);
      const points = [cursor, ...segment];
      steps.push({ type: "move", label: `Move to ${stop.door.label}`, points });
      steps.push({
        type: "use-key",
        label: `Use ${stop.key} on ${stop.door.label}`,
        doorId: stop.door.id,
        itemName: stop.key,
      });
      cursor = nodePoint(graph, nodes[stop.index], 0.45);
      cursorIndex = stop.index;
    }
    const segment = routeFromPath(graph, nodes.slice(cursorIndex), 0.45);
    const finalPoints = [cursor, ...segment];
    if (pathLength(finalPoints) > 0.2) {
      steps.push({
        type: "move",
        label: `Move to ${targetInfo?.label ?? "destination"}`,
        points: finalPoints,
      });
    }
    const doorHandled =
      target.kind === "door" && stops.some((stop) => stop.door.id === target.id);
    if (!doorHandled) {
      steps.push(...buildActionsFor(target).filter((action) => action.type !== "info"));
    }
    return steps;
  };

  const selectTarget = (target: Target) => {
    const q = questRef.current;
    const graph = navRef.current;
    if (!q || !graph) return;
    const info = targetPoint(target);
    if (!info) return;
    const from = nearestNode(graph, playerRef.current, 3.5);
    if (from < 0) {
      setStatusNote("Claire is not standing on a navigation cell.");
      return;
    }
    const blocked = blockedDoorEdges(
      graph,
      q.doors,
      doorStatesRef.current,
      inventoryRef.current,
    );
    const nodes = findNavPath(graph, from, info.node, blocked);
    if (!nodes) {
      const blocker = findBlocker(
        graph,
        from,
        info.node,
        q.doors,
        doorStatesRef.current,
        inventoryRef.current,
      );
      const reason = blocker
        ? `No route to ${info.label}. ${blocker.label} is locked and needs ${blocker.requires.join(" / ")}.`
        : `No route to ${info.label}.`;
      setStatusNote(reason);
      setToast(reason);
      setSelected(target);
      selectedRef.current = target;
      setPath([]);
      setQueue([]);
      setActionsAt([]);
      return;
    }
    const points = [playerRef.current, ...routeFromPath(graph, nodes, 0.45)];
    pathRef.current = points;
    setPath(points);
    setSelected(target);
    selectedRef.current = target;
    const nextQueue = buildQueue(nodes, target);
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    const availableHere = buildActionsFor(target);
    actionsRef.current = availableHere;
    setActionsAt(availableHere);
    setStatusNote(`Route ready to ${info.label}. Confirm the move to start.`);
  };

  const refreshAfterAction = () => {
    const q = questRef.current;
    if (!q) return;
    const at = playerRef.current;
    const nextRoom = nearbyRoom(q, at);
    roomRef.current = nextRoom.name;
    setPlayerRoom(nextRoom.name);
    const graph = navRef.current;
    if (graph) {
      const node = nearestNode(graph, at, 3.0);
      if (node >= 0) setActiveFloor(graph.floor[node]);
    }
    setSelected(null);
    selectedRef.current = null;
    pathRef.current = [];
    setPath([]);
    queueRef.current = [];
    setQueue([]);
    actionsRef.current = [];
    setActionsAt([]);
  };

  const performPickup = (itemId: string) => {
    const q = questRef.current;
    const module = moduleRef.current;
    const item = q?.items.find((entry) => entry.id === itemId);
    if (!item) return;
    if (!itemSatisfied(item, inventoryRef.current)) {
      setToast(`Locked: ${item.name} needs ${item.requires.join(" / ")}.`);
      return;
    }
    const nextInventory = new Set(inventoryRef.current);
    nextInventory.add(item.name);
    inventoryRef.current = nextInventory;
    setInventory(nextInventory);
    const nextPicked = new Set(pickedRef.current);
    nextPicked.add(item.id);
    pickedRef.current = nextPicked;
    setPicked(nextPicked);
    const marker = itemMarkers.current.get(item.id);
    if (marker !== undefined && module) module._rpd_marker_set_visible(marker, 0);
    setToast(`Picked up ${item.name}`);
    setStatusNote(`Picked up ${item.name}.`);
  };

  const useKey = (doorId: string, itemName: string) => {
    const q = questRef.current;
    const module = moduleRef.current;
    const door = q?.doors.find((entry) => entry.id === doorId);
    if (!door) return;
    const nextStates = new Map(doorStatesRef.current);
    nextStates.set(door.id, "unlocked");
    doorStatesRef.current = nextStates;
    setDoorStates(nextStates);
    const marker = doorMarkers.current.get(door.id);
    if (marker !== undefined && module) {
      const colour = DOOR_COLOURS.unlocked;
      module._rpd_marker_set_color(marker, colour[0], colour[1], colour[2]);
    }
    if (itemName) {
      const nextInventory = new Set(inventoryRef.current);
      nextInventory.delete(itemName);
      inventoryRef.current = nextInventory;
      setInventory(nextInventory);
    }
    setToast(`Unlocked ${door.label}${itemName ? ` with ${itemName}` : ""}.`);
    setStatusNote(`Unlocked ${door.label}. New routes are open.`);
  };

  const moveAlong = (points: Vec3[], label: string) =>
    new Promise<void>((resolve) => {
      const module = moduleRef.current;
      if (!module) {
        resolve();
        return;
      }
      const total = pathLength(points);
      if (total < 0.01) {
        resolve();
        return;
      }
      const duration = Math.max(260, (total / MOVE_SPEED) * 1000);
      let elapsed = 0;
      let last = performance.now();
      let lastUi = 0;
      const step = (now: number) => {
        if (cancelledRef.current) {
          resolve();
          return;
        }
        if (pausedRef.current) {
          last = now;
          requestAnimationFrame(step);
          return;
        }
        elapsed += now - last;
        last = now;
        const t = Math.min(1, elapsed / duration);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const position = pointAt(points, total * ease);
        const graph = navRef.current;
        if (graph) {
          const node = nearestNode(graph, [position[0], position[1] - 0.45, position[2]], 2.0);
          if (node >= 0) {
            const surface = graph.y[node] + 0.45;
            if (Math.abs(surface - position[1]) < 0.7) position[1] = surface;
          }
        }
        playerRef.current = position;
        module._rpd_set_player_position(position[0], position[1], position[2]);
        revealItems(position);
        if (now - lastUi > 110) {
          lastUi = now;
          setPlayer(position);
          const room = nearbyRoom(questRef.current!, position);
          if (room.name !== roomRef.current) {
            roomRef.current = room.name;
            setPlayerRoom(room.name);
          }
        }
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          setPlayer(position);
          const room = nearbyRoom(questRef.current!, position);
          roomRef.current = room.name;
          setPlayerRoom(room.name);
          setStatusNote(label);
          resolve();
        }
      };
      requestAnimationFrame(step);
    });

  const confirm = async () => {
    if (pausedRef.current) return;
    if (movingRef.current) return;
    const q = questRef.current;
    if (!q || queueRef.current.length === 0) return;
    movingRef.current = true;
    setMoving(true);
    const actions = [...queueRef.current];
    for (const action of actions) {
      while (pausedRef.current && !cancelledRef.current) await nextFrame();
      if (cancelledRef.current) break;
      if (action.type === "move") {
        await moveAlong(action.points, action.label);
      } else if (action.type === "pickup") {
        performPickup(action.itemId);
      } else if (action.type === "use-key") {
        useKey(action.doorId, action.itemName);
      }
      await nextFrame();
    }
    movingRef.current = false;
    setMoving(false);
    refreshAfterAction();
  };

  const cellAt = (
    clientX: number,
    clientY: number,
    floorIndex: number,
  ): { target: Target; depth: number } | null => {
    const graph = navRef.current;
    const canvas = overlayRef.current;
    if (!graph || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const matrix = viewProjRef.current;
    const half = graph.half;
    let best: { target: Target; depth: number } | null = null;
    for (const node of navNodesByFloor[floorIndex] ?? []) {
      const x = graph.x[node];
      const y = graph.y[node];
      const z = graph.z[node];
      const corners: { x: number; y: number }[] = [];
      let complete = true;
      for (const [dx, dz] of [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ]) {
        const point = projectPoint([x + dx, y + 0.02, z + dz], matrix, rect.width, rect.height);
        if (!point) {
          complete = false;
          break;
        }
        corners.push({ x: point.x, y: point.y });
      }
      if (!complete) continue;
      if (!pointInQuad(clientX, clientY, corners)) continue;
      const centre = projectPoint([x, y + 0.02, z], matrix, rect.width, rect.height);
      const depth = centre?.depth ?? Infinity;
      if (!best || depth < best.depth) {
        best = { target: { kind: "cell", node }, depth };
      }
    }
    return best;
  };

  const pickAt = (clientX: number, clientY: number): Target | null => {
    const q = questRef.current;
    const canvas = overlayRef.current;
    if (!q || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const matrix = viewProjRef.current;
    const nearest: { target: Target; distance: number; kind: number }[] = [];
    for (const item of q.items) {
      if (!discoveredRef.current.has(item.id) || pickedRef.current.has(item.id)) continue;
      const point = projectPoint(itemPoint(item), matrix, rect.width, rect.height);
      if (!point) continue;
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < 26) nearest.push({ target: { kind: "item", id: item.id }, distance, kind: 0 });
    }
    for (const door of q.doors) {
      const point = projectPoint([door.x, door.y + 1.05, door.z], matrix, rect.width, rect.height);
      if (!point) continue;
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < 26) nearest.push({ target: { kind: "door", id: door.id }, distance, kind: 1 });
    }
    nearest.sort((a, b) => a.kind - b.kind || a.distance - b.distance);
    if (nearest.length > 0 && nearest[0].distance < 24) return nearest[0].target;
    const active = cellAt(clientX, clientY, activeFloorRef.current);
    if (active) return active.target;
    for (const floor of q.floors) {
      if (floor.index === activeFloorRef.current) continue;
      const fallback = cellAt(clientX, clientY, floor.index);
      if (fallback) {
        setActiveFloor(floor.index);
        return fallback.target;
      }
    }
    return null;
  };

  const hoverAt = (clientX: number, clientY: number) => {
    const q = questRef.current;
    const canvas = overlayRef.current;
    if (!q || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const matrix = viewProjRef.current;
    let best: { hover: Hover; distance: number } | null = null;
    for (const item of q.items) {
      if (!discoveredRef.current.has(item.id) || pickedRef.current.has(item.id)) continue;
      const point = projectPoint(itemPoint(item), matrix, rect.width, rect.height);
      if (!point) continue;
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < 22 && (!best || distance < best.distance)) {
        best = {
          distance,
          hover: {
            kind: "item",
            label: item.name,
            detail: `${item.location} · ${CATEGORY_LABELS[item.category] ?? "Item"}${
              item.links.length
                ? ` · unlocks ${item.links
                    .map((id) => doorLookup.get(id)?.label)
                    .filter(Boolean)
                    .join(", ")}`
                : ""
            }${item.itemLinks.length ? ` · links ${item.itemLinks
              .map((id) => itemLookup.get(id)?.name)
              .filter(Boolean)
              .join(", ")}` : ""}${!itemSatisfied(item, inventoryRef.current) ? ` · needs ${item.requires.join(" / ")}` : ""}`,
            x: clientX,
            y: clientY,
          },
        };
      }
    }
    for (const door of q.doors) {
      const point = projectPoint([door.x, door.y + 1.05, door.z], matrix, rect.width, rect.height);
      if (!point) continue;
      const distance = Math.hypot(point.x - clientX, point.y - clientY);
      if (distance < 22 && (!best || distance < best.distance)) {
        const state = doorStatesRef.current.get(door.id) ?? door.state;
        best = {
          distance,
          hover: {
            kind: "door",
            label: door.label,
            detail:
              state === "locked"
                ? `Locked${door.requires.length ? ` · ${door.requires.join(" / ")}` : ""}`
                : state === "unlocked"
                  ? "Unlocked"
                  : "Unknown",
            x: clientX,
            y: clientY,
          },
        };
      }
    }
    if (!best) {
      const cellHit = cellAt(clientX, clientY, activeFloorRef.current);
      if (cellHit && cellHit.target.kind === "cell") {
        hoverCellRef.current = cellHit.target.node;
        const graph = navRef.current;
        if (graph) {
          const point = nodePoint(graph, cellHit.target.node);
          const room = nearbyRoom(q, point);
          setHover({
            kind: "cell",
            label: room.name,
            detail: "Click this floor cell to move Claire here",
            x: clientX,
            y: clientY,
          });
        }
        return;
      }
    }
    hoverCellRef.current = null;
    setHover(best?.hover ?? null);
  };

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const api = {
      debug: () => ({
        player: playerRef.current,
        room: roomRef.current,
        inventory: [...inventoryRef.current],
        discovered: [...discoveredRef.current],
        picked: [...pickedRef.current],
        doors: Object.fromEntries(doorStatesRef.current),
        selected: selectedRef.current,
        queue: queueRef.current.map(actionLabel),
        moving: movingRef.current,
        paused: pausedRef.current,
        actions: allActions.map(actionLabel),
      }),
      selectItem: (id: string) => selectTarget({ kind: "item", id }),
      selectDoor: (id: string) => selectTarget({ kind: "door", id }),
      selectCell: (x: number, z: number) => {
        const graph = navRef.current;
        if (!graph) return;
        const floor = graph.floors[activeFloorRef.current];
        const node = nearestNodeOnFloor(graph, [x, floor?.level ?? 0, z], activeFloorRef.current, 8);
        if (node >= 0) selectTarget({ kind: "cell", node });
      },
      setFloor: (floor: number) => {
        activeFloorRef.current = floor;
        setActiveFloor(floor);
      },
      giveItem: (name: string) => {
        const next = new Set(inventoryRef.current);
        next.add(name);
        inventoryRef.current = next;
        setInventory(next);
      },
      confirm: () => confirm(),
      checkPath: () => {
        const graph = navRef.current;
        const points = pathRef.current;
        if (!graph) return null;
        let bad = 0;
        let worst = 0;
        for (const p of points) {
          const node = nearestNode(graph, [p[0], p[1] - 0.45, p[2]], 2.0);
          if (node < 0) {
            bad += 1;
            worst = 99;
            continue;
          }
          const distance = Math.hypot(graph.x[node] - p[0], graph.z[node] - p[2], graph.y[node] + 0.45 - p[1]);
          worst = Math.max(worst, distance);
          if (distance > 0.85) bad += 1;
        }
        return { points: points.length, bad, worst, nodes: graph.count, edges: graph.edgeCount };
      },
      click: (x: number, y: number) => {
        const target = pickAt(x, y);
        if (target) selectTarget(target);
      },
      matrix: () => Array.from(viewProjRef.current),
      project: (x: number, y: number, z: number) => {
        const canvas = overlayRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return projectPoint([x, y, z], viewProjRef.current, rect.width, rect.height);
      },
    };
    (window as unknown as { __quest?: typeof api }).__quest = api;
    return () => {
      delete (window as unknown as { __quest?: typeof api }).__quest;
    };
  }, [quest, allActions, confirm]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };

  const pickFromClick = (clientX: number, clientY: number, start: { x: number; y: number } | null) => {
    if (start && Math.hypot(clientX - start.x, clientY - start.y) > 5) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const target = pickAt(clientX - rect.left, clientY - rect.top);
    if (target) selectTarget(target);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    clickHandled.current = true;
    window.setTimeout(() => {
      clickHandled.current = false;
    }, 0);
    pickFromClick(event.clientX, event.clientY, start);
  };

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (clickHandled.current) return;
    const start = pointerStart.current;
    pointerStart.current = null;
    pickFromClick(event.clientX, event.clientY, start);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    hoverAt(event.clientX - rect.left, event.clientY - rect.top);
  };

  const focusRoute = () => {
    const module = moduleRef.current;
    const route = pathRef.current;
    if (!module || route.length < 2) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
    for (const [x, y, z] of route) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      maxY = Math.max(maxY, y);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 6);
    const eye: Vec3 = [cx, maxY + Math.max(10, span * 0.9), cz + Math.max(8, span * 0.7)];
    const target: Vec3 = [cx, maxY - 0.4, cz];
    const distance = distance3(eye, target);
    const yaw = Math.atan2(eye[0] - target[0], eye[2] - target[2]);
    const pitch = Math.asin((eye[1] - target[1]) / distance);
    module._rpd_set_orbit(
      target[0],
      target[1],
      target[2],
      yaw,
      pitch,
      distance,
    );
    setToast("Framed the planned route.");
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "KeyP" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      event.preventDefault();
      const next = !pausedRef.current;
      pausedRef.current = next;
      setPaused(next);
      setToast(next ? "Paused." : "Resumed.");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reset = () => {
    const q = questRef.current;
    const module = moduleRef.current;
    if (!q || !module) return;
    setInventory(new Set());
    inventoryRef.current = new Set();
    setPicked(new Set());
    pickedRef.current = new Set();
    setDiscovered(new Set());
    discoveredRef.current = new Set();
    for (const [id, marker] of itemMarkers.current) {
      const item = q.items.find((entry) => entry.id === id);
      if (item) module._rpd_marker_set_visible(marker, 0);
    }
    const states = new Map<string, DoorState>();
    for (const door of q.doors) {
      states.set(door.id, door.state);
      const marker = doorMarkers.current.get(door.id);
      if (marker !== undefined) {
        const colour = DOOR_COLOURS[door.state];
        module._rpd_marker_set_color(marker, colour[0], colour[1], colour[2]);
      }
    }
    doorStatesRef.current = states;
    setDoorStates(states);
    setPlayer(q.spawn);
    playerRef.current = q.spawn;
    const room = nearbyRoom(q, q.spawn);
    roomRef.current = room.name;
    setPlayerRoom(room.name);
    setActiveFloor(room.floor);
    module._rpd_set_player_position(q.spawn[0], q.spawn[1], q.spawn[2]);
    revealItems(q.spawn, true);
    refreshAfterAction();
    setToast("Run reset.");
    setStatusNote("Walk near items to discover them. Click anywhere in a blue grid cell to move.");
  };

  const statusText = error ? `Scene error — ${error}` : "Loading RPD floors 1–3";
  const selectedLabel =
    selected?.kind === "item"
      ? itemLookup.get(selected.id)?.name
      : selected?.kind === "door"
        ? doorLookup.get(selected.id)?.label
        : selected?.kind === "cell"
          ? `${quest && nav ? nearbyRoom(quest, nodePoint(nav, selected.node)).name : "Floor"} cell`
          : null;

  const floorCounts = quest
    ? quest.floors.map((floor) => ({
        ...floor,
        discovered: quest.items.filter(
          (item) => discovered.has(item.id) && Math.abs(item.y - floor.level - 0.36) < 0.8,
        ).length,
        total: quest.items.filter((item) => Math.abs(item.y - floor.level - 0.36) < 0.8).length,
      }))
    : [];

  return (
    <main className="rpd-root" ref={wrapRef} data-paused={paused}>
      <div className="rpd-stage">
        <canvas
          ref={canvasRef}
          id="canvas"
          className="rpd-canvas"
          data-cell={hover?.kind === "cell" ? "true" : undefined}
          aria-label={label}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onClick={handleClick}
          onPointerCancel={() => {
            pointerStart.current = null;
          }}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => {
            hoverCellRef.current = null;
            setHover(null);
          }}
          onContextMenu={(event) => event.preventDefault()}
        />
        <canvas ref={overlayRef} className="rpd-overlay" aria-hidden="true" />
        {hover && (
          <div className="rpd-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <strong>{hover.label}</strong>
            <span>{hover.detail}</span>
          </div>
        )}
      </div>

      <header className="rpd-brand">
        <div className="rpd-brand-mark">RPD</div>
        <div>
          <h1>Claire A · Hardcore</h1>
          <p>Raccoon Police Department · 1F–3F</p>
        </div>
      </header>

      <section className="rpd-floors" aria-label="Floor selector">
        {floorCounts.map((floor) => (
          <button
            key={floor.index}
            className="rpd-floor"
            data-active={activeFloor === floor.index}
            onClick={() => setActiveFloor(floor.index)}
          >
            <span>{floor.label}</span>
            <small>
              {floor.discovered}/{floor.total}
            </small>
          </button>
        ))}
        <button
          className="rpd-icon-button"
          title="Reset run"
          onClick={reset}
          aria-label="Reset run"
        >
          ↺
        </button>
      </section>

      <aside className="rpd-panel" aria-label="Quest planner">
        <div className="rpd-panel-head">
          <div>
            <p className="rpd-kicker">Next actions</p>
            <h2>{selectedLabel ?? playerRoom}</h2>
          </div>
          <div className="rpd-panel-status">
            {paused && <span className="rpd-paused">Paused</span>}
            <span className="rpd-badge">
              {discovered.size}/{items.length}
            </span>
          </div>
        </div>

        <p className="rpd-note">{statusNote}</p>

        {selected?.kind === "item" &&
          ((itemLookup.get(selected.id)?.links.length ?? 0) +
            (itemLookup.get(selected.id)?.itemLinks.length ?? 0)) >
            0 && (
          <div className="rpd-links">
            <span>Links</span>
            <p>
              {[
                ...(itemLookup.get(selected.id)?.links ?? [])
                  .map((id) => doorLookup.get(id)?.label)
                  .filter(Boolean),
                ...(itemLookup.get(selected.id)?.itemLinks ?? [])
                  .map((id) => itemLookup.get(id)?.name)
                  .filter(Boolean),
              ].join(" · ")}
            </p>
          </div>
        )}

        {queue.length > 0 && (
          <div className="rpd-queue">
            <div className="rpd-section-title">
              <span>Planned route</span>
              <span className="rpd-route-tools">
                <button className="rpd-text-button" onClick={focusRoute}>
                  focus
                </button>
                <button
                  className="rpd-text-button"
                  onClick={() => {
                    setQueue([]);
                    queueRef.current = [];
                    setPath([]);
                    pathRef.current = [];
                    setSelected(null);
                    selectedRef.current = null;
                  }}
                >
                  clear
                </button>
              </span>
            </div>
            <ol>
              {queue.map((action, index) => (
                <li key={`${action.label}-${index}`}>
                  <span className="rpd-step-number">{String(index + 1).padStart(2, "0")}</span>
                  <span>{action.label}</span>
                  <button
                    className="rpd-remove"
                    onClick={() =>
                      setQueue((current) => {
                        const next = current.filter((_, i) => i !== index);
                        queueRef.current = next;
                        return next;
                      })
                    }
                    aria-label={`Remove ${action.label}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
            <button
              className="rpd-confirm"
              onClick={confirm}
              disabled={paused || moving || queue.length === 0}
            >
              {paused
                ? "Paused · P to resume"
                : moving
                  ? "Moving…"
                  : `Confirm ${queue.length} action${queue.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}

        <div className="rpd-section-title">
          <span>At this position</span>
          <span className="rpd-muted">{allActions.length} available</span>
        </div>
        {allActions.length === 0 ? (
          <p className="rpd-empty">
            Move closer to a discovered item or a locked door to unlock new actions.
          </p>
        ) : (
          <div className="rpd-actions">
            {allActions.map((action, index) => (
              <button
                key={`${action.label}-${index}`}
                className="rpd-action"
                data-info={action.type === "info"}
                disabled={action.type === "info"}
                onClick={() => {
                  if (action.type === "info") return;
                  setQueue((current) => {
                    if (current.some((entry) => entry.label === action.label)) return current;
                    const next = [...current, action];
                    queueRef.current = next;
                    return next;
                  });
                }}
              >
                <span className="rpd-action-icon">
                  {action.type === "pickup" ? "◆" : action.type === "use-key" ? "⌁" : action.type === "info" ? "!" : "→"}
                </span>
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        )}

        <div className="rpd-section-title">
          <span>Inventory</span>
          <button
            className="rpd-text-button"
            title="Toggle inventory"
            aria-expanded={showInventory}
            onClick={() => setShowInventory((value) => !value)}
          >
            {showInventory ? "hide" : "show"}
          </button>
        </div>
        {showInventory && (
          <div className="rpd-inventory">
            {keyItems.length === 0 ? (
              <p className="rpd-empty">No key items yet.</p>
            ) : (
              keyItems.map(([name, count]) => (
                <span className="rpd-chip" key={name}>
                  {name}
                  {count > 1 ? ` ×${count}` : ""}
                </span>
              ))
            )}
            <p className="rpd-inventory-meta">
              {picked.size} items collected · {discovered.size} discovered
            </p>
          </div>
        )}

        <div className="rpd-legend-toggle">
          <button className="rpd-text-button" onClick={() => setShowLegend((value) => !value)}>
            {showLegend ? "hide legend" : "show legend"}
          </button>
        </div>
        {showLegend && (
          <div className="rpd-legend">
            <div className="rpd-legend-row">
              <span className="rpd-dot" style={{ background: "#b45cff" }} />
              <span>Key</span>
              <span className="rpd-dot" style={{ background: "#ff5cd0" }} />
              <span>Key item</span>
            </div>
            <div className="rpd-legend-row">
              <span className="rpd-dot" style={{ background: "#43d17a" }} />
              <span>Healing</span>
              <span className="rpd-dot" style={{ background: "#f2c94c" }} />
              <span>Ammo</span>
            </div>
            <div className="rpd-legend-row">
              <span className="rpd-dot" style={{ background: "#ff7a45" }} />
              <span>Weapon</span>
              <span className="rpd-dot" style={{ background: "#2dd4bf" }} />
              <span>Upgrade</span>
            </div>
            <div className="rpd-legend-row">
              <span className="rpd-door-key" style={{ background: "#d62828" }} />
              <span>Locked</span>
              <span className="rpd-door-key" style={{ background: "#1f77b4" }} />
              <span>Unlocked</span>
              <span className="rpd-door-key" style={{ background: "#7f7f7f" }} />
              <span>Unknown</span>
            </div>
            <p className="rpd-legend-note">
              Items stay hidden until Claire walks near them. Click a discovered
              item to plot a route. Locked doors need the listed key.
            </p>
          </div>
        )}
      </aside>

      <div className="rpd-fps">{fps > 0 ? `${fps} FPS` : "-- FPS"}</div>
      {toast && <div className="rpd-toast">{toast}</div>}
      <div
        className="rpd-status"
        data-hidden={hidden}
        data-error={error !== null}
        style={{ "--progress": `${Math.round(progress * 100)}%` } as CSSProperties}
        aria-live="polite"
      >
        <div className="rpd-status-inner">
          <span>{error ? statusText : `${statusText} · ${Math.round(progress * 100)}%`}</span>
          <span className="rpd-status-mark" />
        </div>
      </div>
    </main>
  );
}
