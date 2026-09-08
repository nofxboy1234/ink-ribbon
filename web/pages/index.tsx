import { useEffect, useRef, useState } from "react";
import type { Props } from "./index.server";
import "./styles.css";

type Floor = { name: string; src: string };
const FLOORS: Floor[] = [
  { name: "Floor 3", src: "/maps/floor-3.png" },
  { name: "Floor 2", src: "/maps/floor-2.png" },
  { name: "Floor 1", src: "/maps/floor-1.png" },
  { name: "Basement", src: "/maps/basement.png" },
];

export default function HomePage(_props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [floor, setFloor] = useState(2);
  const [zoom, setZoom] = useState(1);
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5, visible: false });
  const state = useRef({ x: 0, y: 0, dragging: false, lastX: 0, lastY: 0, pulse: 0 });

  useEffect(() => {
    const canvas = canvasRef.current; const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const images = FLOORS.map((f) => { const image = new Image(); image.src = f.src; return image; });
    let raf = 0;
    const resize = () => { const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    const draw = (time: number) => {
      const s = state.current; const w = canvas.clientWidth; const h = canvas.clientHeight; const image = images[floor];
      s.pulse = (time / 1000) % 2.8; ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#02090d"; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(171,155,103,.16)"; ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 18) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 18) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      const frame = { x: 64, y: 45, w: w - 128, h: h - 92 }; ctx.strokeStyle = "rgba(179,153,89,.8)"; ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
      if (image.complete && image.naturalWidth) { const scale = Math.min(frame.w / image.naturalWidth, frame.h / image.naturalHeight) * zoom; const iw = image.naturalWidth * scale; const ih = image.naturalHeight * scale; const ix = frame.x + (frame.w - iw) / 2 + s.x; const iy = frame.y + (frame.h - ih) / 2 + s.y; ctx.drawImage(image, ix, iy, iw, ih); }
      const px = frame.x + frame.w * .51 + s.x; const py = frame.y + frame.h * .56 + s.y; const pulse = 9 + (s.pulse / 2.8) * 21; ctx.strokeStyle = `rgba(236,190,49,${.45 - s.pulse / 2.8 * .35})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, pulse, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = "#e9bd32"; ctx.beginPath(); ctx.moveTo(px, py - 13); ctx.lineTo(px - 8, py + 9); ctx.lineTo(px, py + 5); ctx.lineTo(px + 8, py + 9); ctx.closePath(); ctx.fill();
      if (cursor.visible) { const cx = cursor.x * w; const cy = cursor.y * h; ctx.strokeStyle = "rgba(225,199,112,.9)"; ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fillStyle = "#e9bd32"; ctx.fill(); }
      raf = requestAnimationFrame(draw);
    };
    resize(); window.addEventListener("resize", resize); raf = requestAnimationFrame(draw); return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, [floor, zoom, cursor.visible, cursor.x, cursor.y]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(key)) {
        event.preventDefault(); const amount = event.shiftKey ? 24 : 12;
        if (key === "arrowup" || key === "w") state.current.y += amount;
        if (key === "arrowdown" || key === "s") state.current.y -= amount;
        if (key === "arrowleft" || key === "a") state.current.x += amount;
        if (key === "arrowright" || key === "d") state.current.x -= amount;
      }
      if (key === "q") setFloor((value) => Math.max(0, value - 1));
      if (key === "e") setFloor((value) => Math.min(3, value + 1));
      if (key === "home" || key === "c") recenter();
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);
  const changeFloor = (next: number) => setFloor(Math.max(0, Math.min(3, next)));
  const recenter = () => { state.current.x = 0; state.current.y = 0; setZoom(1); };
  return <main className="map-app"><header className="map-shell-header"><span className="brand">evo</span><span>living instrument / v6</span><strong>124</strong><span>POPULATION</span><strong>39</strong><span>GENERATION</span><strong>74:58</strong><span>TIME</span><strong>81</strong><span>LINEAGES</span><span className="terrarium">terrarium</span></header><section className="map-stage"><div className="map-hint">Care Center · interactive map</div><canvas ref={canvasRef} className="map-canvas" onMouseEnter={() => setCursor((c) => ({ ...c, visible: true }))} onMouseLeave={() => setCursor((c) => ({ ...c, visible: false }))} onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCursor({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, visible: true }); const s = state.current; if (s.dragging) { s.x += e.clientX - s.lastX; s.y += e.clientY - s.lastY; s.lastX = e.clientX; s.lastY = e.clientY; } }} onWheel={(e) => { e.preventDefault(); setZoom((z) => Math.max(.7, Math.min(2.6, z - e.deltaY * .001))); }} onMouseDown={(e) => { state.current.dragging = true; state.current.lastX = e.clientX; state.current.lastY = e.clientY; }} onMouseUp={() => { state.current.dragging = false; }} /><div className="floor-rail">{FLOORS.map((f, i) => <button className={i === floor ? "active" : ""} key={f.name} onClick={() => changeFloor(i)}><i />{f.name}</button>)}</div><div className="zoom-rail"><span>+</span><div className="zoom-track"><i style={{ bottom: `${((zoom - .7) / 1.9) * 100}%` }} /></div><span>−</span></div><div className="map-status"><span>BATTERY</span><b>•••</b><span>MEMORY</span><b>••</b><span>DISC</span><b>◉</b></div><div className="area-map">AREA MAP</div><div className="map-controls"><button onClick={recenter}>◉ Current Location</button><span>WASD / arrows Move</span><span>Wheel Zoom In/Out</span><span>Q / E Change Floor</span><span>Drag Pan</span></div></section></main>;
}
