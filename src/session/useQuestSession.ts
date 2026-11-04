import { useEffect, useMemo, useRef, useState } from "react";
import { nearestNode } from "../nav";
import { planPath as buildPlanPath, planStateFor } from "../planner";
import type { DoorState, Item, Quest, Vec3 } from "../quest";
import type { RpdClient } from "../wasm/client";
import type { PlanState, PlanStep } from "../planner";
import type { NavGraph } from "../nav";
import type { QuestSession, RpdData, RpdDomRefs, RpdRefs, RpdSet, RpdState } from "./types";

export function useQuestSession(): QuestSession {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLElement>(null);
  const popupLayerRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);

  const clientRef = useRef<RpdClient | null>(null);
  const questRef = useRef<Quest | null>(null);
  const navRef = useRef<NavGraph | null>(null);
  const itemMarkers = useRef(new Map<string, number>());
  const doorMarkers = useRef(new Map<string, number>());
  const playerMarker = useRef(-1);
  const viewProjRef = useRef(new Float32Array(16));
  const hoverCellRef = useRef<number | null>(null);
  const glassStyleRef = useRef(false);
  const view2DRef = useRef(false);
  const cancelledRef = useRef(false);
  const cancelRunRef = useRef(false);
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
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [preview, setPreview] = useState<RpdState["preview"]>(null);
  const [moving, setMoving] = useState(false);
  const [paused, setPaused] = useState(false);
  const [toast, setToast] = useState("");
  const [hover, setHover] = useState<RpdState["hover"]>(null);
  const [activeFloor, setActiveFloor] = useState(0);
  const [view2D, setView2D] = useState(false);
  const [mapPopupAnchor, setMapPopupAnchor] = useState<{ x: number; y: number } | null>(null);
  const [mapFocusToken, setMapFocusToken] = useState(0);
  const [showInventory, setShowInventory] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [statusNote, setStatusNote] = useState(
    "Walk near items to discover them. Click a discovered item or a floor cell to preview a route.",
  );

  const playerRef = useRef(player);
  const roomRef = useRef(playerRoom);
  const inventoryRef = useRef(inventory);
  const discoveredRef = useRef(discovered);
  const pickedRef = useRef(picked);
  const doorStatesRef = useRef(doorStates);
  const planRef = useRef(plan);
  const previewRef = useRef(preview);
  const planStateRef = useRef<PlanState | null>(null);
  const planPathRef = useRef<Vec3[]>([]);
  const movingRef = useRef(moving);
  const activeFloorRef = useRef(activeFloor);

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
    planRef.current = plan;
  }, [plan]);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  useEffect(() => {
    movingRef.current = moving;
  }, [moving]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    activeFloorRef.current = activeFloor;
  }, [activeFloor]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const floors = quest?.floors ?? [];
  const rooms = quest?.rooms ?? [];
  const items = quest?.items ?? [];
  const doors = quest?.doors ?? [];

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

  const itemNodes = useMemo(() => {
    const nodes = new Map<number, Item[]>();
    if (!nav) return nodes;
    for (const item of items) {
      const node = nearestNode(nav, [item.x, item.y - 0.36, item.z], 1.0);
      if (node < 0) continue;
      const list = nodes.get(node);
      if (list) list.push(item);
      else nodes.set(node, [item]);
    }
    return nodes;
  }, [items, nav]);

  const planState = useMemo(
    () =>
      nav && quest
        ? planStateFor({
            plan,
            inventory,
            picked,
            doorStates,
            player,
            nav,
            itemLookup,
          })
        : null,
    [quest, nav, plan, inventory, picked, doorStates, player, itemLookup],
  );

  useEffect(() => {
    planStateRef.current = planState;
  }, [planState]);

  const planPath = useMemo(() => buildPlanPath(plan), [plan]);

  useEffect(() => {
    planPathRef.current = planPath;
  }, [planPath]);

  const mapBounds = useMemo<[number, number, number, number] | null>(() => {
    if (!nav) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < nav.count; i++) {
      if (nav.floor[i] !== activeFloor) continue;
      minX = Math.min(minX, nav.x[i]);
      maxX = Math.max(maxX, nav.x[i]);
      minZ = Math.min(minZ, nav.z[i]);
      maxZ = Math.max(maxZ, nav.z[i]);
    }
    if (!Number.isFinite(minX)) return null;
    return [minX - 1.5, minZ - 1.5, maxX + 1.5, maxZ + 1.5];
  }, [nav, activeFloor]);

  const state: RpdState = {
    quest,
    nav,
    progress,
    hidden,
    error,
    fps,
    player,
    playerRoom,
    inventory,
    discovered,
    picked,
    doorStates,
    plan,
    preview,
    moving,
    paused,
    toast,
    hover,
    activeFloor,
    view2D,
    mapPopupAnchor,
    mapFocusToken,
    showInventory,
    showLegend,
    statusNote,
  };

  const refs = useMemo<RpdRefs>(
    () => ({
      player: playerRef,
      room: roomRef,
      inventory: inventoryRef,
      discovered: discoveredRef,
      picked: pickedRef,
      doorStates: doorStatesRef,
      plan: planRef,
      preview: previewRef,
      planState: planStateRef,
      planPath: planPathRef,
      moving: movingRef,
      paused: pausedRef,
      activeFloor: activeFloorRef,
      view2D: view2DRef,
      glassStyle: glassStyleRef,
      hoverCell: hoverCellRef,
      viewProj: viewProjRef,
      cancelled: cancelledRef,
      cancelRun: cancelRunRef,
      client: clientRef,
      quest: questRef,
      nav: navRef,
      itemMarkers,
      doorMarkers,
      playerMarker,
    }),
    [],
  );

  const set = useMemo<RpdSet>(
    () => ({
      quest: setQuest,
      nav: setNav,
      progress: setProgress,
      hidden: setHidden,
      error: setError,
      fps: setFps,
      player: setPlayer,
      playerRoom: setPlayerRoom,
      inventory: setInventory,
      discovered: setDiscovered,
      picked: setPicked,
      doorStates: setDoorStates,
      plan: setPlan,
      preview: setPreview,
      moving: setMoving,
      paused: setPaused,
      toast: setToast,
      hover: setHover,
      activeFloor: setActiveFloor,
      view2D: setView2D,
      mapPopupAnchor: setMapPopupAnchor,
      mapFocusToken: setMapFocusToken,
      showInventory: setShowInventory,
      showLegend: setShowLegend,
      statusNote: setStatusNote,
    }),
    [],
  );

  const ref = useMemo<RpdDomRefs>(
    () => ({
      canvas: canvasRef,
      overlay: overlayRef,
      wrap: wrapRef,
      popupLayer: popupLayerRef,
      dock: dockRef,
    }),
    [],
  );

  const data: RpdData = {
    floors,
    rooms,
    items,
    doors,
    itemLookup,
    doorLookup,
    roomLookup,
    keyItems,
    itemNodes,
    gridLines,
    navNodesByFloor,
    planState,
    planPath,
    mapBounds,
  };

  return { state, refs, set, data, ref };
}
