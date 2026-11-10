import { useState } from "react";

import type { PlanSession } from "../session/usePlanSession";

type QuestPanelProps = {
  session: PlanSession;
};

const SLOTS = 8;

// Mirrors CATEGORY_COLOURS in native/src/rpd_items.c.
const ITEM_KEYS = [
  ["Keys", "rgb(158 79 242)"],
  ["Locks", "rgb(242 140 51)"],
  ["Files", "rgb(230 230 214)"],
  ["Weapons", "rgb(230 71 71)"],
  ["Ammo", "rgb(242 209 77)"],
  ["Herbs", "rgb(89 217 102)"],
  ["Containers", "rgb(153 107 64)"],
  ["Puzzle", "rgb(77 217 217)"],
] as const;

export default function QuestPanel({ session }: QuestPanelProps) {
  const { planCount, moving, room, inventory, box } = session.state;
  const [selected, setSelected] = useState<number | null>(null);
  const selectedSlot = selected !== null ? inventory[selected] : null;
  const note = moving
    ? "Claire is moving along the route."
    : planCount === 0
      ? "Switch to the 2D plan, right click a cell and choose Add waypoint. Right click again to run the route."
      : `Plan has ${planCount} step${planCount === 1 ? "" : "s"}. Right click the plan to remove a waypoint or run the route.`;

  return (
    <aside className="rpd-panel" aria-label="Route planner">
      <div className="rpd-panel-head">
        <div>
          <p className="rpd-kicker">Route planner</p>
          <h2>{room}</h2>
        </div>
        <div className="rpd-panel-status">{moving && <span className="rpd-paused">Running</span>}</div>
      </div>
      <p className="rpd-note">{note}</p>
      <div className="rpd-section-title">
        <span>Inventory</span>
      </div>
      <div className="rpd-inventory" data-empty={inventory.every((slot) => slot === null)}>
        {Array.from({ length: SLOTS }, (_, index) => {
          const slot = inventory[index];
          const style = slot ? { background: `rgb(${slot.r} ${slot.g} ${slot.b})` } : undefined;
          return (
            <button
              type="button"
              className={`rpd-slot${selected === index ? " selected" : ""}`}
              key={index}
              data-filled={slot !== null}
              data-name={slot?.name ?? ""}
              style={style}
              title={slot?.name ?? undefined}
              aria-label={slot ? slot.name : `Empty slot ${index + 1}`}
              onClick={() => setSelected(slot ? (selected === index ? null : index) : null)}
            />
          );
        })}
      </div>
      {selectedSlot && (
        <div className="rpd-item-detail">
          <p className="rpd-item-name">{selectedSlot.name}</p>
          <p className="rpd-item-desc">{selectedSlot.description}</p>
          <div className="rpd-item-actions">
            <button type="button" onClick={() => session.actions.discard(selectedSlot.index)}>
              Discard
            </button>
            <button type="button" onClick={() => session.actions.store(selectedSlot.index)}>
              Store in box
            </button>
          </div>
        </div>
      )}
      <div className="rpd-section-title">
        <span>Item box</span>
      </div>
      <div className="rpd-box" data-empty={box.length === 0}>
        {box.length === 0 && <span className="rpd-box-empty">Empty</span>}
        {box.map((entry) => (
          <button
            type="button"
            className="rpd-box-slot"
            key={entry.slot}
            title={entry.name}
            onClick={() => session.actions.takeFromBox(entry.slot)}
          >
            {entry.name}
          </button>
        ))}
      </div>
      <div className="rpd-legend">
        <div className="rpd-legend-row rpd-legend-items">
          {ITEM_KEYS.map(([label, color]) => (
            <span className="rpd-legend-key" key={label}>
              <span className="rpd-dot" style={{ background: color }} />
              <span>{label}</span>
            </span>
          ))}
        </div>
        <div className="rpd-legend-row">
          <span className="rpd-dot" style={{ background: "#39ff14" }} />
          <span>Route</span>
          <span className="rpd-dot" style={{ background: "#22d3ee" }} />
          <span>Waypoint</span>
        </div>
        <p className="rpd-legend-note">
          Click an item to take, unlock, open or read it. Keys must be in the eight slots before a
          lock opens. Right click the 2D plan for waypoints and Run route. Right drag rotates the
          camera in 3D.
        </p>
      </div>
    </aside>
  );
}
