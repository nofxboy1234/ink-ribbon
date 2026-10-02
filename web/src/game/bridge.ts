import { useSyncExternalStore } from "react";

export type GameState = {
  player: [number, number];
};

export type GameWindow = Window & {
  __inkRibbonState?: GameState;
  inkRibbonCommands?: number[];
};

const EMPTY: GameState = {
  player: [0, 0],
};

const subscribe = (onChange: () => void) => {
  window.addEventListener("ink-ribbon:state", onChange);
  return () => window.removeEventListener("ink-ribbon:state", onChange);
};

export function useGameState() {
  return useSyncExternalStore(
    subscribe,
    () => (window as GameWindow).__inkRibbonState ?? EMPTY,
    () => EMPTY,
  );
}

export function command(action: number, id: number) {
  const game = window as GameWindow;
  (game.inkRibbonCommands ??= []).push(action * 1000 + id);
}
