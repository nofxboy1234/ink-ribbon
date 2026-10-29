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

const CACHE_VERSION = "20261029n";

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

export default function RpdScene({
  assetUrl = "/rpd/rpd.bin",
  label = "RPD floors one to three as a 3D model",
}: RpdSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [progress, setProgress] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);

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

        if (import.meta.env.DEV) {
          (window as unknown as { __rpd?: RpdModule }).__rpd = module;
        }

        const cameraPtr = module._malloc(6 * 4);
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
          module._rpd_get_camera(cameraPtr);
          const view = new Float32Array(module.HEAPU8.buffer, cameraPtr, 6);
          const text = [view[0], view[1], view[2], view[3], view[4]]
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
        onContextMenu={(event) => event.preventDefault()}
        aria-label={label}
      />
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
