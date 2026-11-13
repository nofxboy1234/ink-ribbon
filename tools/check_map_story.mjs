// Contact pickup and the story gates: notebook, knife at the taped gate,
// Spade Key, and both doors turning blue.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_MAP_STORY_PORT ?? 5178);
const chromePort = Number(process.env.RPD_MAP_STORY_CHROME ?? 9248);
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-map-story-"));
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
  const item = async (id) => {
    const index = await evaluate(`window.__rpd.itemIndexForId(${id})`);
    const entry = await evaluate(`window.__quest.items()[${index}]`);
    return { index, ...entry };
  };
  const inventory = () => evaluate("window.__quest.inventory().filter(Boolean).map((slot) => slot.name)");
  const state = async (index) => (await evaluate(`window.__quest.items()[${index}]`)).state;
  const teleport = async (entry) => {
    await evaluate(`window.__quest.setPlayer(${entry.x}, ${entry.y}, ${entry.z})`);
    await sleep(900);
  };
  const doorState = async (floor, key) => {
    const doors = await evaluate(`window.__quest.mapDoors(${floor})`);
    const door = doors.find((entry) => Math.round(entry.key) === key);
    return door ? door.state : -1;
  };

  const notebook = await item(544441);
  await evaluate("window.__quest.setFloor(0)");
  await teleport(notebook);
  const notebookState = await state(notebook.index);

  const box = await item(544404);
  await teleport(box);
  const afterBoxInventory = await inventory();
  const tapedDoor = await doorState(0, 544445);
  await shot("story-knife");

  await evaluate("window.__quest.setFloor(2)");
  const spadeKey = await item(544555);
  await teleport(spadeKey);
  const afterSpadeInventory = await inventory();
  const spadeKeyState = await state(spadeKey.index);

  await evaluate("window.__quest.setFloor(0)");
  const spadeDoorItem = await item(544562);
  await teleport(spadeDoorItem);
  const spadeDoor = await doorState(0, 544555);
  await shot("story-spade");

  console.log(JSON.stringify({ notebookState, afterBoxInventory, tapedDoor, afterSpadeInventory, spadeKeyState, spadeDoor }, null, 2));
  const notebookOk = notebookState >= 2;
  const knifeOk = afterBoxInventory.includes("Combat Knife");
  const tapedDoorOk = tapedDoor === 2;
  const spadeOk = afterSpadeInventory.includes("Spade Key") && spadeKeyState === 2;
  const spadeDoorOk = spadeDoor === 2;
  console.log(JSON.stringify({ notebookOk, knifeOk, tapedDoorOk, spadeOk, spadeDoorOk }));
  const ok = notebookOk && knifeOk && tapedDoorOk && spadeOk && spadeDoorOk;
  if (!ok) console.log("FAIL: the pickup or the story gates did not reach the expected states");
  if (ok) console.log("PASS: notebook, knife at the gate, Spade Key and both doors reached the expected states");
  socket.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
}
