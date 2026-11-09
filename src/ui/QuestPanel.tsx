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
            <span
              className="rpd-slot"
              key={index}
              data-filled={slot !== null}
              data-name={slot?.name ?? ""}
              style={style}
              title={slot?.name ?? undefined}
              aria-label={slot ? slot.name : `Empty slot ${index + 1}`}
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
          Click an item to take, unlock, open or read it. Keys must be in the eight slots before a
          lock opens. Right click the plan for waypoints and Run route. Right drag rotates the
          camera in 3D.
        </p>
      </div>
    </aside>
  );
}
