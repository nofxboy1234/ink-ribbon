// Left click walks, right click runs, and a double click clears the route.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_MOVE_PORT ?? 5180);
const chromePort = Number(process.env.RPD_MAP_MOVE_CHROME ?? 9246);
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-move-"));
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
  const click = async (x, y, button = "left") => {
    const buttons = button === "right" ? 2 : 1;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(40);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
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
  await sleep(900);
  const rect = await evaluate("(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()");
  const player = async () => evaluate("window.__quest.debug().player");
  const planCount = async () => evaluate("window.__rpd.planCount()");
  const run = async () => evaluate("window.__quest.run()");
  const targetScreen = async (x, y, z) => {
    const point = await evaluate(`window.__quest.project(${x}, ${y}, ${z})`);
    return point ? { x: rect.left + point.x, y: rect.top + point.y } : null;
  };
  const start = await player();
  const target = await evaluate(`window.__quest.nearestNavNode(0, ${start[0] + 4}, ${start[1]}, ${start[2]})`);
  const walk = await targetScreen(target.x, target.y, target.z);
  await click(walk.x, walk.y);
  await sleep(1600);
  const afterWalk = await player();
  const walked = Math.hypot(afterWalk[0] - start[0], afterWalk[2] - start[2]);
  const walkPlan = await planCount();
  const walkRun = await run();
  await shot("move-walk");

  await click(walk.x, walk.y);
  await sleep(120);
  await click(walk.x, walk.y);
  await sleep(500);
  const afterDouble = await planCount();
  const stopped = await evaluate("window.__rpd.planMoving()");

  const startRun = await player();
  const runTarget = await evaluate(`window.__quest.nearestNavNode(0, ${startRun[0] - 3}, ${startRun[1]}, ${startRun[2]})`);
  const runPoint = await targetScreen(runTarget.x, runTarget.y, runTarget.z);
  await click(runPoint.x, runPoint.y, "right");
  await sleep(900);
  const runMode = await run();
  const afterRun = await player();
  const ran = Math.hypot(afterRun[0] - startRun[0], afterRun[2] - startRun[2]);
  await shot("move-run");

  console.log(JSON.stringify({ walked, walkPlan, walkRun, afterDouble, stopped, runMode, ran }, null, 2));
  const ok = walked > 0.3 && walkPlan > 0 && walkRun === false && afterDouble === 0 && stopped === 0 && runMode === true && ran > 0.3;
  if (!ok) console.log("FAIL: the map click movement did not walk, run or clear as expected");
  if (ok) console.log("PASS: left click walks, double click clears, right click runs");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
