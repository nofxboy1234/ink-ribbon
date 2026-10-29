import { useEffect, useRef, useState, type CSSProperties } from "react";

type RpdModule = {
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _rpd_load_scene: (ptr: number, size: number) => number;
  _rpd_get_camera: (ptr: number) => number;
  _rpd_set_camera: (
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
  ) => number;
};

type RpdFactory = (options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}) => Promise<RpdModule>;

const CACHE_VERSION = "20261029m";

async function fetchScene(
  url: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok || !response.body) {
    throw new Error(`could not fetch ${url} (${response.status})`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(total > 0 ? received / total : 0);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

type RpdSceneProps = {
  assetUrl?: string;
  label?: string;
};

const MARK_COLOURS = [
  "#ffb86c",
  "#8be9fd",
  "#50fa7b",
  "#ff79c6",
  "#bd93f9",
  "#f1fa8c",
];

export default function RpdScene({
  assetUrl = "/rpd/rpd.bin",
  label = "RPD floors one to three as a 3D model",
}: RpdSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const moduleRef = useRef<RpdModule | null>(null);
  const modeRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [markMode, setMarkMode] = useState(false);
  const [markCount, setMarkCount] = useState(0);
  const [exportText, setExportText] = useState("");

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frames += 1;
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;

    type Point = { x: number; y: number };
    type Camera = { eye: [number, number, number]; yaw: number; pitch: number };

    const views: { camera: Camera; points: Point[] }[] = [];
    let draft: Point[] = [];
    let draftCamera: Camera | null = null;
    let dirty = false;
    let drag: { startX: number; startY: number; origins: Point[]; index: number } | null = null;

    const readCamera = (): Camera | null => {
      const module = moduleRef.current;
      if (!module) return null;
      const ptr = module._malloc(6 * 4);
      module._rpd_get_camera(ptr);
      const view = new Float32Array(module.HEAPU8.buffer, ptr, 6);
      const camera: Camera = {
        eye: [view[0], view[1], view[2]],
        yaw: view[3],
        pitch: view[4],
      };
      module._free(ptr);
      return camera;
    };

    const toBuffer = (event: MouseEvent): Point => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * canvas.height,
      };
    };

    const moved = (a: Camera, b: Camera) =>
      Math.hypot(a.eye[0] - b.eye[0], a.eye[1] - b.eye[1], a.eye[2] - b.eye[2]) >
        0.05 ||
      Math.abs(a.yaw - b.yaw) > 0.02 ||
      Math.abs(a.pitch - b.pitch) > 0.02;

    const inside = (p: Point) => {
      let hit = false;
      for (let i = 0, j = draft.length - 1; i < draft.length; j = i++) {
        const a = draft[i];
        const b = draft[j];
        if (
          a.y > p.y !== b.y > p.y &&
          p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
        ) {
          hit = !hit;
        }
      }
      return hit;
    };

    const nearest = (p: Point) => {
      let best = -1;
      let bestDistance = 16;
      draft.forEach((q, index) => {
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d <= bestDistance) {
          best = index;
          bestDistance = d;
        }
      });
      return best;
    };

    const redraw = () => {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      const ctx = overlay.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      ctx.lineCap = "round";

      const draw = (points: Point[], colour: string, alpha: number, numbered: boolean) => {
        if (points.length === 0) return;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.beginPath();
        points.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
        points.forEach((point, index) => {
          const arm = 9;
          ctx.beginPath();
          ctx.moveTo(point.x - arm, point.y - arm);
          ctx.lineTo(point.x + arm, point.y + arm);
          ctx.moveTo(point.x + arm, point.y - arm);
          ctx.lineTo(point.x - arm, point.y + arm);
          ctx.strokeStyle = "rgba(14,15,17,0.85)";
          ctx.lineWidth = 6;
          ctx.stroke();
          ctx.strokeStyle = colour;
          ctx.lineWidth = 2.5;
          ctx.stroke();
          if (!numbered) return;
          const label = String(index + 1);
          ctx.font = "600 14px ui-monospace, monospace";
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(14,15,17,0.9)";
          ctx.strokeText(label, point.x + 12, point.y - 8);
          ctx.fillStyle = colour;
          ctx.fillText(label, point.x + 12, point.y - 8);
        });
        ctx.globalAlpha = 1;
      };

      views.forEach((view) => draw(view.points, "#6b7280", 0.55, false));
      draw(draft, MARK_COLOURS[views.length % MARK_COLOURS.length], 1, true);
    };

    const commitIfDirty = () => {
      if (!dirty || draft.length < 3 || !draftCamera) return;
      views.push({ camera: draftCamera, points: draft.map((p) => ({ ...p })) });
      dirty = false;
    };

    const watchCamera = () => {
      if (!modeRef.current) return;
      const camera = readCamera();
      if (!camera) return;
      if (!draftCamera) {
        draftCamera = camera;
        return;
      }
      if (dirty && draft.length >= 3 && moved(camera, draftCamera)) {
        commitIfDirty();
        draftCamera = camera;
        setMarkCount(draft.length);
        redraw();
      }
    };

    const onDown = (event: MouseEvent) => {
      if (!modeRef.current) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const point = toBuffer(event);
      const index = nearest(point);
      const grabbable = index >= 0 || (draft.length >= 3 && inside(point));
      if (!grabbable) {
        if (views.length > 0) return;
        draft = [...draft, point];
        dirty = true;
        draftCamera = readCamera();
        setMarkCount(draft.length);
        redraw();
        return;
      }
      drag = {
        startX: point.x,
        startY: point.y,
        origins: draft.map((p) => ({ ...p })),
        index,
      };
    };

    const onMove = (event: MouseEvent) => {
      if (!drag) return;
      event.preventDefault();
      event.stopPropagation();
      const point = toBuffer(event);
      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      if (drag.index >= 0) {
        draft[drag.index] = { x: drag.origins[drag.index].x + dx, y: drag.origins[drag.index].y + dy };
      } else {
        draft = drag.origins.map((origin) => ({ x: origin.x + dx, y: origin.y + dy }));
      }
      redraw();
    };

    const onUp = (event: MouseEvent) => {
      if (!drag) return;
      event.preventDefault();
      event.stopPropagation();
      drag = null;
      dirty = true;
      draftCamera = readCamera();
      redraw();
    };

    const exportMarks = () => {
      if (draft.length >= 3 && draftCamera && (dirty || views.length === 0)) {
        views.push({ camera: draftCamera, points: draft.map((p) => ({ ...p })) });
        dirty = false;
      }
      const payload = {
        canvas: [canvas.width, canvas.height],
        views: views.map((view) => ({
          eye: view.camera.eye,
          yaw: view.camera.yaw,
          pitch: view.camera.pitch,
          points: view.points.map((p) => [
            Math.round(p.x * 10) / 10,
            Math.round(p.y * 10) / 10,
          ]),
        })),
      };
      const text = JSON.stringify(payload);
      setExportText(text);
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      console.log(text);
    };

    const clear = () => {
      views.length = 0;
      draft = [];
      draftCamera = null;
      dirty = false;
      drag = null;
      setMarkCount(0);
      redraw();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "m" || event.key === "M") {
        modeRef.current = !modeRef.current;
        setMarkMode(modeRef.current);
        if (!modeRef.current) clear();
        event.preventDefault();
        return;
      }
      if (!modeRef.current) return;
      if (event.key === "Backspace") {
        if (views.length === 0) {
          draft = draft.slice(0, -1);
          setMarkCount(draft.length);
          redraw();
        }
        event.preventDefault();
      } else if (event.key === "c" || event.key === "C") {
        exportMarks();
        event.preventDefault();
      } else if (event.key === "Escape") {
        modeRef.current = false;
        setMarkMode(false);
        clear();
        event.preventDefault();
      }
    };

    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", redraw);
    const timer = window.setInterval(watchCamera, 200);
    redraw();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", redraw);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = new AbortController();
    let cancelled = false;

    const boot = async () => {
      try {
        const probe = document.createElement("canvas");
        if (!probe.getContext("webgl2")) {
          throw new Error("this browser does not provide WebGL2");
        }
        const [asset, factory] = await Promise.all([
          fetchScene(`${assetUrl}?v=${CACHE_VERSION}`, controller.signal, (fraction) => {
            if (!cancelled) setProgress(fraction);
          }),
          import("./wasm/rpd.js").then(
            (imported) => (imported.default ?? imported) as unknown as RpdFactory,
          ),
        ]);
        if (cancelled) return;

        const module = await factory({
          canvas,
          locateFile: (path: string) => `/rpd/${path}`,
        });
        if (cancelled) return;

        moduleRef.current = module;
        if (import.meta.env.DEV) {
          (window as unknown as { __rpd?: RpdModule }).__rpd = module;
        }

        const cameraPtr = module._malloc(6 * 4);
        const readCamera = () => {
          module._rpd_get_camera(cameraPtr);
          const view = new Float32Array(
            module.HEAPU8.buffer,
            cameraPtr,
            6,
          );
          return [
            view[0], view[1], view[2], view[3], view[4],
          ] as const;
        };
        const ptr = module._malloc(asset.byteLength);
        module.HEAPU8.set(asset, ptr);
        const result = module._rpd_load_scene(ptr, asset.byteLength);
        module._free(ptr);
        if (result !== 0) throw new Error("the RPD scene could not be loaded");

        await nextFrame();
        await nextFrame();
        const requested = new URLSearchParams(location.hash.slice(1)).get("cam");
        if (requested) {
          const parts = requested.split(",").map(Number);
          if (parts.length === 5 && parts.every((v) => Number.isFinite(v))) {
            module._rpd_set_camera(
              parts[0], parts[1], parts[2], parts[3], parts[4],
            );
            await nextFrame();
            await nextFrame();
          }
        }
        if (!cancelled) setHidden(true);

        // Mirror the live view into the URL so a pose can be reopened or sent.
        let last = "";
        const syncCamera = () => {
          if (cancelled) return;
          const values = readCamera();
          const text = values
            .map((v) => (Math.round(v * 100) / 100).toString())
            .join(",");
          if (text !== last) {
            last = text;
            const url = `${location.pathname}${location.search}#cam=${text}`;
            history.replaceState(null, "", url);
          }
          window.setTimeout(syncCamera, 250);
        };
        syncCamera();
        void cameraPtr;
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        console.error(cause);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void boot();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [assetUrl]);

  const statusText = error ? `Scene error — ${error}` : `Loading RPD floors 1–3`;

  return (
    <main className="rpd-root">
      <canvas
        ref={canvasRef}
        id="canvas"
        className="rpd-canvas"
        data-mark={markMode}
        onContextMenu={(event) => event.preventDefault()}
        aria-label={label}
      />
      <canvas ref={overlayRef} className="rpd-mark" aria-hidden="true" />
      <div className="rpd-mark-hud" data-open={markMode}>
        <span className="rpd-mark-key">M</span>
        <span>
          {markMode
            ? `mark mode · ${markCount} points · click 4 corners · right-drag to move · drag a cross or the group to fit · C copy · Backspace undo · Esc exit`
            : "mark mode"}
        </span>
      </div>
      {exportText ? (
        <textarea
          className="rpd-mark-out"
          readOnly
          value={exportText}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="mark export"
        />
      ) : null}
      <div className="rpd-fps">{fps > 0 ? `${fps} FPS` : "-- FPS"}</div>
      <div
        className="rpd-status"
        data-hidden={hidden}
        data-error={error !== null}
        style={{ "--progress": `${Math.round(progress * 100)}%` } as CSSProperties}
        aria-live="polite"
      >
        <div className="rpd-status-inner">
          <span>{error ? statusText : `${statusText} · ${Math.round(progress * 100)}%`}</span>
          <span className="rpd-status-mark" />
        </div>
      </div>
    </main>
  );
}
