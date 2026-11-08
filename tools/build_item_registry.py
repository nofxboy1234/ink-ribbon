#!/usr/bin/env python3
"""Join the MapGenie markers, item models and icons into one item registry.

The registry is the single source of truth for every RPD B1-4F MapGenie item.
It joins three committed assets by title and category:

- ``public/rpd/items_mapgenie.json``  the mapped world pose per marker
- ``public/rpd/item_models.json``     the 3D model per MapGenie title
- ``public/rpd/icons.json``           the icon per MapGenie title or category

The typed action and its gates come from the MapGenie links in the API
descriptions. Every markdown link that carries ``locationIds=`` is a relation
between two registry items; the link's surrounding bold section names the
relation:

    **Unlocked By:**  the linked item must be held (or opened) first
    **Contents:**     the linked item is revealed when this one opens
    **Unlocks:**      this item opens the linked item
    **Repaired with:** the linked item is held first
    Inside the X      X reveals this item

No relation is hand-written per item. The tool reports every link it cannot
resolve so the residual gap is visible.

Run:

    python3 tools/build_item_registry.py --map-json /tmp/mapgenie/map-878.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
RPD = ROOT / "public" / "rpd"
MAPGENIE = RPD / "items_mapgenie.json"
MODELS = RPD / "item_models.json"
ICONS = RPD / "icons.json"
OUT = RPD / "item_registry.json"
DEFAULT_API = pathlib.Path("/tmp/mapgenie/map-878.json")

LINK = re.compile(r"\[([^\]]+)\]\((https://mapgenie\.io/[^)]*?locationIds=(\d+)[^)]*)\)")
BOLD = re.compile(r"^\*\*(.+?):\*\*(.*)$")
INSIDE_LEAD = re.compile(r"^\s*Inside the ([A-Z][A-Za-z0-9' .!-]{1,48}?)(?=,|\.|;|\n|$)")

ACTIONS = {
    "none": "none",
    "take": "take",
    "unlock": "unlock",
    "open": "open",
    "solve": "solve",
    "read": "read",
    "use": "use",
    "inspect": "inspect",
}

CONTAINERS = {"Safe", "Item Box"}
CARRY = {
    "Key Item",
    "Weapon",
    "Weapon Upgrade",
    "Hip Pouch",
    "Handgun Ammo",
    "Grenade Rounds",
    "SMG Ammo",
    "Needle Cartridges",
    "High-Powered Rounds",
    "Ink Ribbon",
    "Knife",
    "Flash Grenade",
    "Hand Grenade",
    "Green Herb",
    "Red Herb",
    "Blue Herb",
    "Gunpowder",
    "High-Grade Gunpowder",
    "First Aid Spray",
    "Film",
}
READ = {"File", "Area Map"}
INSPECT = {"Mr Raccoon", "Easter Egg"}
FIXTURE = {"Transition", "Window", "Wooden Boards", "Boss"}


def slug(category: str) -> str:
    return category.lower().replace(" ", "_").replace("-", "_")


def read_json(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def api_locations(path: pathlib.Path) -> dict[int, dict]:
    data = read_json(path)
    return {int(entry["id"]): entry for entry in data["locations"]}


def section_links(description: str | None) -> list[tuple[str, int, str, str]]:
    """Return (section, linked id, link title, prefix) for each MapGenie link."""
    if not description:
        return []
    out: list[tuple[str, int, str, str]] = []
    section = ""
    for raw_line in description.splitlines():
        line = raw_line.strip()
        bold = BOLD.match(line)
        if bold:
            section = bold.group(1).strip().lower()
            line = bold.group(2)
        for match in LINK.finditer(line):
            prefix = line[: match.start()].strip().lower()
            out.append((section, int(match.group(3)), match.group(1).strip(), prefix))
    return out


def classify(section: str, prefix: str, line: str) -> str | None:
    """Name the relation a link carries, from its section or the words before it."""
    if prefix.endswith("inside the") or prefix.endswith("inside"):
        return "inside_container"
    if re.search(r"receive(?:s|d)?\s+(?:a|an)?\s*$", prefix):
        return "contents"
    if prefix.endswith("obtained when the") and "is solved" in line:
        return "hidden_by_target"
    if prefix.endswith("processed in the") or prefix.endswith("processed in"):
        return "hint"
    if section in ("unlocked by", "requires", "repaired with"):
        return "requires"
    if section in ("contents", "content"):
        return "contents"
    if section in ("unlocks", "unlocked"):
        return "opens"
    if section in ("used to", "used on"):
        return "used_on"
    return None


def carryable(category: str) -> bool:
    return category in CARRY or category in ("Film", "Area Map")


def action_for(category: str, requires: list[int], contents: list[int]) -> str:
    if category in CONTAINERS:
        return "open"
    if category == "Lock":
        if contents:
            return "open"
        if requires:
            return "unlock"
        return "none"
    if category == "Safe":
        return "open"
    if category == "Puzzle":
        return "solve"
    if category in ("Typewriter", "Miscellaneous"):
        return "use"
    if category in READ:
        return "read"
    if category in INSPECT:
        return "inspect"
    if category in FIXTURE:
        return "none"
    if category in CARRY or category == "Lock":
        return "take"
    return "none"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--map-json", type=pathlib.Path, default=DEFAULT_API)
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    args = parser.parse_args()

    marker_file = read_json(MAPGENIE)
    model_file = read_json(MODELS)
    icon_file = read_json(ICONS)
    locations = api_locations(args.map_json)

    floors = {name: entry["index"] for name, entry in marker_file["floors"].items()}
    model_items = model_file["items"]
    icon_categories = icon_file["categories"]
    icon_overrides = icon_file["items"]

    rows: list[dict] = []
    by_id: dict[int, dict] = {}
    by_title: dict[str, list[dict]] = {}
    for entry in marker_file["items"]:
        category = entry["category"]
        icon = icon_overrides.get(entry["title"])
        if not icon:
            icon = (icon_categories.get(slug(category)) or {}).get("icon")
        model = (model_items.get(entry["title"]) or {}).get("model")
        row = {
            "id": int(entry["id"]),
            "title": entry["title"],
            "category": category,
            "category_slug": slug(category),
            "floor": int(floors[entry["floor"]]),
            "x": round(float(entry["x"]), 4),
            "y": round(float(entry["y"]), 4),
            "z": round(float(entry["z"]), 4),
            "on_floor": bool(entry["on_floor"]),
            "on_door": bool(entry["on_door"]),
            "on_stair": bool(entry["on_stair"]),
            "nearest_nav": round(float(entry["nearest_nav"]), 3),
            "placement": "floor"
            if entry["on_floor"] or entry["on_door"] or entry["on_stair"]
            else "fixture",
            "model": model,
            "icon": icon or "miscellaneous",
            "action": "none",
            "requires": [],
            "requires_open": [],
            "contents": [],
            "opens": [],
            "hidden_by": None,
            "links": [],
        }
        rows.append(row)
        by_id[row["id"]] = row
        by_title.setdefault(row["title"], []).append(row)

    known = set(by_id)
    unresolved: list[dict] = []
    relations: list[tuple[int, int, str]] = []

    for row in rows:
        description = (locations.get(row["id"]) or {}).get("description")
        if not description:
            continue
        for section, target_id, title, prefix in section_links(description):
            line = (description or "").lower()
            relation = classify(section, prefix, line)
            if relation is None:
                row["links"].append({"section": section or "body", "id": target_id, "title": title})
                continue
            if target_id not in known:
                unresolved.append({"from": row["id"], "to": target_id, "title": title, "relation": relation, "reason": "not in the RPD marker set"})
                continue
            target = by_id[target_id]
            if relation == "inside_container":
                target["contents"].append(row["id"])
                row["hidden_by"] = target_id
                relations.append((target_id, row["id"], "contents"))
            elif relation == "contents":
                row["contents"].append(target_id)
                target["hidden_by"] = row["id"]
                relations.append((row["id"], target_id, "contents"))
            elif relation == "hidden_by_target":
                target["contents"].append(row["id"])
                row["hidden_by"] = target_id
                relations.append((target_id, row["id"], "contents"))
            elif relation == "requires":
                if carryable(target["category"]):
                    row["requires"].append(target_id)
                else:
                    row["requires_open"].append(target_id)
                relations.append((target_id, row["id"], "opens"))
            elif relation == "requires_open":
                row["requires_open"].append(target_id)
                relations.append((target_id, row["id"], "opens"))
            elif relation == "opens":
                row["opens"].append(target_id)
                relations.append((row["id"], target_id, "opens"))
            elif relation == "used_on":
                if target_id != row["id"] and not carryable(target["category"]):
                    if carryable(row["category"]):
                        target["requires"].append(row["id"])
                    else:
                        target["requires_open"].append(row["id"])
                    row["opens"].append(target_id)
                    relations.append((row["id"], target_id, "opens"))
                else:
                    row["links"].append({"section": section or "used", "id": target_id, "title": title})

        lead = INSIDE_LEAD.match(description)
        if lead:
            title = lead.group(1).strip()
            parent = by_title.get(title)
            if parent and parent[0]["id"] != row["id"] and row["hidden_by"] is None:
                row["hidden_by"] = parent[0]["id"]
                if row["id"] not in parent[0]["contents"]:
                    parent[0]["contents"].append(row["id"])
                relations.append((parent[0]["id"], row["id"], "contents"))

    for row in rows:
        row["requires"] = sorted(set(row["requires"]))
        row["requires_open"] = sorted(set(row["requires_open"]))
        row["contents"] = sorted(set(row["contents"]))
        row["opens"] = sorted(set(row["opens"]))
        row["action"] = action_for(row["category"], row["requires"], row["contents"])

    action_counts: dict[str, int] = {name: 0 for name in ACTIONS}
    for row in rows:
        action_counts[row["action"]] = action_counts.get(row["action"], 0) + 1
    modelled = sum(1 for row in rows if row["model"])
    hidden = sum(1 for row in rows if row["hidden_by"] is not None)
    gated = sum(1 for row in rows if row["requires"] or row["requires_open"])

    digest = hashlib.sha256(args.map_json.read_bytes()).hexdigest()[:16]
    registry = {
        "version": 1,
        "source": {
            "mapgenie": "public/rpd/items_mapgenie.json",
            "models": "public/rpd/item_models.json",
            "icons": "public/rpd/icons.json",
            "api": f"mapgenie map 878 descriptions sha256:{digest}",
        },
        "actions": sorted(ACTIONS),
        "stats": {
            "items": len(rows),
            "modelled": modelled,
            "hidden_contents": hidden,
            "gated": gated,
            "actions": action_counts,
            "relations": len(relations),
            "unresolved_links": len(unresolved),
        },
        "unresolved": unresolved,
        "items": rows,
    }
    args.out.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out.relative_to(ROOT)}")
    print(json.dumps(registry["stats"], indent=2))
    if unresolved:
        print(f"{len(unresolved)} links point outside the RPD marker set (kept in unresolved)")


if __name__ == "__main__":
    main()
