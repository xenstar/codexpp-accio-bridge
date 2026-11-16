// Installs dist/stage-<version>/accio-bridge into
// %APPDATA%\Codex++\user_scripts\accio-bridge and verifies every hash, so the
// copy Codex++ actually loads is provably the copy that was tested.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "codexpp.json"), "utf8")).version;
const stage = path.join(root, "dist", `stage-${version}`, "accio-bridge");
const targetRoot = process.env.CODEXPP_USER_SCRIPTS
  || path.join(os.homedir(), "AppData", "Roaming", "Codex++", "user_scripts");
const target = path.join(targetRoot, "accio-bridge");
if (!fs.existsSync(stage)) throw new Error(`stage is missing, run tools/pack.mjs first: ${stage}`);

const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const walk = (dir, prefix = "") => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
};

const files = walk(stage);
let copied = 0;
for (const rel of files) {
  const to = path.join(target, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to) && hash(path.join(stage, rel)) === hash(to)) continue;
  fs.copyFileSync(path.join(stage, rel), to);
  copied += 1;
}

// Anything left over from an older release would keep running, so drop only
// files this package no longer ships, and only inside the plugin folder.
const keep = new Set(files);
let removed = 0;
if (fs.existsSync(target)) {
  for (const rel of walk(target)) {
    if (keep.has(rel)) continue;
    fs.rmSync(path.join(target, rel), { force: true });
    removed += 1;
  }
}

const mismatched = files.filter((rel) => hash(path.join(stage, rel)) !== hash(path.join(target, rel)));
if (mismatched.length) throw new Error(`install verification failed for: ${mismatched.join(", ")}`);
const installed = JSON.parse(fs.readFileSync(path.join(target, "codexpp.json"), "utf8"));
if (installed.version !== version) throw new Error(`installed version is ${installed.version}, expected ${version}`);

console.log(`installed ${version} -> ${target}`);
console.log(`${copied} copied, ${removed} stale removed, ${files.length} verified identical`);
