import { useEffect, useReducer, useState } from "react";
import type { CSSProperties } from "react";

import type { Floor } from "../quest";
import type { PlanSession } from "../session/usePlanSession";

type SaveSlot = {
  savedAt: number;
  floor: number;
  data: number[];
};

type SaveSlots = [SaveSlot | null, SaveSlot | null, SaveSlot | null];

type SlotIndex = 0 | 1 | 2;

type OverlayMode = "save" | "load";

type OverlayState =
  | { kind: "closed" }
  | { kind: "open"; mode: OverlayMode; message: string | null };

type OverlayEvent =
  | { type: "typewriter"; at: boolean }
  | { type: "toggle-load"; atTypewriter: boolean }
  | { type: "close"; atTypewriter: boolean }
  | { type: "message"; text: string };

const SLOT_INDEXES: readonly SlotIndex[] = [0, 1, 2];

const SAVE_KEY = "rpd.saves.v2";

const EMPTY_SLOTS: SaveSlots = [null, null, null];

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 11,
  display: "grid",
  placeItems: "center",
  padding: 18,
  background: "rgb(36 34 30 / 28%)",
};

const PANEL: CSSProperties = {
  width: "min(440px, calc(100vw - 36px))",
  padding: 20,
  border: "1px solid #24221e",
  background: "linear-gradient(180deg, rgb(250 247 239 / 98%), rgb(244 239 228 / 96%))",
  boxShadow: "0 24px 70px rgb(36 34 30 / 28%)",
  color: "#24221e",
  font: '12px/1.5 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};

const HEAD: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  paddingBottom: 10,
  borderBottom: "1px solid rgb(36 34 30 / 16%)",
};

const TITLE: CSSProperties = {
  margin: 0,
  color: "#17150f",
  fontSize: 16,
  lineHeight: 1.2,
};

const HINT: CSSProperties = {
  margin: "12px 0 10px",
  color: "rgb(36 34 30 / 66%)",
};

const SLOT_ROW: CSSProperties = {
  marginBottom: 0,
  padding: "10px 0",
  borderBottom: "1px solid rgb(36 34 30 / 10%)",
};

const BUTTON: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #24221e",
  background: "transparent",
  color: "#24221e",
  font: "inherit",
  cursor: "pointer",
};

function overlayReducer(state: OverlayState, event: OverlayEvent): OverlayState {
  switch (event.type) {
    case "typewriter":
      if (event.at) {
        return state.kind === "closed" ? { kind: "open", mode: "save", message: null } : state;
      }
      return state.kind === "open" && state.mode === "save" ? { kind: "closed" } : state;
    case "toggle-load":
      if (state.kind === "open" && state.mode === "load") {
        return event.atTypewriter
          ? { kind: "open", mode: "save", message: null }
          : { kind: "closed" };
      }
      return { kind: "open", mode: "load", message: null };
    case "close":
      return event.atTypewriter && state.kind === "open" && state.mode === "load"
        ? { kind: "open", mode: "save", message: null }
        : { kind: "closed" };
    case "message":
      return state.kind === "open" ? { ...state, message: event.text } : state;
    default:
      return state;
  }
}

function parseSlot(value: unknown): SaveSlot | null {
  if (typeof value !== "object" || value === null) return null;
  const slot = value as Record<string, unknown>;
  if (typeof slot.savedAt !== "number" || typeof slot.floor !== "number") return null;
  if (!Array.isArray(slot.data) || slot.data.length === 0) return null;
  if (!slot.data.every(Number.isInteger)) return null;
  return { savedAt: slot.savedAt, floor: slot.floor, data: slot.data as number[] };
}

function readSlots(): SaveSlots {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return EMPTY_SLOTS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_SLOTS;
    return [parseSlot(parsed[0]), parseSlot(parsed[1]), parseSlot(parsed[2])];
  } catch {
    return EMPTY_SLOTS;
  }
}

function writeSlots(slots: SaveSlots): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(slots));
    return true;
  } catch {
    return false;
  }
}

function formatSavedAt(savedAt: number): string {
  return new Date(savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type SaveMenuProps = {
  mode: OverlayMode;
  slots: SaveSlots;
  floors: Floor[];
  message: string | null;
  onSave: (index: SlotIndex) => void;
  onLoad: (index: SlotIndex) => void;
  onClose: () => void;
};

function SaveMenu({ mode, slots, floors, message, onSave, onLoad, onClose }: SaveMenuProps) {  const floorLabel = (index: number) =>
    floors.find((floor) => floor.index === index)?.label ?? `Floor ${index + 1}`;

  return (
    <div style={BACKDROP} role="presentation" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={mode === "save" ? "Save game" : "Load game"}
        data-overlay={mode}
        style={PANEL}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={HEAD}>
          <div>
            <p className="rpd-kicker">{mode === "save" ? "Typewriter" : "Save slots"}</p>
            <h2 style={TITLE}>{mode === "save" ? "Save game" : "Load game"}</h2>
          </div>
          <button
            type="button"
            style={BUTTON}
            onClick={onClose}
            aria-label={mode === "save" ? "Close save menu" : "Close load menu"}
          >
            ×
          </button>
        </div>
        <p style={HINT}>
          {mode === "save"
            ? "Choose a slot. Press L for the load menu."
            : "Choose a saved slot. Escape or the backdrop closes this menu."}
        </p>
        {SLOT_INDEXES.map((index) => {
          const slot = slots[index];
          return (
            <div
              className="rpd-save-slot"
              style={SLOT_ROW}
              key={index}
              data-slot={index + 1}
              data-filled={slot !== null}
            >
              <span className="rpd-save-name">Slot {index + 1}</span>
              <span className="rpd-save-meta">
                {slot ? `${formatSavedAt(slot.savedAt)} · ${floorLabel(slot.floor)}` : "Empty"}
              </span>
              {mode === "save" ? (
                <button
                  type="button"
                  style={BUTTON}
                  aria-label={`Save to slot ${index + 1}`}
                  onClick={() => onSave(index)}
                >
                  Save
                </button>
              ) : (
                <button
                  type="button"
                  style={{
                    ...BUTTON,
                    opacity: slot ? 1 : 0.45,
                    cursor: slot ? "pointer" : "default",
                  }}
                  aria-label={`Load slot ${index + 1}`}
                  disabled={!slot}
                  onClick={() => onLoad(index)}
                >
                  Load
                </button>
              )}
            </div>
          );
        })}
        {message && (
          <p className="rpd-save-message" role="status" style={{ margin: "10px 0 0" }}>
            {message}
          </p>
        )}
      </section>
    </div>
  );
}

type SaveOverlayProps = {
  session: PlanSession;
};

export default function SaveOverlay({ session }: SaveOverlayProps) {
  const { atTypewriter, loaded, floors, activeFloor } = session.state;
  const [slots, setSlots] = useState<SaveSlots>(readSlots);
  const [overlay, dispatch] = useReducer(
    overlayReducer,
    atTypewriter,
    (at): OverlayState =>
      at ? { kind: "open", mode: "save", message: null } : { kind: "closed" },
  );

  useEffect(() => {
    dispatch({ type: "typewriter", at: atTypewriter });
  }, [atTypewriter]);

  useEffect(() => {
    if (!loaded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (event.key.toLowerCase() !== "l") return;
      event.preventDefault();
      dispatch({ type: "toggle-load", atTypewriter });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atTypewriter, loaded]);

  useEffect(() => {
    if (overlay.kind === "closed") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dispatch({ type: "close", atTypewriter });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay.kind, atTypewriter]);

  if (overlay.kind === "closed" || !loaded) return null;

  const close = () => dispatch({ type: "close", atTypewriter });

  const save = (index: SlotIndex) => {
    if (!atTypewriter) {
      dispatch({ type: "message", text: "Stand at a typewriter to save." });
      return;
    }
    const snapshot = session.actions.save();
    if (!snapshot) {
      dispatch({ type: "message", text: "The save is not ready yet." });
      return;
    }
    const next: SaveSlots = [slots[0], slots[1], slots[2]];
    next[index] = { savedAt: Date.now(), floor: activeFloor, data: snapshot };
    if (!writeSlots(next)) {
      dispatch({ type: "message", text: "The browser refused the save." });
      return;
    }
    setSlots(next);
    dispatch({ type: "message", text: `Saved to slot ${index + 1}.` });
  };

  const load = (index: SlotIndex) => {
    const slot = slots[index];
    if (!slot) return;
    const result = session.actions.restore(slot.data);
    dispatch({
      type: "message",
      text: result === 0 ? `Loaded slot ${index + 1}.` : `Slot ${index + 1} would not load (${result}).`,
    });
  };

  return (
    <SaveMenu
      mode={overlay.mode}
      slots={slots}
      floors={floors}
      message={overlay.message}
      onSave={save}
      onLoad={load}
      onClose={close}
    />
  );
}
