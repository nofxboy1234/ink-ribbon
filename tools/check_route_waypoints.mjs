// Checks that multi-waypoint routes pass through each waypoint centre in order
// and that running traverses a route at twice the walking speed.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_WAYPOINT_PORT ?? 5190);
const chromePort = Number(process.env.RPD_WAYPOINT_CHROME ?? 9232);
const outDir = join(root, "verification", "rpd", "waypoints");
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

const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, NODE_ENV: "development" },
});
let chrome;
let userDataDir;
try {
  await waitForHttp(`http://localhost:${port}/`);
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-waypoints-"));
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

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${port}/` });
  for (let i = 0; i < 300; i += 1) {
    await sleep(300);
    if (await evaluate("(() => { try { return (window.__quest?.items?.().length ?? 0) > 200; } catch { return false; } })()")) break;
  }
  await evaluate("window.__rpd.setViewMode(1)");
  await evaluate("window.__quest.setFloor(0)");
  await evaluate("window.__rpd.setOrbit(0, 0, 0, 0, 1.2, 40)");
  await evaluate("window.__rpd.resetView()");
  await sleep(500);

  const start = [-1.5, 0.02, 3.5];
  const w1 = { node: 1786, x: -2.5, z: -0.5 };
  const w2 = { node: 1565, x: -0.5, z: -3.5 };
  const w3 = { node: 1230, x: -1.5, z: -8.5 };

  await evaluate(`window.__quest.setPlayer(${start[0]}, ${start[1]}, ${start[2]})`);
  await sleep(300);
  await evaluate("window.__quest.reset()");
  await evaluate(`window.__quest.addTargetNode(${w1.node})`);
  await evaluate(`window.__quest.addTargetNode(${w2.node})`);
  await evaluate(`window.__quest.addTargetNode(${w3.node})`);
  await sleep(300);
  const route = await evaluate("Array.from(window.__rpd.planRoute())");
  const points = [];
  for (let i = 0; i + 2 < route.length; i += 3) points.push([route[i], route[i + 2]]);
  const distanceTo = (target) => Math.min(...points.map(([x, z]) => Math.hypot(x - target.x, z - target.z)));
  const indexNear = (target) => {
    let best = -1;
    let bestDistance = Infinity;
    points.forEach(([x, z], index) => {
      const distance = Math.hypot(x - target.x, z - target.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  };
  const waypoint = {
    points: points.length,
    distanceToW1: distanceTo(w1),
    distanceToW2: distanceTo(w2),
    distanceToW3: distanceTo(w3),
    order: [indexNear(w1), indexNear(w2), indexNear(w3)],
  };

  const measure = async () => {
    const elapsed = await evaluate(`(async () => {
      const startTime = performance.now();
      window.__rpd.planStartMove();
      while (window.__quest.debug().moving) await new Promise((r) => setTimeout(r, 20));
      return performance.now() - startTime;
    })()`);
    return elapsed;
  };
  const routeLength = () => {
    let length = 0;
    for (let i = 3; i < route.length; i += 3) {
      length += Math.hypot(route[i] - route[i - 3], route[i + 1] - route[i - 2], route[i + 2] - route[i - 1]);
    }
    return length;
  };

  await evaluate("window.__quest.reset()");
  await evaluate(`window.__quest.setPlayer(${start[0]}, ${start[1]}, ${start[2]})`);
  await evaluate(`window.__quest.addTargetNode(${w3.node})`);
  await sleep(200);
  const straight = await evaluate("Array.from(window.__rpd.planRoute())");
  let straightLength = 0;
  for (let i = 3; i < straight.length; i += 3) {
    straightLength += Math.hypot(straight[i] - straight[i - 3], straight[i + 1] - straight[i - 2], straight[i + 2] - straight[i - 1]);
  }
  const walkMs = await measure();

  const player = await evaluate("window.__quest.debug().player");
  const screen = await evaluate(`window.__quest.project(${player[0]}, ${player[1]}, ${player[2]})`);
  await click(screen.x, screen.y, "right");
  await sleep(250);
  const popup = await evaluate("window.__quest.popup()");
  const runChoice = popup?.choices?.find((entry) => entry.enabled && entry.label === "Run");
  if (!runChoice) throw new Error(`no Run choice: ${JSON.stringify(popup?.choices?.map((e) => e.label))}`);
  await click((runChoice.x0 + runChoice.x1) / 2, (runChoice.y0 + runChoice.y1) / 2);
  await sleep(250);

  await evaluate("window.__quest.reset()");
  await evaluate(`window.__quest.setPlayer(${start[0]}, ${start[1]}, ${start[2]})`);
  await evaluate(`window.__quest.addTargetNode(${w3.node})`);
  await sleep(200);
  const runMs = await measure();

  const walkSpeed = straightLength / (walkMs / 1000);
  const runSpeed = straightLength / (runMs / 1000);
  const speed = { walkMs, runMs, walkSpeed, runSpeed, ratio: runSpeed / walkSpeed, straightLength };

  console.log(JSON.stringify({ waypoint, speed }, null, 2));
  const waypointOk =
    waypoint.distanceToW1 <= 0.05 &&
    waypoint.distanceToW2 <= 0.05 &&
    waypoint.distanceToW3 <= 0.05 &&
    waypoint.order[0] < waypoint.order[1] &&
    waypoint.order[1] < waypoint.order[2];
  const speedOk = speed.ratio >= 1.7 && speed.ratio <= 2.3;
  const failed = !waypointOk || !speedOk;
  if (!waypointOk) console.log("FAIL: the route does not pass through the middle waypoint centre in order");
  if (!speedOk) console.log(`FAIL: run/walk speed ratio is ${speed.ratio.toFixed(2)}, expected about 2`);
  if (!failed) console.log("PASS: waypoints are visited in order at their centres and run is twice walking speed");
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
