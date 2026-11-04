# All-code refactor decision log

Goal: refactor all first-party code without changing behavior, verified against the browser contract and the structure gate.

Done predicate: `npm run wasm`, `npm run typecheck`, `npm run build`, `npm run check:structure`, and `npm run verify:rpd` all pass; fixed-state screenshots match the committed baseline; the Python tools reproduce the tracked data or report BLOCKED.

## Baseline

- `tools/verify_rpd.mjs` captures 12 fixed states and compares 1400x900 screenshots with a 0.1 percent pixel threshold.
- F was made deterministic by keeping the map camera on resize, refitting only on a floor change, and making floor selection sticky. F is the explicit follow action.
- Unit 0 commit: `14f8c1c`.
- Baseline: `verification/rpd/baseline/`.

## Units

| Unit | Commit | Gate | Verdict |
|---|---|---|---|
| 0 browser contract and baseline | `14f8c1c` | 12 screenshots, no console errors | VERIFIED |
| 1 typed WASM client | `da9850e` | no raw `_rpd_*` outside client, contract | VERIFIED |
| 2-3 map geometry, camera, pointer, labels | `ea9e0e1` | contract, FloorMap2D under 200 | VERIFIED |
| 4 3D overlay renderer | `ea9e0e1` | contract, overlay unchanged | VERIFIED |
| 7 stylesheet split and dedupe | `0f719d2` | contract, no duplicate selectors | VERIFIED |
| 8 native module split | `1622f19` | wasm, build, contract; main.c 29, largest 552 | VERIFIED |
| 9 Python tools split | `ec66de2` | data parity, py_compile, largest 567 | VERIFIED |
| 5-6 RpdScene session and UI split | `7d71fe7` | RpdScene 57, largest new file 350, structure gate, contract | VERIFIED |

## Final gates

Run on the merged root after all units:

- `npm run wasm` 0
- `npm run typecheck` 0
- `npm run build` 0
- `npm run check:structure` 0, "Structure checks passed."
- `npm run verify:rpd` 0, "Contract passed. 12 screenshots matched."

Structural result: `RpdScene.tsx` 57 lines; largest runtime file `native/src/rpd_scene.c` 552; largest TS file `src/session/useQuestSession.ts` 350; `native/main.c` 29; no raw `_rpd_*` outside `src/wasm/client.ts`; no duplicate `RpdModule`; no duplicate CSS selectors.

## Data caveats

- `public/rpd/quest.json` is the hand-edited three-item fixture from `c2587e2`, not tool output. `npm run quest:data` overwrites it with the 112-item dataset. The tools lane compared against the HEAD-tool output and restored the fixture.
- `build/rpd.blend` contains manual edits that raw extraction does not reproduce. `npm run data` produces a different `rpd.bin`; the committed blend and binary were restored and reproduced.
- The tools lane added `tools/check_data_parity.py` as the rerunnable semantic and checksum comparator.

## Native caveat

The native lane reproduced the pre-existing `06-before-f` timing flake on the original base. The floor-sticky/focus fix in Unit 0 and 3 removes the race; the merged app passed the full contract.
