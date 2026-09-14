import { readFile, writeFile } from "node:fs/promises";

const configPath = new URL("../wrangler.jsonc", import.meta.url);
const source = await readFile(configPath, "utf8");
const key = /^([ \t]*)"d1_databases"\s*:\s*\[/m.exec(source);

if (!key) {
  console.log("wrangler.jsonc already uses Void-managed local D1 bindings.");
  process.exit(0);
}

const arrayStart = key.index + key[0].lastIndexOf("[");
let depth = 0;
let inString = false;
let escaped = false;
let arrayEnd = -1;

for (let i = arrayStart; i < source.length; i += 1) {
  const character = source[i];

  if (inString) {
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') inString = false;
    continue;
  }

  if (character === '"') {
    inString = true;
  } else if (character === "[") {
    depth += 1;
  } else if (character === "]") {
    depth -= 1;
    if (depth === 0) {
      arrayEnd = i + 1;
      break;
    }
  }
}

if (arrayEnd < 0) {
  throw new Error("Could not find the end of d1_databases in wrangler.jsonc");
}

let removalStart = key.index;
let removalEnd = arrayEnd;

// Remove the whole member line: take the newline that starts it, and the comma
// that follows the array. Left as-is, the comma after the previous member stays
// where it was, so the file is restored byte-for-byte.
if (source[removalStart - 1] === "\n") removalStart -= 1;
if (source[removalStart - 1] === "\r") removalStart -= 1;

while (removalEnd < source.length && (source[removalEnd] === " " || source[removalEnd] === "\t")) {
  removalEnd += 1;
}
if (source[removalEnd] === ",") removalEnd += 1;

const updated = `${source.slice(0, removalStart)}${source.slice(removalEnd)}`;
await writeFile(configPath, updated);
console.log("Removed d1_databases from wrangler.jsonc for Void-managed local D1 bindings.");
