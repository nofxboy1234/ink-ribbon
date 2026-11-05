import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    const shot = async (name) => {
      await cdp.eval(
        "document.querySelectorAll('.rpd-fps,.rpd-toast').forEach((e) => (e.style.visibility = 'hidden'))",
      );
      const path = join(update ? baselineDir : currentDir, `${name}.png`);
      await cdp.screenshot(path);
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
        check: window.__quest.checkPath(),
        view: document.querySelector('.rpd-view-toggle')?.textContent.trim() ?? null,
      };
    })()`);
    const assert = (ok, message) => {
      if (!ok) throw new Error(message);
    };

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
    await cdp.eval("window.__quest.addTarget(2, 4)");
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

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) <= 0.001", 20000);
    await sleep(250);
    await shot("12-route-3d");
    report.states.route3d = await facts();
    assert(report.states.route3d.view === "2D", "M should return to the perspective view");

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
    assert(items.length === 9, "expected nine items");
    const itemRooms = new Map();
    for (const item of items) {
      itemRooms.set(item.roomName, (itemRooms.get(item.roomName) ?? 0) + 1);
    }
    const threeRooms = [...itemRooms.values()].filter((count) => count === 3).length;
    assert(threeRooms >= 3, "expected three items in each of three rooms");

    await cdp.key("KeyM", "m", 77);
    await cdp.waitFor("(window.__rpd?.debugBlend?.() ?? 0) >= 0.999", 20000);
    await setFloor(0);
    await sleep(500);

    const farItem = items[8];
    const farScreen = JSON.parse(await cdp.eval(
      `JSON.stringify(window.__quest.project(${farItem.x}, ${farItem.y}, ${farItem.z}))`,
    ));
    await cdp.mouse("mousePressed", farScreen.x, farScreen.y);
    await cdp.mouse("mouseReleased", farScreen.x, farScreen.y);
    await sleep(700);
    const farPopup = await cdp.eval("window.__quest.popup()");
    assert(farPopup.open && farPopup.item === 8, "clicking an item cell did not open its popup");
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

    for (let i = 0; i < 8; i += 1) {
      const item = (await cdp.eval("window.__quest.items()"))[i];
      const stood = await cdp.eval(`window.__quest.standNextTo(${i})`);
      assert(stood, `could not stand next to item ${i}`);
      await sleep(500);
      const screen = JSON.parse(await cdp.eval(
        `JSON.stringify(window.__quest.project(${item.x}, ${item.y}, ${item.z}))`,
      ));
      await cdp.mouse("mousePressed", screen.x, screen.y);
      await cdp.mouse("mouseReleased", screen.x, screen.y);
      await sleep(700);
      const itemPopup = await cdp.eval("window.__quest.popup()");
      assert(itemPopup.open, `item ${i} did not open a popup`);
      assert(itemPopup.item === i, `item ${i} popup pointed at ${itemPopup.item}`);
      const takeChoice = itemPopup.choices.find(
        (choice) => choice.enabled && choice.label.includes("TAKE"),
      );
      assert(takeChoice, `item ${i} popup has no Take choice`);
      const takeX = (takeChoice.x0 + takeChoice.x1) / 2;
      const takeY = (takeChoice.y0 + takeChoice.y1) / 2;
      await cdp.mouse("mouseMoved", takeX, takeY);
      await sleep(200);
      await cdp.mouse("mousePressed", takeX, takeY);
      await cdp.mouse("mouseReleased", takeX, takeY);
      await sleep(700);
      const slots = await cdp.eval("window.__quest.inventory()");
      assert(slots.filter(Boolean).length === i + 1, `taking item ${i} did not fill a slot`);
      assert((await cdp.eval("window.__quest.items()"))[i].taken, `item ${i} is not marked taken`);
      if (i === 0) {
        const unblocked = await cdp.eval(`(() => {
          const entry = window.__quest.items()[0];
          window.__quest.setPlayer(entry.x, entry.y, entry.z);
          const player = window.__quest.debug().player;
          return Math.hypot(player[0] - entry.x, player[2] - entry.z) < 0.2;
        })()`);
        assert(unblocked, "taking an item did not unblock its nav cell");
        await sleep(400);
      }
      if (i === 2) {
        await sleep(600);
        await shot("15-inventory-3");
      }
    }
    await sleep(700);
    await shot("16-inventory-full");
    const fullSlots = await cdp.eval("window.__quest.inventory()");
    assert(fullSlots.every(Boolean), "the inventory should have eight filled slots");

    const ninth = (await cdp.eval("window.__quest.items()"))[8];
    const stoodNinth = await cdp.eval("window.__quest.standNextTo(8)");
    assert(stoodNinth, "could not stand next to the ninth item");
    await sleep(500);
    const ninthScreen = JSON.parse(await cdp.eval(
      `JSON.stringify(window.__quest.project(${ninth.x}, ${ninth.y}, ${ninth.z}))`,
    ));
    await cdp.mouse("mousePressed", ninthScreen.x, ninthScreen.y);
    await cdp.mouse("mouseReleased", ninthScreen.x, ninthScreen.y);
    await sleep(700);
    const refused = await cdp.eval("window.__quest.popup()");
    assert(refused.open, "the ninth item did not open a popup");
    assert(refused.message === "INVENTORY FULL", `expected Inventory full, got ${refused.message}`);
    const refusedTake = refused.choices.find((choice) => choice.label.includes("TAKE"));
    assert(refusedTake && !refusedTake.enabled, "the ninth Take should be disabled");
    await shot("17-inventory-refused");
    await cdp.mouse("mousePressed", (refusedTake.x0 + refusedTake.x1) / 2, (refusedTake.y0 + refusedTake.y1) / 2);
    await cdp.mouse("mouseReleased", (refusedTake.x0 + refusedTake.x1) / 2, (refusedTake.y0 + refusedTake.y1) / 2);
    await sleep(400);
    assert(!(await cdp.eval("window.__quest.items()"))[8].taken, "the ninth item must stay on the floor");
    const afterRefusal = await cdp.eval("window.__quest.inventory()");
    assert(afterRefusal.filter(Boolean).length === 8, "a refused take must not change the inventory");

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
