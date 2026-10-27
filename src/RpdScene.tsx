import { useEffect, useRef, useState, type CSSProperties } from "react";

type RpdModule = {
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _rpd_load_scene: (ptr: number, size: number) => number;
};

type RpdFactory = (options: {
  canvas: HTMLCanvasElement;
  locateFile: (path: string) => string;
}) => Promise<RpdModule>;

const ASSET_URL = "/rpd/rpd.bin";

async function fetchScene(
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(ASSET_URL, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`could not fetch ${ASSET_URL} (${response.status})`);
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

export default function RpdScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [progress, setProgress] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = new AbortController();
    let cancelled = false;

    const boot = async () => {
      try {
        const [asset, factory] = await Promise.all([
          fetchScene(controller.signal, (fraction) => {
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

        const ptr = module._malloc(asset.byteLength);
        module.HEAPU8.set(asset, ptr);
        const result = module._rpd_load_scene(ptr, asset.byteLength);
        module._free(ptr);
        if (result !== 0) throw new Error("the RPD scene could not be loaded");

        await nextFrame();
        await nextFrame();
        if (!cancelled) setHidden(true);
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
  }, []);

  const statusText = error ? `Scene error — ${error}` : `Loading RPD floors 1–3`;

  return (
    <main className="rpd-root">
      <canvas
        ref={canvasRef}
        id="canvas"
        className="rpd-canvas"
        onContextMenu={(event) => event.preventDefault()}
        aria-label="RPD floors one to three as a 3D wireframe"
      />
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
