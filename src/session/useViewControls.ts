import { useEffect } from "react";
import { nearestNode } from "../nav";
import { nearbyRoom } from "../quest";
import type { QuestSession } from "./types";

export function useViewControls(session: QuestSession) {
  const { refs, set } = session;

  const toggleView2D = () => {
    const next = !refs.view2D.current;
    refs.view2D.current = next;
    set.view2D(next);
    refs.client.current?.setViewMode(next ? 1 : 0);
    if (next) {
      const graph = refs.nav.current;
      const player = refs.player.current;
      const quest = refs.quest.current;
      if (graph && player && quest) {
        const node = nearestNode(graph, player, 4.0);
        const floor = node >= 0 ? graph.floor[node] : nearbyRoom(quest, player).floor;
        set.activeFloor(floor);
      }
      set.mapFocusToken((value) => value + 1);
    }
    set.toast(next ? "Top-down plan." : "Perspective.");
  };

  useEffect(() => {
    refs.client.current?.setViewMode(session.state.view2D ? 1 : 0);
  }, [refs, session.state.view2D]);

  return { toggleView2D };
}
