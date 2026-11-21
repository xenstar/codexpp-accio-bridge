import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEGACY_SERVER_ID = "accio-bridge-accio-tools";
const LEGACY_HEADER = `[mcp_servers.${LEGACY_SERVER_ID}]`;

function codexHome(options = {}) {
  const explicit = String(options.codexHome || process.env.CODEX_HOME || "").trim();
  return explicit || path.join(options.homeDir || os.homedir(), ".codex");
}

export function legacyMcpConfigPath(options = {}) {
  return path.join(codexHome(options), "config.toml");
}

function readConfig(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      return { text: null, reason: "config-symlink" };
    }
    if (!stat.isFile()) {
      return { text: null, reason: "config-not-file" };
    }
    return { text: fs.readFileSync(target, "utf8"), reason: "" };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: null, reason: "config-missing" };
    throw error;
  }
}

function developmentServerEnabled(options = {}) {
  const value = options.developmentServerEnabled
    ?? process.env.ACCIO_MCP_DEVELOPMENT_SERVER
    ?? "";
  return ["1", "true", "yes"].includes(String(value).trim().toLowerCase());
}

function legacyBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === LEGACY_HEADER);
  if (start < 0) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const body = lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter(Boolean);
  const urlPattern = /^url\s*=\s*(['"])http:\/\/127\.0\.0\.1:43103\/mcp\1\s*(?:#.*)?$/;
  const owned = body.length === 1 && urlPattern.test(body[0]);
  return {
    start,
    end,
    owned,
    reason: owned ? "" : "entry-has-extra-content",
  };
}

function removeLegacyBlock(text) {
  const block = legacyBlock(text);
  if (!block) return { changed: false, text, reason: "entry-absent" };
  if (!block.owned) return { changed: false, text, reason: block.reason };
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  lines.splice(block.start, block.end - block.start);
  return {
    changed: true,
    text: lines.join(newline),
    reason: "entry-removed",
  };
}

export function inspectLegacyMcpRegistration(options = {}) {
  const target = legacyMcpConfigPath(options);
  const current = readConfig(target);
  if (current.text == null) {
    return { path: target, present: false, owned: false, reason: current.reason };
  }
  const block = legacyBlock(current.text);
  if (!block) {
    return { path: target, present: false, owned: false, reason: "entry-absent" };
  }
  return {
    path: target,
    present: true,
    owned: block.owned,
    reason: block.reason,
  };
}

function backupName(target, label, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  return `${target}.accio-bridge-${label}-${stamp}.bak`;
}

function replaceFile(target, before, after, label) {
  const backupPath = backupName(target, label);
  const temporaryPath = `${target}.accio-bridge-${process.pid}-${Date.now()}.tmp`;
  const currentMode = fs.statSync(target).mode & 0o7777;
  fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
  try {
    // Start from a copy so the temporary replacement keeps the target's
    // existing file permissions and attributes instead of fresh defaults.
    fs.copyFileSync(target, temporaryPath, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(temporaryPath, after, { encoding: "utf8" });
    fs.chmodSync(temporaryPath, currentMode);
    if (fs.readFileSync(target, "utf8") !== before) {
      throw new Error("File changed during legacy Accio MCP cleanup.");
    }
    fs.renameSync(temporaryPath, target);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {}
    throw error;
  }
  return backupPath;
}

export function removeLegacyMcpRegistration(options = {}) {
  const target = legacyMcpConfigPath(options);
  if (developmentServerEnabled(options)) {
    return {
      path: target,
      changed: false,
      reason: "development-server-enabled",
    };
  }
  const current = readConfig(target);
  if (current.text == null) {
    return {
      path: target,
      changed: false,
      reason: current.reason,
    };
  }

  const removed = removeLegacyBlock(current.text);
  if (!removed.changed) {
    return {
      path: target,
      changed: false,
      reason: removed.reason,
    };
  }

  const backupPath = replaceFile(target, current.text, removed.text, "legacy");

  return {
    path: target,
    changed: true,
    backupPath,
    reason: "entry-removed",
  };
}

export function removeLegacyMcpFromCodexPlusSettings(options = {}) {
  const stateDir = String(
    options.stateDir
      || process.env.CODEX_PLUS_STATE_DIR
      || path.join(options.homeDir || os.homedir(), ".codex-session-delete"),
  ).trim();
  const target = options.settingsPath || path.join(stateDir, "settings.json");
  if (developmentServerEnabled(options)) {
    return {
      path: target,
      changed: false,
      profiles: 0,
      reason: "development-server-enabled",
    };
  }
  const current = readConfig(target);
  if (current.text == null) {
    return { path: target, changed: false, profiles: 0, reason: current.reason };
  }

  let document;
  try {
    document = JSON.parse(current.text);
  } catch {
    return { path: target, changed: false, profiles: 0, reason: "settings-invalid" };
  }

  const profileGroups = [
    document?.relayProfiles,
    document?.tools?.codex?.relayProfiles,
  ];
  const replacements = new Map();
  const expectedOccurrences = new Map();
  let profiles = 0;
  for (const group of profileGroups) {
    if (!Array.isArray(group)) continue;
    for (const profile of group) {
      if (!profile || typeof profile.configContents !== "string") continue;
      const removed = removeLegacyBlock(profile.configContents);
      if (!removed.changed) continue;
      replacements.set(profile.configContents, removed.text);
      expectedOccurrences.set(
        profile.configContents,
        (expectedOccurrences.get(profile.configContents) || 0) + 1,
      );
      profiles += 1;
    }
  }

  if (!profiles) {
    return { path: target, changed: false, profiles: 0, reason: "entry-absent" };
  }

  let updated = current.text;
  for (const [before, after] of replacements) {
    const encodedBefore = JSON.stringify(before);
    const encodedAfter = JSON.stringify(after);
    const occurrences = updated.split(encodedBefore).length - 1;
    if (occurrences !== expectedOccurrences.get(before)) {
      return {
        path: target,
        changed: false,
        profiles: 0,
        reason: "settings-profile-format-conflict",
      };
    }
    updated = updated.split(encodedBefore).join(encodedAfter);
  }

  let verified;
  try {
    verified = JSON.parse(updated);
  } catch {
    return {
      path: target,
      changed: false,
      profiles: 0,
      reason: "settings-update-invalid",
    };
  }
  const remaining = JSON.stringify([
    verified?.relayProfiles,
    verified?.tools?.codex?.relayProfiles,
  ]);
  if (remaining.includes(LEGACY_HEADER) || remaining.includes("127.0.0.1:43103/mcp")) {
    return {
      path: target,
      changed: false,
      profiles: 0,
      reason: "settings-profile-format-conflict",
    };
  }

  const backupPath = replaceFile(target, current.text, updated, "settings-legacy");
  return {
    path: target,
    changed: true,
    profiles,
    backupPath,
    reason: "entries-removed",
  };
}
