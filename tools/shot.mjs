import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_SHOT_PORT ?? 5188);
const chromePort = Number(process.env.RPD_SHOT_CHROME ?? 9333);
const outDir = join(root, "verification", "rpd", "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout ${url}`));
      setTimeout(poll, 150);
    };
    poll();
  });
}

async function main() {
  const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });
  let log = "";
  server.stdout.on("data", (c) => (log += c));
  server.stderr.on("data", (c) => (log += c));
  let chrome;
  let userDataDir;
  try {
    await waitForHttp(`http://localhost:${port}/`);
    userDataDir = mkdtempSync(join(tmpdir(), "rpd-shot-"));
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
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      if (msg.method === "Runtime.exceptionThrown")
        errors.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description ?? ""));
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error")
        errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const evalJs = async (expression) => {
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
      return res.result?.result?.value;
    };
    const shot = async (name) => {
      await evalJs("document.querySelectorAll('.rpd-fps,.rpd-toast').forEach((e) => (e.style.visibility='hidden'))");
      const res = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(res.result.data, "base64"));
      console.log("shot", name);
    };
    const key = async (code, keyName, keyCode) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: keyName, windowsVirtualKeyCode: keyCode });
      await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: keyName, windowsVirtualKeyCode: keyCode });
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.bringToFront");
    await waitForHttp(`http://localhost:${port}/`, 30000);
    for (let i = 0; i < 120; i++) {
      const ok = await evalJs("Boolean(window.__quest?.setPlayer)").catch(() => false);
      if (ok) break;
      await sleep(200);
    }
    await sleep(1200);
    console.log("state", await evalJs("JSON.stringify({floors:[...document.querySelectorAll('.rpd-floor')].map(e=>e.textContent.trim()), view:document.querySelector('.rpd-view-toggle')?.textContent.trim(), status:document.querySelector('.rpd-status')?.innerText.slice(0,120), player:window.__quest?.debug().player})"));
    await evalJs("document.body.insertAdjacentHTML('beforeend','<div id=\"probe\" style=\"position:fixed;inset:0;background:#ff0000;z-index:99999\"></div>')");
    await shot("00-probe");
    await evalJs("document.getElementById('probe')?.remove()");
    await shot("01-3d");
    await key("KeyM", "m", 77);
    await sleep(1700);
    await shot("02-ortho-1f");
    await evalJs("window.__quest.setFloor(1)");
    await sleep(900);
    await shot("03-ortho-2f");
    await evalJs("window.__quest.setFloor(2)");
    await sleep(900);
    await shot("04-ortho-3f");
    await evalJs("window.__quest.setFloor(3)");
    await sleep(900);
    await shot("05-ortho-4f");
    await evalJs("window.__quest.setFloor(4)");
    await sleep(900);
    await shot("06-ortho-b1");
    await evalJs("window.__quest.setFloor(0)");
    await sleep(900);
    await shot("07-ortho-1f-clean");

    // Waypoint: click a room on 1F and commit the move.
    const mouse = (type, x, y, extra = {}) =>
      send("Input.dispatchMouseEvent", {
        type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra,
      });
    await mouse("mouseMoved", 320, 350);
    await sleep(300);
    await shot("08-hover");
    await mouse("mousePressed", 320, 350);
    await mouse("mouseReleased", 320, 350);
    await sleep(700);
    await shot("09-popup");
    console.log("popup", JSON.stringify(await evalJs("document.querySelector('.rpd-popup-layer')?.innerText ?? null")));
    const chose = await evalJs("(() => { const b=document.querySelector('.rpd-popup-choice:not(:disabled)'); if(!b) return false; b.click(); return true; })()");
    console.log("chose", chose);
    await sleep(700);
    await shot("10-plan");
    console.log("plan", await evalJs("JSON.stringify(window.__quest.debug().plan)"));
    console.log("checkPath", await evalJs("JSON.stringify(window.__quest.checkPath())"));

    // Run by double-clicking Claire's capsule.
    const claire = await evalJs("JSON.stringify(window.__quest.project(...window.__quest.debug().player))");
    console.log("claire", claire);
    if (claire) {
      const c = JSON.parse(claire);
      for (let i = 0; i < 2; i += 1) {
        await mouse("mousePressed", c.x, c.y, { clickCount: 2 });
        await mouse("mouseReleased", c.x, c.y, { clickCount: 2 });
      }
      await sleep(1800);
      await shot("11-running-ortho");
      await key("KeyM", "m", 77);
      await sleep(1500);
      await evalJs("window.__rpd.setOrbit(0, 2, 0, -0.95, 0.32, 175)");
      await sleep(700);
      await shot("12-running-3d");
      await sleep(2500);
      await shot("13-running-3d-later");
      console.log("moving", await evalJs("JSON.stringify(window.__quest.debug())"));
    }
    for (let i = 0; i < 200; i += 1) {
      await sleep(150);
      if (!(await evalJs("window.__quest.debug().moving"))) break;
    }
    await evalJs("window.__quest.setPlayer(0, 0.02, 7.5)");
    await sleep(400);
    // Cross-floor routing checks (4F, B1, back to 1F).
    for (const [floor, x, z, name] of [[3, 30, -17, "4F"], [4, 10, 10, "B1"], [1, 0, 4, "2F"]]) {
      await evalJs(`window.__quest.setFloor(${floor})`);
      await sleep(400);
      await evalJs(`window.__quest.previewCell(${x}, ${z})`);
      await sleep(600);
      console.log("preview", name, await evalJs("JSON.stringify({popup:document.querySelector('.rpd-popup-layer')?.innerText ?? null, toast:document.querySelector('.rpd-toast')?.innerText ?? null, note:document.querySelector('.rpd-note')?.innerText ?? null})"));
      const ok = await evalJs("(() => { const b=document.querySelector('.rpd-popup-choice:not(:disabled)'); if(!b) return false; b.click(); return true; })()");
      const plan = await evalJs("JSON.stringify(window.__quest.debug().plan)");
      console.log("cross", name, "chose", ok, "plan", plan);
      if (!ok) continue;
      await sleep(400);
      await evalJs("window.__quest.run()");
      for (let i = 0; i < 200; i += 1) {
        await sleep(150);
        if (!(await evalJs("window.__quest.debug().moving"))) break;
      }
      console.log("arrived", name, await evalJs("JSON.stringify(window.__quest.debug())"));
    }
    const view = await evalJs("JSON.stringify({view:document.querySelector('.rpd-view-toggle')?.textContent.trim(), plan:window.__quest.debug().plan, cells:document.querySelector('.rpd-map-title')?.innerText, matrix:Array.from(window.__quest.matrix()).map(v=>+v.toFixed(3))})");
    console.log("after ortho", view);
    const cam = await evalJs("JSON.stringify(Array.from(window.__rpd?.getViewProj?.() ?? []))").catch(()=>null);
    console.log("vp", cam);
    console.log("errors", errors.slice(0, 12));
    ws.close();
  } finally {
    chrome?.kill("SIGTERM");
    server.kill("SIGTERM");
    if (userDataDir) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
    if (log.includes("error")) console.log(log.slice(-2000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
