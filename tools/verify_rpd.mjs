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

const renderWallBoxes = (() => {
  const plan = JSON.parse(readFileSync(join(root, "public/rpd/plan.json"), "utf8"));
  const boxes = [];
  for (const floor of plan.floors) {
    for (const box of floor.boxes) {
      if (box.faces === "top") continue;
      boxes.push(box);
    }
  }
  return boxes;
})();

// The paper walls are the rendered floor plan. Sample the route against the
// same boxes plan_scene.py turns into rpd.bin and report any body penetration.
function renderWallClearance(route, height = 1.7) {
  const points = route.length / 3;
  let samples = 0;
  let penetrating = 0;
  let minClearance = Infinity;
  let minAt = null;
  for (let i = 0; i + 1 < points; i += 1) {
    const ax = route[i * 3], ay = route[i * 3 + 1], az = route[i * 3 + 2];
    const bx = route[i * 3 + 3], by = route[i * 3 + 4], bz = route[i * 3 + 5];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / 0.05));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      samples += 1;
      for (const box of renderWallBoxes) {
        if (!(box.y1 > y + 1e-4 && box.y0 < y + height)) continue;
        const dx = Math.max(box.x0 - x, 0, x - box.x1);
        const dz = Math.max(box.z0 - z, 0, z - box.z1);
        const distance = Math.hypot(dx, dz);
        if (distance <= 0) penetrating += 1;
        if (distance < minClearance) {
          minClearance = distance;
          minAt = [x, y, z];
        }
      }
    }
  }
  return { samples, penetrating, minClearance: Number.isFinite(minClearance) ? minClearance : 0, minAt };
}

function changedPixels(a, b, area) {
  const first = readPng(a);
  const second = readPng(b);
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error(`${a} and ${b} have different sizes`);
  }
  let count = 0;
  for (let y = area.y0; y < Math.min(first.height, area.y1); y += 1) {
    for (let x = area.x0; x < Math.min(first.width, area.x1); x += 1) {
      const at = (y * first.width + x) * first.channels;
      if (
        Math.abs(first.pixels[at] - second.pixels[at]) > 8 ||
        Math.abs(first.pixels[at + 1] - second.pixels[at + 1]) > 8 ||
        Math.abs(first.pixels[at + 2] - second.pixels[at + 2]) > 8
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function colouredPixelsInBox(path, area) {
  const { width, height, channels, pixels } = readPng(path);
  let count = 0;
  for (let y = Math.max(0, area.y0); y < Math.min(height, area.y1); y += 1) {
    for (let x = Math.max(0, area.x0); x < Math.min(width, area.x1); x += 1) {
      const at = (y * width + x) * channels;
      if (Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) - Math.min(pixels[at], pixels[at + 1], pixels[at + 2]) > 60) {
        count += 1;
      }
    }
  }
  return count;
}

function colourBounds(path, centre, half, matches) {
  const { width, height, channels, pixels } = readPng(path);
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = Math.max(0, Math.round(centre.y) - half); y < Math.min(height, Math.round(centre.y) + half); y += 1) {
    for (let x = Math.max(0, Math.round(centre.x) - half); x < Math.min(width, Math.round(centre.x) + half); x += 1) {
      const at = (y * width + x) * channels;
      if (!matches(pixels[at], pixels[at + 1], pixels[at + 2])) continue;
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    count,
    width: count > 0 ? maxX - minX + 1 : 0,
    height: count > 0 ? maxY - minY + 1 : 0,
  };
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
    const rightClick = async (x, y) => {
      await cdp.mouse("mouseMoved", x, y);
      await sleep(120);
      await cdp.mouse("mousePressed", x, y, { button: "right", buttons: 2 });
      await cdp.mouse("mouseReleased", x, y, { button: "right", buttons: 0 });
      await sleep(250);
    };

    const report = { shots: [], errors: [], states: {} };

    await cdp.eval("window.__rpd.setFpsVisible(false)");
    await shot("01-3d");
    await rightClick(700, 450);
    assert(
      !(await cdp.eval("Boolean(document.querySelector('.rpd-menu'))")),
      "the React context menu must be gone",
    );
    const menu3d = await cdp.eval("window.__quest.popup()");
    assert(!menu3d.open, "right click in 3D must not open the waypoint menu");
    await shot("01b-menu-3d-disabled");
    report.states.menu3d = { open: menu3d.open };
    report.states.initial = await facts();
    assert(report.states.initial.floors.length === 5, "expected five floor buttons");
    assert(report.states.initial.slots === 8, "expected eight inventory slots");
    assert(!report.states.initial.routeDock, "the route dock should be gone");

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 1) >= 0.999", 20000);
    await sleep(250);
    await shot("02-ortho-1f");
    const legend = await evalJson(`(() => {
      const root = document.querySelector('.rpd-legend');
      return {
        text: root?.innerText ?? '',
        dots: [...root.querySelectorAll('.rpd-dot')].map((dot) => getComputedStyle(dot).backgroundColor),
      };
    })()`);
    for (const label of ["Keys", "Locks", "Files", "Weapons", "Ammo", "Herbs", "Containers", "Puzzle"]) {
      assert(legend.text.includes(label), `the legend is missing the ${label} key`);
    }
    assert(!legend.text.includes("Claire"), "the legend must not list Claire");
    for (const colour of [
      "rgb(158, 79, 242)",
      "rgb(242, 140, 51)",
      "rgb(230, 230, 214)",
      "rgb(230, 71, 71)",
      "rgb(242, 209, 77)",
      "rgb(89, 217, 102)",
      "rgb(153, 107, 64)",
      "rgb(77, 217, 217)",
    ]) {
      assert(legend.dots.includes(colour), `the legend is missing the ${colour} item colour`);
    }
    report.states.legend = legend;
    await shot("02b-legend");
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

    const rawDiamond = await evalJson(`(() => {
      const list = window.__quest.items().filter((item) => item.floor === 0 && item.state === 1);
      const cubes = list.map((item) => window.__quest.project(item.cubeX, item.cubeY, item.cubeZ));
      const player = window.__quest.project(...window.__quest.debug().player);
      let best = null;
      for (const item of list) {
        const raw = window.__quest.project(item.x, item.y, item.z);
        const cube = window.__quest.project(item.cubeX, item.cubeY, item.cubeZ);
        if (Math.hypot(raw.x - cube.x, raw.y - cube.y) < 16) continue;
        let clearance = Math.hypot(raw.x - player.x, raw.y - player.y);
        for (const other of cubes) {
          clearance = Math.min(clearance, Math.hypot(raw.x - other.x, raw.y - other.y));
        }
        if (!best || clearance > best.clearance) best = { name: item.name, raw, clearance };
      }
      return best;
    })()`);
    assert(
      rawDiamond && rawDiamond.clearance > 10,
      `no item is clear of its raw position for the diamond check: ${JSON.stringify(rawDiamond)}`,
    );
    const rawPixels = colouredPixelsInBox(shotPath("07-ortho-1f-clean"), {
      x0: Math.round(rawDiamond.raw.x) - 5,
      y0: Math.round(rawDiamond.raw.y) - 5,
      x1: Math.round(rawDiamond.raw.x) + 5,
      y1: Math.round(rawDiamond.raw.y) + 5,
    });
    assert(rawPixels === 0, `${rawDiamond.name} still draws a diamond at its raw position`);
    report.states.noDiamond = { item: rawDiamond.name, pixels: rawPixels };

    const cell = JSON.parse(await cdp.eval("JSON.stringify(window.__quest.walkableCell())"));
    assert(cell && cell.screen, "the DEV API did not return a walkable cell");
    const cellX = cell.screen.x;
    const cellY = cell.screen.y;
    await cdp.mouse("mouseMoved", cellX, cellY);
    await sleep(400);
    await shot("08-hover");

    await cdp.mouse("mousePressed", cellX, cellY);
    await cdp.mouse("mouseReleased", cellX, cellY);
    await sleep(500);
    assert(
      !(await cdp.eval("window.__quest.popup().open")),
      "a walkable cell must not open the old waypoint popup",
    );

    const menuState = () =>
      evalJson(`(() => {
        const popup = window.__quest.popup();
        if (!popup.open || !popup.menu) return null;
        const enabled = (label) => {
          const choice = popup.choices.find((entry) => entry.label === label);
          return choice ? choice.enabled : null;
        };
        return {
          menu: popup.menu,
          node: popup.node,
          anchor: popup.anchor,
          labels: popup.choices.map((entry) => entry.label),
          add: enabled("Add waypoint"),
          remove: enabled("Remove waypoint"),
          run: enabled("Run route"),
          clear: enabled("Clear all"),
        };
      })()`);
    const menuCommand = async (label) => {
      const choice = await evalJson(
        `window.__quest.popup().choices.find((entry) => entry.label === ${JSON.stringify(label)}) ?? null`,
      );
      assert(choice && choice.enabled, `${label} was not enabled`);
      const x = (choice.x0 + choice.x1) / 2;
      const y = (choice.y0 + choice.y1) / 2;
      await cdp.mouse("mousePressed", x, y);
      await cdp.mouse("mouseReleased", x, y);
      await sleep(500);
    };


    await rightClick(cellX, cellY);
    const freshMenu = await menuState();
    assert(freshMenu, "right click on the plan did not open the native menu");
    assert(
      freshMenu.add && !freshMenu.remove && !freshMenu.run && !freshMenu.clear,
      `fresh menu states are wrong: ${JSON.stringify(freshMenu)}`,
    );
    assert(
      Math.abs(freshMenu.anchor[0] - cellX) < 8 && Math.abs(freshMenu.anchor[1] - cellY) < 8,
      `the native menu did not anchor at the cursor: ${JSON.stringify({ freshMenu, cellX, cellY })}`,
    );
    assert(
      !(await cdp.eval("Boolean(document.querySelector('.rpd-menu'))")),
      "the menu must be drawn by sokol, not React",
    );
    const canvasContextMenu = await cdp.eval(`(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.querySelector('#canvas').dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert(canvasContextMenu, "the canvas must suppress the native context menu");
    const bodyContextMenu = await cdp.eval(`(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert(!bodyContextMenu, "the native context menu must stay enabled outside the canvas");
    await shot("09-menu");

    await menuCommand("Add waypoint");
    assert(
      !(await cdp.eval("window.__quest.popup().open")),
      "the menu should close after an action",
    );
    assert(
      (await cdp.eval("window.__quest.debug().plan.length")) === 1,
      "Add waypoint did not add a waypoint",
    );
    assert(
      (await cdp.eval("window.__quest.debug().waypoints[0]")) === cell.node,
      "Add waypoint did not use the right-clicked cell",
    );

    await rightClick(cellX, cellY);
    const waypointMenu = await menuState();
    assert(
      waypointMenu && !waypointMenu.add && waypointMenu.remove && waypointMenu.clear,
      `waypoint menu states are wrong: ${JSON.stringify(waypointMenu)}`,
    );
    await shot("09-menu-waypoint");

    const planBeforeEscape = await cdp.eval("window.__quest.debug().plan.length");
    await cdp.key("Escape", "Escape", 27);
    await sleep(250);
    assert(!(await cdp.eval("window.__quest.popup().open")), "Escape did not close the menu");
    assert(
      (await cdp.eval("window.__quest.debug().plan.length")) === planBeforeEscape,
      "Escape with the menu open must not clear the plan",
    );

    const cellB = await evalJson(`(() => {
      const a = window.__quest.walkableCell();
      for (const [dx, dz] of [[8, 0], [0, 8], [-8, 0], [0, -8], [10, 10], [-10, -10], [14, 0], [0, 14]]) {
        const b = window.__quest.nearestCell(a.world[0] + dx, a.world[2] + dz);
        if (b && b.node !== a.node) return b;
      }
      return null;
    })()`);
    assert(cellB, "could not find a second walkable cell");
    await rightClick(cellB.screen.x, cellB.screen.y);
    const otherMenu = await menuState();
    assert(
      otherMenu && otherMenu.add && !otherMenu.remove,
      `Remove must only show on a waypoint cell: ${JSON.stringify(otherMenu)}`,
    );
    await menuCommand("Add waypoint");
    assert(
      (await cdp.eval("window.__quest.debug().waypoints.length")) === 2,
      "the second waypoint was not added",
    );

    await rightClick(cellX, cellY);
    await menuCommand("Remove waypoint");
    const afterRemove = await evalJson("window.__quest.debug().waypoints");
    assert(
      afterRemove.length === 1 && afterRemove[0] === cellB.node,
      `Remove waypoint did not remove the right-clicked cell: ${JSON.stringify(afterRemove)}`,
    );

    await cdp.eval(`window.__quest.addTargetNode(${cell.node})`);
    await sleep(400);
    await rightClick(cellB.screen.x, cellB.screen.y);
    const clearMenu = await menuState();
    assert(
      clearMenu && clearMenu.clear && clearMenu.remove,
      `Clear all should be offered with waypoints: ${JSON.stringify(clearMenu)}`,
    );
    await shot("09-menu-clear");
    await menuCommand("Clear all");
    assert(
      (await cdp.eval("window.__quest.debug().plan.length")) === 0 &&
        (await cdp.eval("window.__quest.debug().routePoints")) === 0,
      "Clear all did not clear the waypoints and route",
    );

    await cdp.eval(`window.__quest.addTargetNode(${cell.node})`);
    await cdp.eval(`window.__quest.addTargetNode(${cell.node})`);
    await sleep(400);
    const unique = await evalJson("window.__quest.debug().waypoints");
    assert(
      unique.length === 1 && unique[0] === cell.node,
      `the C add path must refuse a duplicate cell: ${JSON.stringify(unique)}`,
    );

    let emptyPoint = null;
    for (const point of [[40, 800], [60, 760], [1000, 840], [1040, 40], [520, 170]]) {
      await cdp.mouse("mouseMoved", point[0], point[1]);
      await sleep(150);
      if ((await cdp.eval("window.__quest.hover()")) === -1) {
        emptyPoint = point;
        break;
      }
    }
    assert(emptyPoint, "could not find a screen point without a hovered nav cell");
    await cdp.eval("window.__quest.reset()");
    await rightClick(emptyPoint[0], emptyPoint[1]);
    const blockedMenu = await menuState();
    assert(
      blockedMenu && !blockedMenu.add && !blockedMenu.remove,
      "Add and Remove should be disabled without a hovered nav cell",
    );
    await cdp.mouse("mousePressed", 240, 760);
    await cdp.mouse("mouseReleased", 240, 760);
    await sleep(300);
    assert(
      !(await cdp.eval("window.__quest.popup().open")),
      "an outside click did not close the menu",
    );

    await cdp.eval("window.__quest.reset()");
    await cdp.eval("window.__quest.addTarget(0, 4)");
    await sleep(500);
    await shot("09-waypoint");
    await cdp.eval("window.__quest.addTarget(22, -10)");
    await sleep(500);
    await shot("10-plan");
    report.states.plan = await facts();
    console.log("route check", JSON.stringify(report.states.plan.check));
    const renderedRoute = JSON.parse(
      await cdp.eval("JSON.stringify(Array.from(window.__rpd.planRoute()))"),
    );
    const renderWall = renderWallClearance(renderedRoute);
    const renderRadius = await cdp.eval("window.__rpd.playerRadius()");
    report.states.plan.renderWall = { ...renderWall, radius: renderRadius, boxes: renderWallBoxes.length };
    console.log("render wall check", JSON.stringify(report.states.plan.renderWall));
    assert(
      renderWall.samples > 100 && renderWall.penetrating === 0,
      `the route enters the rendered paper walls at ${renderWall.penetrating} of ${renderWall.samples} samples`,
    );
    assert(report.states.plan.plan.length > 1, "the waypoint did not add plan steps");
    assert(
      report.states.plan.check &&
        report.states.plan.check.points > 1 &&
        report.states.plan.check.samples > 0 &&
        report.states.plan.check.bad === 0 &&
        report.states.plan.check.worst <= 0.75 &&
        report.states.plan.check.clearance >= 0,
      `the capsule body leaves the walkable corridor (clearance ${report.states.plan.check?.clearance}, radius ${report.states.plan.check?.radius})`,
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
    await sleep(700);
    assert(
      !(await cdp.eval("window.__quest.debug().moving")),
      "double clicking Claire must not run the route any more",
    );
    assert(
      (await cdp.eval("window.__quest.debug().plan.length")) > 0,
      "double clicking Claire must not change the plan",
    );

    await rightClick(700, 500);
    const readyMenu = await menuState();
    assert(
      readyMenu && readyMenu.run,
      `Run route should be enabled with a route: ${JSON.stringify(readyMenu)}`,
    );
    await menuCommand("Run route");
    await cdp.waitFor("window.__quest.debug().moving === true", 10000);
    await rightClick(700, 500);
    const movingMenu = await menuState();
    assert(
      movingMenu &&
        !movingMenu.add &&
        !movingMenu.remove &&
        !movingMenu.run &&
        movingMenu.clear,
      `moving menu states are wrong: ${JSON.stringify(movingMenu)}`,
    );
    await cdp.mouse("mousePressed", emptyPoint[0], emptyPoint[1]);
    await cdp.mouse("mouseReleased", emptyPoint[0], emptyPoint[1]);
    await sleep(200);
    for (let i = 0; i < 600; i += 1) {
      await sleep(150);
      if (!(await cdp.eval("window.__quest.debug().moving"))) break;
    }
    await sleep(400);
    await shot("11-route-ortho");
    report.states.arrived = await facts();
    assert(!report.states.arrived.moving, "Run route should run the route to completion");
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
    await rightClick(700, 500);
    await menuCommand("Run route");
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

    const blockingCandidates = await evalJson(`(() => {
      const list = window.__quest
        .items()
        .filter(
          (item) =>
            item.floor === 0 && item.state === 1 && item.action === 1 && !item.hidden && item.available,
        );
      const preferred = list.filter((item) => item.name === "Green Herb");
      const others = list.filter((item) => !/Key|Bolt Cutter|Film/.test(item.name));
      const candidates = [];
      for (const item of [...preferred, ...others]) {
        const snap = window.__quest.nearestNavNode(item.floor, item.x, item.y, item.z);
        if (!snap || item.node < 0) continue;
        const approach = window.__quest.navNode(item.node);
        if (!approach || approach.index === snap.index) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const before = window.__quest.nearestNavNode(item.floor, snap.x - dx * 3, snap.y, snap.z - dz * 3);
          const beyond = window.__quest.nearestNavNode(item.floor, snap.x + dx * 3, snap.y, snap.z + dz * 3);
          if (!before || !beyond || before.index === beyond.index) continue;
          if (window.__quest.cellBlocked(before.index) || window.__quest.cellBlocked(beyond.index)) continue;
          if (Math.floor((before.x + beyond.x) / 2) !== Math.floor(snap.x)) continue;
          if (Math.floor((before.z + beyond.z) / 2) !== Math.floor(snap.z)) continue;
          if (Math.hypot(before.x - beyond.x, before.z - beyond.z) < 3) continue;
          candidates.push({ item, snap, before, beyond, approach });
          break;
        }
        if (candidates.length >= 12) break;
      }
      return candidates;
    })()`);
    assert(blockingCandidates.length > 0, "could not find an item cell with a route around it");

    let blockingItem = null;
    for (const candidate of blockingCandidates) {
      await cdp.eval("window.__quest.reset()");
      await cdp.eval(
        `window.__quest.setPlayer(${candidate.before.x}, ${candidate.before.y}, ${candidate.before.z})`,
      );
      await sleep(250);
      await cdp.eval(`window.__quest.addTargetNode(${candidate.beyond.index})`);
      await sleep(350);
      if ((await cdp.eval("window.__quest.debug().routePoints")) > 1) {
        blockingItem = candidate;
        break;
      }
    }
    assert(blockingItem, "no route resolved around a candidate item cell");
    assert(
      await cdp.eval(`window.__quest.cellBlocked(${blockingItem.snap.index})`),
      `${blockingItem.item.name} does not block its nav cell`,
    );
    assert(
      blockingItem.approach.index !== blockingItem.snap.index &&
        !(await cdp.eval(`window.__quest.cellBlocked(${blockingItem.approach.index})`)),
      "the item approach cell must be a reachable neighbour",
    );

    const itemCellHits = await cdp.eval(`(() => {
      const route = window.__rpd.planRoute();
      const cellX = Math.floor(${blockingItem.snap.x});
      const cellZ = Math.floor(${blockingItem.snap.z});
      let hits = 0;
      for (let i = 0; i < route.length; i += 3) {
        if (Math.floor(route[i]) === cellX && Math.floor(route[i + 2]) === cellZ) hits += 1;
      }
      return hits;
    })()`);
    assert(itemCellHits === 0, `the detour crossed the item cell ${itemCellHits} times`);

    await cdp.eval("window.__quest.reset()");
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await cdp.eval(`window.__quest.addTargetNode(${blockingItem.snap.index})`);
    await sleep(400);
    assert(
      (await cdp.eval("window.__quest.debug().routePoints")) === 0,
      "a route must not end on an item cell",
    );

    await cdp.eval("window.__quest.reset()");
    await cdp.eval(
      `window.__quest.setPlayer(${blockingItem.approach.x}, ${blockingItem.approach.y}, ${blockingItem.approach.z})`,
    );
    await sleep(300);
    await cdp.eval(`window.__quest.openPopupAt(${blockingItem.item.x}, ${blockingItem.item.z})`);
    await sleep(400);
    const approachPopup = await cdp.eval("window.__quest.popup()");
    assert(
      approachPopup.open && approachPopup.item === blockingItem.item.index,
      "the item popup did not open from the approach cell",
    );
    assert(
      approachPopup.choices.some((choice) => choice.enabled && choice.label.includes("TAKE")),
      "the item is not interactable from the approach cell",
    );
    await cdp.key("Escape", "Escape", 27);
    await sleep(200);
    assert(
      (await cdp.eval(`window.__quest.actItem(${blockingItem.item.index})`)) === 0,
      "the pickup failed from the approach cell",
    );
    await sleep(300);
    assert(
      !(await cdp.eval(`window.__quest.cellBlocked(${blockingItem.snap.index})`)),
      "taking the item did not free its cell",
    );
    report.states.itemBlocking = blockingItem;

    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await sleep(300);

    await cdp.eval("window.__quest.setFloor(1)");
    await sleep(300);
    await cdp.eval("window.__quest.setFloor(0)");
    await cdp.eval("window.__quest.setPlayer(0, 0.02, 7.5)");
    await sleep(600);
    const settledPlayer = await evalJson("window.__quest.debug().player");

    let labelOverlap = null;
    const rooms = await cdp.eval("window.__quest.rooms()");
    const labelCandidates = await evalJson(`(() => {
      const items = window.__quest.items().filter((item) => item.floor === 0 && item.state === 1);
      return window.__quest.rooms()
        .filter((room) => room.floor === 0)
        .map((room) => {
          const item = items
            .filter((entry) => !window.__quest.itemHasCode(entry.index))
            .sort(
              (a, b) =>
                Math.hypot(a.x - room.x, a.z - room.z) -
                Math.hypot(b.x - room.x, b.z - room.z),
            )[0];
          return item ? { room: room.name, item: { x: item.x, z: item.z } } : null;
        })
        .filter(Boolean);
    })()`);
    for (const candidate of labelCandidates) {
      const opened = await cdp.eval(
        `window.__quest.openPopupAt(${candidate.item.x}, ${candidate.item.z})`,
      );
      if (opened) {
        await cdp.waitFor("window.__quest.overlayStats()[5] === 1", 4000);
      }
      const stats = await cdp.eval("window.__quest.overlayStats()");
      if (opened && stats[2] > 0) {
        labelOverlap = { room: candidate.room, stats };
        break;
      }
      await cdp.key("Escape", "Escape", 27);
      await cdp.waitFor("window.__quest.overlayStats()[5] === 0", 4000);
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
    const floorHover = [];
    for (const floor of [0, 1, 2, 3, 4]) {
      await setFloor(floor);
      await sleep(400);
      const stats = await cdp.eval("window.__quest.overlayStats()");
      assert(stats[0] === -1, `floor ${floor} should start with no hovered item`);
      assert(stats[4] === 0, `floor ${floor} must not draw a Claire label`);
      floorHover.push({ floor, hover: stats[0], claire: stats[4] });
    }
    await setFloor(0);
    await sleep(400);
    const floorOneStats = await cdp.eval("window.__quest.overlayStats()");
    assert(floorOneStats[4] === 0, "Claire's overlay label must be gone");
    await setFloor(1);
    await sleep(300);
    const floorTwoStats = await cdp.eval("window.__quest.overlayStats()");
    assert(floorTwoStats[4] === 0, "Claire's overlay label must be gone on 2F");
    const floorOnePixels = colouredPixels(shotPath("07-ortho-1f-clean"));
    assert(floorOnePixels > 0, "item cubes must draw on their own floor");
    report.states.floorFilter = {
      floorOneStats,
      floorTwoStats,
      floorHover,
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

    const dragPose = await evalJson("window.__quest.cameraModel()");
    await cdp.mouse("mousePressed", 700, 450, { button: "right", buttons: 2 });
    await cdp.mouse("mouseMoved", 760, 470, { button: "right", buttons: 2 });
    await cdp.mouse("mouseReleased", 760, 470, { button: "right", buttons: 0 });
    await sleep(300);
    const dragPoseAfter = await evalJson("window.__quest.cameraModel()");
    assert(
      Math.abs(dragPoseAfter[4] - dragPose[4]) > 1e-3,
      "right drag must still rotate the perspective camera",
    );
    assert(
      !(await cdp.eval("Boolean(document.querySelector('.rpd-menu'))")),
      "a right drag must not open the context menu",
    );
    await cdp.eval("window.__rpd.setOrbit(0, 2.5, 2, -0.75, 0.36, 65)");
    await sleep(500);

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
    const centring = await evalJson(`(() => {
      const list = window.__quest.items();
      const bad = [];
      let checked = 0;
      for (const item of list) {
        if (item.state !== 1) continue;
        const nearest = window.__quest.nearestNavNode(item.floor, item.x, item.y, item.z);
        checked += 1;
        if (!nearest || Math.abs(item.cubeX - nearest.x) > 1e-3 ||
            Math.abs(item.cubeZ - nearest.z) > 1e-3 ||
            Math.abs(item.cubeY - (nearest.y + 0.45)) > 1e-3) {
          bad.push({ name: item.name, cube: [item.cubeX, item.cubeY, item.cubeZ], nearest });
        }
      }
      return { checked, bad };
    })()`);
    assert(
      centring.checked > 200 && centring.bad.length === 0,
      `item cubes must sit on their closest nav node: ${JSON.stringify(centring.bad.slice(0, 3))}`,
    );
    report.states.itemCentring = centring;

    // Every registry item draws as a small coloured cube in both views.
    // Keys are the purple family; the rest follow CATEGORY_COLOURS.
    await cdp.eval("window.__rpd.setOrbit(0, 0, 0, 0, 1.2, 14)");
    await sleep(900);
    const items3d = JSON.parse(await cdp.eval("JSON.stringify(window.__quest.items())"));
    assert(items3d.length === 271, `expected 271 items in the perspective, got ${items3d.length}`);
    const spade = items3d.find((entry) => entry.name === "Spade Key");
    assert(spade, "the Spade Key item is missing");
    assert(spade.r > 0.5 && spade.b > 0.8 && spade.g < 0.5,
           `keys must be purple, got ${spade.r},${spade.g},${spade.b}`);
    await shot("31-item-cubes-3d");

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) >= 0.999", 20000);
    await setFloor(0);
    await cdp.eval("window.__rpd.setOrbit(0, 0, 0, 0, 1.2, 20)");
    await sleep(900);
    const itemsOrtho = JSON.parse(await cdp.eval("JSON.stringify(window.__quest.items())"));
    assert(itemsOrtho.length === 271, `expected 271 items in the plan, got ${itemsOrtho.length}`);
    await shot("32-item-cubes-ortho");
    report.states.itemCubes = { perspective: items3d.length, ortho: itemsOrtho.length,
                                spade: [spade.r, spade.g, spade.b] };

    // The waypoint menu owns the pointer while it is open, so close it
    // before probing the item hover.
    await cdp.key("Escape", "Escape", 27);
    await sleep(200);
    const ammoIndex = itemsOrtho.findIndex(
      (entry) => entry.name === "Handgun Ammo" && entry.floor === 0 && entry.state === 1,
    );
    assert(ammoIndex >= 0, "expected a present Handgun Ammo on 1F");
    const ammoItem = itemsOrtho[ammoIndex];
    const centreOrbit = (entry) =>
      `window.__rpd.setOrbit(${entry.cubeX}, 0, ${entry.cubeZ}, 0, 1.2, 20)`;
    await cdp.eval(centreOrbit(ammoItem));
    await sleep(500);
    const ammoScreen = JSON.parse(
      await cdp.eval(
        `JSON.stringify(window.__quest.project(${ammoItem.cubeX}, ${ammoItem.cubeY}, ${ammoItem.cubeZ}))`,
      ),
    );
    await cdp.mouse("mouseMoved", ammoScreen.x, ammoScreen.y);
    await cdp.waitFor(`window.__quest.overlayStats()[0] === ${ammoIndex}`, 10000);
    await shot("32b-item-hover");
    await cdp.mouse("mouseMoved", Math.round(ammoScreen.x + 70), Math.round(ammoScreen.y + 70));
    await cdp.waitFor("window.__quest.overlayStats()[0] === -1", 10000);
    await shot("32c-item-no-hover");
    const hoverPixels = changedPixels(shotPath("32b-item-hover"), shotPath("32c-item-no-hover"), {
      x0: Math.max(0, Math.round(ammoScreen.x) - 90),
      y0: Math.max(0, Math.round(ammoScreen.y) - 46),
      x1: Math.min(1400, Math.round(ammoScreen.x) + 90),
      y1: Math.min(900, Math.round(ammoScreen.y) - 8),
    });
    assert(hoverPixels > 40, `the hovered item name did not draw (${hoverPixels} pixels)`);

    const hiddenIndex = itemsOrtho.findIndex(
      (entry) => entry.hidden && entry.floor === 0 && entry.name === "Hip Pouch",
    );
    assert(hiddenIndex >= 0, "expected the hidden Hip Pouch on 1F");
    await cdp.eval(centreOrbit(itemsOrtho[hiddenIndex]));
    await sleep(500);
    const hiddenScreen = JSON.parse(
      await cdp.eval(
        `JSON.stringify(window.__quest.project(${itemsOrtho[hiddenIndex].cubeX}, ${itemsOrtho[hiddenIndex].cubeY}, ${itemsOrtho[hiddenIndex].cubeZ}))`,
      ),
    );
    await cdp.mouse("mouseMoved", hiddenScreen.x, hiddenScreen.y);
    await sleep(600);
    assert(
      (await cdp.eval("window.__quest.overlayStats()"))[0] !== hiddenIndex,
      "a hidden item must not hover",
    );

    const takenIndex = itemsOrtho.findIndex((entry) => entry.floor === 0 && entry.taken);
    assert(takenIndex >= 0, "expected a taken item on 1F");
    const takenItem = itemsOrtho[takenIndex];
    await cdp.eval(centreOrbit(takenItem));
    await sleep(500);
    const takenScreen = await evalJson(
      `window.__quest.project(${takenItem.cubeX}, ${takenItem.cubeY}, ${takenItem.cubeZ})`,
    );
    await cdp.mouse("mouseMoved", takenScreen.x, takenScreen.y);
    await sleep(600);
    assert(
      (await cdp.eval("window.__quest.overlayStats()"))[0] !== takenIndex,
      "a taken item must not hover",
    );
    report.states.itemHover = { taken: takenIndex, hidden: hiddenIndex, pixels: hoverPixels };

    await setFloor(2);
    const spadeItem = itemsOrtho.find(
      (entry) => entry.name === "Spade Key" && entry.floor === 2 && entry.state === 1,
    );
    assert(spadeItem, "expected the present Spade Key on 2F");
    const sizeOrbit = (distance) =>
      `window.__rpd.setOrbit(${spadeItem.cubeX}, ${spadeItem.cubeY}, ${spadeItem.cubeZ}, 0, 1.2, ${distance})`;
    await cdp.eval(sizeOrbit(20));
    await sleep(600);
    const sizeCentre = await evalJson(
      `window.__quest.project(${spadeItem.cubeX}, ${spadeItem.cubeY}, ${spadeItem.cubeZ})`,
    );
    await shot("32d-item-size-far");
    await cdp.eval(sizeOrbit(8));
    await sleep(600);
    await shot("32e-item-size-near");
    const keyColour = [spadeItem.r, spadeItem.g, spadeItem.b].map((value) => Math.round(value * 255));
    const cubeColour = (r, g, b) =>
      Math.abs(r - keyColour[0]) < 24 &&
      Math.abs(g - keyColour[1]) < 24 &&
      Math.abs(b - keyColour[2]) < 24;
    const farSize = colourBounds(shotPath("32d-item-size-far"), sizeCentre, 30, cubeColour);
    const nearSize = colourBounds(shotPath("32e-item-size-near"), sizeCentre, 30, cubeColour);
    assert(
      farSize.width >= 10 && nearSize.width >= 10,
      `the item cube did not draw in both zoom shots: ${JSON.stringify({ farSize, nearSize })}`,
    );
    assert(
      Math.abs(farSize.width - nearSize.width) <= 2 &&
        Math.abs(farSize.height - nearSize.height) <= 2,
      `the ortho cube must keep its pixel size across zoom: ${JSON.stringify({ farSize, nearSize })}`,
    );
    report.states.itemSize = { far: farSize, near: nearSize };
    await setFloor(0);

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
        return JSON.stringify({ title: slot.title, bg: getComputedStyle(slot).backgroundColor });
      })()`),
    );
    assert(keySlot && keySlot.title === "Car Key", "the inventory slot should name the car key");
    const keyColor = `rgb(${Math.round(items[carKey].r * 255)}, ${Math.round(items[carKey].g * 255)}, ${Math.round(items[carKey].b * 255)})`;
    assert(keySlot.bg === keyColor, `the inventory slot should be the item cube colour ${keyColor}, got ${keySlot.bg}`);

    await shot("33-inventory-square");

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
    // Node 2027 is the adjacent cell north of the threshold. It was reachable
    // while the door was locked under the old 1 m block.
    await cdp.eval("window.__quest.reset()");
    await cdp.eval("window.__quest.addTargetNode(2027)");
    await sleep(500);
    const chainedAdjacentLockedRoute = await cdp.eval("window.__quest.debug().routePoints");
    assert(
      chainedAdjacentLockedRoute === 0,
      `a route slipped around the locked chained door with ${chainedAdjacentLockedRoute} points`,
    );
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
    await cdp.eval("window.__quest.reset()");
    await cdp.eval("window.__quest.addTargetNode(2027)");
    await sleep(500);
    const chainedAdjacentUnlockedRoute = await cdp.eval("window.__quest.debug().routePoints");
    assert(chainedAdjacentUnlockedRoute > 1, "the route to the adjacent cell did not build after unlocking");
    report.states.chainedDoorRoute = {
      locked: chainedLockedRoute,
      adjacentLocked: chainedAdjacentLockedRoute,
      unlocked: chainedUnlockedRoute,
      adjacentUnlocked: chainedAdjacentUnlockedRoute,
    };

    // A film carried to the Darkroom Sink reveals its file. The Sewers film is
    // fetched from the mapped Underground Facility transition, so the user path
    // never needs the DEV grant.
    const film = items.findIndex((entry) => entry.name === 'Film: "Commemorative"');
    const photo = items.findIndex((entry) => entry.name === "Commemorative Photo");
    const sink = items.findIndex((entry) => entry.name === "Darkroom Sink");
    const hiding = items.findIndex((entry) => entry.name === "Hiding Place");
    const filmSource = items.findIndex(
      (entry) => entry.name === "To Underground Facility" && entry.floor === 0,
    );
    assert(film >= 0 && photo >= 0 && sink >= 0 && hiding >= 0, "the film chain is missing");
    assert(filmSource >= 0, "the Sewers film source is missing");
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

    // The MQ 11 magazine is downstream of the Hiding Place file.
    const magazine = items.findIndex((entry) => entry.name === "High-Capacity Mag. (MQ 11)");
    assert(magazine >= 0, "the MQ 11 magazine is missing");
    await setFloor(1);
    await cdp.eval(`window.__quest.standAt(${magazine})`);
    assert((await cdp.eval(`window.__quest.actItem(${magazine})`)) === -2, "the MQ 11 magazine opened without the Hiding Place file");

    await setFloor(0);
    await cdp.eval(`window.__quest.standAt(${hiding})`);
    assert((await cdp.eval(`window.__quest.actItem(${hiding})`)) === -2, "the Sewers film gate was ignored");
    assert((await cdp.eval(`window.__quest.itemHint(${hiding})`)) === "OUTSIDE THE MAP", "the film gate lost its hint");
    await cdp.eval(`window.__quest.standAt(${filmSource})`);
    assert((await cdp.eval(`window.__quest.actItem(${filmSource})`)) === 0, "the Underground Facility film fetch failed");
    assert((await cdp.eval(`window.__quest.itemHint(${hiding})`)) !== "OUTSIDE THE MAP", "fetching the film did not clear the gate");
    assert((await cdp.eval(`window.__quest.actItem(${hiding})`)) === 0, "the Hiding Place file did not open after the film");
    await setFloor(1);
    await cdp.eval(`window.__quest.standAt(${magazine})`);
    assert((await cdp.eval(`window.__quest.actItem(${magazine})`)) === 0, "the Hiding Place file did not unlock the MQ 11 magazine");
    report.states.film = { film, photo, sink, hiding, filmSource, magazine };

    // Safe and dial-lock codes are entered in the React code UI. The state
    // machine refuses a code until the matching hint file has been read.
    const dial = items.findIndex((entry) => entry.name === "Dial Lock" && entry.floor === 1);
    const codedSafe = items.findIndex((entry) => entry.name === "Safe" && entry.floor === 0);
    const dialHint = items.findIndex((entry) => entry.name === "Locker Room Code");
    const safeHint = items.findIndex((entry) => entry.name === "Internal Memo");
    assert(dial >= 0 && codedSafe >= 0, "the coded locks are missing");
    assert(dialHint >= 0 && safeHint >= 0, "the code hint files are missing");
    await setFloor(1);
    assert((await cdp.eval(`window.__quest.itemHasCode(${dial})`)) === true, "the dial lock lost its code");
    assert((await cdp.eval(`window.__quest.actItem(${dial})`)) === -5, "the dial lock opened without a code");
    const dialHintText = await cdp.eval(`window.__quest.itemHint(${dial})`);
    const dialHintState = (await cdp.eval("window.__quest.items()"))[dialHint].state;
    const dialHintInventory = (await cdp.eval("window.__quest.inventory()")).some((slot) => slot?.name === "Locker Room Code");
    assert(
      dialHintText === "Locker Room Code",
      `the dial hint should name the file, got ${dialHintText} (state ${dialHintState}, carried ${dialHintInventory})`,
    );
    assert((await cdp.eval(`window.__quest.enterCode(${dial}, "C-A-P")`)) === -7, "the dial lock accepted a code without its hint");
    await setFloor(0);
    await cdp.eval(`window.__quest.standAt(${dialHint})`);
    assert((await cdp.eval(`window.__quest.actItem(${dialHint})`)) === 0, "the Locker Room Code hint could not be read");
    await setFloor(1);
    assert((await cdp.eval(`window.__quest.enterCode(${dial}, "C-A-P")`)) === 0, "the dial lock code C-A-P failed after reading its hint");

    await setFloor(0);
    assert((await cdp.eval(`window.__quest.itemHasCode(${codedSafe})`)) === true, "the safe lost its code");
    await cdp.eval(`window.__quest.standAt(${codedSafe})`);
    await cdp.eval(`window.__quest.openPopupAt(${items[codedSafe].x}, ${items[codedSafe].z})`);
    await cdp.waitFor("Boolean(document.querySelector('.rpd-code-input'))");
    const hintPopup = await cdp.eval("window.__quest.popup()");
    assert(hintPopup.message === "Internal Memo", `expected the hint title, got ${hintPopup.message}`);
    assert(
      (await cdp.eval("document.querySelector('.rpd-code-input').disabled")) === true,
      "the code input should wait for the hint file",
    );
    await cdp.eval("document.querySelector('.rpd-code-close').click()");
    assert((await cdp.eval(`window.__quest.enterCode(${codedSafe}, "L9 R15 L6")`)) === -7, "the safe accepted a code without its hint");

    await setFloor(1);
    await cdp.eval(`window.__quest.standAt(${safeHint})`);
    assert((await cdp.eval(`window.__quest.actItem(${safeHint})`)) === 0, "the Internal Memo hint could not be read");

    const hipPouchBefore = (await cdp.eval("window.__quest.items()")).filter(
      (entry) => entry.name === "Hip Pouch" && entry.hidden,
    ).length;
    await setFloor(0);
    await cdp.eval(`window.__quest.standAt(${codedSafe})`);
    await cdp.eval(`window.__quest.openPopupAt(${items[codedSafe].x}, ${items[codedSafe].z})`);
    await cdp.waitFor("document.querySelector('.rpd-code-input')?.disabled === false");
    const codePopup = await cdp.eval("window.__quest.popup()");
    assert(codePopup.message === "CODE REQUIRED", `expected Code required, got ${codePopup.message}`);
    await shot("39-code-lock");
    const typeCode = (value) =>
      cdp.eval(
        `(() => { const input = document.querySelector('.rpd-code-input'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      );
    assert(await typeCode("L9 R15 L6"), "the code input disappeared");
    await cdp.eval("document.querySelector('.rpd-code-submit').click()");
    await cdp.waitFor("document.querySelector('.rpd-code-message')?.textContent === 'WRONG CODE'");
    assert(await typeCode("L9 R15 L7"), "the code input disappeared after a wrong code");
    await cdp.eval("document.querySelector('.rpd-code-submit').click()");
    await cdp.waitFor("document.querySelector('.rpd-code') === null");
    const hipPouchAfter = (await cdp.eval("window.__quest.items()")).filter(
      (entry) => entry.name === "Hip Pouch" && entry.hidden,
    ).length;
    assert(hipPouchAfter < hipPouchBefore, "the coded safe did not reveal its contents");
    report.states.codes = { dial, codedSafe, dialHint, safeHint };

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
      await cdp.eval(`JSON.stringify(window.__quest.project(${farItem.cubeX}, ${farItem.cubeY}, ${farItem.cubeZ}))`),
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
    const relations = await evalJson(`(() => {
      const key = window.__quest.items().find((item) => item.name === "Heart Key");
      if (!key) return null;
      return { index: key.index, related: window.__quest.itemRelated(key.index) };
    })()`);
    assert(relations && relations.related.length > 0, "the heart key has no related items");
    await cdp.eval(`window.__quest.itemDebugHighlight(${relations.index})`);
    assert((await cdp.eval("window.__quest.itemDebugHighlighted()")) === relations.index, "the highlight did not take");
    const relatedNames = await evalJson(
      `window.__quest.itemRelated(${relations.index}).map((index) => window.__quest.items()[index].name)`,
    );
    assert(relatedNames.includes("Heart Door"), `the heart door is missing from the relations: ${JSON.stringify(relatedNames)}`);
    await cdp.eval(`window.__quest.itemDebugHighlight(-1)`);
    await cdp.eval("window.__quest.toggleDebug()");

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
