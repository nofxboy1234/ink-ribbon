import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_ACCEPT_PORT ?? 5199);
const chromePort = Number(process.env.RPD_CHROME_PORT ?? 9222);
const outDir = join(root, "verification", "rpd", "acceptance");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(outDir, { recursive: true });
// Start from a clean frame set so stale shots never leak into the GIFs.
for (const entry of readdirSync(outDir)) {
  if (entry.endsWith(".png") || entry.endsWith(".gif") || entry === "timeline.json") {
    rmSync(join(outDir, entry), { force: true });
  }
}

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

    // Save/load round trip: snapshot, change the inventory, restore, assert.
    const snapshot = await evaluate("Array.from(window.__quest.saveSnapshot())");
    const carriedBefore = await evaluate(
      "window.__quest.items().filter((item) => item.state === 2).map((item) => item.index)",
    );
    const inventoryBefore = await evaluate("window.__quest.inventory().filter(Boolean).length");
    const slotItem = await evaluate("window.__rpd.inventoryItem(0)");
    let boxCode = null;
    if (slotItem >= 0) boxCode = await evaluate(`window.__quest.boxStore(${slotItem})`);
    const inventoryBoxed = await evaluate("window.__quest.inventory().filter(Boolean).length");
    await evaluate(`window.__quest.saveRestore(${JSON.stringify(snapshot)})`);
    const inventoryAfter = await evaluate("window.__quest.inventory().filter(Boolean).length");
    report.saved = snapshot.length;
    report.inventory = [inventoryBefore, inventoryBoxed, inventoryAfter, boxCode, slotItem, carriedBefore.length];
    report.savedRoundTrip =
      inventoryBoxed === inventoryBefore - 1 && inventoryAfter === inventoryBefore;

    // The GIF timeline mixes time-lapse camera moves with real-time moments so
    // the menu and the item panel play at their natural speed.
    const ortho = [];
    const persp = [];
    const frames = (view, list) => ({
      add: async (name, ms) => {
        await shot(`${view}-${name}`);
        list.push({ file: `${view}-${name}.png`, ms });
      },
    });
    const orthoShots = frames("ortho", ortho);
    const perspShots = frames("persp", persp);
    const click = async (x, y, button = "left") => {
      const buttons = button === "right" ? 2 : 1;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(80);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
    };

    await evaluate("window.__quest.toggleDebug()");

    const planMode = async () => {
      await evaluate("window.__rpd.setViewMode(1)");
      await evaluate("window.__rpd.setOrbit(0, 0, 0, 0, 1.2, 40)");
      await evaluate("window.__rpd.resetView()");
      await sleep(250);
    };

    // Time-lapse walk in the 2D plan: put Claire on 1F, plan a route through
    // the rooms and start it, sampling the plan while she walks.
    await planMode();
    await evaluate("window.__quest.setFloor(0)");
    await evaluate("window.__quest.reset()");
    const rooms = await evaluate("window.__quest.rooms().filter((room) => room.floor === 0)");
    if (rooms.length) {
      await evaluate(`window.__quest.setPlayer(${rooms[0].x}, ${rooms[0].y}, ${rooms[0].z})`);
    }
    await evaluate("window.__rpd.resetView()");
    await sleep(300);
    let walkCells = 0;
    for (const room of rooms.slice(1, 4)) {
      const cell = await evaluate(`window.__quest.nearestCell(${room.x}, ${room.z})`);
      if (!cell) continue;
      await evaluate(`window.__quest.addTargetNode(${cell.node})`);
      walkCells += 1;
    }
    let walked = 0;
    if (walkCells > 0) await evaluate("window.__rpd.planStartMove()");
    for (let frame = 0; frame < 24; frame += 1) {
      await sleep(320);
      await orthoShots.add(`walk-${String(frame).padStart(2, "0")}`, 80);
      walked = frame;
      const state = await evaluate(
        "({ moving: window.__quest.debug().moving, health: window.__quest.health() })",
      );
      if (!state.moving || state.health < 80) break;
    }
    report.walkedFrames = walked;
    await evaluate("window.__quest.reset()");
    await evaluate("window.__rpd.resetView()");
    await sleep(300);
    const pose = await evaluate("window.__quest.cameraPose()");
    const [cx, , cz] = pose;
    const orthoDistance = pose[8];

    // Time-lapse survey of the fitted 1F plan: a slow zoom in and back out
    // while the target drifts across the rooms.
    for (let frame = 0; frame < 20; frame += 1) {
      const t = frame / 19;
      const zoom = 1 - 0.24 * Math.sin(t * Math.PI);
      const x = cx + Math.sin(t * Math.PI * 2) * 2.5;
      const z = cz + Math.cos(t * Math.PI * 2) * 1.8;
      await evaluate(
        `window.__rpd.setOrbit(${x}, ${pose[1]}, ${z}, 0, 1.2, ${(orthoDistance * zoom).toFixed(3)})`,
      );
      await sleep(90);
      await orthoShots.add(`fly-${String(frame).padStart(2, "0")}`, 70);
    }

    // Real-time menu moment: open the waypoint menu on Claire's cell and let it
    // sit for a second before closing it.
    const player = await evaluate("window.__quest.debug().player");
    const screen = await evaluate(`window.__quest.project(${player[0]}, ${player[1]}, ${player[2]})`);
    if (screen) await click(screen.x, screen.y, "right");
    await sleep(250);
    for (let frame = 0; frame < 8; frame += 1) {
      await sleep(100);
      await orthoShots.add(`menu-${frame}`, 100);
    }
    await evaluate("window.__rpd.popupClose()");
    await sleep(150);
    await orthoShots.add("menu-closed", 120);

    // Real-time item moment: select an inventory slot and read the detail.
    await evaluate("document.querySelector('.rpd-slot[data-filled=\"true\"]')?.click()");
    await sleep(160);
    for (let frame = 0; frame < 6; frame += 1) {
      await sleep(110);
      await orthoShots.add(`item-${frame}`, 110);
    }
    await evaluate("document.querySelector('.rpd-slot[data-filled=\"true\"]')?.click()");
    await sleep(120);

    // Perspective flyover of the same map, plus the item moment again.
    await evaluate("window.__rpd.setViewMode(0)");
    for (let frame = 0; frame < 20; frame += 1) {
      const t = frame / 19;
      await evaluate(
        `window.__rpd.setOrbit(${cx}, 4, ${cz}, ${-0.6 + t * 1.4}, ${0.32 + t * 0.18}, ${52 - t * 16})`,
      );
      await sleep(90);
      await perspShots.add(`fly-${String(frame).padStart(2, "0")}`, 70);
    }
    await evaluate("document.querySelector('.rpd-slot[data-filled=\"true\"]')?.click()");
    await sleep(160);
    for (let frame = 0; frame < 6; frame += 1) {
      await sleep(110);
      await perspShots.add(`item-${frame}`, 110);
    }
    await evaluate("document.querySelector('.rpd-slot[data-filled=\"true\"]')?.click()");
    await sleep(150);
    await perspShots.add("final", 1200);

    // Final ortho still of the ending floor.
    await evaluate("window.__quest.setFloor(4)");
    await planMode();
    await sleep(200);
    await shot("03-ortho-final");
    ortho.push({ file: "03-ortho-final.png", ms: 1500 });

    writeFileSync(join(outDir, "timeline.json"), JSON.stringify({ ortho, persp }, null, 2));

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
