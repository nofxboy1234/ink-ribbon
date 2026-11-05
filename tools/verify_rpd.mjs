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

    await cdp.mouse("mouseMoved", 320, 350);
    await sleep(400);
    await shot("08-hover");

    await cdp.mouse("mousePressed", 320, 350);
    await cdp.mouse("mouseReleased", 320, 350);
    await sleep(500);
    const picked = await cdp.eval("window.__quest.debug().plan.length");
    assert(picked > 0, "clicking a cell did not add a waypoint");
    await cdp.eval("window.__quest.reset()");
    await cdp.eval("window.__quest.addTarget(0, 4)");
    await sleep(500);
    await shot("09-waypoint");
    await cdp.eval("window.__quest.addTarget(2, 4)");
    await sleep(500);
    await shot("10-plan");
    report.states.plan = await facts();
    assert(report.states.plan.plan.length > 1, "the waypoint did not add plan steps");
    assert(report.states.plan.check && report.states.plan.check.bad === 0, "route leaves the walkable graph");

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
