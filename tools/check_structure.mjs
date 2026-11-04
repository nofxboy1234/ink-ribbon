import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const toPosix = (path) => path.split("\\").join("/");

function walk(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
}

const sourceFiles = [
  ...walk(join(root, "src")),
  ...walk(join(root, "pages")),
  ...walk(join(root, "native", "main.c")),
  ...walk(join(root, "native", "src")),
].filter((path) => {
  const rel = toPosix(relative(root, path));
  if (rel.includes("native/third_party")) return false;
  if (rel === "src/wasm/rpd.js") return false;
  if (rel.startsWith("verification/")) return false;
  return /\.(ts|tsx|c|h|css|sh)$/.test(rel);
});

const codeFiles = sourceFiles.filter((path) => /\.(ts|tsx)$/.test(path));
const runtimeFiles = sourceFiles.filter((path) => /\.(ts|tsx|c|h|css)$/.test(path));

for (const path of codeFiles) {
  const rel = toPosix(relative(root, path));
  if (rel === "src/wasm/client.ts" || rel === "src/wasm/rpd.d.ts") continue;
  const text = readFileSync(path, "utf8");
  if (/_rpd_/.test(text)) {
    failures.push(`${rel}: raw _rpd_* call outside src/wasm/client.ts`);
  }
}

for (const path of codeFiles) {
  const rel = toPosix(relative(root, path));
  if (rel === "src/wasm/rpd.d.ts") continue;
  const text = readFileSync(path, "utf8");
  if (/\b(type|interface)\s+RpdModule\b/.test(text)) {
    failures.push(`${rel}: duplicate RpdModule type`);
  }
}

const limits = new Map([
  ["src/RpdScene.tsx", 300],
  ["src/FloorMap2D.tsx", 200],
  ["native/main.c", 250],
]);
for (const path of runtimeFiles) {
  const rel = toPosix(relative(root, path));
  const lines = readFileSync(path, "utf8").split("\n").length - 1;
  const limit = limits.get(rel) ?? 600;
  if (lines > limit) failures.push(`${rel}: ${lines} lines, limit ${limit}`);
}

const cssFiles = sourceFiles.filter((path) => path.endsWith(".css"));
const selectorOwners = new Map();
for (const path of cssFiles) {
  const rel = toPosix(relative(root, path));
  const lines = readFileSync(path, "utf8").split("\n");
  let mediaDepth = 0;
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@media")) {
      mediaDepth += 1;
    }
    if (mediaDepth === 0) {
      const match = trimmed.match(/^([^@/][^{]+?)\s*\{$/);
      if (match && !match[1].includes(":")) {
        const selector = match[1].trim();
        if (selector && !selector.startsWith(".") === false) {
          const owner = selectorOwners.get(selector);
          if (owner) {
            failures.push(`${rel}: duplicate selector ${selector} (also ${owner})`);
          } else {
            selectorOwners.set(selector, rel);
          }
        }
      }
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (mediaDepth > 0 && depth <= 0) {
      mediaDepth = 0;
      depth = 0;
    }
  }
}

let changed = "";
try {
  changed = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" });
  changed += execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
} catch {
  // no git is handled by the build gate
}
const disallowed = changed
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((rel) => /^(native\/third_party\/|dist\/|node_modules\/|\.void\/|build\/)/.test(rel));
if (disallowed.length > 0) {
  failures.push(`generated or vendored paths changed: ${disallowed.join(", ")}`);
}

if (failures.length > 0) {
  console.error("Structure failures:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Structure checks passed.");
