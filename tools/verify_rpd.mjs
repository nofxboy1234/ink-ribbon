import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const update = process.argv.includes("--update");
const keep = process.argv.includes("--keep");
const port = Number(process.env.RPD_VERIFY_PORT ?? 5199);
const chromePort = Number(process.env.RPD_CHROME_PORT ?? 9222);
const baselineDir = join(root, "verification", "rpd", "baseline");
const currentDir = join(root, "verification", "rpd", "current");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const imageThreshold = 0.001;

mkdirSync(baselineDir, { recursive: true });
mkdirSync(currentDir, { recursive: true });

const mapArea = { x0: 0, y0: 140, x1: 1020, y1: 820 };

function readPng(path) {
  const file = readFileSync(path);
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const chunks = [];
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString("ascii", at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8 || body[12] !== 0) throw new Error(`${path}: unsupported PNG depth or interlace`);
    } else if (type === "IDAT") {
      chunks.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`${path}: unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function colouredPixels(path) {
  const { width, height, channels, pixels } = readPng(path);
  let count = 0;
  for (let y = mapArea.y0; y < Math.min(height, mapArea.y1); y += 1) {
    for (let x = mapArea.x0; x < Math.min(width, mapArea.x1); x += 1) {
      const at = (y * width + x) * channels;
      const r = pixels[at];
      const g = pixels[at + 1];
      const b = pixels[at + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) count += 1;
    }
  }
  return count;
}

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`));
      setTimeout(poll, 150);
    };
    poll();
  });
}

async function startServer() {
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--port", String(port), "--strictPort"],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  try {
    await waitForHttp(`http://localhost:${port}/`);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n${output}`);
  }
  return child;
}

async function startChrome() {
  const userDataDir = mkdtempSync(join(tmpdir(), "rpd-verify-chrome-"));
  const binary = process.env.CHROME_BIN ?? "google-chrome";
  const child = spawn(
    binary,
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
      "--noerrdialogs",
      "--ozone-platform=headless",
      "--window-size=1400,900",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 20000);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\nChrome binary: ${binary}`);
  }
  return { child, userDataDir };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails.text);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails));
    }
    return response.result?.result?.value;
  }

  async waitFor(expression, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.eval(expression).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  async screenshot(path) {
    const response = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(response.result.data, "base64"));
  }

  async mouse(type, x, y, extra = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      ...extra,
    });
  }

  async key(code, key, keyCode) {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      code,
      key,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      code,
      key,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }
}

async function run() {
  const server = await startServer();
  const chrome = await startChrome();
  let cdp;
  try {
    const page = await (
      await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(`http://localhost:${port}/`)}`, {
        method: "PUT",
      })
    ).json();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    cdp = new Cdp(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.bringToFront");
    await cdp.waitFor("Boolean(window.__quest?.setPlayer)");
    await cdp.waitFor("document.querySelector('.rpd-status')?.dataset.hidden === 'true'");
    await sleep(800);
    await cdp.eval(
      "document.querySelectorAll('.rpd-fps,.rpd-toast').forEach((e) => (e.style.visibility = 'hidden'))",
    );

    const shots = [];
    const shotPath = (name) => join(update ? baselineDir : currentDir, `${name}.png`);
    const shot = async (name) => {
      await cdp.eval(
        "document.querySelectorAll('.rpd-fps,.rpd-toast').forEach((e) => (e.style.visibility = 'hidden'))",
      );
      await cdp.screenshot(shotPath(name));
      shots.push(name);
    };
    const setFloor = async (floor) => {
      await cdp.eval(`window.__quest.setFloor(${floor})`);
      await sleep(750);
    };
    const facts = () => cdp.eval(`(() => {
      return {
        floors: [...document.querySelectorAll('.rpd-floor:not(.rpd-view-toggle)')].map((e) => e.textContent.trim()),
        active: document.querySelector('.rpd-floor[data-active="true"]')?.textContent.trim() ?? null,
        slots: document.querySelectorAll('.rpd-slot').length,
        routeDock: Boolean(document.querySelector('.rpd-route-dock')),
        inventoryShown: Boolean(document.querySelector('.rpd-inventory')),
        panel: document.querySelector('.rpd-panel')?.innerText.slice(0, 90) ?? null,
        mapTitle: document.querySelector('.rpd-map-title')?.innerText ?? null,
        plan: window.__quest.debug().plan,
        player: window.__quest.debug().player,
        moving: window.__quest.debug().moving,
        routePoints: window.__quest.debug().routePoints,
        move: window.__quest.debug().move,
        playerFloor: window.__quest.debug().playerFloor,
        check: window.__quest.checkPath(),
        view: document.querySelector('.rpd-view-toggle')?.textContent.trim() ?? null,
        cameraPose: window.__quest.cameraPose(),
        mapCamera: window.__quest.camera(),
        cameraModel: window.__quest.cameraModel(),
        floorRoles: window.__quest.debugFloors(),
        overlay: window.__quest.overlayStats(),
      };
    })()`);
    const assert = (ok, message) => {
      if (!ok) throw new Error(message);
    };
    const evalJson = async (expression) =>
      JSON.parse(await cdp.eval(`JSON.stringify(${expression})`));
    const closeEnough = (a, b, tolerance = 1e-3) =>
      a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

    const report = { shots: [], errors: [], states: {} };

    await cdp.eval("window.__rpd.setFpsVisible(false)");
    await shot("01-3d");
    report.states.initial = await facts();
    assert(report.states.initial.floors.length === 5, "expected five floor buttons");
    assert(report.states.initial.slots === 8, "expected eight inventory slots");
    assert(!report.states.initial.routeDock, "the route dock should be gone");

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 1) >= 0.999", 20000);
    await sleep(250);
    await shot("02-ortho-1f");
    report.states.ortho1f = await facts();

    const camBefore = await cdp.eval("JSON.stringify(window.__quest.camera())");
    await cdp.mouse("mousePressed", 700, 500);
    await cdp.mouse("mouseMoved", 720, 490);
    await cdp.mouse("mouseMoved", 740, 480);
    await cdp.mouse("mouseReleased", 740, 480);
    await sleep(350);
    const camAfter = await cdp.eval("JSON.stringify(window.__quest.camera())");
    report.states.leftDrag = { before: camBefore, after: camAfter };
    assert(camBefore === camAfter, "left drag must not pan the plan");
    assert(report.states.ortho1f.view === "3D", "M should switch to the plan view");
    assert(report.states.ortho1f.mapTitle?.includes("1F"), "the plan should show 1F");

    for (const [floor, name] of [[1, "03-ortho-2f"], [2, "04-ortho-3f"], [3, "05-ortho-4f"], [4, "06-ortho-b1"]]) {
      await setFloor(floor);
      await shot(name);
    }
    report.states.orthoB1 = await facts();
    assert(report.states.orthoB1.mapTitle?.includes("B1"), "floor selection should reach B1");

    await setFloor(0);
    await shot("07-ortho-1f-clean");

    const cell = JSON.parse(await cdp.eval("JSON.stringify(window.__quest.walkableCell())"));
    assert(cell && cell.screen, "the DEV API did not return a walkable cell");
    const cellX = cell.screen.x;
    const cellY = cell.screen.y;
    await cdp.mouse("mouseMoved", cellX, cellY);
    await sleep(400);
    await shot("08-hover");

    await cdp.mouse("mousePressed", cellX, cellY);
    await cdp.mouse("mouseReleased", cellX, cellY);
    await sleep(600);
    let popup = await cdp.eval("window.__quest.popup()");
    assert(popup.open, "clicking a walkable cell did not open the routing popup");
    assert(!popup.choices.some((choice) => choice.label.includes("TAKE")), "a walkable cell should offer a waypoint");
    await cdp.mouse("mousePressed", 240, 760);
    await cdp.mouse("mouseReleased", 240, 760);
    await sleep(400);
    assert(!(await cdp.eval("window.__quest.popup().open")), "clicking outside should dismiss the popup");

    await cdp.mouse("mousePressed", cellX, cellY);
    await cdp.mouse("mouseReleased", cellX, cellY);
    await sleep(600);
    popup = await cdp.eval("window.__quest.popup()");
    const waypointChoice = popup.choices.find(
      (choice) => choice.enabled && choice.label.includes("ADD WAYPOINT"),
    );
    assert(waypointChoice, "the routing popup has no Add waypoint choice");
    await shot("09-popup");
    const choiceIndex = popup.choices.indexOf(waypointChoice);
    const choiceX = (waypointChoice.x0 + waypointChoice.x1) / 2;
    const choiceY = (waypointChoice.y0 + waypointChoice.y1) / 2;
    await cdp.mouse("mouseMoved", choiceX, choiceY);
    await sleep(500);
    const hovered = await cdp.eval("window.__quest.popup().hover");
    assert(hovered === choiceIndex, "hovering a popup choice did not highlight it");
    await shot("09-popup-hover");
    await cdp.mouse("mousePressed", choiceX, choiceY);
    await cdp.mouse("mouseReleased", choiceX, choiceY);
    await sleep(600);
    assert(!(await cdp.eval("window.__quest.popup().open")), "the popup should close after a choice");
    const picked = await cdp.eval("window.__quest.debug().plan.length");
    assert(picked > 0, "choosing Add waypoint did not add a waypoint");
    await cdp.eval("window.__quest.reset()");
    await cdp.eval("window.__quest.addTarget(0, 4)");
    await sleep(500);
    await shot("09-waypoint");
    await cdp.eval("window.__quest.addTarget(22, -10)");
    await sleep(500);
    await shot("10-plan");
    report.states.plan = await facts();
    console.log("route check", JSON.stringify(report.states.plan.check));
    assert(report.states.plan.plan.length > 1, "the waypoint did not add plan steps");
    assert(
      report.states.plan.check &&
        report.states.plan.check.points > 1 &&
        report.states.plan.check.samples > 0 &&
        report.states.plan.check.bad === 0 &&
        report.states.plan.check.worst <= 0.75,
      "route leaves the walkable graph",
    );

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) <= 0.001", 20000);
    await sleep(250);
    await shot("10b-route-3d");
    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) >= 0.999", 20000);
    await sleep(250);

    const claire = JSON.parse(
      await cdp.eval("JSON.stringify(window.__quest.project(...window.__quest.debug().player))"),
    );
    for (let i = 0; i < 2; i += 1) {
      await cdp.mouse("mousePressed", claire.x, claire.y, { clickCount: 2 });
      await cdp.mouse("mouseReleased", claire.x, claire.y, { clickCount: 2 });
    }
    for (let i = 0; i < 600; i += 1) {
      await sleep(150);
      if (!(await cdp.eval("window.__quest.debug().moving"))) break;
    }
    await sleep(400);
    await shot("11-route-ortho");
    report.states.arrived = await facts();
    assert(!report.states.arrived.moving, "double clicking Claire should run the route to completion");
    assert(report.states.arrived.plan.length === 0, "arriving should clear the waypoints");
    assert(report.states.arrived.routePoints === 0, "arriving should clear the drawn route");

    const escIdlePlayer = report.states.arrived.player;
    await cdp.eval("window.__quest.addTarget(-30, 10)");
    await sleep(400);
    assert((await cdp.eval("window.__quest.debug().plan.length")) > 0, "Esc test did not add a waypoint");
    await cdp.key("Escape", "Escape", 27);
    await sleep(400);
    const escIdle = await facts();
    assert(escIdle.plan.length === 0, "Esc while idle should clear the waypoints");
    assert(escIdle.routePoints === 0, "Esc while idle should clear the route");
    assert(
      JSON.stringify(escIdle.player) === JSON.stringify(escIdlePlayer),
      "Esc while idle must not move Claire",
    );
    assert(
      closeEnough(escIdle.mapCamera, report.states.arrived.mapCamera, 1e-4),
      "Esc while idle must not move the map camera",
    );
    report.states.escIdle = escIdle;

    await cdp.eval("window.__quest.addTarget(-30, 10)");
    await sleep(400);
    const movingStart = await evalJson("window.__quest.debug().player");
    const movingClaire = await evalJson(
      "window.__quest.project(...window.__quest.debug().player)",
    );
    for (let i = 0; i < 2; i += 1) {
      await cdp.mouse("mousePressed", movingClaire.x, movingClaire.y, { clickCount: 2 });
      await cdp.mouse("mouseReleased", movingClaire.x, movingClaire.y, { clickCount: 2 });
    }
    await cdp.waitFor("window.__quest.debug().moving === true", 10000);
    await sleep(900);
    const movingCamera = await cdp.eval("JSON.stringify(window.__quest.camera())");
    await cdp.key("Escape", "Escape", 27);
    await sleep(400);
    const escMoving = await facts();
    const pausedPlayer = escMoving.player;
    assert(!escMoving.moving, "Esc while moving should stop Claire");
    assert(escMoving.plan.length === 0, "Esc while moving should clear the waypoints");
    assert(escMoving.routePoints === 0, "Esc while moving should clear the route");
    assert(
      Math.hypot(pausedPlayer[0] - movingStart[0], pausedPlayer[2] - movingStart[2]) > 0.5,
      "Esc while moving must leave Claire where she stopped",
    );
    assert(
      movingCamera === JSON.stringify(escMoving.mapCamera),
      "Esc while moving must not move the map camera",
    );
    report.states.escMoving = escMoving;

    await cdp.eval("window.__quest.setFloor(1)");
    await sleep(300);
    await cdp.eval("window.__quest.setFloor(0)");
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await sleep(600);
    const settledPlayer = await evalJson("window.__quest.debug().player");

    let labelOverlap = null;
    const rooms = await cdp.eval("window.__quest.rooms()");
    for (const room of rooms) {
      if (room.floor !== 0) continue;
      if (Math.hypot(room.x - settledPlayer[0], room.z - settledPlayer[2]) < 6) continue;
      const opened = await cdp.eval(`window.__quest.openPopupAt(${room.x}, ${room.z})`);
      await sleep(700);
      const stats = await cdp.eval("window.__quest.overlayStats()");
      if (opened && stats[2] > 0) {
        labelOverlap = { room: room.name, stats };
        break;
      }
    }
    assert(labelOverlap, "could not open a popup that reserves a room label");
    assert(labelOverlap.stats[3] === 0, "a room label was drawn over the popup");
    await shot("18-popup-label-overlap");
    report.states.labelOverlap = labelOverlap;
    await cdp.key("Escape", "Escape", 27);
    await sleep(300);

    await setFloor(0);
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await sleep(400);
    const registry = await cdp.eval("window.__quest.items()");
    assert(registry.length === 271, `expected 271 registry items, got ${registry.length}`);
    assert(
      registry.every((item) => item.floor >= 0 && item.floor <= 4 && item.name),
      "every registry item should carry a floor and a title",
    );
    const expectedDiamonds = (floor) =>
      registry.filter((item) => item.floor === floor && item.state === 1 && !item.hasModel).length;
    const floorDiamonds = [];
    for (const floor of [0, 1, 2, 3, 4]) {
      await setFloor(floor);
      await sleep(400);
      const stats = await cdp.eval("window.__quest.overlayStats()");
      const expected = expectedDiamonds(floor);
      assert(
        stats[0] === expected,
        `floor ${floor} drew ${stats[0]} item diamonds, expected ${expected}`,
      );
      floorDiamonds.push({ floor, drawn: stats[0], expected, claire: stats[4] });
    }
    await setFloor(0);
    await sleep(400);
    const floorOneStats = await cdp.eval("window.__quest.overlayStats()");
    assert(floorOneStats[4] === 1, "Claire's label should draw on her own floor");
    await setFloor(1);
    await sleep(300);
    const floorTwoStats = await cdp.eval("window.__quest.overlayStats()");
    assert(floorTwoStats[4] === 0, "Claire's label must not draw on 2F");
    const floorOnePixels = colouredPixels(shotPath("07-ortho-1f-clean"));
    assert(floorOnePixels > 0, "item diamonds must draw on their own floor");
    report.states.floorFilter = {
      floorOneStats,
      floorTwoStats,
      floorDiamonds,
      markerPixels: { floorOne: floorOnePixels },
    };
    await setFloor(0);

    const mapBeforeReset = await evalJson("window.__quest.camera()");
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 450,
      deltaX: 0,
      deltaY: -400,
    });
    await sleep(400);
    const mapChanged = await evalJson("window.__quest.camera()");
    assert(
      Math.abs(mapChanged[2] - mapBeforeReset[2]) > 0.01,
      "the wheel should change the ortho zoom",
    );
    await cdp.eval("document.querySelector('.rpd-icon-button').click()");
    await sleep(500);
    const mapArrowReset = await evalJson("window.__quest.camera()");
    await cdp.mouse("mousePressed", 600, 450, { button: "middle" });
    await cdp.mouse("mouseMoved", 680, 500, { button: "middle" });
    await cdp.mouse("mouseReleased", 680, 500, { button: "middle" });
    await sleep(300);
    const mapPanChanged = await evalJson("window.__quest.camera()");
    assert(
      Math.abs(mapPanChanged[0] - mapArrowReset[0]) > 0.01 ||
        Math.abs(mapPanChanged[1] - mapArrowReset[1]) > 0.01,
      "middle drag should pan the ortho map",
    );
    await cdp.key("KeyR", "r", 82);
    await sleep(500);
    const mapKeyReset = await evalJson("window.__quest.camera()");
    assert(
      closeEnough(mapArrowReset, mapKeyReset, 1e-4),
      "the arrow and R should fit the same ortho view",
    );
    const afterOrthoReset = await facts();
    assert(
      JSON.stringify(afterOrthoReset.player) === JSON.stringify(settledPlayer),
      "resetting the ortho view must not move Claire",
    );
    assert(afterOrthoReset.plan.length === 0, "resetting the view must not create waypoints");
    report.states.orthoReset = { mapChanged, mapArrowReset, mapKeyReset };

    for (const [floor, name] of [
      [0, "20-doors-1f"],
      [1, "21-doors-2f"],
      [2, "22-doors-3f"],
      [4, "23-doors-b1"],
    ]) {
      await setFloor(floor);
      await shot(name);
    }
    await setFloor(0);

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) <= 0.001", 20000);
    await sleep(250);
    await shot("12-route-3d");
    report.states.route3d = await facts();
    assert(report.states.route3d.view === "2D", "M should return to the perspective view");

    const resetPlayer = await evalJson("window.__quest.debug().player");
    await cdp.eval("window.__rpd.setOrbit(10, 5, 10, -1.2, 0.5, 40)");
    await sleep(500);
    await cdp.eval("document.querySelector('.rpd-icon-button').click()");
    await sleep(600);
    const poseArrow = await evalJson("window.__quest.cameraPose()");
    await cdp.eval("window.__rpd.setOrbit(10, 5, 10, -1.2, 0.5, 40)");
    await sleep(500);
    await cdp.key("KeyR", "r", 82);
    await sleep(600);
    const poseKey = await evalJson("window.__quest.cameraPose()");
    assert(
      closeEnough(poseArrow, poseKey, 1e-3),
      "the arrow and R should restore the same perspective camera",
    );
    const afterPerspectiveReset = await facts();
    assert(
      JSON.stringify(afterPerspectiveReset.player) === JSON.stringify(resetPlayer),
      "resetting the perspective view must not move Claire",
    );
    assert(
      afterPerspectiveReset.plan.length === 0,
      "resetting the perspective view must not create waypoints",
    );
    report.states.perspectiveReset = { poseArrow, poseKey };

    await cdp.eval("window.__rpd.setOrbit(0, 2.5, 2, -0.75, 0.36, 65)");
    await sleep(800);
    await shot("24-3d-clean");

    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await sleep(400);
    const claireClose = JSON.parse(
      await cdp.eval("JSON.stringify(window.__quest.debug().player)"),
    );
    await cdp.eval(
      `window.__rpd.setOrbit(${claireClose[0]}, ${claireClose[1] + 0.9}, ${claireClose[2]}, 2.4, 0.12, 4.5)`,
    );
    await sleep(700);
    await shot("13-claire-closeup");

    const items = await cdp.eval("window.__quest.items()");
    assert(items.length === 271, `expected 271 registry items, got ${items.length}`);
    const byName = (name) => items.findIndex((entry) => entry.name === name);

    // The 72 extracted models must upload, texture and draw in both views.
    await cdp.eval("window.__rpd.setOrbit(0, 0, 0, 0, 1.2, 14)");
    await sleep(900);
    const models3d = JSON.parse(await cdp.eval("JSON.stringify(window.__quest.itemModels())"));
    assert(models3d[5] === 1, "the ITM1 models did not upload");
    assert(models3d[2] >= 60, `only ${models3d[2]} albedo textures uploaded`);
    assert(models3d[3] > 0, "no item model drew in the perspective view");
    await shot("31-item-models-3d");

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) >= 0.999", 20000);
    await setFloor(0);
    await cdp.eval("window.__rpd.setOrbit(0, 0, 0, 0, 1.2, 20)");
    await sleep(900);
    const modelsOrtho = JSON.parse(await cdp.eval("JSON.stringify(window.__quest.itemModels())"));
    assert(modelsOrtho[3] > 0, "no item model drew in the plan view");
    await shot("32-item-models-ortho");
    report.states.itemModels = { perspective: models3d, ortho: modelsOrtho };

    // Key gating: the car trunk refuses until the car key sits in a slot.
    const trunk = byName("Car Trunk");
    const carKey = byName("Car Key");
    const carKeyBox = byName("Car Key Box");
    const jmb = byName("JMB Hp3");
    assert(trunk >= 0 && carKey >= 0 && carKeyBox >= 0 && jmb >= 0, "the car trunk chain is missing");
    assert((await cdp.eval("window.__quest.items()"))[jmb].hidden, "trunk contents should start hidden");
    assert((await cdp.eval("window.__quest.items()"))[carKey].hidden, "the car key should start inside its box");
    await setFloor(4);
    await cdp.eval(`window.__quest.standAt(${trunk})`);
    await sleep(400);
    await cdp.eval(`window.__quest.openPopupAt(${items[trunk].x}, ${items[trunk].z})`);
    await sleep(400);
    const lockedPopup = await cdp.eval("window.__quest.popup()");
    assert(lockedPopup.open && lockedPopup.item === trunk, "the car trunk did not open its popup");
    assert(lockedPopup.message === "Car Key", `expected Car Key as the gate, got ${lockedPopup.message}`);
    const lockedChoice = lockedPopup.choices.find((choice) => choice.label.includes("NEEDS KEY"));
    assert(lockedChoice && !lockedChoice.enabled, "the locked trunk should advertise its missing key");
    await shot("34-key-gating");
    assert(
      (await cdp.eval(`window.__quest.actItem(${trunk})`)) === -2,
      "a locked trunk opened without the key in the inventory",
    );
    assert(!(await cdp.eval("window.__quest.items()"))[trunk].taken, "the refused trunk must stay closed");

    await cdp.eval(`window.__quest.standAt(${carKeyBox})`);
    await sleep(300);
    assert((await cdp.eval(`window.__quest.actItem(${carKeyBox})`)) === 0, "the car key box could not be opened");
    await sleep(300);
    assert(!(await cdp.eval("window.__quest.items()"))[carKey].hidden, "opening the box did not reveal the car key");
    await cdp.eval(`window.__quest.standAt(${carKey})`);
    await sleep(300);
    assert((await cdp.eval(`window.__quest.actItem(${carKey})`)) === 0, "the car key could not be taken");
    await sleep(500);
    const keySlot = JSON.parse(
      await cdp.eval(`(() => {
        const slot = document.querySelector('.rpd-slot[data-name="Car Key"]');
        if (!slot) return null;
        return JSON.stringify({ title: slot.title, bg: getComputedStyle(slot).backgroundImage });
      })()`),
    );
    assert(keySlot && keySlot.title === "Car Key", "the inventory slot should name the car key");
    assert(keySlot.bg.includes("icons_atlas.png"), "the inventory slot should show the item icon");
    await shot("33-inventory-icon");

    assert(
      (await cdp.eval(`window.__quest.actItem(${trunk})`)) === 0,
      "the trunk did not open with the car key in the inventory",
    );
    const opened = await cdp.eval("window.__quest.items()");
    assert(opened[trunk].state === 3, `the trunk should be open, state ${opened[trunk].state}`);
    assert(!opened[jmb].hidden, "opening the trunk did not reveal its contents");
    await cdp.key("Escape", "Escape", 27);
    await cdp.eval(`window.__quest.standAt(${jmb})`);
    assert((await cdp.eval(`window.__quest.actItem(${jmb})`)) === 0, "the revealed contents could not be taken");
    await sleep(500);
    await shot("35-box-open");

    const lockedDoors = items
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.name.endsWith("Door") && (entry.action === 2 || entry.action === 4));
    assert(lockedDoors.length === 14, `expected 14 mapped locked doors, got ${lockedDoors.length}`);
    for (const { entry, index } of lockedDoors) {
      assert(
        (await cdp.eval(`window.__quest.itemBlocked(${index})`)) > 0,
        `${entry.name} does not block the nav graph`,
      );
    }

    const door = items.findIndex((entry) => entry.name === "Diamond Door" && entry.floor === 4);
    const diamondKey = items.findIndex((entry) => entry.name === "Diamond Key");
    assert(door >= 0 && diamondKey >= 0, "the diamond door chain is missing");
    assert((await cdp.eval(`window.__quest.actItem(${door})`)) === -2, "a locked door opened without its key");
    await cdp.eval(`window.__quest.standAt(${diamondKey})`);
    assert((await cdp.eval(`window.__quest.actItem(${diamondKey})`)) === 0, "the diamond key could not be taken");
    assert((await cdp.eval(`window.__quest.actItem(${door})`)) === 0, "the door did not open with its key");
    assert(
      (await cdp.eval("window.__quest.items()"))[door].state === 4,
      "the unlocked door should carry the unlocked state",
    );

    // A keyless safe still reveals its hidden contents when opened.
    const safe = items.findIndex((entry) => entry.name === "Portable Safe" && entry.floor === 1);
    const hiddenSpareBefore = (await cdp.eval("window.__quest.items()")).filter(
      (entry) => entry.name === "Spare Key" && entry.hidden,
    ).length;
    await setFloor(1);
    assert((await cdp.eval(`window.__quest.actItem(${safe})`)) === 0, "the portable safe could not open");
    const hiddenSpareAfter = (await cdp.eval("window.__quest.items()")).filter(
      (entry) => entry.name === "Spare Key" && entry.hidden,
    ).length;
    assert(hiddenSpareAfter < hiddenSpareBefore, "opening the safe did not reveal what it hides");

    // A locked Spade Door cuts the route to the room behind it until the key
    // turns the lock.
    const spadeDoor = items.findIndex((entry) => entry.name === "Spade Door" && entry.floor === 0);
    const spadeKey = items.findIndex((entry) => entry.name === "Spade Key");
    assert(spadeDoor >= 0 && spadeKey >= 0, "the spade door chain is missing");
    await setFloor(0);
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await cdp.eval("window.__quest.reset()");
    await sleep(400);
    assert((await cdp.eval(`window.__quest.itemBlocked(${spadeDoor})`)) > 0, "the spade door does not block the route");
    // Node 1347 is the west threshold cell of the 1F Spade Door.
    await cdp.eval("window.__quest.addTargetNode(1347)");
    await sleep(500);
    const lockedRoute = await cdp.eval("window.__quest.debug().routePoints");
    assert(lockedRoute === 0, `a route crossed the locked spade door with ${lockedRoute} points`);
    await shot("36-door-route-locked");
    await cdp.eval(`window.__quest.standAt(${spadeKey})`);
    assert((await cdp.eval(`window.__quest.actItem(${spadeKey})`)) === 0, "the spade key could not be taken");
    await cdp.eval(`window.__quest.standAt(${spadeDoor})`);
    assert((await cdp.eval(`window.__quest.actItem(${spadeDoor})`)) === 0, "the spade door did not unlock");
    assert((await cdp.eval(`window.__quest.itemBlocked(${spadeDoor})`)) === 0, "the unlocked spade door still blocks the route");
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await cdp.eval("window.__quest.reset()");
    await sleep(300);
    await cdp.eval("window.__quest.addTargetNode(1347)");
    await sleep(500);
    const unlockedRoute = await cdp.eval("window.__quest.debug().routePoints");
    assert(unlockedRoute > 1, "the route behind the unlocked spade door did not build");
    await shot("37-door-route-unlocked");
    report.states.doorRoute = { lockedRoute, unlockedRoute };

    // The 1F Chained Door threshold is node 1953. It must refuse a route and
    // stay locked until the Bolt Cutters are held.
    const chainedDoor = byName("Chained Door");
    const boltCutters = byName("Bolt Cutters");
    assert(chainedDoor >= 0 && boltCutters >= 0, "the chained door chain is missing");
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await cdp.eval("window.__quest.reset()");
    await sleep(300);
    assert((await cdp.eval(`window.__quest.itemBlocked(${chainedDoor})`)) > 0, "the chained door does not block the route");
    await cdp.eval("window.__quest.addTargetNode(1953)");
    await sleep(500);
    const chainedLockedRoute = await cdp.eval("window.__quest.debug().routePoints");
    assert(chainedLockedRoute === 0, `a route crossed the locked chained door with ${chainedLockedRoute} points`);
    await cdp.eval(`window.__quest.standAt(${boltCutters})`);
    assert((await cdp.eval(`window.__quest.actItem(${boltCutters})`)) === 0, "the bolt cutters could not be taken");
    await cdp.eval(`window.__quest.standAt(${chainedDoor})`);
    assert((await cdp.eval(`window.__quest.actItem(${chainedDoor})`)) === 0, "the chained door did not unlock");
    assert((await cdp.eval(`window.__quest.itemBlocked(${chainedDoor})`)) === 0, "the unlocked chained door still blocks the route");
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await cdp.eval("window.__quest.reset()");
    await sleep(300);
    await cdp.eval("window.__quest.addTargetNode(1953)");
    await sleep(500);
    const chainedUnlockedRoute = await cdp.eval("window.__quest.debug().routePoints");
    assert(chainedUnlockedRoute > 1, "the route through the unlocked chained door did not build");
    report.states.chainedDoorRoute = { locked: chainedLockedRoute, unlocked: chainedUnlockedRoute };

    // A film carried to the Darkroom Sink reveals its file; the Sewers film is
    // outside the mapped world, so the DEV grant stands in for carrying it.
    const film = items.findIndex((entry) => entry.name === 'Film: "Commemorative"');
    const photo = items.findIndex((entry) => entry.name === "Commemorative Photo");
    const sink = items.findIndex((entry) => entry.name === "Darkroom Sink");
    const hiding = items.findIndex((entry) => entry.name === "Hiding Place");
    assert(film >= 0 && photo >= 0 && sink >= 0 && hiding >= 0, "the film chain is missing");
    await setFloor(0);
    assert((await cdp.eval("window.__quest.items()"))[photo].hidden, "the file should wait for processing");
    assert((await cdp.eval("window.__quest.items()"))[hiding].hidden, "the Hiding Place file should start hidden");
    await cdp.eval(`window.__quest.standAt(${film})`);
    assert((await cdp.eval(`window.__quest.actItem(${film})`)) === 0, "the film could not be taken");
    assert((await cdp.eval("window.__quest.items()"))[photo].hidden, "carrying the film alone revealed the file");
    await cdp.eval(`window.__quest.standAt(${sink})`);
    assert((await cdp.eval(`window.__quest.actItem(${sink})`)) === 0, "the Darkroom Sink could not be used");
    await sleep(300);
    const processed = await cdp.eval("window.__quest.items()");
    assert(!processed[photo].hidden, "processing the film did not reveal its file");
    assert(!processed[hiding].hidden, "processing did not reveal the Hiding Place file");
    await cdp.eval(`window.__quest.standAt(${photo})`);
    await cdp.eval(`window.__quest.openPopupAt(${items[photo].x}, ${items[photo].z})`);
    await sleep(400);
    await shot("38-film-file");
    await cdp.key("Escape", "Escape", 27);
    assert((await cdp.eval(`window.__quest.actItem(${photo})`)) === 0, "the processed film file could not be read");
    await cdp.eval(`window.__quest.standAt(${hiding})`);
    assert((await cdp.eval(`window.__quest.actItem(${hiding})`)) === -2, "the Sewers film gate was ignored");
    assert((await cdp.eval("window.__quest.grantExternal(545948)")) === 0, "the DEV external film grant failed");
    assert((await cdp.eval(`window.__quest.actItem(${hiding})`)) === 0, "the Hiding Place file did not open after the film");
    report.states.film = { film, photo, sink, hiding };

    // Safe and dial-lock codes come from the MapGenie prose and are entered
    // through the DEV API, not a keypad UI.
    const dial = items.findIndex((entry) => entry.name === "Dial Lock" && entry.floor === 1);
    const codedSafe = items.findIndex((entry) => entry.name === "Safe" && entry.floor === 0);
    assert(dial >= 0 && codedSafe >= 0, "the coded locks are missing");
    await setFloor(1);
    assert((await cdp.eval(`window.__quest.itemHasCode(${dial})`)) === true, "the dial lock lost its code");
    assert((await cdp.eval(`window.__quest.actItem(${dial})`)) === -5, "the dial lock opened without a code");
    assert((await cdp.eval(`window.__quest.enterCode(${dial}, "C-A-P")`)) === 0, "the dial lock code C-A-P failed");
    await setFloor(0);
    assert((await cdp.eval(`window.__quest.itemHasCode(${codedSafe})`)) === true, "the safe lost its code");
    assert((await cdp.eval(`window.__quest.enterCode(${codedSafe}, "L9 R15 L6")`)) === -6, "a wrong safe code was accepted");
    const hipPouchBefore = (await cdp.eval("window.__quest.items()")).filter(
      (entry) => entry.name === "Hip Pouch" && entry.hidden,
    ).length;
    await cdp.eval(`window.__quest.standAt(${codedSafe})`);
    await cdp.eval(`window.__quest.openPopupAt(${items[codedSafe].x}, ${items[codedSafe].z})`);
    await sleep(400);
    const codePopup = await cdp.eval("window.__quest.popup()");
    assert(codePopup.message === "CODE REQUIRED", `expected Code required, got ${codePopup.message}`);
    await shot("39-code-lock");
    await cdp.key("Escape", "Escape", 27);
    assert((await cdp.eval(`window.__quest.enterCode(${codedSafe}, "L9 R15 L7")`)) === 0, "the safe code L9 R15 L7 failed");
    const hipPouchAfter = (await cdp.eval("window.__quest.items()")).filter(
      (entry) => entry.name === "Hip Pouch" && entry.hidden,
    ).length;
    assert(hipPouchAfter < hipPouchBefore, "the coded safe did not reveal its contents");
    report.states.codes = { dial, codedSafe };

    // A distant item offers Walk next and still routes there.
    await setFloor(0);
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await sleep(500);
    const farIndex = items.findIndex(
      (entry) => entry.name === "Typewriter" && entry.floor === 0 && entry.state === 1,
    );
    assert(farIndex >= 0, "expected the 1F typewriter");
    const farItem = { ...items[farIndex], index: farIndex };
    assert(
      Math.hypot(farItem.x - 0, farItem.z - 7.5) > 2.5,
      "the walk-next check needs an item out of reach",
    );
    const farScreen = JSON.parse(
      await cdp.eval(`JSON.stringify(window.__quest.project(${farItem.x}, ${farItem.y}, ${farItem.z}))`),
    );
    await cdp.mouse("mousePressed", farScreen.x, farScreen.y);
    await cdp.mouse("mouseReleased", farScreen.x, farScreen.y);
    await sleep(700);
    const farPopup = await cdp.eval("window.__quest.popup()");
    assert(farPopup.open, "clicking a distant item did not open its popup");
    assert(
      !farPopup.choices.some((choice) => choice.enabled && choice.label.includes("TAKE")),
      "a distant item should not offer Take",
    );
    const walkChoice = farPopup.choices.find(
      (choice) => choice.enabled && choice.label.includes("WALK NEXT"),
    );
    assert(walkChoice, "a distant item should offer Walk next to it");
    await shot("14-item-popup");
    await cdp.mouse("mousePressed", (walkChoice.x0 + walkChoice.x1) / 2, (walkChoice.y0 + walkChoice.y1) / 2);
    await cdp.mouse("mouseReleased", (walkChoice.x0 + walkChoice.x1) / 2, (walkChoice.y0 + walkChoice.y1) / 2);
    await sleep(600);
    assert((await cdp.eval("window.__quest.debug().plan.length")) > 0, "Walk next did not add a waypoint");
    assert((await cdp.eval("window.__quest.debug().routePoints")) > 1, "Walk next did not build a route");
    await cdp.eval("window.__quest.reset()");
    await sleep(400);

    // Fill the eight slots, then prove the ninth take is refused.
    for (let guard = 0; guard < 40; guard += 1) {
      const filled = (await cdp.eval("window.__quest.inventory()")).filter(Boolean).length;
      if (filled >= 8) break;
      const list = await cdp.eval("window.__quest.items()");
      const next = list.findIndex(
        (entry) => entry.floor === 0 && entry.state === 1 && entry.action === 1 && !entry.hidden,
      );
      assert(next >= 0, "ran out of takeable items before the inventory filled");
      await cdp.eval(`window.__quest.standAt(${next})`);
      const result = await cdp.eval(`window.__quest.actItem(${next})`);
      assert(result === 0, `filling slot ${filled + 1} failed with ${result}`);
      await sleep(300);
      if (filled === 4) await shot("15-inventory-3");
    }
    await sleep(500);
    await shot("16-inventory-full");
    const fullSlots = await cdp.eval("window.__quest.inventory()");
    assert(fullSlots.every(Boolean), "the inventory should have eight filled slots");

    const ninth = (await cdp.eval("window.__quest.items()")).findIndex(
      (entry) => entry.floor === 0 && entry.state === 1 && entry.action === 1 && !entry.hidden,
    );
    assert(ninth >= 0, "expected a ninth takeable item");
    const ninthItem = (await cdp.eval("window.__quest.items()"))[ninth];
    await cdp.eval(`window.__quest.standAt(${ninth})`);
    await sleep(300);
    await cdp.eval(`window.__quest.openPopupAt(${ninthItem.x}, ${ninthItem.z})`);
    await sleep(400);
    const refused = await cdp.eval("window.__quest.popup()");
    assert(refused.open, "the ninth item did not open a popup");
    assert(refused.message === "INVENTORY FULL", `expected Inventory full, got ${refused.message}`);
    const refusedChoice = refused.choices.find((choice) => choice.label.includes("TAKE"));
    assert(refusedChoice && !refusedChoice.enabled, "the ninth Take should be disabled");
    await shot("17-inventory-refused");
    await cdp.mouse(
      "mousePressed",
      (refusedChoice.x0 + refusedChoice.x1) / 2,
      (refusedChoice.y0 + refusedChoice.y1) / 2,
    );
    await cdp.mouse(
      "mouseReleased",
      (refusedChoice.x0 + refusedChoice.x1) / 2,
      (refusedChoice.y0 + refusedChoice.y1) / 2,
    );
    await sleep(400);
    assert(
      !(await cdp.eval("window.__quest.items()"))[ninth].taken,
      "the refused ninth item must stay on the floor",
    );
    const afterRefusal = await cdp.eval("window.__quest.inventory()");
    assert(afterRefusal.filter(Boolean).length === 8, "a refused take must not change the inventory");

    const orthoPanStart = await evalJson("window.__quest.cameraModel()");
    await cdp.mouse("mousePressed", 600, 450, { button: "middle" });
    await cdp.mouse("mouseMoved", 680, 500, { button: "middle" });
    await cdp.mouse("mouseReleased", 680, 500, { button: "middle" });
    await sleep(400);
    const orthoPanEnd = await evalJson("window.__quest.cameraModel()");
    assert(
      Math.hypot(orthoPanEnd[0] - orthoPanStart[0], orthoPanEnd[2] - orthoPanStart[2]) > 0.01,
      "the ortho pan must move the shared target",
    );
    assert(Math.abs(orthoPanEnd[3] - orthoPanStart[3]) < 1e-4, "the ortho pan must keep the shared frame");
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 450,
      deltaX: 0,
      deltaY: -400,
    });
    await sleep(400);
    const orthoZoomEnd = await evalJson("window.__quest.cameraModel()");
    assert(
      Math.abs(orthoZoomEnd[3] - orthoPanEnd[3]) > 0.01,
      "the ortho wheel must change the shared frame",
    );
    assert(
      Math.hypot(orthoZoomEnd[0] - orthoPanEnd[0], orthoZoomEnd[2] - orthoPanEnd[2]) < 1e-4,
      "the ortho wheel must keep the shared target",
    );
    report.states.orthoPan = { start: orthoPanStart, pan: orthoPanEnd, zoom: orthoZoomEnd };

    const iconOrder = await evalJson(
      "Array.from(document.querySelectorAll('.rpd-floors .rpd-icon-button')).map((b) => b.getAttribute('aria-label'))",
    );
    assert(
      iconOrder.length === 2 &&
        iconOrder[0] === "Reset view" &&
        iconOrder[1] === "Recenter on Claire",
      "the recenter button must sit immediately right of the reset arrow",
    );

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) <= 0.001", 20000);
    await setFloor(0);
    await cdp.eval("window.__rpd.setOrbit(0, 2.5, 2, -0.75, 0.36, 65)");
    await sleep(800);
    const glassFloors = await evalJson("window.__quest.debugFloors()");
    assert(
      glassFloors[0] === 0 && glassFloors[1] === 4,
      `perspective should draw floor 0 in paper and four glass floors, got ${JSON.stringify(glassFloors)}`,
    );
    const perspectiveModel = await evalJson("window.__quest.cameraModel()");
    const perspectiveCenter = await evalJson(
      `window.__quest.project(${perspectiveModel[0]}, ${perspectiveModel[1]}, ${perspectiveModel[2]})`,
    );
    assert(
      Math.hypot(perspectiveCenter.x - 510, perspectiveCenter.y - 450) < 1.5,
      "the shared target must project to the map-area centre in perspective",
    );
    await shot("25-3d-paper-glass");

    await cdp.eval("window.__rpd.setOrbit(5, 3, 7, -0.9, 0.4, 50)");
    await sleep(400);
    const tripStart = await evalJson("window.__quest.cameraModel()");
    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) >= 0.999", 20000);
    await sleep(300);
    const tripOrtho = await evalJson("window.__quest.cameraModel()");
    assert(
      closeEnough(tripStart.slice(0, 6), tripOrtho.slice(0, 6), 1e-4),
      "switching to ortho must hold the shared target, frame and saved orientation",
    );
    assert(
      Math.abs(tripOrtho[6] - Math.PI / 2) < 0.02,
      "the orthographic orientation must be top-down",
    );
    const orthoCenter = await evalJson(
      `window.__quest.project(${tripOrtho[0]}, ${tripOrtho[1]}, ${tripOrtho[2]})`,
    );
    assert(
      Math.hypot(orthoCenter.x - 510, orthoCenter.y - 450) < 1.5,
      "the shared target must project to the map-area centre in ortho",
    );
    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) <= 0.001", 20000);
    await sleep(300);
    const tripBack = await evalJson("window.__quest.cameraModel()");
    assert(
      closeEnough(tripStart.slice(0, 6), tripBack.slice(0, 6), 1e-4),
      "a 2D/3D round trip must restore the shared target, frame and saved orientation",
    );
    report.states.cameraRoundTrip = { start: tripStart, ortho: tripOrtho, back: tripBack };

    const perspPanStart = await evalJson("window.__quest.cameraModel()");
    await cdp.mouse("mousePressed", 600, 450, { button: "middle" });
    await cdp.mouse("mouseMoved", 680, 500, { button: "middle" });
    await cdp.mouse("mouseReleased", 680, 500, { button: "middle" });
    await sleep(400);
    const perspPanEnd = await evalJson("window.__quest.cameraModel()");
    assert(
      Math.hypot(perspPanEnd[0] - perspPanStart[0], perspPanEnd[2] - perspPanStart[2]) > 0.01,
      "the perspective pan must move the shared target",
    );
    assert(
      Math.abs(perspPanEnd[3] - perspPanStart[3]) < 1e-4,
      "the perspective pan must keep the shared frame",
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 450,
      deltaX: 0,
      deltaY: -400,
    });
    await sleep(400);
    const perspZoomEnd = await evalJson("window.__quest.cameraModel()");
    assert(
      Math.abs(perspZoomEnd[3] - perspPanEnd[3]) > 0.01,
      "the perspective wheel must change the shared frame",
    );
    assert(
      Math.hypot(perspZoomEnd[0] - perspPanEnd[0], perspZoomEnd[2] - perspPanEnd[2]) < 1e-4,
      "the perspective wheel must keep the shared target",
    );
    report.states.perspectivePan = { start: perspPanStart, pan: perspPanEnd, zoom: perspZoomEnd };

    await cdp.eval("window.__rpd.setOrbit(0, 2.5, 2, -0.75, 0.36, 65)");
    await sleep(400);
    const recenterPlayer = await evalJson("window.__quest.debug().player");
    const recenterFrame = (await evalJson("window.__quest.cameraModel()"))[3];
    await shot("28-recenter-3d-before");
    await cdp.eval("document.querySelector('.rpd-recenter-button').click()");
    await cdp.waitFor(
      `(() => { const m = window.__quest.cameraModel(); return Math.hypot(m[0] - ${recenterPlayer[0]}, m[1] - ${recenterPlayer[1] + 1.7}, m[2] - ${recenterPlayer[2]}) < 0.08; })()`,
      20000,
    );
    await sleep(300);
    const recentered3d = await evalJson("window.__quest.cameraModel()");
    assert(
      Math.abs(recentered3d[3] - recenterFrame) < 0.01,
      "recentering must keep the shared frame",
    );
    assert(
      JSON.stringify(await evalJson("window.__quest.debug().player")) ===
        JSON.stringify(recenterPlayer),
      "recentering must not move Claire",
    );
    await shot("28-recenter-3d-after");

    await cdp.eval("window.__rpd.setOrbit(0, 2.5, 2, -0.75, 0.36, 65)");
    await sleep(400);
    await cdp.key("KeyC", "c", 67);
    await cdp.waitFor(
      `(() => { const m = window.__quest.cameraModel(); return Math.hypot(m[0] - ${recenterPlayer[0]}, m[1] - ${recenterPlayer[1] + 1.7}, m[2] - ${recenterPlayer[2]}) < 0.08; })()`,
      20000,
    );

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) >= 0.999", 20000);
    await setFloor(1);
    const floorCell = JSON.parse(await cdp.eval("JSON.stringify(window.__quest.walkableCell())"));
    assert(floorCell, "could not find a floor 1 cell for the recenter follow");
    await setFloor(0);
    await cdp.eval(
      `window.__quest.setPlayer(${floorCell.world[0]}, ${floorCell.world[1]}, ${floorCell.world[2]})`,
    );
    await sleep(500);
    const orthoPlayer = await evalJson("window.__quest.debug().player");
    const orthoPlayerFloor = await evalJson("window.__quest.debug().playerFloor");
    assert(orthoPlayerFloor === 1, "the recenter test needs Claire on floor 1");
    const orthoFrameBefore = (await evalJson("window.__quest.cameraModel()"))[3];
    await shot("29-recenter-ortho-before");
    await cdp.eval("document.querySelector('.rpd-recenter-button').click()");
    await cdp.waitFor(
      `(() => { const m = window.__quest.cameraModel(); return Math.hypot(m[0] - ${orthoPlayer[0]}, m[2] - ${orthoPlayer[2]}) < 0.08; })()`,
      20000,
    );
    await cdp.waitFor("window.__quest.debug().activeFloor === 1", 10000);
    await sleep(300);
    const recenteredOrtho = await evalJson("window.__quest.cameraModel()");
    assert(
      Math.abs(recenteredOrtho[3] - orthoFrameBefore) < 0.01,
      "recentering in ortho must keep the shared frame",
    );
    assert(
      JSON.stringify(await evalJson("window.__quest.debug().player")) ===
        JSON.stringify(orthoPlayer),
      "ortho recentering must not move Claire",
    );
    const orthoRecenterCenter = await evalJson(
      `window.__quest.project(${recenteredOrtho[0]}, ${recenteredOrtho[1]}, ${recenteredOrtho[2]})`,
    );
    assert(
      Math.hypot(orthoRecenterCenter.x - 510, orthoRecenterCenter.y - 450) < 1.5,
      "recentering in ortho must put the target at the map-area centre",
    );
    await shot("29-recenter-ortho-after");
    report.states.recenter = {
      perspective: recentered3d,
      ortho: recenteredOrtho,
      floorBefore: 0,
      floorAfter: 1,
    };

    await cdp.eval("document.querySelector('.rpd-icon-button').click()");
    await sleep(600);
    const resetModel = await evalJson("window.__quest.cameraModel()");
    const resetCamera = await evalJson("window.__quest.camera()");
    const resetCenter = await evalJson(
      `window.__quest.project(${resetModel[0]}, ${resetModel[1]}, ${resetModel[2]})`,
    );
    assert(
      Math.abs(resetModel[0] - resetCamera[0]) < 1e-4 &&
        Math.abs(resetModel[2] - resetCamera[1]) < 1e-4,
      "resetting ortho must fit the active floor around the shared target",
    );
    assert(
      Math.abs(resetModel[3] - 900 / resetCamera[2]) < 0.01,
      "the ortho frame and the debug map scale must agree after reset",
    );
    assert(
      Math.hypot(resetCenter.x - 510, resetCenter.y - 450) < 1.5,
      "the reset ortho target must project to the map-area centre",
    );
    assert(
      JSON.stringify(await evalJson("window.__quest.debug().player")) ===
        JSON.stringify(orthoPlayer),
      "resetting the view must not move Claire",
    );
    await shot("30-reset-view");
    report.states.resetView = { model: resetModel, camera: resetCamera };

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) <= 0.001", 20000);
    await cdp.eval("window.__quest.setFloor(1)");
    await sleep(400);
    const glassMoveStart = await evalJson("window.__quest.debug().player");
    const floorOneRooms = rooms
      .filter((room) => room.floor === 1)
      .sort(
        (a, b) =>
          Math.hypot(b.x - glassMoveStart[0], b.z - glassMoveStart[2]) -
          Math.hypot(a.x - glassMoveStart[0], a.z - glassMoveStart[2]),
      );
    assert(floorOneRooms.length > 0, "expected rooms on floor 1");
    let movingRouteReady = false;
    for (const room of floorOneRooms) {
      await cdp.eval(`window.__rpd.planAddTarget(${room.x}, ${room.y}, ${room.z})`);
      await sleep(400);
      if ((await cdp.eval("window.__rpd.planRouteCount()")) > 1) {
        movingRouteReady = true;
        break;
      }
    }
    assert(movingRouteReady, "the moving glass test needs a route on floor 1");
    await cdp.eval("window.__rpd.planStartMove()");
    await cdp.waitFor("window.__quest.debug().moving === true", 10000);
    await sleep(900);
    const movingFloors = await evalJson("window.__quest.debugFloors()");
    assert(
      movingFloors[0] === 1 && movingFloors[1] === 4,
      `a moving Claire should put her floor in paper and four floors in glass, got ${JSON.stringify(movingFloors)}`,
    );
    await shot("26-moving-glass");
    report.states.movingGlass = { floors: movingFloors, player: glassMoveStart };
    await cdp.key("Escape", "Escape", 27);
    await sleep(400);

    report.states.items = items;
    report.states.inventory = await cdp.eval("window.__quest.inventory()");
    report.shots = shots;
    report.errors = cdp.errors;
    const reportPath = join(update ? baselineDir : currentDir, "report.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    if (report.errors.length > 0) {
      throw new Error(`Page errors:\n${report.errors.join("\n")}`);
    }

    if (update) {
      console.log(`Baseline captured in ${baselineDir}`);
      return;
    }

    const failures = [];
    for (const name of shots) {
      const current = join(currentDir, `${name}.png`);
      const baseline = join(baselineDir, `${name}.png`);
      if (!existsSync(baseline)) {
        failures.push(`${name}: missing baseline`);
        continue;
      }
      const result = spawnSync("compare", ["-metric", "AE", current, baseline, "null:"], {
        encoding: "utf8",
      });
      const match = `${result.stderr ?? ""} ${result.stdout ?? ""}`.match(/(\d+)/);
      if (!match) {
        failures.push(`${name}: could not compare (${result.stderr ?? result.stdout})`);
        continue;
      }
      const changed = Number(match[1]);
      const ratio = changed / (1400 * 900);
      if (ratio > imageThreshold) {
        failures.push(`${name}: ${changed} pixels changed (${(ratio * 100).toFixed(2)}%)`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Contract failures:\n${failures.join("\n")}`);
    }
    console.log(`Contract passed. ${shots.length} screenshots matched.`);
  } finally {
    cdp?.ws.close();
    chrome.child.kill("SIGTERM");
    server.kill("SIGTERM");
    if (!keep) {
      try {
        rmSync(chrome.userDataDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
