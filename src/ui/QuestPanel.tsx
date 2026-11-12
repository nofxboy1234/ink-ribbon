import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

import type { PlanSession } from "../session/usePlanSession";

type QuestPanelProps = {
  session: PlanSession;
};

type PanelTab = "inventory" | "files";

type MenuTarget =
  | { kind: "inventory"; slot: number }
  | { kind: "box"; slot: number };

type MenuState = {
  x: number;
  y: number;
  target: MenuTarget;
  partnerIndexes: number[];
};

type PanelMode =
  | { kind: "browse"; selectedSlot: number | null }
  | { kind: "combine"; firstSlot: number };

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

const MENU_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 10,
  minWidth: 140,
  padding: 4,
  border: "1px solid #24221e",
  background: "rgb(250 247 239 / 97%)",
  boxShadow: "0 10px 24px rgb(36 34 30 / 16%)",
  color: "#24221e",
  font: '11px/1.4 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};

const MENU_ITEM_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "7px 10px",
  border: 0,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

function MenuItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      style={MENU_ITEM_STYLE}
      onClick={onSelect}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "#24221e";
        event.currentTarget.style.color = "#f5f1e6";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
        event.currentTarget.style.color = "#24221e";
      }}
    >
      {label}
    </button>
  );
}

export default function QuestPanel({ session }: QuestPanelProps) {
  const { planCount, moving, room, inventory, box, boxOpen, notes } = session.state;
  const [tab, setTab] = useState<PanelTab>("inventory");
  const [mode, setMode] = useState<PanelMode>({ kind: "browse", selectedSlot: null });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedSlot = mode.kind === "combine" ? mode.firstSlot : mode.selectedSlot;
  const selectedItem = selectedSlot !== null ? inventory[selectedSlot] : null;
  const note = moving
    ? "Claire is moving along the route."
    : planCount === 0
      ? "Switch to the 2D plan, right click a cell and choose Add waypoint. Right click again to run the route."
      : `Plan has ${planCount} step${planCount === 1 ? "" : "s"}. Right click the plan to remove a waypoint or run the route.`;

  useEffect(() => {
    if (!menu) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [menu]);

  useEffect(() => {
    if (mode.kind !== "combine") return;
    const cancelOnKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMode({ kind: "browse", selectedSlot: mode.firstSlot });
      setMessage(null);
    };
    window.addEventListener("keydown", cancelOnKey);
    return () => window.removeEventListener("keydown", cancelOnKey);
  }, [mode]);

  const forgetSlot = (slot: number) => {
    setMode((current) => {
      if (current.kind === "combine" && current.firstSlot === slot) {
        return { kind: "browse", selectedSlot: null };
      }
      if (current.kind === "browse" && current.selectedSlot === slot) {
        return { kind: "browse", selectedSlot: null };
      }
      return current;
    });
  };

  const changeTab = (next: PanelTab) => {
    setTab(next);
    setMenu(null);
    if (mode.kind === "combine") setMode({ kind: "browse", selectedSlot: mode.firstSlot });
  };

  const openInventoryMenu = (event: ReactMouseEvent<HTMLButtonElement>, slot: number) => {
    event.preventDefault();
    event.stopPropagation();
    const entry = inventory[slot];
    if (!entry) return;
    setMenu({
      x: event.clientX,
      y: event.clientY,
      target: { kind: "inventory", slot },
      partnerIndexes: session.actions.combinePartners(entry.index),
    });
  };

  const openBoxMenu = (event: ReactMouseEvent<HTMLButtonElement>, slot: number) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target: { kind: "box", slot }, partnerIndexes: [] });
  };

  const selectSlot = (slot: number) => {
    const entry = inventory[slot];
    if (!entry) {
      if (mode.kind === "browse") setMode({ kind: "browse", selectedSlot: null });
      return;
    }
    if (mode.kind === "combine") {
      if (slot === mode.firstSlot) return;
      const first = inventory[mode.firstSlot];
      if (!first) {
        setMessage("Those items have no recipe.");
        return;
      }
      const result = session.actions.combine(first.index, entry.index);
      if (result === 0) {
        setMode({ kind: "browse", selectedSlot: null });
        setMessage("Combined.");
      } else {
        setMessage(result === -1 ? "Those items have no recipe." : "The combine failed.");
      }
      return;
    }
    setMode({ kind: "browse", selectedSlot: mode.selectedSlot === slot ? null : slot });
    setMessage(null);
  };

  const startCombine = (slot: number) => {
    setMode({ kind: "combine", firstSlot: slot });
    setMenu(null);
    setMessage(null);
  };

  const discardItem = (slot: number, index: number) => {
    session.actions.discard(index);
    forgetSlot(slot);
    setMenu(null);
    setMessage(null);
  };

  const storeItem = (slot: number, index: number) => {
    session.actions.store(index);
    forgetSlot(slot);
    setMenu(null);
    setMessage(null);
  };

  const menuEntry =
    menu?.target.kind === "inventory" ? inventory[menu.target.slot] : null;
  const menuBoxEntry =
    menu?.target.kind === "box" ? box.find((entry) => entry.slot === menu.target.slot) : null;

  return (
    <>
      <aside className="rpd-panel" aria-label="Route planner and inventory">
        <div className="rpd-panel-head">
          <div>
            <p className="rpd-kicker">Route planner</p>
            <h2>{room}</h2>
          </div>
          <div className="rpd-panel-status">{moving && <span className="rpd-paused">Running</span>}</div>
        </div>
        <div className="rpd-notes-tabs" role="tablist" aria-label="Inventory and files">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "inventory"}
            data-active={tab === "inventory"}
            onClick={() => changeTab("inventory")}
          >
            Inventory
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            data-active={tab === "files"}
            onClick={() => changeTab("files")}
          >
            Files
          </button>
        </div>
        {tab === "inventory" ? (
          <>
            <p className="rpd-note">{note}</p>
            <div className="rpd-section-title">
              <span>Inventory</span>
            </div>
            <div className="rpd-inventory" data-empty={inventory.every((slot) => slot === null)}>
              {Array.from({ length: SLOTS }, (_, index) => {
                const slot = inventory[index];
                const combining =
                  mode.kind === "combine" && slot !== null && index !== mode.firstSlot;
                const style = {
                  ...(slot ? { background: `rgb(${slot.r} ${slot.g} ${slot.b})` } : {}),
                  ...(combining ? { outline: "2px solid #8a5a2b", outlineOffset: 2 } : {}),
                };
                return (
                  <button
                    type="button"
                    className={`rpd-slot${selectedSlot === index ? " selected" : ""}`}
                    key={index}
                    data-filled={slot !== null}
                    data-name={slot?.name ?? ""}
                    style={style}
                    title={slot ? slot.name : undefined}
                    aria-label={slot ? slot.name : `Empty slot ${index + 1}`}
                    onClick={() => selectSlot(index)}
                    onContextMenu={(event) => openInventoryMenu(event, index)}
                  />
                );
              })}
            </div>
            {selectedItem && (
              <div className="rpd-item-detail">
                <p className="rpd-item-name">{selectedItem.name}</p>
                <p className="rpd-item-desc">{selectedItem.description}</p>
                {mode.kind === "combine" && (
                  <p className="rpd-item-desc" role="status">
                    Choose a highlighted item to combine with {selectedItem.name}.
                  </p>
                )}
                {mode.kind === "combine" && (
                  <div className="rpd-item-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setMode({ kind: "browse", selectedSlot: mode.firstSlot });
                        setMessage(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
            {message && (
              <p className="rpd-item-desc" role="status" style={{ margin: "8px 0 0" }}>
                {message}
              </p>
            )}
            {boxOpen && (
              <>
                <div className="rpd-section-title">
                  <span>Item box</span>
                </div>
                <div className="rpd-inventory" data-empty={box.length === 0}>
                  {box.length === 0 && <span className="rpd-box-empty">Empty</span>}
                  {box.map((entry) => (
                    <button
                      type="button"
                      className="rpd-slot rpd-box-slot"
                      key={entry.slot}
                      data-filled="true"
                      data-name={entry.name}
                      title={entry.name}
                      aria-label={`${entry.name} in the item box`}
                      style={{
                        background: `rgb(${entry.r} ${entry.g} ${entry.b})`,
                        padding: 0,
                      }}
                      onClick={() => session.actions.takeFromBox(entry.slot)}
                      onContextMenu={(event) => openBoxMenu(event, entry.slot)}
                    />
                  ))}
                </div>
              </>
            )}
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
                lock opens. Right click an inventory block for its actions. Right click the 2D plan for
                waypoints and Run route. Middle drag pans the plan. Wheel zooms.
              </p>
            </div>
          </>
        ) : (
          <div className="rpd-notes-list">
            {notes.length === 0 && <p className="rpd-notes-empty">No notes collected yet.</p>}
            {notes.map((file) => (
              <article className="rpd-note" key={file.id}>
                <h3>{file.title}</h3>
                <p>{file.body}</p>
              </article>
            ))}
          </div>
        )}
      </aside>
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Item actions"
          style={{ ...MENU_STYLE, left: menu.x, top: menu.y }}
        >
          {menu.target.kind === "inventory" && menuEntry && (
            <>
              <MenuItem
                label="Examine"
                onSelect={() => {
                  setMode({ kind: "browse", selectedSlot: menu.target.slot });
                  setMenu(null);
                }}
              />
              {menu.partnerIndexes.length > 0 && (
                <MenuItem label="Combine" onSelect={() => startCombine(menu.target.slot)} />
              )}
              {boxOpen && <MenuItem label="Store" onSelect={() => storeItem(menu.target.slot, menuEntry.index)} />}
              <MenuItem label="Discard" onSelect={() => discardItem(menu.target.slot, menuEntry.index)} />
            </>
          )}
          {menu.target.kind === "box" && menuBoxEntry && (
            <MenuItem
              label="Take"
              onSelect={() => {
                session.actions.takeFromBox(menu.target.slot);
                setMenu(null);
              }}
            />
          )}
        </div>
      )}
    </>
  );
}
