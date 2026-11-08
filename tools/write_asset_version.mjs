import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rpd = join(root, "public", "rpd");
const files = [
  "rpd.bin",
  "nav.json",
  "quest.json",
  "rpd.wasm",
  "item_models.bin",
  "item_models.json",
  "item_registry.json",
  "icons.json",
];
const hash = createHash("sha256");
for (const file of files) {
  hash.update(file);
  hash.update(readFileSync(join(rpd, file)));
}
const version = hash.digest("hex").slice(0, 16);
writeFileSync(join(rpd, "version.json"), `${JSON.stringify({ version, files }, null, 2)}\n`);
console.log(`wrote public/rpd/version.json (${version})`);
