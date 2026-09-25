import { useSyncExternalStore } from "react";

import type { Props } from "./index.server";
import "./styles.css";

const DEFAULT_FLOOR = 2;
const FLOOR_LABELS = ["FLOOR 3", "FLOOR 2", "FLOOR 1"];

type Goal = { label: string; floor: number };
type RunState = {
  steps: number;
  turn: number;
  floor: number;
  goal: number;
  routeVisible: boolean;
  goals: Goal[];
};
type InkRibbonCommand = {
  newRun: boolean;
  goal: number;
  routeVisible: boolean | null;
};
type InkRibbonWindow = Window & {
  inkRibbonCommand?: InkRibbonCommand;
  inkRibbonDownloadScene?: () => number;
  __inkRibbonState?: RunState;
  __inkRibbonFloor?: number;
};

const EMPTY_RUN: RunState = {
  steps: 0,
  turn: 0,
  floor: DEFAULT_FLOOR,
  goal: -1,
  routeVisible: true,
  goals: [],
};

// The wasm pushes floor and run-state through window globals; expose them as
// external stores so React picks up whatever arrived before it mounted, with no
// set-state-in-effect.
function subscribeFloor(onChange: () => void) {
  window.addEventListener("ink-ribbon:floor", onChange);
  return () => window.removeEventListener("ink-ribbon:floor", onChange);
}
function floorSnapshot() {
  return (window as InkRibbonWindow).__inkRibbonFloor ?? DEFAULT_FLOOR;
}
function subscribeRun(onChange: () => void) {
  window.addEventListener("ink-ribbon:state", onChange);
  return () => window.removeEventListener("ink-ribbon:state", onChange);
}
function runSnapshot() {
  return (window as InkRibbonWindow).__inkRibbonState ?? EMPTY_RUN;
}

export default function HomePage(_props: Props) {
  const floor = useSyncExternalStore(subscribeFloor, floorSnapshot, () => DEFAULT_FLOOR);
  const run = useSyncExternalStore(subscribeRun, runSnapshot, () => EMPTY_RUN);

  const command = () => (window as InkRibbonWindow).inkRibbonCommand;

  const newRun = () => {
    const cmd = command();
    if (cmd) {
      cmd.newRun = true;
    }
  };

  const downloadScene = () => {
    (window as InkRibbonWindow).inkRibbonDownloadScene?.();
  };

  const selectGoal = (index: number) => {
    const cmd = command();
    if (cmd) {
      cmd.goal = run.goal === index ? -1 : index;
    }
  };

  const toggleRoute = () => {
    const cmd = command();
    if (cmd) {
      cmd.routeVisible = !run.routeVisible;
    }
  };

  return (
    <main className="map-app">
      <header className="map-shell-header">
        <span className="brand">ink-ribbon</span>
        <span>living instrument / v6</span>
        <strong>124</strong>
        <span>POPULATION</span>
        <strong>39</strong>
        <span>GENERATION</span>
        <strong>74:58</strong>
        <span>TIME</span>
        <strong>81</strong>
        <span>LINEAGES</span>
        <span className="terrarium">terrarium</span>
      </header>
      <div className="map-layout">
        <section className="map-stage">
          <canvas suppressHydrationWarning id="map-canvas" className="map-canvas" />
          <script
            dangerouslySetInnerHTML={{
              __html:
                "var Module = { canvas: document.getElementById('map-canvas'), locateFile: function (path) { return '/' + path; } };" +
                "window.inkRibbonSetFloor = function (floor) { window.__inkRibbonFloor = floor; window.dispatchEvent(new CustomEvent('ink-ribbon:floor', { detail: floor })); };" +
                "window.inkRibbonPersistScene = function () {" +
                "  try {" +
                "    var data = Module.FS.readFile('/scene.bin', { encoding: 'binary' });" +
                "    var bin = ''; for (var i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);" +
                "    localStorage.setItem('ink-ribbon-scene', btoa(bin));" +
                "    return 1;" +
                "  } catch (e) { console.error(e); return 0; }" +
                "};" +
                "window.inkRibbonDownloadScene = function () {" +
                "  try {" +
                "    var data = Module.FS.readFile('/scene.bin', { encoding: 'binary' });" +
                "    var blob = new Blob([data], { type: 'application/octet-stream' });" +
                "    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'scene.bin'; a.click();" +
                "    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);" +
                "    return 1;" +
                "  } catch (e) { console.error(e); return 0; }" +
                "};" +
                "window.inkRibbonLoadScene = function () {" +
                "  try {" +
                "    var b64 = localStorage.getItem('ink-ribbon-scene');" +
                "    if (!b64) return 0;" +
                "    var bin = atob(b64); var arr = new Uint8Array(bin.length);" +
                "    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);" +
                "    Module.FS.writeFile('/scene.bin', arr);" +
                "    return 1;" +
                "  } catch (e) { console.error(e); return 0; }" +
                "};" +
                "window.inkRibbonPersistSlot = function (n) {" +
                "  try {" +
                "    var data = Module.FS.readFile('/save-' + n + '.bin', { encoding: 'binary' });" +
                "    var bin = ''; for (var i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);" +
                "    localStorage.setItem('ink-ribbon-save-' + n, btoa(bin));" +
                "    return 1;" +
                "  } catch (e) { console.error(e); return 0; }" +
                "};" +
                "window.inkRibbonLoadSlot = function (n) {" +
                "  try {" +
                "    var b64 = localStorage.getItem('ink-ribbon-save-' + n);" +
                "    if (!b64) return 0;" +
                "    var bin = atob(b64); var arr = new Uint8Array(bin.length);" +
                "    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);" +
                "    Module.FS.writeFile('/save-' + n + '.bin', arr);" +
                "    return 1;" +
                "  } catch (e) { console.error(e); return 0; }" +
                "};" +
                "window.inkRibbonHasSlot = function (n) {" +
                "  try { return localStorage.getItem('ink-ribbon-save-' + n) ? 1 : 0; } catch (e) { return 0; }" +
                "};" +
                "window.inkRibbonOnState = function (state) {" +
                "  window.__inkRibbonState = state;" +
                "  window.dispatchEvent(new CustomEvent('ink-ribbon:state', { detail: state }));" +
                "};" +
                "window.inkRibbonCommand = { newRun: false, goal: -999, routeVisible: null };",
            }}
          />
          <script src="/map.js" />
        </section>
        <aside className="details-panel">
          <h2>MAP STATUS</h2>
          <div className="panel-row">
            <span>LOCATION</span>
            <b>CARE CENTER</b>
          </div>
          <div className="panel-row">
            <span>FLOOR</span>
            <b>{FLOOR_LABELS[floor] ?? FLOOR_LABELS[DEFAULT_FLOOR]}</b>
          </div>
          <div className="panel-row">
            <span>STEPS</span>
            <b>{run.steps}</b>
          </div>
          <div className="panel-row">
            <span>TURN</span>
            <b>{run.turn}</b>
          </div>
          <button type="button" className="panel-action" onClick={newRun}>
            NEW RUN
          </button>
          <div className="panel-rule" />
          <h2>GOALS</h2>
          {run.goals.length === 0 ? (
            <p className="panel-empty">Nothing left on this floor.</p>
          ) : (
            <ul className="goal-list">
              {run.goals.map((goal, index) => (
                <li key={`${goal.label}-${index}`}>
                  <button
                    type="button"
                    className={index === run.goal ? "goal-item selected" : "goal-item"}
                    onClick={() => selectGoal(index)}
                  >
                    <span className="goal-label">{goal.label}</span>
                    <span className="goal-floor">{FLOOR_LABELS[goal.floor] ?? ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="panel-action" onClick={toggleRoute}>
            {run.routeVisible ? "HIDE ROUTE" : "SHOW ROUTE"}
          </button>
          <div className="panel-rule" />
          <h2>LEGEND</h2>
          <p>
            <i className="legend-player" /> Current location
          </p>
          <p>
            <i className="legend-route" /> Route / connection
          </p>
          <p>
            <i className="legend-move" /> Reachable this turn
          </p>
          <p>
            <i className="legend-floor" /> Floor selector
          </p>
        </aside>
      </div>
      <footer className="app-footer">
        <span>running · map navigation</span>
        <button>lineage colors</button>
        <button type="button" onClick={downloadScene}>
          scene.bin
        </button>
        <button>load</button>
        <button>CSV</button>
      </footer>
    </main>
  );
}
