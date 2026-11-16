"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PORT = 57321;
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_OVERALL_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 15000;
const PORT_FILE = "protocol-proxy-port";
const PORT_HISTORY_FILE = "protocol-proxy-port-history";
const STATUS_FILE = "latest-status.json";
const STATE_DIR = ".codex-session-delete";

function positivePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function envPort(name) {
  return positivePort(process.env[name]);
}

function codexPlusStateDir() {
  const explicit = String(process.env.CODEX_PLUS_STATE_DIR || "").trim();
  return explicit || path.join(os.homedir(), STATE_DIR);
}

function normalizeBaseUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (_) {
    return null;
  }
}

function readPortFile(file) {
  try {
    return String(fs.readFileSync(file, "utf8")).split(/\r?\n/).map(positivePort).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function statusPort(file) {
  try {
    const status = JSON.parse(fs.readFileSync(file, "utf8"));
    const port = positivePort(status.helper_port ?? status.helperPort ?? status.protocol_proxy_port ?? status.protocolProxyPort);
    const recent = Date.now() - Number(status.started_at_ms || 0) < 30 * 24 * 60 * 60 * 1000;
    return status.status === "running" && recent ? port : null;
  } catch (_) {
    return null;
  }
}

function flag(name) {
  return String(process.env[name] || "").trim().toLowerCase().match(/^(1|true|yes)$/);
}

function candidateUrls() {
  const explicit = [
    normalizeBaseUrl(process.env.CODEXPLUS_BASE_URL),
    normalizeBaseUrl(process.env.CODEX_PLUS_BASE_URL),
    normalizeBaseUrl(process.env.OPENAI_BASE_URL && process.env.ACCIO_PROVIDER_SOURCES === "codexplus" ? process.env.OPENAI_BASE_URL : ""),
  ].filter(Boolean);
  if (flag("CODEXPLUS_DISCOVERY_ONLY_EXPLICIT")) return [...new Set(explicit)];

  const ports = [];
  for (const name of ["CODEX_PLUS_PROTOCOL_PROXY_PORT"]) ports.push(envPort(name));
  const stateDir = codexPlusStateDir();
  ports.push(...readPortFile(path.join(stateDir, PORT_FILE)));
  ports.push(statusPort(path.join(stateDir, STATUS_FILE)));
  ports.push(...readPortFile(path.join(stateDir, PORT_HISTORY_FILE)));
  ports.push(DEFAULT_PORT);

  const urls = [...explicit, ...ports.filter(Boolean).map(port => `http://127.0.0.1:${port}`)];
  return [...new Set(urls.map(normalizeBaseUrl).filter(Boolean))];
}

function safeLoopback(url) {
  try {
    const parsed = new URL(url);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function modelFromPayload(item) {
  const id = String(item?.id || item?.model || item?.slug || "").trim();
  if (!id) return null;
  const displayName = String(item?.display_name || item?.displayName || item?.name || id).trim() || id;
  const contextWindow = positiveInteger(item?.context_window ?? item?.contextWindow) || undefined;
  const reasoningEfforts = Array.isArray(item?.reasoningEfforts || item?.reasoning_efforts)
    ? (item.reasoningEfforts || item.reasoning_efforts).map(String)
    : undefined;
  const multimodal = typeof item?.multimodal === "boolean" ? item.multimodal : undefined;
  return { id, displayName, contextWindow, reasoningEfforts, multimodal };
}

function isVideoModel(value) {
  const model = String(value || "").trim().toLowerCase();
  if (!model) return false;
  return /(^|[/:_-])(?:video|videoedit|t2v|i2v|r2v|veo|sora|seedance|kling|runway|pika|hailuo)([/:_-]|$)/i.test(model);
}

async function probeBaseUrl(baseUrl, timeoutMs, userAgent = "") {
  if (!safeLoopback(baseUrl) && !flag("CODEXPLUS_ALLOW_NON_LOOPBACK")) {
    const error = new Error("Codex++ discovery only accepts a loopback endpoint");
    error.code = "CODEXPLUS_NON_LOOPBACK";
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(userAgent ? { "user-agent": userAgent } : {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = (payload?.data || payload?.models || []).map(modelFromPayload).filter(Boolean);
    if (!models.length) throw new Error("empty model list");
    const looksLikeCodexPlus = payload?.data?.some(item => String(item?.owned_by || "").toLowerCase() === "codex-plus");
    if (!looksLikeCodexPlus && flag("CODEXPLUS_REQUIRE_OWNER")) {
      throw new Error("model list is not attributed to Codex++");
    }
    return { baseUrl, models };
  } finally {
    clearTimeout(timer);
  }
}

let cached = { at: 0, ready: false, value: null, error: null, inFlight: null };

function remember(value, error = null) {
  cached = { at: Date.now(), ready: true, value, error, inFlight: null };
  return value;
}

async function discover(options = {}) {
  const ttlMs = options.ttlMs ?? Number(process.env.CODEXPLUS_DISCOVERY_TTL_MS ?? DEFAULT_TTL_MS);
  const timeoutMs = options.timeoutMs ?? Number(process.env.CODEXPLUS_DISCOVERY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const overallTimeoutMs = options.overallTimeoutMs ?? Number(process.env.CODEXPLUS_DISCOVERY_OVERALL_TIMEOUT_MS ?? DEFAULT_OVERALL_TIMEOUT_MS);
  const force = Boolean(options.force);
  const now = Date.now();
  const fresh = cached.ready && (now - cached.at) < Math.max(0, ttlMs);
  if (!force && fresh && cached.error) throw cached.error;
  if (!force && fresh && cached.value) return cached.value;
  if (!force && cached.inFlight) return cached.inFlight;

  const urls = candidateUrls();
  const startedAt = Date.now();
  cached.inFlight = (async () => {
    const errors = [];
    for (const baseUrl of urls) {
      const remaining = overallTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      try {
        const value = remember(await probeBaseUrl(baseUrl, Math.min(timeoutMs, remaining), options.userAgent));
        return value;
      } catch (error) {
        errors.push(error.message || String(error));
      }
    }
    const error = new Error(`Codex++ protocol proxy is not reachable (${errors.slice(0, 3).join("; ")})`);
    error.code = "CODEXPLUS_UNAVAILABLE";
    remember(null, error);
    throw error;
  })();

  return cached.inFlight;
}

function responsesUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/$/, "")}/v1/responses`;
}

module.exports = {
  candidateUrls,
  codexPlusStateDir,
  discover,
  isVideoModel,
  normalizeBaseUrl,
  probeBaseUrl,
  responsesUrl,
};
