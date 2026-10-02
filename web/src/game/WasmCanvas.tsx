import { memo } from "react";

const BOOTSTRAP = `
var Module = {
  canvas: document.getElementById("game-canvas"),
  locateFile: function (path) { return "/" + path; },
};
window.inkRibbonOnState = function (state) {
  window.__inkRibbonState = state;
  window.dispatchEvent(new CustomEvent("ink-ribbon:state", { detail: state }));
};
window.inkRibbonCommands = [];
window.inkRibbonTakeCommand = function () {
  return window.inkRibbonCommands.length ? window.inkRibbonCommands.shift() : -1;
};
`;

export const WasmCanvas = memo(function WasmCanvas() {
  return (
    <div className="map-stage">
      <canvas
        suppressHydrationWarning
        id="game-canvas"
        className="game-canvas"
        tabIndex={0}
        onMouseDown={(event) => event.currentTarget.focus()}
        onContextMenu={(event) => event.preventDefault()}
      />
      <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP }} />
      <script src="/game.js" />
    </div>
  );
});
