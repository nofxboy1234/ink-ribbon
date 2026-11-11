// Containers and puzzles must emit their contents onto the map at the
// container's own cell, and debug mode must open or solve them regardless of
// keys, codes or puzzle prerequisites.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_CONTAINER_PORT ?? 5184);
const chromePort = Number(process.env.RPD_CONTAINER_CHROME ?? 9242);
const outDir = join(root, "verification", "rpd", "containers");
const registry = JSON.parse(readFileSync(join(root, "public", "rpd", "item_registry.json"), "utf8")).items;
const byId = new Map(registry.map((entry) => [entry.id, entry]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(outDir, { recursive: true });

const waitForHttp = async (url, timeoutMs = 30000) => {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`timeout ${url}`);
    await sleep(150);
  }
};

const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, NODE_ENV: "development" },
});
let chrome;
let userDataDir;
try {
  await waitForHttp(`http://localhost:${port}/`);
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-containers-"));
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
  const socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
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
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return res?.exceptionDetails ? undefined : res?.result?.value;
  };
  const click = async (x, y, button = "left") => {
    const buttons = button === "right" ? 2 : 1;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(60);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
  };
  const shot = async (name) => {
    const result = await send("Page.captureScreenshot", { format: "png" });
    const path = join(outDir, `${name}.png`);
    writeFileSync(path, Buffer.from(result.data, "base64"));
    return path;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${port}/` });
  for (let i = 0; i < 300; i += 1) {
    await sleep(300);
    if (await evaluate("(() => { try { return (window.__quest?.items?.().length ?? 0) > 200; } catch { return false; } })()")) break;
  }
  await evaluate("window.__rpd.setViewMode(1)");
  await evaluate("window.__quest.toggleDebug()");
  await sleep(400);

  const find = async (title, floor) => {
    await evaluate(`window.__quest.setFloor(${floor})`);
    await evaluate("window.__rpd.resetView()");
    await sleep(400);
    return evaluate(`(() => { const list = window.__quest.items(); const item = list.find((entry) => entry.name === ${JSON.stringify(title)} && entry.state === 1); return item ? item.index : -1; })()`);
  };
  const menuChoices = async (index) => {
    const item = await evaluate(`window.__quest.items()[${index}]`);
    const screen = await evaluate(`window.__quest.project(${item.cubeX}, ${item.cubeY}, ${item.cubeZ})`);
    if (!screen) return [];
    for (const [dx, dy] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [7, 7], [-7, -7]]) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: screen.x + dx, y: screen.y + dy });
      await sleep(150);
      if ((await evaluate("window.__quest.hoverItem()")) !== index) continue;
      await click(screen.x + dx, screen.y + dy, "right");
      await sleep(250);
      const labels = await evaluate("window.__quest.popup().choices.map((choice) => choice.label)");
      await evaluate("window.__rpd.popupClose()");
      await sleep(100);
      return labels ?? [];
    }
    return [];
  };
  const state = async (index) => evaluate(`JSON.stringify(window.__quest.items()[${index}])`).then((value) => JSON.parse(value));

  const cases = [
    { name: "normal-open", title: "Portable Safe", floor: 1, action: "actItem", contentIds: [544477] },
    { name: "debug-open-code", title: "Dial Lock", floor: 1, action: "itemDebugOpen", contentIds: [544480] },
    { name: "debug-open-key", title: "Weapons Locker", floor: 0, action: "itemDebugOpen", contentIds: [544598, 544599] },
    { name: "normal-solve", title: "Maiden Statue", floor: 2, action: "actItem", contentIds: [544543] },
    { name: "debug-solve", title: "Clock Tower Puzzle", floor: 2, action: "itemDebugSolve", contentIds: [544539] },
  ];
  const results = [];
  for (const testCase of cases) {
    const containerIndex = await find(testCase.title, testCase.floor);
    if (containerIndex < 0) {
      results.push({ ...testCase, error: "container not found" });
      continue;
    }
    const container = await state(containerIndex);
    const labels = await menuChoices(containerIndex);
    const contentIndices = [];
    for (const contentId of testCase.contentIds) {
      const index = await evaluate(`window.__rpd.itemIndexForId(${contentId})`);
      contentIndices.push(index);
    }
    const before = [];
    for (const index of contentIndices) before.push(await state(index));
    const markersBefore = await evaluate("window.__rpd.markerCount()");
    const code = await evaluate(`window.__quest.${testCase.action}(${containerIndex})`);
    const markersAfter = await evaluate("window.__rpd.markerCount()");
    await sleep(400);
    const after = [];
    for (const index of contentIndices) after.push(await state(index));
    const containerAfter = await state(containerIndex);
    const placement = contentIndices.map((index, slot) => ({
      id: testCase.contentIds[slot],
      state: after[slot].state,
      dx: Math.round((after[slot].cubeX - container.cubeX) * 100) / 100,
      dz: Math.round((after[slot].cubeZ - container.cubeZ) * 100) / 100,
      floor: after[slot].floor,
    }));
    results.push({
      name: testCase.name,
      containerIndex,
      code,
      labels,
      containerStateBefore: container.state,
      containerStateAfter: containerAfter.state,
      markersBefore,
      markersAfter,
      hiddenBefore: before.map((entry) => entry.state),
      placement,
    });
    await shot(testCase.name);
  }

  const lockerResult = results.find((entry) => entry.name === "debug-open-key");
  let saveRoundTrip = null;
  if (lockerResult && lockerResult.containerIndex >= 0) {
    const snapshot = await evaluate("Array.from(window.__quest.saveSnapshot())");
    await evaluate(`window.__quest.saveRestore(${JSON.stringify(snapshot)})`);
    await sleep(400);
    const container = await state(lockerResult.containerIndex);
    const contents = [];
    for (const contentId of [544598, 544599]) {
      const index = await evaluate(`window.__rpd.itemIndexForId(${contentId})`);
      contents.push(await state(index));
    }
    saveRoundTrip = {
      state: contents.map((entry) => entry.state),
      dx: contents.map((entry) => Math.round((entry.cubeX - container.cubeX) * 100) / 100),
      dz: contents.map((entry) => Math.round((entry.cubeZ - container.cubeZ) * 100) / 100),
    };
  }
  console.log(JSON.stringify({ results, saveRoundTrip }, null, 2));
  const expectedLabels = {
    "normal-open": [],
    "debug-open-code": ["Debug open"],
    "debug-open-key": ["Debug open"],
    "normal-solve": ["Debug solve"],
    "debug-solve": ["Debug solve"],
  };
  const forbiddenLabels = {
    "normal-open": [],
    "debug-open-code": ["Debug solve"],
    "debug-open-key": ["Debug solve"],
    "normal-solve": ["Debug open"],
    "debug-solve": ["Debug open"],
  };
  const saveOk = saveRoundTrip
    ? saveRoundTrip.state.every((value) => value === 1) &&
      saveRoundTrip.dx.every((value) => Math.abs(value) <= 0.05) &&
      saveRoundTrip.dz.every((value) => Math.abs(value) <= 0.05)
    : false;
  const failed = results.some((entry) => {
    if (entry.error) return true;
    const wants = expectedLabels[entry.name] ?? [];
    const hasLabels = wants.every((label) => entry.labels.includes(label));
    const forbids = (forbiddenLabels[entry.name] ?? []).every((label) => !entry.labels.includes(label));
    const containerOpen = entry.containerStateAfter === 3;
    const revealed = entry.placement.every((content) => content.state === 1);
    const atContainer = entry.placement.every((content) => Math.abs(content.dx) <= 0.05 && Math.abs(content.dz) <= 0.05);
    const hasGraphics = entry.markersAfter > entry.markersBefore;
    return !hasLabels || !forbids || !containerOpen || !revealed || !atContainer || !hasGraphics;
  }) || !saveOk;
  if (failed) console.log("FAIL: a container or puzzle did not emit its contents at its cell, or a debug action is missing");
  if (!failed) console.log("PASS: containers and puzzles emit contents at their cell and debug actions bypass their gates");
  socket.close();
  process.exitCode = failed ? 1 : 0;
} finally {
  chrome?.kill();
  server.kill();
  if (userDataDir) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}
