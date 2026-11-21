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
import {
  removeLegacyMcpFromCodexPlusSettings,
  removeLegacyMcpRegistration,
} from "../backend/legacy-mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "codexpp.json"), "utf8"));
const english = JSON.parse(fs.readFileSync(path.join(root, "locale", "en.json"), "utf8"));
const chinese = JSON.parse(fs.readFileSync(path.join(root, "locale", "zh.json"), "utf8"));
const managerSource = fs.readFileSync(path.join(root, "manager.html"), "utf8");
const bridgeSource = fs.readFileSync(path.join(root, "sidecar", "bridge.js"), "utf8");

assert.equal(manifest.version, "0.1.40");
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
assert.equal(manifest.mcpServers, undefined, "the extension must not expose a reverse MCP server to Codex++");
assert.ok(fs.existsSync(path.join(root, "sidecar", "accio-mcp.js")), "the Accio MCP bridge must ship");
assert.match(bridgeSource, /HARNESS_NATIVE_ROUTING_INSTRUCTION/, "the harness routing guidance must ship");
assert.match(bridgeSource, /HARNESS_SHELL_TOOL_NAMES/, "the harness shell-route guard must ship");
assert.match(bridgeSource, /function harnessState\(/, "the harness controls must be scope-gated");
assert.match(bridgeSource, /function harnessMcpArguments\(/, "the harness MCP name compatibility must ship");
assert.ok(!/id="video[A-Z]/.test(managerSource), "manager must not expose any video status or generation UI");
assert.ok(!/state\.video\b/.test(managerSource), "manager must not read video state");
const managerScript = managerSource.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(managerScript, "manager must contain an inline script");
new Function(managerScript);

// The image route must ship as real manifest config, using the schema Codex++ accepts.
for (const key of [
  "imageRoute",
  "imageCatalog",
  "imageModel",
  "harnessPrompts",
  "harnessToolNames",
  "harnessShellBlock",
]) {
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
for (const key of ["harnessPrompts", "harnessToolNames", "harnessShellBlock"]) {
  assert.equal(manifest.config[key].type, "select");
  assert.deepEqual(manifest.config[key].options.map(o => o.value), ["auto", "off"]);
  assert.equal(manifest.config[key].default, "auto");
}

// The Codex++ image client is part of the package, and it must not write Codex++ state.
const imageClient = fs.readFileSync(path.join(root, "sidecar", "codexplus-image.js"), "utf8");
assert.ok(imageClient.length > 1000, "codexplus-image.js must ship with the package");
assert.ok(!/writeFileSync|createWriteStream|appendFile/.test(imageClient), "the image client must stay read-only against Codex++ state");
assert.ok(!fs.existsSync(path.join(root, "sidecar", "codexplus-video.js")), "the bridge must not ship a video capability client");

// Image models are published as their own Accio section, never merged into the chat list.
const relaySource = fs.readFileSync(path.join(root, "sidecar", "relay.js"), "utf8");
assert.ok(relaySource.includes("codexplus-image"), "relay must publish the image model group");
assert.ok(relaySource.includes("/image/status"), "relay must expose the image route status");
assert.ok(
  relaySource.includes('process.env.ACCIO_MCP_DEVELOPMENT_SERVER === "1"'),
  "the reverse MCP listener must be disabled unless explicitly enabled for development",
);
const backendSource = fs.readFileSync(path.join(root, "backend", "main.mjs"), "utf8");
const supervisorSource = fs.readFileSync(path.join(root, "backend", "supervisor.mjs"), "utf8");
const headlessSource = fs.readFileSync(path.join(root, "tools", "headless-route.mjs"), "utf8");
assert.ok(backendSource.includes("cleanupLegacyMcp"), "manager must expose obsolete MCP cleanup");
assert.ok(managerSource.includes("cleanupLegacyMcp"), "manager must run obsolete MCP cleanup when opened");
for (const key of ["harnessPrompts", "harnessToolNames", "harnessShellBlock"]) {
  assert.ok(backendSource.includes(key), `backend must pass ${key}`);
}
for (const key of ["ACCIO_HARNESS_PROMPTS", "ACCIO_HARNESS_TOOL_NAMES", "ACCIO_HARNESS_SHELL_BLOCK"]) {
  assert.ok(supervisorSource.includes(key), `supervisor must pass ${key} to the routed sidecars`);
}
assert.ok(
  /async agentStatus\(\)[\s\S]*collectAgentStatus\(config, log\)/.test(backendSource),
  "background agent status must not probe Codex++ while Accio is closed",
);
assert.ok(
  /async function openAccio\(config[\s\S]*cleanupLegacyMcpRegistrations\(log\)/.test(backendSource),
  "opening routed Accio must clean an obsolete MCP registration without requiring the manager",
);
assert.ok(
  headlessSource.includes('message === "supervisor exited"'),
  "headless UAT must exit after Accio's supervisor stops",
);
assert.ok(
  headlessSource.includes("await backend.stop();"),
  "headless UAT must release resources when launch cannot start",
);
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

const mcpTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "accio-legacy-mcp-test-"));
try {
  const codexHome = path.join(mcpTempRoot, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });

  const exact = [
    'model = "keep"',
    "",
    "[mcp_servers.jev]",
    'url = "http://127.0.0.1:9999/mcp"',
    "",
    "[mcp_servers.accio-bridge-accio-tools]",
    'url = "http://127.0.0.1:43103/mcp"',
    "",
    "[plugins]",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, exact);
  const configMode = fs.statSync(configPath).mode & 0o7777;
  const development = removeLegacyMcpRegistration({
    codexHome,
    developmentServerEnabled: true,
  });
  assert.equal(development.changed, false);
  assert.equal(development.reason, "development-server-enabled");
  assert.equal(fs.readFileSync(configPath, "utf8"), exact);

  const cleaned = removeLegacyMcpRegistration({ codexHome });
  assert.equal(cleaned.changed, true);
  assert.ok(cleaned.backupPath && fs.existsSync(cleaned.backupPath), "cleanup must create a backup");
  const cleanedText = fs.readFileSync(configPath, "utf8");
  assert.ok(!cleanedText.includes("[mcp_servers.accio-bridge-accio-tools]"));
  assert.ok(cleanedText.includes("[mcp_servers.jev]"));
  assert.ok(cleanedText.includes("[plugins]"));
  assert.equal(fs.statSync(configPath).mode & 0o7777, configMode, "cleanup must preserve config file mode");

  const conflict = [
    "[mcp_servers.accio-bridge-accio-tools]",
    'url = "http://127.0.0.1:43103/mcp"',
    'approval_mode = "never"',
    "",
  ].join("\n");
  fs.writeFileSync(configPath, conflict);
  const preserved = removeLegacyMcpRegistration({ codexHome });
  assert.equal(preserved.changed, false);
  assert.equal(preserved.reason, "entry-has-extra-content");
  assert.equal(fs.readFileSync(configPath, "utf8"), conflict);

  const foreign = [
    "[mcp_servers.accio-bridge-accio-tools]",
    'url = "http://127.0.0.1:9000/mcp"',
    "",
  ].join("\n");
  fs.writeFileSync(configPath, foreign);
  const untouched = removeLegacyMcpRegistration({ codexHome });
  assert.equal(untouched.changed, false);
  assert.equal(untouched.reason, "entry-has-extra-content");
  assert.equal(fs.readFileSync(configPath, "utf8"), foreign);

  const stateDir = path.join(mcpTempRoot, ".codex-session-delete");
  const settingsPath = path.join(stateDir, "settings.json");
  fs.mkdirSync(stateDir, { recursive: true });
  const legacyProfile = {
    id: "legacy",
    name: "Legacy",
    configContents: [
      'model = "keep"',
      "",
      "[mcp_servers.accio-bridge-accio-tools]",
      'url = "http://127.0.0.1:43103/mcp"',
      "",
    ].join("\n"),
  };
  const settingsText = JSON.stringify({
    codexAppWhaleBalanceScale: 1,
    relayProfiles: [legacyProfile],
    tools: { codex: { relayProfiles: [structuredClone(legacyProfile)] } },
  }, null, 2).replace('"codexAppWhaleBalanceScale": 1', '"codexAppWhaleBalanceScale": 1.0');
  fs.writeFileSync(settingsPath, settingsText);
  const settingsMode = fs.statSync(settingsPath).mode & 0o7777;
  const developmentSettings = removeLegacyMcpFromCodexPlusSettings({
    stateDir,
    developmentServerEnabled: true,
  });
  assert.equal(developmentSettings.changed, false);
  assert.equal(developmentSettings.reason, "development-server-enabled");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), settingsText);

  const cleanedSettings = removeLegacyMcpFromCodexPlusSettings({ stateDir });
  assert.equal(cleanedSettings.changed, true);
  assert.equal(cleanedSettings.profiles, 2);
  assert.ok(cleanedSettings.backupPath && fs.existsSync(cleanedSettings.backupPath));
  const settingsDocument = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.ok(!settingsDocument.relayProfiles[0].configContents.includes("43103"));
  assert.ok(!settingsDocument.tools.codex.relayProfiles[0].configContents.includes("43103"));
  assert.ok(settingsDocument.relayProfiles[0].configContents.includes('model = "keep"'));
  assert.ok(fs.readFileSync(settingsPath, "utf8").includes('"codexAppWhaleBalanceScale": 1.0'));
  assert.equal(fs.statSync(settingsPath).mode & 0o7777, settingsMode, "cleanup must preserve settings file mode");
} finally {
  fs.rmSync(mcpTempRoot, { recursive: true, force: true });
}

console.log("package tests passed");
