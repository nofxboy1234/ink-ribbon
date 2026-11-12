// Walk-through capture: Claire actually walks a planned route through every
// floor, collecting the available items with the real item state machine.
// Frames are stored with their own delays so the resulting GIF is a time-lapse
// of the run with real-time interaction moments.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_PLAY_PORT ?? 5198);
const chromePort = Number(process.env.RPD_PLAY_CHROME ?? 9223);
const outDir = join(root, "verification", "rpd", "playthrough");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const limit = Number(process.env.RPD_PLAY_LIMIT ?? 0);
mkdirSync(outDir, { recursive: true });
for (const entry of readdirSync(outDir)) {
  if (entry.endsWith(".png") || entry.endsWith(".gif") || entry === "timeline.json" || entry === "debug.log") {
    rmSync(join(outDir, entry), { force: true });
  }
}

const registry = JSON.parse(
  readFileSync(join(root, "public", "rpd", "item_registry.json"), "utf8"),
).items;
const idAt = registry.map((item) => item.id);
const indexById = new Map(idAt.map((id, index) => [id, index]));

const nav = JSON.parse(readFileSync(join(root, "public", "rpd", "nav.json"), "utf8"));
const navNodes = nav.nodes;
const portalLinks = [];
for (const [a, b] of nav.portals) {
  portalLinks.push({ a, b });
  portalLinks.push({ a: b, b: a });
}

function nextHop(from, to) {
  const queue = [{ floor: from, a: -1, b: -1 }];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    if (current.floor === to) return current;
    for (const link of portalLinks) {
      if (navNodes[link.a].floor !== current.floor) continue;
      const next = navNodes[link.b].floor;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ floor: next, a: link.a, b: link.b });
    }
  }
  return null;
}

function hopDistance(from, to) {
  if (from === to) return 0;
  const queue = [{ floor: from, depth: 0 }];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    for (const link of portalLinks) {
      if (navNodes[link.a].floor !== current.floor) continue;
      const next = navNodes[link.b].floor;
      if (next === to) return current.depth + 1;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ floor: next, depth: current.depth + 1 });
    }
  }
  return 99;
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
  const started = Date.now();
  try {
    await waitForHttp(`http://localhost:${port}/`);
    userDataDir = mkdtempSync(join(tmpdir(), "rpd-play-"));
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
    const click = async (x, y, button = "left") => {
      const buttons = button === "right" ? 2 : 1;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(60);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: `http://localhost:${port}/` });
    for (let i = 0; i < 100; i += 1) {
      await sleep(300);
      if (await evaluate("Boolean(window.__quest?.setPlayer)")) break;
    }

    const timeline = [];
    let frame = 0;
    const snap = async (ms) => {
      const name = `p-${String(frame).padStart(4, "0")}`;
      frame += 1;
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, "base64"));
      timeline.push({ file: `${name}.png`, ms });
    };

    const debug = () => evaluate("window.__quest.debug()");
    const items = () => evaluate("window.__quest.items()");
    const player = () => evaluate("window.__quest.debug().player");

    const report = {
      frames: 0,
      actions: 0,
      walked: 0,
      boxed: 0,
      floors: [],
      fallbacks: [],
      failed: [],
    };

    const planMode = async () => {
      await evaluate("window.__rpd.setOrbit(0, 0, 0, 0, 1.2, 40)");
      await evaluate("window.__rpd.resetView()");
      await sleep(250);
    };

    // Running (1.5x) is a menu toggle; give the menu a route so Run is enabled.
    const enableRun = async () => {
      const list = await items();
      const first = list.find(
        (item) => item.state === 1 && item.available && [1, 2, 3].includes(item.action) && item.node >= 0,
      );
      if (!first) return false;
      await evaluate(`window.__quest.addTargetNode(${first.node})`);
      const where = await player();
      const screen = await evaluate(`window.__quest.project(${where[0]}, ${where[1]}, ${where[2]})`);
      if (!screen) return false;
      await click(screen.x, screen.y, "right");
      await sleep(250);
      const popup = await evaluate("window.__quest.popup()");
      report.popup = { open: popup.open, menu: popup.menu, choices: popup.choices.map((choice) => `${choice.enabled ? "+" : "-"}${choice.label}`) };
      const run = popup.choices.find((choice) => choice.enabled && choice.label === "Run");
      if (run) {
        await click((run.x0 + run.x1) / 2, (run.y0 + run.y1) / 2);
        await sleep(300);
      }
      if (await evaluate("window.__quest.popup().open")) await evaluate("window.__rpd.popupClose()");
      await evaluate("window.__quest.reset()");
      return Boolean(run);
    };

    // Opening frame of the 2D plan before the walk starts.
    await planMode();
    report.run = await enableRun();
    await snap(600);
    await snap(200);

    const routeLength = async () => {
      const points = await evaluate("window.__rpd.planRouteCount()");
      if (points < 1) return 0;
      return evaluate(
        "(() => { const r = window.__rpd.planRoute(); let d = 0; for (let i = 3; i < r.length; i += 3) d += Math.hypot(r[i] - r[i-3], r[i+1] - r[i-2], r[i+2] - r[i-1]); return d; })()",
      );
    };

    const walkTo = async (node) => {
      await evaluate("window.__quest.reset()");
      await evaluate(`window.__quest.addTargetNode(${node})`);
      const metres = await routeLength();
      if (metres <= 0) return { ok: false, metres: 0 };
      await evaluate("window.__rpd.planStartMove()");
      const start = Date.now();
      while (Date.now() - start < 240000) {
        await sleep(650);
        await snap(45);
        if (!(await evaluate("window.__quest.debug().moving"))) break;
      }
      return { ok: true, metres };
    };

    // Keys that some still-present item needs must stay in the eight slots; the
    // rest of the inventory can move to the box so the next take has room.
    const guardedSet = (list) => {
      const guarded = new Set();
      for (const item of list) {
        if (item.state !== 1) continue;
        const def = registry[item.index];
        if (!def) continue;
        for (const id of [...(def.requires ?? []), ...(def.requires_open ?? [])]) {
          const index = indexById.get(id);
          if (index !== undefined) guarded.add(index);
        }
      }
      return guarded;
    };

    const boxCarried = async (guarded, allowGuarded = false) => {
      const keyIndex = await evaluate("window.__quest.itemByName('Parking Garage Key Card')");
      const slots = [];
      for (let slot = 0; slot < 8; slot += 1) {
        const item = await evaluate(`window.__rpd.inventoryItem(${slot})`);
        if (item < 0) continue;
        slots.push({ slot, item, guarded: guarded.has(item) });
      }
      const pick =
        slots.find((entry) => entry.item !== keyIndex && !entry.guarded) ??
        (allowGuarded ? slots.find((entry) => entry.item !== keyIndex) : null);
      if (!pick) return false;
      if (await evaluate(`window.__quest.boxStore(${pick.item})`) !== 0) return false;
      report.boxed += 1;
      await sleep(90);
      await snap(100);
      return true;
    };

    const act = async (index, guarded) => {
      let code = await evaluate(`window.__quest.actItem(${index})`);
      if (code === -1) {
        await boxCarried(guarded, true);
        code = await evaluate(`window.__quest.actItem(${index})`);
      }
      report.actions += 1;
      await sleep(90);
      await snap(120);
      // A carried item that no gate needs goes straight to the box, so the
      // next take always has a free slot.
      if (code === 0 && !guarded.has(index)) {
        if (await evaluate(`window.__quest.boxStore(${index})`) === 0) {
          report.boxed += 1;
          await sleep(80);
          await snap(120);
        }
      }
      return code;
    };

    const travelToFloor = async (targetFloor) => {
      let floor = (await debug()).activeFloor;
      if (floor === targetFloor) return true;
      while (floor !== targetFloor) {
        const hop = nextHop(floor, targetFloor);
        if (!hop) return false;
        const from = navNodes[hop.a];
        const to = navNodes[hop.b];
        const cell = await evaluate(`window.__quest.nearestCell(${from.x}, ${from.z})`);
        let walked = false;
        if (cell) walked = (await walkTo(cell.node)).ok;
        await evaluate(`window.__quest.setFloor(${to.floor})`);
        await evaluate(`window.__quest.setPlayer(${to.x}, ${to.y}, ${to.z})`);
        await sleep(500);
        await evaluate("window.__rpd.resetView()");
        await sleep(300);
        await snap(220);
        await snap(160);
        if (!report.floors.includes(to.floor)) report.floors.push(to.floor);
        if (!walked) report.fallbacks.push(`stairs ${floor}->${to.floor}`);
        floor = to.floor;
      }
      return true;
    };

    const deferred = new Map();
    const seen = new Set();
    const failedSeen = new Set();
    let guard = 0;
    while (guard < 700) {
      guard += 1;
      if (limit && report.actions >= limit) break;
      const list = await items();
      const guarded = guardedSet(list);
      const candidates = list.filter(
        (item) =>
          !seen.has(item.index) &&
          !failedSeen.has(item.index) &&
          !deferred.has(item.index) &&
          item.state === 1 &&
          (item.action === 1 || item.action === 2 || item.action === 3) &&
          item.available,
      );

      // Retry a deferred item every few steps: a door opened since then may
      // have made its route walkable.
      if (deferred.size && guard % 6 === 0) {
        const [index, item] = deferred.entries().next().value;
        deferred.delete(index);
        const retry = item.node >= 0 ? await walkTo(item.node) : { ok: false, metres: 0 };
        if (retry.ok) {
          report.walked += retry.metres;
          if (await act(index, guarded) === 0) seen.add(index);
          else failedSeen.add(index);
        } else {
          deferred.set(index, item);
        }
        continue;
      }

      if (!candidates.length && deferred.size) {
        const [index, item] = deferred.entries().next().value;
        deferred.delete(index);
        const retry = item.node >= 0 ? await walkTo(item.node) : { ok: false, metres: 0 };
        if (retry.ok) report.walked += retry.metres;
        else {
          await evaluate(`window.__quest.standAt(${index})`);
          await sleep(400);
          report.fallbacks.push(`stood at ${item.name}`);
        }
        if (await act(index, guarded) === 0) seen.add(index);
        else failedSeen.add(index);
        continue;
      }
      appendFileSync(join(outDir, "debug.log"), `iter ${guard} floor ${(await debug()).activeFloor} candidates ${candidates.length} deferred ${deferred.size}\n`);
      if (!candidates.length) break;

      const state = await debug();
      const position = await player();
      const onFloor = candidates.filter((item) => item.floor === state.activeFloor);
      let pick = onFloor.sort(
        (a, b) =>
          Math.abs(a.x - position[0]) + Math.abs(a.z - position[2]) -
          (Math.abs(b.x - position[0]) + Math.abs(b.z - position[2])),
      )[0];
      if (!pick) {
        const floors = [...new Set(candidates.map((item) => item.floor))];
        floors.sort((a, b) => {
          const hopA = hopDistance(state.activeFloor, a);
          const hopB = hopDistance(state.activeFloor, b);
          if (hopA !== hopB) return hopA - hopB;
          const countA = candidates.filter((item) => item.floor === a).length;
          const countB = candidates.filter((item) => item.floor === b).length;
          return countB - countA;
        });
        const reached = await travelToFloor(floors[0]);
        if (!reached) break;
        continue;
      }
      if (!report.floors.includes(state.activeFloor)) report.floors.push(state.activeFloor);

      const walk = pick.node >= 0 ? await walkTo(pick.node) : { ok: false, metres: 0 };
      appendFileSync(join(outDir, "debug.log"), `walk ${pick.name} node ${pick.node} ok ${walk.ok} m ${Math.round(walk.metres)}\n`);
      if (walk.ok) report.walked += walk.metres;
      else {
        deferred.set(pick.index, pick);
        continue;
      }
      const code = await act(pick.index, guarded);
      appendFileSync(join(outDir, "debug.log"), `act ${pick.name} code ${code}\n`);
      if (code !== 0) {
        deferred.set(pick.index, pick);
        continue;
      }
      seen.add(pick.index);
    }

    // Make sure the garage ending is actually reached: carry the key card and
    // use the Card Reader on B1.
    const keyIndex = await evaluate("window.__quest.itemByName('Parking Garage Key Card')");
    const endingList = await items();
    const endingGuarded = guardedSet(endingList);
    if (keyIndex >= 0) {
      const inv = await evaluate("window.__quest.inventory().filter(Boolean).length");
      if (inv >= 8) await boxCarried(endingGuarded, true);
      const box = await evaluate("window.__quest.box()");
      const keySlot = box.find((entry) => entry.name === "Parking Garage Key Card");
      if (keySlot) await evaluate(`window.__quest.boxTake(${keySlot.slot})`);
      await sleep(250);
      await snap(200);
    }
    const readerIndex = await evaluate("window.__quest.itemByName('Card Reader')");
    if (readerIndex >= 0) {
      const list = await items();
      const reader = list.find((item) => item.index === readerIndex);
      if (reader && reader.state === 1) {
        await travelToFloor(reader.floor);
        const walk = reader.node >= 0 ? await walkTo(reader.node) : { ok: false, metres: 0 };
        if (!walk.ok) await evaluate(`window.__quest.standAt(${readerIndex})`);
        await act(readerIndex, endingGuarded);
      }
    }

    // Final top-down still of the ending floor.
    await travelToFloor(4);
    await planMode();
    await evaluate("window.__rpd.resetView()");
    await sleep(400);
    await snap(1500);

    report.pending = await evaluate(`(() => {
      const list = window.__quest.items();
      const present = list.filter((item) => item.state === 1);
      const available = present.filter((item) => item.available);
      const byAction = {};
      for (const item of available) byAction[item.action] = (byAction[item.action] ?? 0) + 1;
      return {
        hidden: list.filter((item) => item.state === 0).length,
        present: present.length,
        available: available.length,
        byAction,
        sample: present.filter((item) => !item.available).slice(0, 10).map((item) => ({ name: item.name, action: item.action })),
      };
    })()`);
    report.frames = frame;
    report.collected = await evaluate("window.__quest.items().filter((item) => item.state >= 2).length");
    report.boxedTotal = await evaluate("window.__quest.box().length");
    report.health = await evaluate("window.__quest.health()");
    report.enemies = await evaluate("window.__quest.enemies().length");
    report.garage = await evaluate("window.__quest.ending()");
    report.key = await evaluate("window.__quest.items().find((item) => item.name === 'Parking Garage Key Card')?.state");
    report.reader = await evaluate("window.__quest.items().find((item) => item.name === 'Card Reader')?.state");
    report.items = await evaluate("window.__quest.items().length");
    report.minutes = Math.round((Date.now() - started) / 6000) / 10;

    writeFileSync(join(outDir, "timeline.json"), JSON.stringify({ ortho: timeline, persp: [] }, null, 2));
    writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log("playthrough", JSON.stringify(report));
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
