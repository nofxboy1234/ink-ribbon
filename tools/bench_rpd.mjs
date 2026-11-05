import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_BENCH_PORT ?? 5220);
const chromePort = Number(process.env.RPD_BENCH_CHROME ?? 9364);
const label = process.env.RPD_BENCH_LABEL ?? "run";
const outPath = process.env.RPD_BENCH_OUT ?? join(root, "verification", "rpd", `${label}.json`);
const seconds = Number(process.env.RPD_BENCH_SECONDS ?? 5);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${url}`));
      setTimeout(poll, 150);
    };
    poll();
  });
}

async function main() {
  const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => (serverLog += chunk));
  server.stderr.on("data", (chunk) => (serverLog += chunk));
  let chrome;
  let userDataDir;
  let ws;
  try {
    await waitForHttp(`http://localhost:${port}/`);
    userDataDir = mkdtempSync(join(tmpdir(), "rpd-bench-"));
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
    const page = await (
      await fetch(
        `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(`http://localhost:${port}/`)}`,
        { method: "PUT" },
      )
    ).json();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const requestId = ++id;
        pending.set(requestId, resolve);
        ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    const evaluate = async (expression) => {
      const response = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.result?.exceptionDetails) {
        throw new Error(response.result.exceptionDetails.text);
      }
      return response.result?.result?.value;
    };
    const metrics = async () => {
      const response = await send("Performance.getMetrics");
      return Object.fromEntries(
        (response.result?.metrics ?? []).map((entry) => [entry.name, entry.value]),
      );
    };
    const mouse = (type, x, y, extra = {}) =>
      send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "none",
        buttons: 0,
        clickCount: 1,
        ...extra,
      });

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Performance.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (let i = 0; i < 150; i += 1) {
      if (await evaluate("Boolean(window.__quest?.debug)").catch(() => false)) break;
      await sleep(200);
    }
    await sleep(2500);
    await evaluate(`(() => {
      window.__benchFrames = [];
      window.__benchStart = performance.now();
      const tick = (t) => { window.__benchFrames.push(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return true;
    })()`);

    const sample = async (name, action) => {
      const before = await metrics();
      const start = await evaluate("performance.now()");
      await evaluate("window.__benchFrames = []; window.__benchStart = performance.now();");
      if (action) await action();
      await sleep(seconds * 1000);
      const frames = await evaluate("window.__benchFrames.slice()");
      const end = await evaluate("performance.now()");
      const after = await metrics();
      const intervals = [];
      for (let i = 1; i < frames.length; i += 1) intervals.push(frames[i] - frames[i - 1]);
      intervals.sort((a, b) => a - b);
      const pick = (q) => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * q))] ?? 0;
      const elapsed = (end - start) / 1000;
      return {
        name,
        seconds: elapsed,
        frames: frames.length,
        fps: frames.length / elapsed,
        p50FrameMs: pick(0.5),
        p95FrameMs: pick(0.95),
        p99FrameMs: pick(0.99),
        maxFrameMs: intervals[intervals.length - 1] ?? 0,
        scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
        taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
        layoutMs: ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000,
        styleMs: ((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1000,
      };
    };

    const results = [];
    results.push(await sample("3d-idle"));
    await send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyM", key: "m", windowsVirtualKeyCode: 77 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyM", key: "m", windowsVirtualKeyCode: 77 });
    for (let i = 0; i < 120; i += 1) {
      if ((await evaluate("window.__rpd.debugBlend?.() ?? 0")) >= 0.999) break;
      await sleep(200);
    }
    await sleep(500);
    results.push(await sample("plan-idle"));
    results.push(
      await sample("plan-zoom", async () => {
        for (let i = 0; i < seconds * 10; i += 1) {
          await mouse("mouseWheel", 700, 500, { deltaX: 0, deltaY: i % 2 === 0 ? -120 : 120 });
          await sleep(100);
        }
      }),
    );
    await evaluate("window.__quest.setFloor(2)");
    await sleep(500);
    results.push(await sample("plan-floor-3f"));

    const payload = { label, seconds, results, errors, server: serverLog.slice(-400) };
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify(payload, null, 2));
  } finally {
    ws?.close();
    chrome?.kill("SIGTERM");
    server.kill("SIGTERM");
    if (userDataDir) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
