// The 1F map reveals 1F; the Upper Floors map reveals 2F and 3F.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_REVEAL_PORT ?? 5177);
const chromePort = Number(process.env.RPD_MAP_REVEAL_CHROME ?? 9249);
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-reveal-"));
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
  const revealed = async (floor) => evaluate(`window.__quest.mapRevealed(${floor})`);
  const item = async (id) => {
    const index = await evaluate(`window.__rpd.itemIndexForId(${id})`);
    return evaluate(`window.__quest.items()[${index}]`);
  };
  const touch = async (entry) => {
    await evaluate(`window.__quest.setPlayer(${entry.x}, ${entry.y}, ${entry.z})`);
    await sleep(900);
  };
  const before = { one: await revealed(0), two: await revealed(1), three: await revealed(2) };
  await shot("reveal-before");

  await evaluate("window.__quest.setFloor(0)");
  await touch(await item(544458));
  const after1F = { one: await revealed(0), two: await revealed(1), three: await revealed(2) };
  await shot("reveal-1f");

  await evaluate("window.__quest.setFloor(1)");
  await touch(await item(544498));
  const afterUpper = { one: await revealed(0), two: await revealed(1), three: await revealed(2) };
  await shot("reveal-2f");

  console.log(JSON.stringify({ before, after1F, afterUpper }, null, 2));
  const ok = before.one === false && before.two === false && before.three === false &&
    after1F.one === true && after1F.two === false &&
    afterUpper.one === true && afterUpper.two === true && afterUpper.three === true;
  if (!ok) console.log("FAIL: the map items did not reveal the expected floors");
  if (ok) console.log("PASS: the 1F map reveals 1F and the Upper Floors map reveals 2F and 3F");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
