import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_ACCEPT_PORT ?? 5199);
const chromePort = Number(process.env.RPD_CHROME_PORT ?? 9222);
const outDir = join(root, "verification", "rpd", "acceptance");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  let chrome;
  let userDataDir;
  try {
    await waitForHttp(`http://localhost:${port}/`);
    userDataDir = mkdtempSync(join(tmpdir(), "rpd-accept-"));
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
    const target = pages.find((page) => page.type === "page");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
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
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return result?.result?.value;
    };
    const shot = async (name) => {
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, "base64"));
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: `http://localhost:${port}/` });
    for (let i = 0; i < 100; i += 1) {
      await sleep(300);
      if (await evaluate("Boolean(window.__quest?.setPlayer)")) break;
    }

    const report = { collected: 0, boxed: 0, saved: 0, garage: false, views: [] };
    await evaluate("window.__quest.reset()");

    // Dependency-aware collection: repeat the take/unlock/open passes until a
    // pass makes no progress. The debug take bypasses the reach but not the
    // item's own key and container prerequisites.
    for (let pass = 0; pass < 12; pass += 1) {
      let changed = 0;
      const pending = await evaluate(
        "window.__quest.items().filter((item) => item.state === 1).map((item) => item.index)",
      );
      for (const index of pending) {
        const kind = await evaluate(`window.__quest.items()[${index}].action`);
        if (kind !== 1 && kind !== 2 && kind !== 3) continue;
        let code = await evaluate(`window.__quest.actItem(${index})`);
        if (code !== 0 && kind === 1) {
          const carried = await evaluate("window.__quest.items().filter((item) => item.state === 2).map((item) => item.index)");
          for (const taken of carried) await evaluate(`window.__quest.boxStore(${taken})`);
          code = await evaluate(`window.__quest.itemDebugTake(${index})`);
        }
        if (code === 0) changed += 1;
      }
      if (!changed) break;
    }
    // The keycard must be carried, not boxed, for the Card Reader to unlock.
    const keySlot = await evaluate(
      "window.__quest.box().find((entry) => entry.name === 'Parking Garage Key Card')?.slot ?? -1",
    );
    if (keySlot >= 0) await evaluate(`window.__quest.boxTake(${keySlot})`);
    const readerIndex = await evaluate(
      "window.__quest.items().find((item) => item.name === 'Card Reader')?.index ?? -1",
    );
    if (readerIndex >= 0) await evaluate(`window.__quest.actItem(${readerIndex})`);
    report.collected = await evaluate("window.__quest.items().filter((item) => item.state >= 2).length");

    const box = await evaluate("window.__quest.box().length");
    report.boxed = box;

    // A real sequence instead of two stills: the camera moves through the
    // collected map, then the ending view. The GIFs are built from these.
    await evaluate("window.__quest.toggleDebug()");
    for (let frame = 0; frame < 20; frame += 1) {
      await evaluate(`window.__rpd.setOrbit(${-40 + frame * 4}, 0, ${-10 + frame * 1.5}, 0, ${1.1 + frame * 0.01}, ${18 - frame * 0.3})`);
      await sleep(120);
      await shot(`ortho-${String(frame).padStart(2, "0")}`);
    }
    await evaluate("window.__rpd.setViewMode(0)");
    for (let frame = 0; frame < 20; frame += 1) {
      await evaluate(`window.__rpd.setOrbit(${-40 + frame * 4}, 0, ${-10 + frame * 1.5}, 0, ${1.1 + frame * 0.01}, ${18 - frame * 0.3})`);
      await sleep(120);
      await shot(`persp-${String(frame).padStart(2, "0")}`);
    }
    await evaluate("window.__rpd.setViewMode(1)");
    await shot("03-ortho-final");

    report.saved = await evaluate("window.__quest.saveSnapshot().length");
    report.reader = await evaluate("window.__quest.items().find((item) => item.name === 'Card Reader')?.state");
    report.key = await evaluate("window.__quest.items().find((item) => item.name === 'Parking Garage Key Card')?.state");
    report.garage = await evaluate("window.__quest.ending()");
    report.items = await evaluate("window.__quest.items().length");
    report.health = await evaluate("window.__quest.health()");
    report.enemies = await evaluate("window.__quest.enemies().length");

    writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log("acceptance", JSON.stringify(report));
    socket.close();
  } finally {
    chrome?.kill();
    server.kill();
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
