import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateAccioPaths,
  discoverAccioExecutable,
  discoverAccioVersion,
  normalizeAccioExecutable,
} from "../backend/accio-location.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "codexpp.json"), "utf8"));
const english = JSON.parse(fs.readFileSync(path.join(root, "locale", "en.json"), "utf8"));
const chinese = JSON.parse(fs.readFileSync(path.join(root, "locale", "zh.json"), "utf8"));
const managerSource = fs.readFileSync(path.join(root, "manager.html"), "utf8");

assert.equal(manifest.version, "0.1.22");
assert.equal(manifest.manager.page, "manager.html");
assert.equal(manifest.manager.nav, undefined, "plugin must not add a Tools navigation tab");
assert.equal(manifest.inject, undefined, "plugin must not ship DOM injection");
assert.equal(english.meta.title, "Accio Bridge");
assert.match(chinese.meta.title, /Accio 桥接/);
for (const keyword of [
  "accio",
  "accio work",
  "accio bridge",
  "accio 桥接",
  "accio 中文",
  "accio 桌面版",
  "accio 智能体",
  "阿西欧",
  "生图",
]) {
  assert.ok(manifest.keywords.includes(keyword), `community search keyword is missing: ${keyword}`);
}
assert.ok(fs.existsSync(path.join(root, "README.md")), "English README must ship");
assert.ok(fs.existsSync(path.join(root, "README.zh-CN.md")), "Chinese README must ship");
assert.ok(!/id="video[A-Z]/.test(managerSource), "manager must not expose any video status or generation UI");
assert.ok(!/state\.video\b/.test(managerSource), "manager must not read video state");
const managerScript = managerSource.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(managerScript, "manager must contain an inline script");
new Function(managerScript);

// The image route must ship as real manifest config, using the schema Codex++ accepts.
for (const key of ["imageRoute", "imageCatalog", "imageModel"]) {
  const field = manifest.config[key];
  assert.ok(field, `codexpp.json must declare config.${key}`);
  assert.ok(field.title?.en && field.title?.zh, `config.${key} needs an English and Chinese title`);
  assert.ok(field.description?.en && field.description?.zh, `config.${key} needs an English and Chinese description`);
}
assert.equal(manifest.config.imageRoute.type, "select");
assert.deepEqual(manifest.config.imageRoute.options.map(o => o.value), ["auto", "codexplus", "codex-cli", "off"]);
assert.equal(manifest.config.imageCatalog.type, "select");
assert.equal(manifest.config.imageCatalog.options.length, 3);
assert.equal(manifest.config.imageModel.type, "string");
assert.equal(manifest.config.imageModel.default, "auto");

// The Codex++ image client is part of the package, and it must not write Codex++ state.
const imageClient = fs.readFileSync(path.join(root, "sidecar", "codexplus-image.js"), "utf8");
assert.ok(imageClient.length > 1000, "codexplus-image.js must ship with the package");
assert.ok(!/writeFileSync|createWriteStream|appendFile/.test(imageClient), "the image client must stay read-only against Codex++ state");
assert.ok(!fs.existsSync(path.join(root, "sidecar", "codexplus-video.js")), "the bridge must not ship a video capability client");

// Image models are published as their own Accio section, never merged into the chat list.
const relaySource = fs.readFileSync(path.join(root, "sidecar", "relay.js"), "utf8");
assert.ok(relaySource.includes("codexplus-image"), "relay must publish the image model group");
assert.ok(relaySource.includes("/image/status"), "relay must expose the image route status");
// Accio checks the prepared prompt against `contextWindow - output reserve` before it sends
// anything and fails with "Prepared input exceeds the conservative context capacity". A small
// hardcoded window on the image entries used to trip that guard on ordinary prompts.
assert.ok(!/contextWindow:\s*8192\b/.test(relaySource), "image entries must not declare a tiny context window");
assert.ok(/function imageContextWindow/.test(relaySource), "relay must derive the image context window");
assert.ok(/contextWindow,\n\s*multimodal: false/.test(relaySource), "image entries must use the derived context window");
assert.ok(relaySource.includes('errorCode: "ACCIO_VIDEO_UNSUPPORTED"'), "Codex++ video must stay out of Accio's gateway");
assert.ok(relaySource.includes("native video tool"), "the video boundary should point to harness-native video");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "accio-location-test-"));
try {
  const localAppData = path.join(tempRoot, "local");
  const programFiles = path.join(tempRoot, "program-files");
  const standardDirectory = path.join(localAppData, "Programs", "Accio");
  const standardExecutable = path.join(standardDirectory, "Accio.exe");
  fs.mkdirSync(standardDirectory, { recursive: true });
  fs.writeFileSync(standardExecutable, "");

  const env = {
    LOCALAPPDATA: localAppData,
    ProgramFiles: programFiles,
    "ProgramFiles(x86)": path.join(tempRoot, "program-files-x86"),
  };
  assert.deepEqual(candidateAccioPaths(env, tempRoot), [
    standardExecutable,
    path.join(localAppData, "Accio", "Accio.exe"),
    path.join(programFiles, "Accio", "Accio.exe"),
    path.join(tempRoot, "program-files-x86", "Accio", "Accio.exe"),
  ]);

  const standard = await discoverAccioExecutable({ env, home: tempRoot, platform: "win32" });
  assert.deepEqual(standard, { path: standardExecutable, source: "standard", exists: true });
  const version = await discoverAccioVersion(standardExecutable, {
    run: async (command) => {
      assert.equal(command, "powershell.exe");
      return { stdout: "0.39.0.0\r\n", stderr: "" };
    },
  });
  assert.equal(version, "0.39.0.0");

  const registryExecutable = path.join(tempRoot, "custom", "Accio.exe");
  fs.mkdirSync(path.dirname(registryExecutable), { recursive: true });
  fs.writeFileSync(registryExecutable, "");
  const registry = await discoverAccioExecutable({
    env: { LOCALAPPDATA: path.join(tempRoot, "empty"), ProgramFiles: programFiles },
    home: tempRoot,
    platform: "win32",
    run: async (command) => {
      if (command === "where.exe") throw new Error("not on PATH");
      return { stdout: `    (Default)    REG_SZ    "${registryExecutable}"\n`, stderr: "" };
    },
  });
  assert.deepEqual(registry, { path: registryExecutable, source: "registry", exists: true });

  assert.equal(
    normalizeAccioExecutable(`%CUSTOM_ROOT%\\Accio\\Accio.exe`, { CUSTOM_ROOT: tempRoot }),
    path.join(tempRoot, "Accio", "Accio.exe"),
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("package tests passed");
