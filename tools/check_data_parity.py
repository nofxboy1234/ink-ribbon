#!/usr/bin/env python3
"""Compare two public/rpd directories for the data contract.

JSON artifacts are compared by parsed value so formatting and key order do not
count as a change. Binary artifacts are compared by SHA-256.

    python3 tools/check_data_parity.py BASELINE CURRENT
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys

ARTIFACTS = ("grid.json", "nav.json", "quest.json", "rpd.json", "rpd.bin", "rpd.wasm")
JSON_ARTIFACTS = {name for name in ARTIFACTS if name.endswith(".json")}
MAX_REPORTED = 20


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def differences(left, right, path: str = ""):
    if type(left) is not type(right):
        yield f"{path or '<root>'}: {type(left).__name__} != {type(right).__name__}"
        return
    if isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            child = f"{path}.{key}" if path else key
            if key not in left:
                yield f"{child}: missing in baseline"
            elif key not in right:
                yield f"{child}: missing in current"
            else:
                yield from differences(left[key], right[key], child)
        return
    if isinstance(left, list):
        if len(left) != len(right):
            yield f"{path}: length {len(left)} != {len(right)}"
            return
        for index, (a, b) in enumerate(zip(left, right)):
            yield from differences(a, b, f"{path}[{index}]")
        return
    if left != right:
        yield f"{path}: {left!r} != {right!r}"


def compare(baseline: pathlib.Path, current: pathlib.Path) -> int:
    failures = 0
    for name in ARTIFACTS:
        a = baseline / name
        b = current / name
        if not a.exists() or not b.exists():
            missing = "baseline" if not a.exists() else "current"
            print(f"FAIL {name}: missing from {missing}")
            failures += 1
            continue
        if a.read_bytes() == b.read_bytes():
            print(f"PASS {name}: byte-identical (sha256 {digest(a)})")
            continue
        if name in JSON_ARTIFACTS:
            found = list(differences(json.loads(a.read_text()), json.loads(b.read_text())))
            if not found:
                print(f"PASS {name}: semantically identical, bytes differ (sha256 {digest(a)} -> {digest(b)})")
                continue
            print(f"FAIL {name}: {len(found)} semantic difference(s)")
            for line in found[:MAX_REPORTED]:
                print(f"  {line}")
            if len(found) > MAX_REPORTED:
                print(f"  ... {len(found) - MAX_REPORTED} more")
        else:
            print(f"FAIL {name}: sha256 {digest(a)} -> {digest(b)}")
        failures += 1
    return 1 if failures else 0


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__.strip().splitlines()[-1].strip())
    return compare(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))


if __name__ == "__main__":
    sys.exit(main())
