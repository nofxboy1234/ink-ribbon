import type { PlanSession } from "../session/usePlanSession";

type QuestPanelProps = {
  session: PlanSession;
};

const SLOTS = 8;

export default function QuestPanel({ session }: QuestPanelProps) {
  const { planCount, moving, room, inventory } = session.state;
  const note = moving
    ? "Claire is moving along the route."
    : planCount === 0
      ? "Switch to the 2D plan, click a cell and choose Add waypoint. Double click Claire to run the route."
      : `Plan has ${planCount} step${planCount === 1 ? "" : "s"}. Double click Claire to run the route.`;

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
          return (
            <span
              className="rpd-slot"
              key={index}
              data-filled={slot !== null}
              style={slot ? { background: `rgb(${slot.r} ${slot.g} ${slot.b})` } : undefined}
              aria-label={slot ? `Filled slot ${index + 1}` : `Empty slot ${index + 1}`}
            />
          );
        })}
      </div>
      <div className="rpd-legend">
        <div className="rpd-legend-row">
          <span className="rpd-dot" style={{ background: "#ff79c6" }} />
          <span>Claire</span>
          <span className="rpd-dot" style={{ background: "#39ff14" }} />
          <span>Route</span>
          <span className="rpd-dot" style={{ background: "#22d3ee" }} />
          <span>Waypoint</span>
        </div>
        <p className="rpd-legend-note">
          Click a cell, choose Add waypoint or take an item, then double click Claire to run the
          route.
        </p>
      </div>
    </aside>
  );
}
