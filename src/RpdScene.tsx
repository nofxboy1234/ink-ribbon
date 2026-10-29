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

type Mark = {
  x: number;
  y: number;
  eye: [number, number, number];
  yaw: number;
  pitch: number;
  group: number;
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
  const marksRef = useRef<Mark[]>([]);
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

    const redraw = () => {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      const ctx = overlay.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const groups = new Map<number, Mark[]>();
      for (const mark of marksRef.current) {
        const list = groups.get(mark.group) ?? [];
        list.push(mark);
        groups.set(mark.group, list);
      }
      ctx.lineCap = "round";
      for (const [group, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        const colour = MARK_COLOURS[group % MARK_COLOURS.length];
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.beginPath();
        list.forEach((mark, index) => {
          if (index === 0) ctx.moveTo(mark.x, mark.y);
          else ctx.lineTo(mark.x, mark.y);
        });
        ctx.stroke();
        list.forEach((mark, index) => {
          const arm = 9;
          ctx.beginPath();
          ctx.moveTo(mark.x - arm, mark.y - arm);
          ctx.lineTo(mark.x + arm, mark.y + arm);
          ctx.moveTo(mark.x + arm, mark.y - arm);
          ctx.lineTo(mark.x - arm, mark.y + arm);
          ctx.strokeStyle = "rgba(14,15,17,0.85)";
          ctx.lineWidth = 6;
          ctx.stroke();
          ctx.strokeStyle = colour;
          ctx.lineWidth = 2.5;
          ctx.stroke();
          const label = String(index + 1);
          ctx.font = "600 14px ui-monospace, monospace";
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(14,15,17,0.9)";
          ctx.strokeText(label, mark.x + 12, mark.y - 8);
          ctx.fillStyle = colour;
          ctx.fillText(label, mark.x + 12, mark.y - 8);
        });
      }
    };

    const readCamera = () => {
      const module = moduleRef.current;
      if (!module) return null;
      const ptr = module._malloc(6 * 4);
      module._rpd_get_camera(ptr);
      const view = new Float32Array(module.HEAPU8.buffer, ptr, 6);
      const values: [number, number, number, number, number] = [
        view[0],
        view[1],
        view[2],
        view[3],
        view[4],
      ];
      module._free(ptr);
      return values;
    };

    const addMark = (event: MouseEvent) => {
      if (!modeRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
      const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
      const camera = readCamera();
      if (!camera) return;
      const [ex, ey, ez, yaw, pitch] = camera;
      const previous = marksRef.current[marksRef.current.length - 1];
      let group = previous ? previous.group : 0;
      if (previous) {
        const moved =
          Math.hypot(ex - previous.eye[0], ey - previous.eye[1], ez - previous.eye[2]) >
            0.05 ||
          Math.abs(yaw - previous.yaw) > 0.02 ||
          Math.abs(pitch - previous.pitch) > 0.02;
        if (moved) group = previous.group + 1;
      }
      marksRef.current = [
        ...marksRef.current,
        { x, y, eye: [ex, ey, ez], yaw, pitch, group },
      ];
      setMarkCount(marksRef.current.length);
      redraw();
    };

    const exportMarks = () => {
      const groups = new Map<number, Mark[]>();
      for (const mark of marksRef.current) {
        const list = groups.get(mark.group) ?? [];
        list.push(mark);
        groups.set(mark.group, list);
      }
      const views = [...groups.values()].map((list) => ({
        eye: list[0].eye,
        yaw: list[0].yaw,
        pitch: list[0].pitch,
        points: list.map((mark) => [
          Math.round(mark.x * 10) / 10,
          Math.round(mark.y * 10) / 10,
        ]),
      }));
      const payload = {
        canvas: [canvas.width, canvas.height],
        views,
      };
      const text = JSON.stringify(payload);
      setExportText(text);
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      console.log(text);
    };

    const onPointer = (event: Event) => {
      if (!modeRef.current) return;
      const mouse = event as MouseEvent;
      // Only the left button picks. Right and middle stay with the viewer so
      // the camera can be moved between views.
      if (mouse.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "pointerdown") addMark(mouse);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "m" || event.key === "M") {
        modeRef.current = !modeRef.current;
        setMarkMode(modeRef.current);
        if (!modeRef.current) {
          marksRef.current = [];
          setMarkCount(0);
          redraw();
        }
        event.preventDefault();
        return;
      }
      if (!modeRef.current) return;
      if (event.key === "Backspace") {
        marksRef.current = marksRef.current.slice(0, -1);
        setMarkCount(marksRef.current.length);
        redraw();
        event.preventDefault();
      } else if (event.key === "c" || event.key === "C") {
        exportMarks();
        event.preventDefault();
      } else if (event.key === "Escape") {
        modeRef.current = false;
        setMarkMode(false);
        marksRef.current = [];
        setMarkCount(0);
        redraw();
        event.preventDefault();
      }
    };

    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", redraw);
    redraw();
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("mousedown", onPointer, true);
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
            ? `mark mode · ${markCount} points · click 4 corners · right-drag to move · click the next 4 · C copy · Backspace undo · Esc exit`
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
