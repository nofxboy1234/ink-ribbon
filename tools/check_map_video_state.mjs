// Match the video's opening 1F state: Main Hall currently searching (red),
// Entrance/Reception search completed (blue). Drives the same item flow.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_VIDEO_PORT ?? 5172);
const chromePort = Number(process.env.RPD_MAP_VIDEO_CHROME ?? 9254);
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

const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0; i < poly.length; i += 1) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    if ((y0 > y) !== (y1 > y) && x < ((x1 - x0) * (y - y0)) / (y1 - y0) + x0) inside = !inside;
  }
  return inside;
};

const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
  cwd: root, stdio: "ignore", env: { ...process.env, NODE_ENV: "development" },
});
let chrome;
let userDataDir;
try {
  await waitForHttp(`http://localhost:${port}/`);
  const map = await (await fetch(`http://localhost:${port}/re2map/map.json`)).json();
  const floor = map.floors.find((entry) => entry.index === 0);
  const cal = floor.calibration;
  const receptionX = -20, receptionZ = 16;
  const rpx = cal.ox + receptionX * cal.s;
  const rpz = cal.oy + receptionZ * cal.s;
  const region = map.rooms.find((room) => room.floor === 0 && inPoly(rpx, rpz, room.polygon));
  const regionItems = region ? map.items.filter((item) => item.floor === 0 && item.room === region.id) : [];
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-video-"));
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
  await evaluate("window.__quest.setFloor(0)");
  const mapItem = await evaluate("window.__rpd.itemIndexForId(544458)");
  const mapEntry = await evaluate(`window.__quest.items()[${mapItem}]`);
  await evaluate(`window.__quest.setPlayer(${mapEntry.x}, ${mapEntry.y}, ${mapEntry.z})`);
  await sleep(900);
  await evaluate(`window.__quest.setPlayer(0, 0.02, 4)`);
  await sleep(500);
  const mainHall = await evaluate("window.__quest.mapRoomStateAt(0, 0, 4)");
  for (const item of regionItems) {
    const index = await evaluate(`window.__rpd.itemIndexForId(${item.id})`);
    await evaluate(`window.__quest.actItem(${index})`);
  }
  await evaluate(`window.__quest.setPlayer(${receptionX}, 0.02, ${receptionZ})`);
  await sleep(700);
  const reception = await evaluate(`window.__quest.mapRoomStateAt(0, ${receptionX}, ${receptionZ})`);
  await shot("map-video-state");
  console.log(JSON.stringify({ region: region?.name, regionItems: regionItems.length, mainHall, reception }, null, 2));
  const ok = mainHall === 1 && reception === 2;
  if (!ok) console.log("FAIL: the app's 1F state does not match the video's red Main Hall and blue Entrance");
  if (ok) console.log("PASS: the app's 1F Main Hall is red and the Entrance is blue, matching the video frame");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
