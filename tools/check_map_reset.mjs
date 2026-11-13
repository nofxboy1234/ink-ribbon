// Clicking the map Reset control pans the camera back to Claire and restores
// her floor.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_RESET_PORT ?? 5173);
const chromePort = Number(process.env.RPD_MAP_RESET_CHROME ?? 9253);
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-reset-"));
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
  await evaluate("window.__rpd.setOrbit(20, 0, 20, 0, 1.2, 40)");
  await sleep(500);
  const away = await evaluate("window.__quest.cameraModel()");
  const x = rect.left + rect.width - 196 + 10;
  const y = rect.top + rect.height - 48 + 5;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  let centered = Infinity;
  for (let i = 0; i < 30; i += 1) {
    await sleep(200);
    const pose = await evaluate("window.__quest.cameraModel()");
    centered = Math.hypot(pose[0] - player[0], pose[2] - player[2]);
    if (centered < 0.3) break;
  }
  const floor = await evaluate("window.__rpd.planActiveFloor()");
  const playerFloor = await evaluate("window.__quest.debug().playerFloor");
  await shot("reset-control");
  console.log(JSON.stringify({ player, away: [away[0], away[2]], centered: Math.round(centered * 100) / 100, floor, playerFloor }, null, 2));
  const ok = Math.hypot(away[0] - player[0], away[2] - player[2]) > 5 && centered < 0.3 && floor === playerFloor;
  if (!ok) console.log("FAIL: the Reset control did not pan the camera back to Claire on her floor");
  if (ok) console.log("PASS: the Reset control pans the camera to Claire and restores her floor");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
