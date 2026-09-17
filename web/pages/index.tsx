import { useEffect, useState } from "react";

import type { Props } from "./index.server";
import "./styles.css";

const DEFAULT_FLOOR = 2;
const FLOOR_LABELS = ["FLOOR 3", "FLOOR 2", "FLOOR 1"];

export default function HomePage(_props: Props) {
  const [floor, setFloor] = useState(DEFAULT_FLOOR);

  useEffect(() => {
    const onFloorChange = (event: Event) => {
      const detail = (event as CustomEvent<number>).detail;
      if (typeof detail === "number") {
        setFloor(detail);
      }
    };
    window.addEventListener("ink-ribbon:floor", onFloorChange);
    return () => window.removeEventListener("ink-ribbon:floor", onFloorChange);
  }, []);

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
                "window.inkRibbonSetFloor = function (floor) { window.dispatchEvent(new CustomEvent('ink-ribbon:floor', { detail: floor })); };" +
                "window.inkRibbonPersistScene = function () {" +
                "  try {" +
                "    var data = Module.FS.readFile('/scene.bin', { encoding: 'binary' });" +
                "    var bin = ''; for (var i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);" +
                "    localStorage.setItem('ink-ribbon-scene', btoa(bin));" +
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
                "};",
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
          <div className="panel-rule" />
          <h2>LEGEND</h2>
          <p>
            <i className="legend-player" /> Current location
          </p>
          <p>
            <i className="legend-route" /> Route / connection
          </p>
          <p>
            <i className="legend-floor" /> Floor selector
          </p>
        </aside>
      </div>
      <footer className="app-footer">
        <span>running · map navigation</span>
        <button>lineage colors</button>
        <button>save</button>
        <button>load</button>
        <button>CSV</button>
      </footer>
    </main>
  );
}
