import type { RpdModule } from "./rpd";


export type RpdFactory = (options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}) => Promise<RpdModule>;

export type RpdClient = {
  loadScene(data: Uint8Array): number;
  getCamera(): Float32Array;
  setOrbit(tx: number, ty: number, tz: number, yaw: number, pitch: number, distance: number): number;
  animateOrbit(tx: number, ty: number, tz: number, distance: number, duration: number): number;
  getViewProj(): Float32Array;
  markerClear(): void;
  markerAdd(
    shape: number,
    x: number,
    y: number,
    z: number,
    size: number,
    r: number,
    g: number,
    b: number,
  ): number;
  markerSetVisible(index: number, visible: number): void;
  markerSetPosition(index: number, x: number, y: number, z: number): void;
  markerSetColor(index: number, r: number, g: number, b: number): void;
  markerSetRotation(index: number, radians: number): void;
  markerCount(): number;
  setPlayerPosition(x: number, y: number, z: number): void;
  playerRadius(): number;
  routeRadius(): number;
  mapLoad(data: Uint8Array): number;
  planSetFloors(levels: Float32Array, bounds: Float32Array): void;
  planSetGraph(
    count: number,
    x: Float32Array,
    y: Float32Array,
    z: Float32Array,
    floor: Uint8Array,
    kind: Uint8Array,
    first: Int32Array,
    adjacency: Int32Array,
    cost: Float32Array,
  ): void;
  planSetRooms(
    count: number,
    x: Float32Array,
    y: Float32Array,
    z: Float32Array,
    floor: Uint8Array,
    names: Uint8Array,
    offsets: Int32Array,
  ): void;
  planSetSpawn(x: number, y: number, z: number): void;
  planSetPlayer(x: number, y: number, z: number): void;
  planSetFloor(index: number): void;
  gameRun(): number;
  gameSetRun(on: boolean): void;
  planActiveFloor(): number;
  planStartMove(): void;
  planAddTarget(x: number, y: number, z: number): void;
  planAddTargetNode(node: number): void;
  planRemoveTargetNode(node: number): number;
  planWaypoint(index: number): number;
  planHoverItem(): number;
  planHover(): number;
  planPointerMove(x: number, y: number): void;
  planNodeBlocked(node: number): number;
  planCamera(): Float32Array;
  planRouteCount(): number;
  planHoverRoute(): number[];
  planRoute(): Float32Array;
  popupState(): Float32Array;
  popupChoice(index: number): {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    enabled: boolean;
    action: number;
    label: string;
  } | null;
  popupMessage(): string;
  popupClose(): void;
  itemCount(): number;
  item(index: number): {
    x: number;
    y: number;
    z: number;
    r: number;
    g: number;
    b: number;
    node: number;
    taken: boolean;
    room: number;
    floor: number;
    state: number;
    action: number;
    hidden: boolean;
    available: boolean;
    flags: number;
    cubeX: number;
    cubeY: number;
    cubeZ: number;
    name: string;
    roomName: string;
  } | null;
  itemIcon(index: number): string;
  itemAction(index: number): string;
  itemHint(index: number): string;
  itemAct(index: number): number;
  itemDebugTake(index: number): number;
  itemDebugOpen(index: number): number;
  itemDebugSolve(index: number): number;
  itemRelated(index: number): number[];
  itemDebugHighlight(index: number): void;
  itemDebugHighlighted(): number;
  itemDiscard(index: number): number;
  boxStore(index: number): number;
  boxTake(slot: number): number;
  boxCount(): number;
  boxItem(slot: number): number;
  saveSnapshot(): Uint8Array;
  saveRestore(bytes: Uint8Array): number;
  saveSize(): number;
  doorsCount(): number;
  enemyCount(): number;
  enemyAlive(): number;
  enemyHealth(index: number): number;
  enemyHit(index: number, damage: number): number;
  enemyVisible(index: number): number;
  enemyPosition(index: number): number[];
  doorsDiscovered(index: number): boolean;
  planTeleportItem(index: number): void;
  itemTransitionTarget(index: number): number;
  health(): number;
  ending(): boolean;
  shoot(index: number, stationary: boolean): number;
  stab(index: number): number;
  craftResult(first: number, second: number): number;
  craftCombine(first: number, second: number): number;
  toggleDebug(): void;
  debugEnabled(): boolean;
  setDebugAllowed(allowed: boolean): void;
  itemEnterCode(index: number, code: string): number;
  itemGrantExternal(id: number): number;
  itemHasCode(index: number): boolean;
  itemBlocked(index: number): number;
  itemIndexForId(id: number): number;
  inventoryItem(slot: number): number;
  inventoryCount(): number;
  inventory(): Float32Array;
  planMoveState(): Float32Array;
  setFpsVisible(visible: boolean): void;
  planCount(): number;
  planMoving(): number;
  planRoom(): string;
  planPlayer(): Float32Array;
  planReset(): void;
  planClearRoute(): void;
  openPopupAt(x: number, z: number): number;
  resetView(): void;
  recenter(): void;
  cameraModel(): Float32Array;
  debugFloors(): Float32Array;
  overlayStats(): Float32Array;
  dispose(): void;
};
