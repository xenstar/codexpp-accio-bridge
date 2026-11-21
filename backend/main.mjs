import { execFile, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { discoverAccioExecutable, discoverAccioVersion } from "./accio-location.mjs";
import {
  removeLegacyMcpFromCodexPlusSettings,
  removeLegacyMcpRegistration,
} from "./legacy-mcp.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const sidecarRoot = path.join(packageRoot, "sidecar");
const codexPlus = require(path.join(sidecarRoot, "codexplus.js"));

const SUPERVISOR_SCRIPT = path.join(here, "supervisor.mjs");
const DEFAULT_GATEWAY = "https://phoenix-gw.alibaba.com";
const HEALTH_TIMEOUT_MS = 1500;
const SUPERVISOR_TIMEOUT_MS = 30000;

let supervisor = null;
let nextRequestId = 1;
let lastEvent = null;
let accioLocationCache = null;
let accioLocationCacheUntil = 0;
const pending = new Map();

function asError(value) {
  return String(value?.stack || value?.message || value || "Unknown error")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function modelCachePath() {
  return path.join(os.homedir(), ".accio", "model_cache.json");
}

async function accioLocation(config, force = false) {
  if (!force && accioLocationCache && Date.now() < accioLocationCacheUntil) {
    return accioLocationCache;
  }
  const location = await discoverAccioExecutable({
    configuredPath: config?.accioPath,
  });
  const version = location.exists ? await discoverAccioVersion(location.path) : "";
  accioLocationCache = { ...location, version };
  accioLocationCacheUntil = Date.now() + (location.exists ? 300000 : 30000);
  return location;
}

function healthUrl(port) {
  return `http://127.0.0.1:${port}/health`;
}

async function portHealthy(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(healthUrl(port), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function codexPlusStatus() {
  try {
    const discovered = await codexPlus.discover({
      force: true,
      timeoutMs: 1800,
      overallTimeoutMs: 4500,
    });
    const ids = discovered.models.map((model) => model.id);
    return {
      ok: true,
      baseUrl: discovered.baseUrl,
      modelCount: ids.length,
      sampleModels: ids.slice(0, 12),
    };
  } catch (error) {
    return { ok: false, error: asError(error), modelCount: 0, sampleModels: [] };
  }
}

function runFile(command, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function listAccioProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await runFile("tasklist.exe", [
      "/FO",
      "CSV",
      "/NH",
      "/FI",
      "IMAGENAME eq Accio.exe",
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith('"accio.exe"'))
      .map((line) => {
        const fields = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
        return fields.length >= 2 ? { name: fields[0], pid: Number(fields[1]) } : null;
      })
      .filter((entry) => Number.isInteger(entry?.pid) && entry.pid > 0);
  } catch {
    return [];
  }
}

async function stopProcessTree(pid) {
  if (process.platform !== "win32") {
    try {
      process.kill(pid);
    } catch {}
    return;
  }
  try {
    await runFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 10000);
  } catch {}
}

function rejectPending(error) {
  const message = asError(error);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  pending.clear();
}

function ensureSupervisor(log) {
  if (supervisor && supervisor.connected && supervisor.exitCode == null) return supervisor;

  const child = fork(SUPERVISOR_SCRIPT, [], {
    cwd: packageRoot,
    env: process.env,
    execPath: process.execPath,
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  supervisor = child;

  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-8000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  child.on("message", (message) => {
    if (message?.event) {
      lastEvent = message;
      return;
    }
    const entry = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });

  child.on("error", (error) => rejectPending(error));
  child.on("exit", (code, signal) => {
    if (supervisor === child) supervisor = null;
    const detail = output.trim() || `Supervisor exited (${code ?? signal ?? "unknown"})`;
    rejectPending(detail);
    log?.("supervisor exited", detail);
  });

  return child;
}

function supervisorRequest(method, params = {}, timeoutMs = SUPERVISOR_TIMEOUT_MS, log) {
  const child = ensureSupervisor(log);
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Supervisor request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.send({ id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function supervisorState() {
  return Boolean(supervisor?.connected && supervisor.exitCode == null);
}

function cleanupLegacyMcpRegistrations(log) {
  const config = removeLegacyMcpRegistration();
  const settings = removeLegacyMcpFromCodexPlusSettings();
  if (config.changed || settings.changed) {
    log?.("removed obsolete Accio MCP registration", { config, settings });
  } else {
    for (const result of [config, settings]) {
      if (![
        "entry-absent",
        "config-missing",
        "development-server-enabled",
      ].includes(result.reason)) {
        log?.("preserved MCP registration", result);
      }
    }
  }
  return {
    changed: config.changed || settings.changed,
    config,
    settings,
  };
}

async function relayImageStatus() {
  if (!(await portHealthy(43100))) return null;
  try {
    const response = await fetch("http://127.0.0.1:43100/image/status", { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function collectStatus(config, log) {
  const [proxy, bridge, relay, imageBridge, accioProcesses] = await Promise.all([
    codexPlusStatus(),
    portHealthy(43101),
    portHealthy(43100),
    portHealthy(43102),
    listAccioProcesses(),
  ]);

  let managed = null;
  if (supervisorState()) {
    try {
      managed = await supervisorRequest("status", {}, 5000, log);
    } catch {}
  }

  const accioLocationResult = await accioLocation(config);
  return {
    proxy,
    ports: { relay: 43100, bridge: 43101, imageBridge: 43102 },
    services: { relay, bridge, imageBridge },
    accio: {
      path: accioLocationResult.path,
      source: accioLocationResult.source,
      exists: accioLocationResult.exists,
      version: accioLocationResult.version || "",
      running: accioProcesses.length > 0,
      processes: accioProcesses,
      managed: Boolean(managed?.accioPid),
    },
    managed,
    lastEvent,
    image: await relayImageStatus(),
  };
}

async function collectAgentStatus(config, log) {
  const accioProcesses = await listAccioProcesses();
  let managed = null;
  if (supervisorState()) {
    try {
      managed = await supervisorRequest("status", {}, 5000, log);
    } catch {}
  }

  const accioLocationResult = await accioLocation(config);
  return {
    accio: {
      path: accioLocationResult.path,
      source: accioLocationResult.source,
      exists: accioLocationResult.exists,
      version: accioLocationResult.version || "",
      running: accioProcesses.length > 0,
      processes: accioProcesses,
      managed: Boolean(managed?.accioPid),
    },
    managed,
  };
}

async function openAccio(config, emit, log, options = {}) {
  try {
    cleanupLegacyMcpRegistrations(log);
  } catch (error) {
    log?.("legacy MCP cleanup failed", asError(error));
  }

  const accioLocationResult = await accioLocation(config, true);
  if (!accioLocationResult.exists) {
    throw new Error(
      `Accio executable was not found. Install Accio or set its executable path in the extension settings. Searched from: ${accioLocationResult.path}`,
    );
  }
  const accioPath = accioLocationResult.path;

  let before = await listAccioProcesses();
  let managedState = supervisorState()
    ? await supervisorRequest("status", {}, 5000, log).catch(() => null)
    : null;
  if (options.restart && managedState?.accioPid) {
    await supervisorRequest("stop", {}, 15000, log);
    managedState = null;
    before = await listAccioProcesses();
  }
  const managedPid = Number(managedState?.accioPid || 0);
  const external = before.filter((process) => process.pid !== managedPid);

  if (external.length) {
    if (!options.restart) {
      return {
        ok: false,
        code: "ACCIO_ALREADY_RUNNING",
        message: "Accio is already running. Restart it through the bridge to apply Codex++ routing.",
        processes: before,
      };
    }
    for (const process of external) await stopProcessTree(process.pid);
  }

  const proxy = await codexPlusStatus();
  if (!proxy.ok) {
    throw new Error(`Codex++ protocol proxy is unavailable: ${proxy.error}`);
  }

  if (managedState?.accioPid && !external.length) {
    return { ok: true, code: "ALREADY_ROUTED", status: managedState };
  }

  const result = await supervisorRequest(
    "start",
    {
      accioPath,
      accioVersion: accioLocationResult.version || "",
      codexPlusBaseUrl: proxy.baseUrl,
      originalGatewayBaseUrl: DEFAULT_GATEWAY,
      modelCachePath: modelCachePath(),
      imageRoute: config.imageRoute || "auto",
      imageCatalog: config.imageCatalog || "group",
      imageModel: config.imageModel || "auto",
      harnessPrompts: config.harnessPrompts || "auto",
      harnessToolNames: config.harnessToolNames || "auto",
      harnessShellBlock: config.harnessShellBlock || "auto",
    },
    30000,
    log,
  );
  emit?.("status", result);
  return { ok: true, code: "STARTED", status: result };
}

export default function create({ config: initialConfig = {}, emit, log }) {
  let config = initialConfig;

  return {
    async status() {
      return collectStatus(config, log);
    },

    async agentStatus() {
      // Background discovery must stay inert while Accio is closed. The
      // manager's explicit status view may still probe Codex++.
      const status = await collectAgentStatus(config, log);
      return {
        installed: Boolean(status.accio?.exists),
        running: Boolean(status.accio?.running),
        managed: Boolean(status.accio?.managed),
        externalRunning: Boolean(status.accio?.running && !status.accio?.managed),
        canLaunch: Boolean(status.accio?.exists && !status.accio?.running),
        canRestart: Boolean(status.accio?.exists),
        canStop: Boolean(status.accio?.running && status.accio?.managed),
        message: status.accio?.exists
          ? status.accio.running
            ? status.accio.managed
              ? "Accio is running through Codex++."
              : "Accio is running outside Codex++. Restart it through the bridge to apply routing."
            : "Accio is ready to launch through Codex++."
          : "Accio was not found. Install it or configure its executable path.",
      };
    },

    async openAccio() {
      return openAccio(config, emit, log, { restart: false });
    },

    async restartAccio() {
      return openAccio(config, emit, log, { restart: true });
    },

    async stop() {
      if (supervisorState()) {
        await supervisorRequest("stop", {}, 15000, log);
      }
      return collectStatus(config, log);
    },

    async refreshConfig(next = {}) {
      config = { ...config, ...(next || {}) };
      return collectStatus(config, log);
    },

    async cleanupLegacyMcp() {
      return cleanupLegacyMcpRegistrations(log);
    },
  };
}
