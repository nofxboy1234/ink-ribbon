import type { Dispatch, RefObject, SetStateAction } from "react";
import type { NavGraph } from "../nav";
import type { PlanChoice, PlanState, PlanStep, Preview, Target } from "../planner";
import type { Door, DoorState, Floor, Item, Quest, Room, Vec3 } from "../quest";
import type { RpdClient } from "../wasm/client";

export type Hover = {
  kind: "item" | "door" | "cell";
  label: string;
  detail: string;
  x: number;
  y: number;
};

export type RpdState = {
  quest: Quest | null;
  nav: NavGraph | null;
  progress: number;
  hidden: boolean;
  error: string | null;
  fps: number;
  player: Vec3;
  playerRoom: string;
  inventory: Set<string>;
  discovered: Set<string>;
  picked: Set<string>;
  doorStates: Map<string, DoorState>;
  plan: PlanStep[];
  preview: Preview | null;
  moving: boolean;
  paused: boolean;
  toast: string;
  hover: Hover | null;
  activeFloor: number;
  view2D: boolean;
  mapPopupAnchor: { x: number; y: number } | null;
  mapFocusToken: number;
  showInventory: boolean;
  showLegend: boolean;
  statusNote: string;
};

export type RpdRefs = {
  player: RefObject<Vec3>;
  room: RefObject<string>;
  inventory: RefObject<Set<string>>;
  discovered: RefObject<Set<string>>;
  picked: RefObject<Set<string>>;
  doorStates: RefObject<Map<string, DoorState>>;
  plan: RefObject<PlanStep[]>;
  preview: RefObject<Preview | null>;
  planState: RefObject<PlanState | null>;
  planPath: RefObject<Vec3[]>;
  moving: RefObject<boolean>;
  paused: RefObject<boolean>;
  activeFloor: RefObject<number>;
  view2D: RefObject<boolean>;
  glassStyle: RefObject<boolean>;
  hoverCell: RefObject<number | null>;
  viewProj: RefObject<Float32Array>;
  cancelled: RefObject<boolean>;
  cancelRun: RefObject<boolean>;
  client: RefObject<RpdClient | null>;
  quest: RefObject<Quest | null>;
  nav: RefObject<NavGraph | null>;
  itemMarkers: RefObject<Map<string, number>>;
  doorMarkers: RefObject<Map<string, number>>;
  playerMarker: RefObject<number>;
};

export type RpdSet = {
  quest: Dispatch<SetStateAction<Quest | null>>;
  nav: Dispatch<SetStateAction<NavGraph | null>>;
  progress: Dispatch<SetStateAction<number>>;
  hidden: Dispatch<SetStateAction<boolean>>;
  error: Dispatch<SetStateAction<string | null>>;
  fps: Dispatch<SetStateAction<number>>;
  player: Dispatch<SetStateAction<Vec3>>;
  playerRoom: Dispatch<SetStateAction<string>>;
  inventory: Dispatch<SetStateAction<Set<string>>>;
  discovered: Dispatch<SetStateAction<Set<string>>>;
  picked: Dispatch<SetStateAction<Set<string>>>;
  doorStates: Dispatch<SetStateAction<Map<string, DoorState>>>;
  plan: Dispatch<SetStateAction<PlanStep[]>>;
  preview: Dispatch<SetStateAction<Preview | null>>;
  moving: Dispatch<SetStateAction<boolean>>;
  paused: Dispatch<SetStateAction<boolean>>;
  toast: Dispatch<SetStateAction<string>>;
  hover: Dispatch<SetStateAction<Hover | null>>;
  activeFloor: Dispatch<SetStateAction<number>>;
  view2D: Dispatch<SetStateAction<boolean>>;
  mapPopupAnchor: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  mapFocusToken: Dispatch<SetStateAction<number>>;
  showInventory: Dispatch<SetStateAction<boolean>>;
  showLegend: Dispatch<SetStateAction<boolean>>;
  statusNote: Dispatch<SetStateAction<string>>;
};

export type RpdData = {
  floors: Floor[];
  rooms: Room[];
  items: Item[];
  doors: Door[];
  itemLookup: Map<string, Item>;
  doorLookup: Map<string, Door>;
  roomLookup: Map<string, Room>;
  keyItems: [string, number][];
  itemNodes: Map<number, Item[]>;
  gridLines: Map<number, [Vec3, Vec3][]>;
  navNodesByFloor: number[][];
  planState: PlanState | null;
  planPath: Vec3[];
  mapBounds: [number, number, number, number] | null;
};

export type RpdDomRefs = {
  canvas: RefObject<HTMLCanvasElement | null>;
  overlay: RefObject<HTMLCanvasElement | null>;
  wrap: RefObject<HTMLElement | null>;
  popupLayer: RefObject<HTMLDivElement | null>;
  dock: RefObject<HTMLElement | null>;
};

export type QuestSession = {
  state: RpdState;
  refs: RpdRefs;
  set: RpdSet;
  data: RpdData;
  ref: RpdDomRefs;
};

export type RpdActions = {
  toggleView2D: () => void;
  reset: () => void;
  focusRoute: () => void;
  undoPlan: () => void;
  clearPlan: () => void;
  runPlan: () => void;
  previewTarget: (target: Target) => void;
  commitChoice: (choice: PlanChoice) => void;
};

export type CanvasHandlers = {
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onClick: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  onPointerCancel: () => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLCanvasElement>) => void;
};
