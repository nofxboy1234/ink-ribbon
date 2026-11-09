import { useEffect, useRef } from "react";
import {
  waypointMenuItems,
  type WaypointCommand,
  type WaypointMenuState,
} from "../session/waypointMenu";

type MapContextMenuProps = {
  menu: WaypointMenuState;
  onCommand: (command: WaypointCommand) => void;
  onClose: () => void;
};

export default function MapContextMenu({ menu, onCommand, onClose }: MapContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const items = waypointMenuItems(menu);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose]);

  const margin = 8;
  const width = 192;
  const height = 118;
  const left =
    typeof window === "undefined" ? menu.x : Math.min(menu.x, window.innerWidth - width - margin);
  const top =
    typeof window === "undefined" ? menu.y : Math.min(menu.y, window.innerHeight - height - margin);

  return (
    <div
      className="rpd-menu"
      role="menu"
      aria-label="Map actions"
      ref={ref}
      style={{ left: Math.max(margin, left), top: Math.max(margin, top) }}
    >
      {items.map((item) => (
        <button
          className="rpd-menu-item"
          data-command={item.command}
          disabled={!item.enabled}
          key={item.command}
          role="menuitem"
          type="button"
          onClick={() => onCommand(item.command)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
