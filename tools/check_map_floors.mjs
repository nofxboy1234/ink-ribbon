// 3F stays hidden until the Upper Floors Map is read.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_FLOORS_PORT ?? 5168);
const chromePort = Number(process.env.RPD_MAP_FLOORS_CHROME ?? 9258);
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-floors-"));
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
  const clickFloor = async (row) => {
    const x = rect.left + rect.width - 148 + 26;
    const y = rect.top + rect.height * 0.22 + row * 38 + 14;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(400);
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
  const revealedBefore = await evaluate("window.__quest.mapRevealed(2)");
  await clickFloor(2);
  const hiddenActive = await evaluate("window.__rpd.planActiveFloor()");
  await shot("floors-3f-hidden");
  await evaluate("window.__quest.setFloor(1)");
  const upper = await evaluate("window.__rpd.itemIndexForId(544498)");
  const upperItem = await evaluate(`window.__quest.items()[${upper}]`);
  await evaluate(`window.__quest.setPlayer(${upperItem.x}, ${upperItem.y}, ${upperItem.z})`);
  await sleep(900);
  await evaluate("window.__quest.setFloor(0)");
  await sleep(300);
  const revealedAfter = await evaluate("window.__quest.mapRevealed(2)");
  await clickFloor(2);
  const shownActive = await evaluate("window.__rpd.planActiveFloor()");
  await shot("floors-3f-shown");
  console.log(JSON.stringify({ revealedBefore, hiddenActive, revealedAfter, shownActive }, null, 2));
  const ok = revealedBefore === false && hiddenActive === 0 && revealedAfter === true && shownActive === 2;
  if (!ok) console.log("FAIL: the 3F tab did not stay hidden until the Upper Floors Map");
  if (ok) console.log("PASS: the 3F tab stays hidden until the Upper Floors Map reveals it");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
