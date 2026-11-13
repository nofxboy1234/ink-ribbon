// The Spade Door carries a spade glyph, and the wheel reaches both zoom limits.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_SPADE_PORT ?? 5171);
const chromePort = Number(process.env.RPD_MAP_SPADE_CHROME ?? 9255);
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-spade-"));
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
  const scale = async () => (await evaluate("window.__rpd.planCamera()"))[2];
  const wheel = async (deltaY, times) => {
    for (let i = 0; i < times; i += 1) {
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.left + rect.width * 0.4, y: rect.top + rect.height * 0.5, deltaX: 0, deltaY });
      await sleep(20);
    }
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
  await evaluate("window.__quest.setFloor(0)");
  const mapItem = await evaluate("window.__rpd.itemIndexForId(544458)");
  const mapEntry = await evaluate(`window.__quest.items()[${mapItem}]`);
  await evaluate(`window.__quest.setPlayer(${mapEntry.x}, ${mapEntry.y}, ${mapEntry.z})`);
  await sleep(900);
  const doors = await evaluate("window.__quest.mapDoors(0)");
  const spade = doors.find((door) => Math.round(door.key) === 544555);
  await shot("spade-icon");

  const initial = await scale();
  await wheel(-240, 60);
  let up = await scale();
  let inDirection = -240;
  if (up < initial) {
    inDirection = 240;
    await wheel(240, 120);
    up = await scale();
  }
  await shot("zoom-in");
  await wheel(-inDirection, 160);
  const out = await scale();
  await shot("zoom-out");
  console.log(JSON.stringify({ spade, initial: Math.round(initial * 100) / 100, up: Math.round(up * 100) / 100, out: Math.round(out * 100) / 100 }, null, 2));
  const ok = Boolean(spade) && spade.x < -5 && up > 24 && out < 3.2;
  if (!ok) console.log("FAIL: the Spade Door glyph or the zoom limits did not meet the expected range");
  if (ok) console.log("PASS: the Spade Door is present and the wheel reaches both zoom limits");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
