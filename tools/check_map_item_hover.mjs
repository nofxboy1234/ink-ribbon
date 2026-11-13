// Hovering a map item dot shows the item name.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_ITEM_PORT ?? 5174);
const chromePort = Number(process.env.RPD_MAP_ITEM_CHROME ?? 9252);
const outDir = join(root, "verification", "re2map");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(outDir, { recursive: true });

const waitForHttp = async (url, timeoutMs = 30000) => {
  const start = Date.now();
  for (;;) {
    try { const res = await fetch(url); if (res.ok) return; } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`timeout ${url}`);
    await sleep(150);
  }
};

const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
  cwd: root, stdio: "ignore", env: { ...process.env, NODE_ENV: "development" },
});
let chrome;
let userDataDir;
try {
  await waitForHttp(`http://localhost:${port}/`);
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-item-"));
  chrome = spawn("google-chrome", [
    "--headless=new", `--remote-debugging-port=${chromePort}`, `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--ozone-platform=headless", "--window-size=1400,900", "about:blank",
  ], { stdio: "ignore" });
  await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 20000);
  const pages = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
  const socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); }
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const send = (method, params = {}) => new Promise((resolve) => {
    const next = ++id; pending.set(next, resolve); socket.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return res?.exceptionDetails ? undefined : res?.result?.value;
  };
  const shot = async (name) => {
    const result = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${port}/` });
  for (let i = 0; i < 300; i += 1) {
    await sleep(300);
    if (await evaluate("(() => { try { return (window.__quest?.items?.().length ?? 0) > 200; } catch { return false; } })()")) break;
  }
  await sleep(700);
  const rect = await evaluate("(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()");
  // Reveal 1F first with the 1F map.
  await evaluate("window.__quest.setFloor(0)");
  const mapItem = await evaluate("window.__rpd.itemIndexForId(544458)");
  const mapEntry = await evaluate(`window.__quest.items()[${mapItem}]`);
  await evaluate(`window.__quest.setPlayer(${mapEntry.x}, ${mapEntry.y}, ${mapEntry.z})`);
  await sleep(900);
  const carried = await evaluate("window.__quest.mapRevealed(0)");
  const items = await evaluate(`window.__quest.items().map((entry, index) => ({ index, name: entry.name, floor: entry.floor, state: entry.state, action: entry.action, cubeX: entry.cubeX, cubeY: entry.cubeY, cubeZ: entry.cubeZ }))`);
  const candidates = items.filter((entry) => entry.floor === 0 && entry.state === 1 && (entry.action === 1 || entry.action === 5) && entry.cubeX > -60 && entry.cubeX < 60);
  let hovered = null;
  for (const entry of candidates) {
    const point = await evaluate(`window.__quest.project(${entry.cubeX}, ${entry.cubeY}, ${entry.cubeZ})`);
    if (!point || point.x < 40 || point.y < 180 || point.x > rect.width - 400 || point.y > rect.height - 80) continue;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.left + point.x, y: rect.top + point.y });
    await sleep(250);
    const hoverIndex = await evaluate("window.__quest.hoverItem()");
    if (hoverIndex === entry.index) { hovered = { ...entry, hoverIndex, point }; break; }
  }
  await shot("item-hover");
  console.log(JSON.stringify({ carried, candidateCount: candidates.length, hovered }, null, 2));
  const ok = carried === true && hovered !== null && hovered.hoverIndex === hovered.index;
  if (!ok) console.log("FAIL: hovering a revealed map item did not resolve the item name");
  if (ok) console.log(`PASS: hovering ${hovered.name} resolves the map item hover`);
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
