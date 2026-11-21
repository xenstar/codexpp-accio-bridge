// Builds dist/stage-<version>/accio-bridge and dist/accio-bridge-<version>.zip
// from the working tree, mirroring the layout users extract into
// %APPDATA%\Codex++\user_scripts.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "codexpp.json"), "utf8"));
const version = String(pkg.version || "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bad version: ${version}`);

const INCLUDE = ["backend", "locale", "sidecar", "tools"];
const LOOSE = ["codexpp.json", "manager.html", "README.md", "README.zh-CN.md"];
// Repo build tools stay out of the package: pack.mjs would rebuild dist/ inside
// %APPDATA%\Codex++\user_scripts, and bump-version.mjs rewrites installed files.
// live-image-check.mjs does ship; it is a read-only diagnostic users can run.
const EXCLUDE = new Set(["tools/pack.mjs", "tools/bump-version.mjs"]);

const target = path.join(root, "dist", `stage-${version}`, "accio-bridge");
const zip = path.join(root, "dist", `accio-bridge-${version}.zip`);

fs.rmSync(path.join(root, "dist", `stage-${version}`), { recursive: true, force: true });
fs.rmSync(zip, { force: true });
fs.mkdirSync(target, { recursive: true });

const copied = [];
for (const name of LOOSE) {
  const from = path.join(root, name);
  if (!fs.existsSync(from)) throw new Error(`missing required entry: ${name}`);
  fs.copyFileSync(from, path.join(target, name));
  copied.push(name);
}
for (const dir of INCLUDE) {
  const from = path.join(root, dir);
  if (!fs.existsSync(from)) throw new Error(`missing required directory: ${dir}`);
  fs.mkdirSync(path.join(target, dir), { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/\.(log|tmp|bak)$|\.tmp\d*$/.test(entry.name)) continue;
    if (EXCLUDE.has(`${dir}/${entry.name}`)) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(target, dir, entry.name));
    copied.push(`${dir}/${entry.name}`);
  }
}

// Use the .NET ZIP API because some Windows images cannot load the
// Microsoft.PowerShell.Archive module that owns Compress-Archive.
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${target}', '${zip}', [System.IO.Compression.CompressionLevel]::Optimal, $true)`,
  ],
  { stdio: "inherit" },
);

console.log(`staged ${copied.length} files -> ${path.relative(root, target)}`);
console.log(`archive -> ${path.relative(root, zip)} (${fs.statSync(zip).size} bytes)`);
for (const name of [
  "README.zh-CN.md",
  "sidecar/codexplus-image.js",
  "tools/test-image.mjs",
  "sidecar/relay.js",
]) {
  if (!copied.includes(name)) throw new Error(`archive is missing ${name}`);
}
console.log("pack ok");
