import { useRef } from "react";
import type { PlanSession } from "../session/usePlanSession";
import MapContextMenu from "./MapContextMenu";

type RpdStageProps = {
  session: PlanSession;
  label: string;
};

const DRAG_THRESHOLD = 4;

export default function RpdStage({ session, label }: RpdStageProps) {
  const rightPress = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const { menu } = session.state;

  return (
    <div className="rpd-stage">
      <canvas
        ref={session.ref.canvas}
        id="canvas"
        className="rpd-canvas"
        aria-label={label}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 2) return;
          rightPress.current = { x: event.clientX, y: event.clientY, dragged: false };
        }}
        onPointerMove={(event) => {
          const press = rightPress.current;
          if (!press || (event.buttons & 2) === 0) return;
          if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD) {
            press.dragged = true;
          }
        }}
        onPointerUp={(event) => {
          if (event.button !== 2) return;
          const press = rightPress.current;
          rightPress.current = null;
          if (!press || press.dragged) return;
          const rect = event.currentTarget.getBoundingClientRect();
          session.actions.openMenu(event.clientX - rect.left, event.clientY - rect.top);
        }}
        onPointerCancel={() => {
          rightPress.current = null;
        }}
      />
      {menu && (
        <MapContextMenu
          menu={menu}
          onCommand={session.actions.waypointCommand}
          onClose={session.actions.closeMenu}
        />
      )}
    </div>
  );
}
