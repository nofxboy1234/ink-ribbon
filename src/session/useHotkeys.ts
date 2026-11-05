import { useEffect } from "react";
import { nearestNode, nodePoint } from "../nav";
import { nearbyRoom } from "../quest";
import type { QuestSession } from "./types";

type HotkeyActions = {
  toggleView2D: () => void;
  pauseAndClearRoute: () => void;
};

export function useHotkeys(session: QuestSession, actions: HotkeyActions) {
  const { refs, set } = session;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.code === "Escape") {
        event.preventDefault();
        refs.cancelRun.current = true;
        actions.pauseAndClearRoute();
        return;
      }
      if (event.code === "KeyM") {
        event.preventDefault();
        actions.toggleView2D();
        return;
      }
      if (event.code === "KeyF") {
        if (event.shiftKey || target?.closest('[contenteditable="true"]')) return;
        const player = refs.player.current;
        const client = refs.client.current;
        if (!player || !client) return;
        if (refs.view2D.current) {
          const graph = refs.nav.current;
          const quest = refs.quest.current;
          if (!graph || !quest) return;
          const playerNode = nearestNode(graph, player, 3.0);
          const playerFloor =
            playerNode >= 0 ? graph.floor[playerNode] : nearbyRoom(quest, player).floor;
          refs.activeFloor.current = playerFloor;
          set.activeFloor(playerFloor);
          set.mapFocusToken((value) => value + 1);
          event.preventDefault();
          set.toast("Map centered on Claire.");
          return;
        }
        client.animateOrbit(player[0], player[1], player[2], -1, 0.35);
        event.preventDefault();
        set.toast("Camera centered on Claire.");
        return;
      }
      if (event.code !== "Space") return;
      if (target?.closest('button, select, a, [contenteditable="true"]')) return;
      const node = refs.hoverCell.current;
      if (node === null) return;
      const graph = refs.nav.current;
      const client = refs.client.current;
      if (!graph || !client) return;
      const point = nodePoint(graph, node, 0);
      client.animateOrbit(point[0], point[1], point[2], 8, 0.35);
      event.preventDefault();
      const quest = refs.quest.current;
      if (quest) set.toast(`Camera centered on ${nearbyRoom(quest, point).name}.`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
