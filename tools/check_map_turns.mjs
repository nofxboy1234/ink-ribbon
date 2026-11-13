// Turns: a real corner is smoothed into an arc; a roughly straight line stays
// sharp; the player arrow follows the movement heading.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_TURNS_PORT ?? 5176);
const chromePort = Number(process.env.RPD_MAP_TURNS_CHROME ?? 9250);
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-turns-"));
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
  const player = await evaluate("window.__quest.debug().player");
  const clear = () => evaluate("window.__rpd.planClearRoute()");
  const routePoints = () => evaluate("window.__rpd.planRoute().length / 3");
  const add = (dx, dz) => evaluate(`(() => {
    const node = window.__quest.nearestNavNode(0, ${player[0]} + ${dx}, ${player[1]}, ${player[2]} + ${dz});
    if (!node) return -1;
    window.__rpd.planAddTargetNode(node.index);
    return window.__rpd.planRoute().length / 3;
  })()`);
  const scan = [];
  for (let dx = 4; dx <= 24; dx += 4) {
    for (let dz = -12; dz <= 8; dz += 4) {
      await clear();
      const points = await add(dx, dz);
      scan.push({ dx, dz, points });
    }
  }
  await clear();
  const straight = await add(4, 0);
  await clear();
  const max = scan.reduce((best, entry) => (entry.points > best.points ? entry : best), { points: 0, dx: 0, dz: 0 });
  const maxPoints = await add(max.dx, max.dz);
  await shot("turns-corner");
  await clear();

  // Walk east and read the arrow heading.
  const target = await evaluate(`window.__quest.nearestNavNode(0, ${player[0]} + 4, ${player[1]}, ${player[2]})`);
  const point = await evaluate(`window.__quest.project(${target.x}, ${target.y}, ${target.z})`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.left + point.x, y: rect.top + point.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.left + point.x, y: rect.top + point.y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.left + point.x, y: rect.top + point.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(800);
  const heading = await evaluate("window.__quest.heading()");
  await shot("turns-arrow");

  console.log(JSON.stringify({ straight, max, maxPoints, heading }, null, 2));
  const cornerOk = maxPoints >= 6;
  const straightOk = straight <= 3;
  const headingOk = Math.abs(heading - Math.PI / 2) < 0.6;
  console.log(JSON.stringify({ cornerOk, straightOk, headingOk }));
  const ok = cornerOk && straightOk && headingOk;
  if (!ok) console.log("FAIL: the route did not smooth a real corner, keep a straight line sharp, or face the heading");
  if (ok) console.log("PASS: real turns use the arc, straight lines stay sharp, and the arrow faces the heading");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
