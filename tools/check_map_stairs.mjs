// Walking a portal switches Claire's floor and the map follows her.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_STAIRS_PORT ?? 5175);
const chromePort = Number(process.env.RPD_MAP_STAIRS_CHROME ?? 9251);
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
  const nav = await (await fetch(`http://localhost:${port}/rpd/nav.json`)).json();
  let pair = null;
  for (const [a, b] of nav.portals) {
    const fa = nav.nodes[a].floor;
    const fb = nav.nodes[b].floor;
    if ((fa === 0 && fb === 1) || (fa === 1 && fb === 0)) { pair = fa === 0 ? { from: a, to: b } : { from: b, to: a }; break; }
  }
  if (!pair) throw new Error("no 1F-2F portal found");
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-stairs-"));
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
  const from = nav.nodes[pair.from];
  const to = nav.nodes[pair.to];
  await evaluate("window.__quest.setFloor(0)");
  await evaluate(`window.__quest.setPlayer(${from.x}, ${from.y}, ${from.z})`);
  await sleep(600);
  const before = { player: await evaluate("window.__quest.debug().playerFloor"), active: await evaluate("window.__rpd.planActiveFloor()") };
  await evaluate(`window.__rpd.planAddTargetNode(${pair.to})`);
  await evaluate("window.__rpd.planStartMove()");
  await sleep(3000);
  const after = { player: await evaluate("window.__quest.debug().playerFloor"), active: await evaluate("window.__rpd.planActiveFloor()") };
  await shot("stairs");
  console.log(JSON.stringify({ pair, before, after }, null, 2));
  const ok = before.player === 0 && before.active === 0 && after.player === 1 && after.active === 1;
  if (!ok) console.log("FAIL: the stair transition did not move Claire to the next floor and the map with her");
  if (ok) console.log("PASS: the stair transition moves Claire and the active map floor to 2F");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
