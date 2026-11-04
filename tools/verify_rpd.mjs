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
      await sleep(450);
    };
    const setPlayer = async (x, y, z) => {
      await cdp.eval(`window.__quest.setPlayer(${x}, ${y}, ${z})`);
      await sleep(450);
    };
    const facts = () => cdp.eval(`(() => {
      const label = document.querySelector('.rpd-map-player');
      const rect = label?.getBoundingClientRect();
      return {
        floors: [...document.querySelectorAll('.rpd-floor')].map((e) => ({ text: e.textContent.trim(), active: e.dataset.active })),
        panel: document.querySelector('.rpd-panel')?.innerText.slice(0, 80) ?? null,
        mapTitle: document.querySelector('.rpd-map-title')?.innerText ?? null,
        label: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), text: label.textContent } : null,
        popup: document.querySelector('.rpd-popup-layer')?.innerText ?? null,
        plan: window.__quest.debug().plan,
        player: window.__quest.debug().player,
        moving: window.__quest.debug().moving,
        view: document.querySelector('.rpd-view-toggle')?.textContent.trim() ?? null,
      };
    })()`);

    const report = { shots: [], errors: [], states: {} };

    await shot("01-3d-solid");
    report.states.solid = await facts();

    await cdp.key("KeyG", "g", 71);
    await sleep(700);
    await shot("02-3d-glass");
    await cdp.key("KeyG", "g", 71);
    await sleep(500);

    await cdp.eval("document.querySelector('.rpd-view-toggle').click()");
    await sleep(1300);
    report.states.map1f = await facts();
    await shot("03-2d-1f");

    await setFloor(1);
    report.states.map2f = await facts();
    await shot("04-2d-2f");

    await setFloor(2);
    report.states.map3f = await facts();
    await shot("05-2d-3f");

    await setPlayer(-30, 10.85, -4);
    await setFloor(0);
    report.states.beforeF = await facts();
    await shot("06-before-f");
    await cdp.key("KeyF", "f", 70);
    await sleep(800);
    report.states.afterF = await facts();
    await shot("07-after-f");

    await cdp.mouse("mouseMoved", 650, 500);
    await sleep(500);
    await shot("08-hover");

    await setFloor(0);
    await setPlayer(0, 1.25, 8);
    await cdp.mouse("mousePressed", 650, 570);
    await cdp.mouse("mouseReleased", 650, 570);
    await sleep(700);
    report.states.popup = await facts();
    await shot("09-popup");
    const hasChoice = await cdp.eval(
      "Boolean(document.querySelector('.rpd-popup-choice:not(:disabled)'))",
    );
    if (!hasChoice) throw new Error("Map click did not open a routing choice");
    await cdp.eval("document.querySelector('.rpd-popup-choice:not(:disabled)').click()");
    await sleep(700);
    report.states.plan = await facts();
    await shot("10-plan");
    await cdp.eval("window.__quest.run()");
    for (let i = 0; i < 160; i++) {
      await sleep(150);
      if (!(await cdp.eval("window.__quest.debug().moving"))) break;
    }
    report.states.route2d = await facts();
    await shot("11-2d-route");
    await cdp.eval("document.querySelector('.rpd-view-toggle').click()");
    await sleep(1300);
    report.states.route3d = await facts();
    await shot("12-3d-route");

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
