import { useEffect } from "react";
import type { QuestSession } from "./types";

export function useViewControls(session: QuestSession) {
  const { refs, set, state } = session;

  const toggleView2D = () => {
    const next = !refs.view2D.current;
    refs.view2D.current = next;
    set.view2D(next);
    set.toast(next ? "2D floor plan." : "3D view.");
  };

  const toggleRenderStyle = () => {
    const next = !refs.glassStyle.current;
    refs.glassStyle.current = next;
    refs.client.current?.setRenderStyle(next ? 1 : 0);
    set.toast(next ? "Glass view." : "Solid view.");
  };

  useEffect(() => {
    refs.client.current?.setViewMode(state.view2D ? 1 : 0);
  }, [refs, state.view2D]);

  return { toggleView2D, toggleRenderStyle };
}
