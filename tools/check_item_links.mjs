// Every item's linked list must be the symmetric closure of opens/requires,
// deduplicated. The debug menu must offer one Go to per link and teleport to a
// cell beside the target, and Highlight related must be gone.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RPD_LINKS_PORT ?? 5183);
const chromePort = Number(process.env.RPD_LINKS_CHROME ?? 9243);
const outDir = join(root, "verification", "rpd", "links");
const registry = JSON.parse(readFileSync(join(root, "public", "rpd", "item_registry.json"), "utf8")).items;
const indexById = new Map(registry.map((entry, index) => [entry.id, index]));
const expectedLinks = new Map();
for (let index = 0; index < registry.length; index += 1) {
  const links = new Set();
  const item = registry[index];
  for (const id of [...(item.opens ?? []), ...(item.requires ?? [])]) {
    const target = indexById.get(id);
    if (target !== undefined && target !== index) links.add(target);
  }
  for (let other = 0; other < registry.length; other += 1) {
    if (other === index) continue;
    const candidate = registry[other];
    const ids = [...(candidate.opens ?? []), ...(candidate.requires ?? [])];
    if (ids.includes(item.id)) links.add(other);
  }
  expectedLinks.set(index, [...links].sort((a, b) => a - b));
}
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
  userDataDir = mkdtempSync(join(tmpdir(), "rpd-links-"));
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
  await evaluate("window.__quest.setFloor(0)");
  await evaluate("window.__rpd.resetView()");
  await evaluate("window.__quest.toggleDebug()");
  await sleep(500);

  const linkErrors = [];
  for (let index = 0; index < registry.length; index += 1) {
    const related = await evaluate(`window.__quest.itemRelated(${index})`);
    const expected = expectedLinks.get(index);
    const actual = [...(related ?? [])].sort((a, b) => a - b);
    const duplicates = actual.filter((value, slot) => actual.indexOf(value) !== slot);
    if (duplicates.length) linkErrors.push({ index, name: registry[index].title, error: `duplicate ${duplicates.join(",")}` });
    else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      linkErrors.push({ index, name: registry[index].title, expected, actual });
    }
  }

  const menu = async (index) => {
    const item = await evaluate(`window.__quest.items()[${index}]`);
    await evaluate(`window.__rpd.setOrbit(${item.cubeX}, ${item.cubeY}, ${item.cubeZ}, 0, 1.2, 24)`);
    await sleep(300);
    const screen = await evaluate(`window.__quest.project(${item.cubeX}, ${item.cubeY}, ${item.cubeZ})`);
    if (!screen) return null;
    for (const [dx, dy] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [7, 7], [-7, -7]]) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: screen.x + dx, y: screen.y + dy });
      await sleep(150);
      if ((await evaluate("window.__quest.hoverItem()")) !== index) continue;
      await click(screen.x + dx, screen.y + dy, "right");
      await sleep(250);
      const choices = await evaluate("window.__quest.popup().choices");
      return { choices: choices ?? [], screen: { x: screen.x + dx, y: screen.y + dy } };
    }
    return null;
  };
  const closeMenu = async () => {
    await evaluate("window.__rpd.popupClose()");
    await sleep(150);
  };

  const fuse = indexById.get(544565);
  const fusebox = indexById.get(544405);
  const fuseLinks = await evaluate(`window.__quest.itemRelated(${fuse})`);

  const teleports = [];
  for (const [name, sourceIndex, targetIndex, label] of [
    ["fusebox-to-fuse", fusebox, fuse, "Go to Fuse (Main Hall)"],
  ]) {
    const opened = await menu(sourceIndex);
    const labels = opened?.choices?.map((entry) => entry.label) ?? [];
    const choice = opened?.choices?.find((entry) => entry.label === label);
    if (!choice) {
      teleports.push({ name, error: "choice missing", labels: opened?.choices?.map((entry) => entry.label) });
      await closeMenu();
      continue;
    }
    await click((choice.x0 + choice.x1) / 2, (choice.y0 + choice.y1) / 2);
    await sleep(600);
    const player = await evaluate("window.__quest.debug().player");
    const target = await evaluate(`window.__quest.items()[${targetIndex}]`);
    teleports.push({
      name,
      labels,
      distance: Math.round(Math.hypot(player[0] - target.cubeX, player[2] - target.cubeZ) * 100) / 100,
      floor: target.floor,
    });
  }

  const boxLabels = teleports.find((entry) => entry.name === "fusebox-to-fuse")?.labels ?? [];
  console.log(JSON.stringify({ linkErrors, fuseLinks, boxLabels, teleports }, null, 2));
  const fuseOk = (fuseLinks ?? []).filter((value) => value === fusebox).length === 1;
  const boxOk = boxLabels.filter((label) => label === "Go to Fuse (Main Hall)").length === 1;
  const noHighlight = !boxLabels.some((label) => label === "Highlight related");
  const teleportOk = teleports.every((entry) => !entry.error && entry.distance > 0.2 && entry.distance < 2.5);
  const failed = linkErrors.length > 0 || !fuseOk || !boxOk || !noHighlight || !teleportOk;
  if (failed) console.log("FAIL: item links are duplicated or missing, Highlight related is still offered, or a Go to did not land beside its target");
  if (!failed) console.log("PASS: every item's links are symmetric and deduplicated, one Go to per link, teleports land beside the target");
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
