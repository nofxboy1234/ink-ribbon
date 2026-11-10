# Code entry

## Sub-features

The coded locks, the code entry panel in the React UI, the code grants and the opened lock state.

## How to get to it (user POV)

Act on a coded lock; the code panel opens. Enter the three-digit code. A correct code opens the lock and grants what is inside.

## Driving it with the contract

- `window.__quest.itemHasCode(index)` and `window.__quest.enterCode(code)`.
- Assert the panel opens, the input accepts the code, and the lock state changes.
- `npm run check:items` covers the remaining coded locks.

## Gotchas

Only two of the four coded locks are driven through the browser UI; the rest are covered by the item check. A wrong code must not open the lock and must not consume the item.
