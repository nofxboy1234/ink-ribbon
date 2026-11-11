// Repro for the debug teleport hiding Claire: a staircase cell off the active
// floor's level must still leave her at floor level and drawn on the 2D plan.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nav = JSON.parse(readFileSync(join(root, "public", "rpd", "nav.json"), "utf8"));
const port = Number(process.env.RPD_TELEPORT_PORT ?? 5191);
const chromePort = Number(process.env.RPD_TELEPORT_CHROME ?? 9231);
const outDir = join(root, "verification", "rpd", "teleport");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(outDir, { recursive: true });

const waitForHttp = async (url, timeoutMs = 30000) => {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`timeout ${url}`);
    await sleep(150);
  }
};

const pinkPixelsNear = (png, x, y, radius = 45) => {
  const raw = join(outDir, "frame.raw");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  const data = readFileSync(raw);
  let count = 0;
  for (let py = Math.max(0, y - radius); py < Math.min(757, y + radius); py += 1) {
    for (let px = Math.max(0, x - radius); px < Math.min(1400, x + radius); px += 1) {
      const i = (py * 1400 + px) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 150 && b > 100 && g < 170 && r - g > 40 && b - g > 15) count += 1;
    }
  }
  return count;
};

const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, NODE_ENV: "development" },
});
let chrome;
let userDataDir;
try {
  await waitForHttp(`http://localhost:${port}/`);
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-teleport-"));
  chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--ozone-platform=headless",
      "--window-size=1400,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 20000);
  const pages = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
  const socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return res?.exceptionDetails ? undefined : res?.result?.value;
  };
  const click = async (x, y, button = "left") => {
    const buttons = button === "right" ? 2 : 1;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(60);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
  };
  const shot = async (name) => {
    const result = await send("Page.captureScreenshot", { format: "png" });
    const path = join(outDir, `${name}.png`);
    writeFileSync(path, Buffer.from(result.data, "base64"));
    return path;
  };
  const teleportAt = async (name, x, y, z) => {
    const screen = await evaluate(`window.__quest.project(${x}, ${y}, ${z})`);
    if (!screen) return { name, error: "no screen projection" };
    await click(screen.x, screen.y, "right");
    await sleep(250);
    const popup = await evaluate("window.__quest.popup()");
    const choice = popup?.choices?.find((entry) => entry.enabled && entry.label === "Teleport here");
    if (!choice) {
      await evaluate("window.__rpd.popupClose()");
      return { name, error: "no teleport choice" };
    }
    await click((choice.x0 + choice.x1) / 2, (choice.y0 + choice.y1) / 2);
    await sleep(500);
    const player = await evaluate("window.__quest.debug().player");
    const projected = await evaluate(`window.__quest.project(${player[0]}, ${player[1]}, ${player[2]})`);
    const png = await shot(name);
    return { name, player, projected, png };
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${port}/` });
  for (let i = 0; i < 300; i += 1) {
    await sleep(300);
    if (await evaluate("(() => { try { return (window.__quest?.items?.().length ?? 0) > 200; } catch { return false; } })()")) break;
  }
  await evaluate("window.__rpd.setViewMode(1)");
  await evaluate("window.__quest.setFloor(2)");
  await evaluate("window.__rpd.setOrbit(0, 0, 0, 0, 1.2, 40)");
  await evaluate("window.__rpd.resetView()");
  await sleep(500);
  await evaluate("window.__quest.toggleDebug()");
  await sleep(300);

  const level = nav.floors.find((floor) => floor.index === 2).level;
  const stair = await teleportAt("stair-teleport", 30.5, 7.84, -18.5);
  if (stair.player) {
    stair.offLevel = Math.abs(stair.player[1] - level) > 0.25;
    stair.pink = pinkPixelsNear(stair.png, Math.round(stair.projected.x), Math.round(stair.projected.y));
  }

  await evaluate("window.__quest.setFloor(0)");
  await evaluate("window.__rpd.resetView()");
  await sleep(500);
  const floor = await teleportAt("floor-teleport", 0.0, 0.04, 7.5);
  if (floor.player) {
    floor.offLevel = Math.abs(floor.player[1] - nav.floors.find((entry) => entry.index === 0).level) > 0.25;
    floor.pink = pinkPixelsNear(floor.png, Math.round(floor.projected.x), Math.round(floor.projected.y));
  }

  const results = [stair, floor];
  console.log(JSON.stringify(results, null, 2));
  const failed = results.some((entry) => entry.error || entry.offLevel || entry.pink <= 0);
  console.log(failed ? "FAIL: a teleport hid Claire or left her off the floor" : "PASS: teleports leave Claire at floor level and drawn");
  socket.close();
  process.exitCode = failed ? 1 : 0;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}
