import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { buildNavGraph, nearestNode, type NavFile } from "../nav";
import type { Floor, Quest, Vec3 } from "../quest";
import { createRpdClient, type RpdClient } from "../wasm/client";
import { createDevApi } from "./devApi";
import { CACHE_VERSION, fetchScene } from "./scene";

export type InventoryEntry = {
  name: string;
  index: number;
  description: string;
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
    box: { slot: number; index: number; name: string }[];
    notes: { id: number; title: string; body: string }[];
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
    discard: (index: number) => void;
    store: (index: number) => void;
    takeFromBox: (slot: number) => void;
    save: () => number[] | null;
    restore: (bytes: number[]) => number;
  };
};

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
  const [box, setBox] = useState<{ slot: number; index: number; name: string }[]>([]);
  const [notes, setNotes] = useState<{ id: number; title: string; body: string }[]>([]);
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
              index: itemIndex,
              description: item ? `${item.roomName ? `Found in ${item.roomName}. ` : ""}${item.name}` : "",
              r: Math.round(slots[index * 4 + 1] * 255),
              g: Math.round(slots[index * 4 + 2] * 255),
              b: Math.round(slots[index * 4 + 3] * 255),
            };
          });
          const nextNotes: { id: number; title: string; body: string }[] = [];
          for (let i = 0; i < clientRef.current.itemCount(); i += 1) {
            const entry = clientRef.current.item(i);
            if (entry && entry.taken && entry.action === 5) {
              nextNotes.push({ id: i, title: entry.name, body: "Collected and read in the RPD." });
            }
          }
          setNotes((current) => (JSON.stringify(current) === JSON.stringify(nextNotes) ? current : nextNotes));
          const nextBox = Array.from({ length: clientRef.current.boxCount() }, (_, slot) => {
            const itemIndex = clientRef.current!.boxItem(slot);
            const item = itemIndex >= 0 ? clientRef.current!.item(itemIndex) : null;
            return { slot, index: itemIndex, name: item?.name ?? "" };
          });
          setBox((current) => (JSON.stringify(current) === JSON.stringify(nextBox) ? current : nextBox));
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
    const api = createDevApi({
      client,
      graph,
      canvas,
      rooms: roomsRef.current,
      activeFloor,
      setActiveFloor,
    });
    (window as unknown as { __quest?: typeof api }).__quest = api;
    return () => {
      delete (window as unknown as { __quest?: typeof api }).__quest;
    };
  }, [loaded, activeFloor]);

  return {
    state: {
      loaded,
      error,
      progress,
      floors,
      activeFloor,
      view2D,
      planCount,
      moving,
      room,
      inventory,
      box,
      notes,
      codeLock,
    },
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
      discard(index) {
        clientRef.current?.itemDiscard(index);
      },
      store(index) {
        clientRef.current?.boxStore(index);
      },
      takeFromBox(slot) {
        clientRef.current?.boxTake(slot);
      },
      save() {
        return clientRef.current ? Array.from(clientRef.current.saveSnapshot()) : null;
      },
      restore(bytes) {
        return clientRef.current?.saveRestore(Uint8Array.from(bytes)) ?? -1;
      },
    },
  };
}
