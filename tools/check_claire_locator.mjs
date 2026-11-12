// Claire needs a pulsing green locator ring around her capsule, and a Go to
// action must center the map on her after the teleport.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_LOCATOR_PORT ?? 5182);
const chromePort = Number(process.env.RPD_LOCATOR_CHROME ?? 9244);
const outDir = join(root, "verification", "rpd", "locator");
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

const greenRing = (png, cx, cy, radius = 90) => {
  const raw = join(outDir, "frame.raw");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  const data = readFileSync(raw);
  let count = 0;
  let farthest = 0;
  for (let y = Math.max(0, cy - radius); y < Math.min(757, cy + radius); y += 1) {
    for (let x = Math.max(0, cx - radius); x < Math.min(1400, cx + radius); x += 1) {
      const i = (y * 1400 + x) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const distance = Math.hypot(x - cx, y - cy);
      if (distance > 45) continue;
      if (r < 215 && g > 200 && b > 150 && g - r > 25 && g - b > 15) {
        count += 1;
        farthest = Math.max(farthest, distance);
      }
    }
  }
  return { count, farthest: Math.round(farthest * 10) / 10 };
};

const pinkCenter = (png) => {
  const raw = join(outDir, "pink.raw");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  const data = readFileSync(raw);
  let sx = 0, sy = 0, count = 0;
  for (let y = 0; y < 757; y += 1) {
    for (let x = 0; x < 1010; x += 1) {
      const i = (y * 1400 + x) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 235 && g > 130 && g < 205 && b > 225 && r - g > 50 && b - g > 40) { sx += x; sy += y; count += 1; }
    }
  }
  return count > 0 ? { x: sx / count, y: sy / count, count } : null;
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-locator-"));
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
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${port}/` });
  for (let i = 0; i < 300; i += 1) {
    await sleep(300);
    if (await evaluate("(() => { try { return (window.__quest?.items?.().length ?? 0) > 200; } catch { return false; } })()")) break;
  }
  await evaluate("window.__rpd.setViewMode(1)");
  await evaluate("window.__quest.setFloor(0)");
  await evaluate("window.__rpd.resetView()");
  await evaluate("window.__quest.toggleDebug()");
  await sleep(600);

  const ringFrames = [];
  let center = null;
  for (let frame = 0; frame < 8; frame += 1) {
    const png = await shot(`ring-${frame}`);
    if (!center) center = pinkCenter(png);
    if (center) ringFrames.push(greenRing(png, Math.round(center.x), Math.round(center.y), 50));
    await sleep(150);
  }
  const visibleFrames = ringFrames.filter((entry) => entry.count > 10);
  const ringA = ringFrames[0];
  const ringB = ringFrames[1];
  const pulse = visibleFrames.length >= 2
    ? Math.max(...visibleFrames.map((entry) => entry.farthest)) - Math.min(...visibleFrames.map((entry) => entry.farthest))
    : 0;

  const fusebox = await evaluate("window.__quest.itemByName('Fusebox')");
  const fuse = await evaluate("window.__quest.itemByName('Fuse (Main Hall)')");
  const target = await evaluate(`window.__quest.items()[${fusebox}]`);
  await evaluate(`window.__rpd.setOrbit(${target.cubeX}, ${target.cubeY}, ${target.cubeZ}, 0, 1.2, 24)`);
  await sleep(350);
  const menuPoint = await evaluate(`window.__quest.project(${target.cubeX}, ${target.cubeY}, ${target.cubeZ})`);
  let opened = false;
  for (const [dx, dy] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: menuPoint.x + dx, y: menuPoint.y + dy });
    await sleep(150);
    if ((await evaluate("window.__quest.hoverItem()")) !== fusebox) continue;
    await click(menuPoint.x + dx, menuPoint.y + dy, "right");
    await sleep(250);
    opened = true;
    break;
  }
  const choices = opened ? await evaluate("window.__quest.popup().choices") : [];
  const goTo = choices?.find((choice) => choice.label === "Go to Fuse (Main Hall)");
  if (goTo) {
    await click((goTo.x0 + goTo.x1) / 2, (goTo.y0 + goTo.y1) / 2);
    await sleep(1400);
  } else {
    await evaluate("window.__rpd.popupClose()");
  }
  const afterPlayer = await evaluate("window.__quest.debug().player");
  let pose = await evaluate("window.__quest.cameraPose()");
  for (let i = 0; i < 40; i += 1) {
    if (Math.hypot(pose[0] - afterPlayer[0], pose[2] - afterPlayer[2]) < 0.2) break;
    await sleep(200);
    pose = await evaluate("window.__quest.cameraPose()");
  }
  const centered = Math.hypot(pose[0] - afterPlayer[0], pose[2] - afterPlayer[2]);
  await shot("after-go-to");

  console.log(JSON.stringify({ center, ringFrames, pulse, choices: choices?.map((choice) => choice.label), centered: Math.round(centered * 100) / 100, player: afterPlayer }, null, 2));
  const ringOk = visibleFrames.length >= 2 && pulse > 4;
  const centerOk = Boolean(goTo) && centered < 0.6;
  const failed = !ringOk || !centerOk;
  if (!ringOk) console.log("FAIL: no pulsing green ring around Claire");
  if (!centerOk) console.log(`FAIL: the map did not center on Claire after Go to (target distance ${centered})`);
  if (!failed) console.log("PASS: Claire has a pulsing green ring and Go to centers the map on her");
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
