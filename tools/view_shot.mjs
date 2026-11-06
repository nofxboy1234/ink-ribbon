import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const out = resolve(root, arg("out") ?? "verification/rpd/dots/view.png");
const preset = arg("preset") ?? "dots";
const port = Number(process.env.RPD_SHOT_PORT ?? 5187);
const chromePort = Number(process.env.RPD_SHOT_CHROME ?? 9332);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRESETS = {
  dots: { view: "3d", orbit: [0, 2.5, 2, -0.75, 0.36, 65] },
  door: { view: "3d", orbit: [22.78, 1.5, -7.54, -0.8, 0.28, 13] },
  "3d-wide": { view: "3d", orbit: [0, 8, 0, -0.55, 0.4, 150] },
  "1f": { view: "2d", floor: 0 },
  "2f": { view: "2d", floor: 1 },
  "3f": { view: "2d", floor: 2 },
  "b1": { view: "2d", floor: 4 },
};

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`));
      setTimeout(poll, 150);
    };
    poll();
  });
}

async function main() {
  mkdirSync(dirname(out), { recursive: true });
  const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });
  let log = "";
  server.stdout.on("data", (chunk) => (log += chunk.toString()));
  server.stderr.on("data", (chunk) => (log += chunk.toString()));
  const userDataDir = mkdtempSync(join(tmpdir(), "rpd-view-"));
  const chrome = spawn(
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
      "--disable-background-timer-throttling",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    await waitForHttp(`http://localhost:${port}/`);
    await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 20000);
    const page = await (
      await fetch(
        `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(`http://localhost:${port}/`)}`,
        { method: "PUT" },
      )
    ).json();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const messageId = ++id;
        pending.set(messageId, resolve);
        ws.send(JSON.stringify({ id: messageId, method, params }));
      });
    const evaluate = async (expression) => {
      const response = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
      return response.result?.result?.value;
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.bringToFront");
    for (let i = 0; i < 150; i += 1) {
      if (await evaluate("Boolean(window.__quest?.setPlayer)").catch(() => false)) break;
      await sleep(200);
    }
    for (let i = 0; i < 150; i += 1) {
      if (await evaluate("document.querySelector('.rpd-status')?.dataset.hidden === 'true'").catch(() => false)) break;
      await sleep(200);
    }
    await evaluate("window.__rpd.setFpsVisible(false)");
    const settings = PRESETS[preset];
    if (!settings) throw new Error(`unknown preset ${preset}`);
    if (settings.view === "2d") {
      await send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyM", key: "m", windowsVirtualKeyCode: 77 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyM", key: "m", windowsVirtualKeyCode: 77 });
      for (let i = 0; i < 100; i += 1) {
        if ((await evaluate("window.__rpd.debugBlend()")) >= 0.999) break;
        await sleep(150);
      }
      await evaluate(`window.__quest.setFloor(${settings.floor})`);
      await sleep(1200);
    } else if (settings.orbit) {
      const [x, y, z, yaw, pitch, distance] = settings.orbit;
      await evaluate(`window.__rpd.setOrbit(${x}, ${y}, ${z}, ${yaw}, ${pitch}, ${distance})`);
      await sleep(1200);
    }
    const response = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(out, Buffer.from(response.result.data, "base64"));
    console.log(`wrote ${out}`);
    ws.close();
  } finally {
    chrome.kill("SIGTERM");
    server.kill("SIGTERM");
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
    if (log.includes("Error")) console.log(log.slice(-2000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
