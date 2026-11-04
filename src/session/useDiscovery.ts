import { useCallback } from "react";
import type { Vec3 } from "../quest";
import { DISCOVER_RADIUS, SPAWN_DISCOVER_RADIUS, distance3, itemPoint } from "./scene";
import type { QuestSession } from "./types";

export function useDiscovery(session: QuestSession) {
  const { refs, set } = session;

  const revealItems = useCallback(
    (position: Vec3, force = false): Set<string> => {
      const quest = refs.quest.current;
      const client = refs.client.current;
      if (!quest || !client) return refs.discovered.current;
      let next = refs.discovered.current;
      let changed = false;
      for (const item of quest.items) {
        if (next.has(item.id)) continue;
        if (refs.picked.current.has(item.id)) continue;
        const close =
          distance3(position, itemPoint(item)) <
          (force ? SPAWN_DISCOVER_RADIUS : DISCOVER_RADIUS);
        if (!close) continue;
        if (Math.abs(item.y - position[1]) > 1.9) continue;
        if (next === refs.discovered.current) next = new Set(next);
        next.add(item.id);
        changed = true;
        const marker = refs.itemMarkers.current.get(item.id);
        if (marker !== undefined) client.markerSetVisible(marker, 1);
        set.toast(`Discovered ${item.name} — ${item.location}`);
      }
      if (changed) {
        refs.discovered.current = next;
        set.discovered(next);
      }
      return next;
    },
    [refs, set],
  );

  return { revealItems };
}
