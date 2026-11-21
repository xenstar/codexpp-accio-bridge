// One-shot helper: rewrites every version site in the package.
// Usage: node tools/bump-version.mjs 0.1.12 0.1.13
import fs from "node:fs";
import path from "node:path";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("usage: bump-version.mjs <from> <to>");
const root = path.resolve(import.meta.dirname, "..");

// Every site that must move together, with the exact fragment to replace.
const sites = [
  ["codexpp.json", `"version": "${from}"`],
  ["backend/supervisor.mjs", `ACCIO_BRIDGE_VERSION: "${from}"`],
  ["sidecar/client-identity.js", `BRIDGE_VERSION = "${from}"`],
  ["tools/test-package.mjs", `manifest.version, "${from}"`],
  ["tools/live-image-check.mjs", `AccioBridge/${from}`],
];

for (const [file, fragment] of sites) {
  const target = path.join(root, file);
  const text = fs.readFileSync(target, "utf8");
  if (!text.includes(fragment)) {
    console.log(`MISS  ${file}  ${fragment}`);
    continue;
  }
  fs.writeFileSync(target, text.replace(fragment, fragment.split(from).join(to)));
  console.log(`ok    ${file}`);
}
