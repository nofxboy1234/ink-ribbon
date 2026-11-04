import { useEffect } from "react";
import { popupGeometry } from "../overlay/geometry";
import { drawSceneOverlay } from "../overlay/sceneOverlay";
import type { QuestSession } from "./types";

export function useSceneEffects(session: QuestSession) {
  const { state, refs, data, ref } = session;

  useEffect(() => {
    const dock = ref.dock.current;
    const root = ref.wrap.current;
    if (!dock || !root) {
      root?.style.removeProperty("--dock-height");
      return;
    }
    const update = () =>
      root.style.setProperty("--dock-height", `${dock.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--dock-height");
    };
  }, [state.plan.length, ref]);

  useEffect(() => {
    if (!state.quest || !state.nav) return;
    const frame = () => {
      const client = refs.client.current;
      const canvas = ref.overlay.current;
      if (client && canvas) {
        const viewProj = client.getViewProj();
        refs.viewProj.current = viewProj;
        drawSceneOverlay({
          canvas,
          viewProj,
          quest: state.quest!,
          nav: state.nav!,
          activeFloor: state.activeFloor,
          doors: data.doors,
          gridLines: data.gridLines,
          navNodesByFloor: data.navNodesByFloor,
          player: refs.player.current,
          hovered: refs.hoverCell.current,
          plan: refs.plan.current,
          planPath: refs.planPath.current,
          preview: refs.preview.current,
          planCursor: refs.planState.current?.cursor ?? null,
          view2D: refs.view2D.current,
          popupLayer: ref.popupLayer.current,
        });
      }
      raf = requestAnimationFrame(frame);
    };
    let raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [state.quest, state.nav, state.activeFloor, data.doors, data.gridLines, data.navNodesByFloor, refs, ref]);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frames += 1;
      if (now - last >= 500) {
        session.set.fps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session.set]);

  useEffect(() => {
    if (!state.view2D) return;
    const layer = ref.popupLayer.current;
    if (!layer) return;
    if (!state.preview || !state.mapPopupAnchor) {
      layer.style.visibility = "hidden";
      return;
    }
    const geometry = popupGeometry(
      state.mapPopupAnchor,
      state.preview.choices.length,
      window.innerWidth,
      window.innerHeight,
    );
    layer.style.transform = `translate3d(${geometry.x}px, ${geometry.y}px, 0)`;
    layer.style.visibility = "visible";
  }, [state.view2D, state.preview, state.mapPopupAnchor, ref]);
}
