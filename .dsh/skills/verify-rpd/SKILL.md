---
name: verify-rpd
description: Drive the real RPD map app in a browser and prove a change end to end with state assertions and screenshots. Use for /verify-rpd, "verify this RPD change", or any RPD UI, canvas, route or item behavior.
---

# Verify RPD

The app is a Vite React shell around a sokol/WebGL2 canvas. The map, menus and item markers live in the wasm; the floor selector, inventory, code entry and status live in React. Prove behavior by driving both surfaces and asserting the C and DOM state, not by reading the code.

## Launch

- Full contract: `npm run verify:rpd`. It spawns Vite on `RPD_VERIFY_PORT` (default 5199) and headless Chrome on `RPD_CHROME_PORT` (default 9222), captures the 48 baseline shots, writes `verification/rpd/current/report.json`, and kills what it started. This is the fastest proof of a UI change.
- Interactive app: `npm run dev -- --port 5273 --strictPort`. The wasm and assets are committed; run `npm run wasm` only after native changes, and `npm run build` before claiming a production build.
- Ready when `curl -sf http://localhost:5273/` returns 200, the page has `window.__quest?.setPlayer`, and `.rpd-status` is hidden.
- Teardown: kill the Vite and Chrome processes this run spawned. The contract does this itself.

## Doctor

- `curl -sf http://localhost:<port>/` and check the page exposes `window.__quest` and `window.__rpd`.
- `git status --short` must be clean for a proof; a dirty `public/rpd/rpd.wasm` means the native artifact and the source disagree.
- `git rev-parse --short HEAD` records the proof commit.

## Drive

- Use the existing harness: `tools/verify_rpd.mjs` owns the CDP connection, the `waitFor` polling and the state assertions. Add a check there instead of writing a second browser driver.
- `window.__quest` exposes the plan, the items, the menus, the popup, `overlayStats`, `project`, the player and the route. `window.__rpd` exposes the camera, the blend, `setOrbit` and the floor.
- React selectors: the floor selector buttons, `.rpd-status`, the inventory slots, the code entry inputs and the item titles.
- The sokol menu is native: right-click the canvas and click the menu cell. It is not DOM, so use coordinates projected from `window.__quest.project` or the marker positions.

## Evidence

- Screenshots go to `verification/rpd/current`; the baseline is `verification/rpd/baseline`; the full run writes `report.json` with every asserted state measured.
- Capture the action and the resulting state, and verify the side effect (the item leaves the map, the inventory changes, the route moves) alongside the pixels.
- The page-error trap fails the run on any page error; do not suppress it.
- The route, item and wall checks are part of the proof: `check:items`, the route check and the render-wall check in the contract.

## Cleanup

- The contract kills the Vite and Chrome it spawned. A manual run must stop the `npm run dev` it started. Never kill by process name.
- The evidence survives cleanup in `verification/rpd/baseline`, `verification/rpd/current` and `verification/rpd/repro`.

## Helpers

- `tools/verify_rpd.mjs` - the contract, the CDP driver and the screenshot checks.
- `tools/shot.mjs` - one-off screenshots on `RPD_SHOT_PORT` (default 5188) and `RPD_SHOT_CHROME` (default 9333).
- `src/session/devApi.ts` - the `window.__quest` API and the state it exposes.

## Maintenance

Run `/maintain-verification-skill` after the app's features or menus change, so the feature map below stays honest.
