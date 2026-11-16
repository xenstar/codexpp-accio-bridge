import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAccioVersion } from "./accio-location.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const sidecarRoot = path.join(packageRoot, "sidecar");

const services = new Map();
const logs = new Map();
let accio = null;
let accioPid = null;
let shuttingDown = false;
let activeConfig = null;
const diagnosticsPath = path.join(
  os.tmpdir(),
  "codexpp-accio-bridge",
  `diagnostics-${process.pid}-${Date.now()}.jsonl`,
);
fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true });

function safeText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function appendLog(name, chunk) {
  const next = `${logs.get(name) || ""}${chunk.toString("utf8")}`.slice(-12000);
  logs.set(name, next);
}

function emit(event, payload) {
  if (process.connected) {
    try {
      process.send({ event, payload });
    } catch {}
  }
}

async function portHealthy(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitHealthy(port, required = true) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await portHealthy(port)) return true;
    await wait(250);
  }
  if (required) throw new Error(`Sidecar health check failed on port ${port}`);
  return false;
}

function serviceEnvironment(config) {
  return {
    ...process.env,
    GATEWAY_BASE_URL: "http://127.0.0.1:43100",
    CODEXPLUS_BASE_URL: config.codexPlusBaseUrl,
    CODEXPLUS_DISCOVERY_ONLY_EXPLICIT: "1",
    ACCIO_PROVIDER_SOURCES: "codexplus",
    ACCIO_APP_VERSION: config.accioVersion || "",
    ACCIO_BRIDGE_VERSION: "0.1.22",
    ACCIO_IMAGE_BRIDGE_URL: "http://127.0.0.1:43102",
    // Codex++ owns image generation, so its image gateway is tried first and the Codex CLI
    // bridge on 43102 stays as the fallback. "auto" picks /gw/accio/ when Codex++ registers
    // a binding for Accio and the helper /v1/images/ path otherwise.
    ACCIO_IMAGE_ROUTE: config.imageRoute || "auto",
    ACCIO_IMAGE_CATALOG: config.imageCatalog || "group",
    ACCIO_IMAGE_MODEL: config.imageModel || "auto",
    ACCIO_CODEX_PORT: "43102",
    ACCIO_CODEX_IMAGE_ONLY: "true",
    ACCIO_CODEX_MODEL: "gpt-5.6-luna",
    ACCIO_CODEX_IMAGE_MODEL: "gpt-image-2",
    ACCIO_CODEX_TURN_TIMEOUT_MS: "600000",
    RELAY_IMAGE_TIMEOUT_MS: "600000",
    ACCIO_MODEL_CACHE_SNAPSHOT_PATH: fs.existsSync(config.modelCachePath)
      ? config.modelCachePath
      : "",
    ORIGINAL_GATEWAY_BASE_URL: config.originalGatewayBaseUrl,
    ACCIO_BRIDGE_DIAGNOSTICS_PATH: diagnosticsPath,
    RELAY_PORT: "43100",
    BRIDGE_PORT: "43101",
    BRIDGE_URL: "http://127.0.0.1:43101",
  };
}

function startService(name, script, environment) {
  if (services.has(name)) return;
  const child = spawn(process.execPath, [path.join(sidecarRoot, script)], {
    cwd: sidecarRoot,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  services.set(name, child);
  child.stdout?.on("data", (chunk) => appendLog(name, chunk));
  child.stderr?.on("data", (chunk) => appendLog(name, chunk));
  child.on("error", (error) => appendLog(name, error.message));
  child.on("exit", (code, signal) => {
    services.delete(name);
    if (!shuttingDown && code !== 0) {
      appendLog(name, `exited ${code ?? signal ?? "unknown"}`);
      emit("service-exit", { name, code, signal, error: logs.get(name) || "" });
    }
  });
}

async function ensureServices(config) {
  const environment = serviceEnvironment(config);
  if (!(await portHealthy(43102))) startService("image", "codex-image-bridge.js", environment);
  if (!(await portHealthy(43101))) startService("bridge", "bridge.js", environment);
  if (!(await portHealthy(43100))) startService("relay", "relay.js", environment);

  await waitHealthy(43101);
  await waitHealthy(43100);
  await waitHealthy(43102, false);
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

async function taskkill(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await runFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 10000).catch(() => {});
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

function stopServices() {
  for (const child of services.values()) {
    try {
      child.kill();
    } catch {}
  }
  services.clear();
}

async function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (accioPid) await taskkill(accioPid);
  if (accio && accio.exitCode == null) {
    try {
      accio.kill();
    } catch {}
  }
  accio = null;
  accioPid = null;
  stopServices();
}

function status() {
  return {
    supervisorPid: process.pid,
    accioPid,
    accioRunning: Boolean(accio && accio.exitCode == null),
    services: Object.fromEntries([...services.keys()].map((name) => [name, true])),
    logs: Object.fromEntries([...logs.entries()].map(([name, value]) => [name, value.slice(-2000)])),
    diagnosticsPath,
    config: activeConfig
      ? {
          accioPath: activeConfig.accioPath,
          accioVersion: activeConfig.accioVersion || "",
          codexPlusBaseUrl: activeConfig.codexPlusBaseUrl,
          modelCacheAvailable: fs.existsSync(activeConfig.modelCachePath),
          imageRoute: activeConfig.imageRoute || "auto",
          imageCatalog: activeConfig.imageCatalog || "group",
          imageModel: activeConfig.imageModel || "auto",
        }
      : null,
  };
}

async function startAccio(config) {
  const accioVersion = config.accioVersion || await discoverAccioVersion(config.accioPath);
  activeConfig = { ...config, accioVersion };
  await ensureServices(activeConfig);

  if (accio && accio.exitCode == null) return status();
  if (!fs.existsSync(config.accioPath)) {
    throw new Error(`Accio executable was not found: ${config.accioPath}`);
  }

  accio = spawn(config.accioPath, [], {
    cwd: path.dirname(config.accioPath),
    env: {
      ...process.env,
      GATEWAY_BASE_URL: "http://127.0.0.1:43100",
      ACCIO_PROVIDER_SOURCES: "codexplus",
      ACCIO_MODEL_CACHE_SNAPSHOT_PATH: fs.existsSync(config.modelCachePath)
        ? config.modelCachePath
        : "",
      ORIGINAL_GATEWAY_BASE_URL: config.originalGatewayBaseUrl,
    },
    windowsHide: false,
    stdio: "ignore",
  });
  accioPid = accio.pid;

  accio.on("error", (error) => {
    appendLog("accio", safeText(error));
    emit("accio-error", { error: safeText(error) });
  });
  accio.on("exit", (code, signal) => {
    const pid = accioPid;
    accio = null;
    accioPid = null;
    emit("accio-exit", { pid, code, signal });
    if (!shuttingDown) {
      stopServices();
      setTimeout(() => process.exit(0), 100);
    }
  });

  emit("started", status());
  return status();
}

async function dispatch(method, params) {
  switch (method) {
    case "start":
      return startAccio(params);
    case "status":
      return status();
    case "stop":
      await stopAll();
      return { stopped: true };
    default:
      throw new Error(`Unknown supervisor method: ${method}`);
  }
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  try {
    const result = await dispatch(method, params || {});
    if (process.connected) process.send({ id, result });
  } catch (error) {
    if (process.connected) process.send({ id, error: safeText(error) });
  }
});

process.on("disconnect", async () => {
  await stopAll();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await stopAll();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stopAll();
  process.exit(0);
});

process.on("uncaughtException", async (error) => {
  appendLog("supervisor", safeText(error?.stack || error));
  emit("supervisor-error", { error: safeText(error) });
  await stopAll();
  process.exit(1);
});
