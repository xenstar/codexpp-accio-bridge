"use strict";
const http = require("http"); const fs = require("fs"); const path = require("path"); const net = require("net"); const tls = require("tls"); const { URL } = require("url");
const { PassThrough } = require("stream");
const codexPlus = require(path.join(__dirname, "codexplus.js"));
const codexPlusImage = require(path.join(__dirname, "codexplus-image.js"));
const { requestUserAgent } = require(path.join(__dirname, "client-identity.js"));
const { diagnostic, errorDetail } = require(path.join(__dirname, "diagnostics.js"));
const { decodeContentEncoding } = require(path.join(__dirname, "encoding.js"));
const HOST = process.env.RELAY_HOST || "127.0.0.1"; const PORT = Number(process.env.RELAY_PORT || 43100);
const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:43101"; const IMAGE_BRIDGE = process.env.ACCIO_IMAGE_BRIDGE_URL || ""; const ORIGINAL = process.env.ORIGINAL_GATEWAY_BASE_URL;
const SNAPSHOT_PATH = process.env.ACCIO_MODEL_CACHE_SNAPSHOT_PATH;
const DEBUG = String(process.env.RELAY_DEBUG || "").trim() === "1";
const configuredTimeout = Number(process.env.RELAY_UPSTREAM_TIMEOUT_MS);
const UPSTREAM_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120000;
const configuredImageTimeout = Number(process.env.RELAY_IMAGE_TIMEOUT_MS);
const IMAGE_TIMEOUT_MS = Number.isFinite(configuredImageTimeout) && configuredImageTimeout > 0 ? configuredImageTimeout : 600000;
function reply(res, code, value, headers = {}) { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); }
function hasModality(value, expected) {
  return Array.isArray(value) && value.some(item => String(item).trim().toUpperCase() === expected);
}
function hasImageModality(value) {
  return hasModality(value, "IMAGE");
}
function hasVideoModality(value) {
  return hasModality(value, "VIDEO");
}
function isImageModel(model) {
  const value = String(model || "").trim();
  if (!value) return false;
  return /(^|[/:_-])(?:gpt-image|dall-e|image-generation|seedream|flux)([/:_-]|$)/i.test(value)
    || /(^|[/:_-])[^/:_-]*image([/:_-]|$)/i.test(value);
}
function isImageGenerationPayload(payload) {
  const p = payload?.request || payload?.body || payload;
  const config = codexPlusImage.generationConfigOf(p);
  const imageConfig = config.imageConfig || config.image_config;
  const explicit = hasImageModality(config.responseModalities || config.response_modalities)
    || Boolean(imageConfig && typeof imageConfig === "object" && Object.keys(imageConfig).length);
  // Accio never reads a model capability flag for images -- the string `imageGeneration` does not
  // exist anywhere in its bundle -- so it treats every catalog entry as a chat model. An
  // `codexplus-image/...` code on a turn is therefore not proof the user wants an image: they may
  // just be chatting with the image model still selected. Only an explicit modality or imageConfig
  // starts generation; anything else with a group code falls through to the text bridge, which maps
  // it to a Codex++ chat model. Name inference stays for third-party codes we do not mint.
  return explicit || (isImageModel(p?.model) && !codexPlusImage.imageModelCode(p?.model));
}
function isVideoGenerationPayload(payload) {
  const p = payload?.request || payload?.body || payload;
  const config = codexPlusImage.generationConfigOf(p);
  return hasVideoModality(config.responseModalities || config.response_modalities)
    || codexPlus.isVideoModel(p?.model || p?.modelName);
}
function isCodexPlusFamilyModel(model) {
  const value = String(model || "").trim().toLowerCase();
  return value.startsWith("codexplus/") || value.startsWith("codexplus-image/");
}
const SHARESI_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
const OMNIROUTE_MODELS = ["omniroute/s/coding_cheap", "omniroute/s/free", "omniroute/oc/mimo-v2.5-free", "omniroute/cmd/deepseek/deepseek-v4-pro"];
const DEFAULT_AUTO_SOURCES = ["codexplus", "sharesi", "omni"];
function configuredSources() {
  const value = String(process.env.ACCIO_PROVIDER_SOURCES || "").trim();
  if (!value) return null;
  const parsed = value.split(",").map(source => source.trim().toLowerCase()).filter(Boolean);
  return parsed.length ? parsed : null;
}
function providerSourcesEnabled() {
  return configuredSources() || DEFAULT_AUTO_SOURCES;
}
function autoSourceMode() {
  return configuredSources() === null;
}
const FALLBACK_MODEL = { modelCode: "gpt-5.6-luna", modelName: "gpt-5.6-luna", modelDisplayName: "gpt-5.6-luna", contextWindow: 128000, visible: true, multimodal: false, reasoningEfforts: ["low", "medium", "high"] };
function modelEntry(template, code, isDefault, displayName) {
  const label = displayName || code;
  const model = { ...(template || FALLBACK_MODEL), modelCode: code, modelName: label, modelDisplayName: label, visible: true, isDefault };
  if (Array.isArray(model.reasoningEfforts)) model.reasoningEfforts = ["low", "medium", "high"];
  else model.reasoningEfforts = ["high"];
  if (model.capabilities && typeof model.capabilities === "object") model.capabilities = { ...model.capabilities, thinking: true, thinkingLevel: "high" };
  else model.capabilities = { thinking: true, thinkingLevel: "high" };
  if ("thinkingLevel" in (template || {})) model.thinkingLevel = "high";
  if ("thinkingEffort" in (template || {})) model.thinkingEffort = "high";
  return model;
}
function catalogTemplate(snapshot) {
  const source = snapshot?.data ?? snapshot;
  const groups = Array.isArray(source) ? source : source?.providers || source?.providerList || [];
  const templateGroup = groups.find(group => Array.isArray(group?.modelList)) || {};
  return templateGroup.modelList?.find(model => model && typeof model === "object");
}
function staticProviderCatalog(template, sources) {
  const groups = [];
  if (sources.includes("sharesi")) groups.push({ provider: "sharesi", providerDisplayName: "ShareSI", modelList: SHARESI_MODELS.map((code, i) => modelEntry(template, code, groups.length === 0 && i === 0)) });
  if (sources.includes("omni")) groups.push({ provider: "omniroute", providerDisplayName: "OmniRoute", modelList: OMNIROUTE_MODELS.map((code, i) => modelEntry(template, code, groups.length === 0 && i === 0)) });
  return groups;
}
function codexPlusProviderCatalog(discovered, template) {
  const seen = new Set();
  const modelList = [];
  for (const model of discovered?.models || []) {
    if (!model?.id || seen.has(model.id)) continue;
    if (codexPlus.isVideoModel(model.id)) continue;
    seen.add(model.id);
    const code = `codexplus/${model.id}`;
    const entry = {
      ...(template || FALLBACK_MODEL),
      modelCode: code,
      // Accio sends modelName for explicitly selected models. Native Accio
      // catalogs keep modelName equal to modelCode, so it must retain the
      // provider prefix or the bridge routes the request to the wrong provider.
      modelName: code,
      modelDisplayName: model.displayName || model.id,
      contextWindow: model.contextWindow || template?.contextWindow || FALLBACK_MODEL.contextWindow,
      multimodal: model.multimodal ?? template?.multimodal ?? false,
      visible: true,
      isDefault: modelList.length === 0
    };
    entry.reasoningEfforts = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length
      ? model.reasoningEfforts
      : Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length ? entry.reasoningEfforts : ["low", "medium", "high"];
    modelList.push(entry);
  }
  if (!modelList.length) throw new Error("Codex++ model list is empty");
  return [{ provider: "codexplus", providerDisplayName: "Codex++", modelList }];
}
// Accio refuses a turn before it sends anything when the prepared prompt does not fit
// `llm.contextWindow - output reserve`, and answers with "Prepared input exceeds the
// conservative context capacity". Image entries used to declare 8192 tokens, which tripped
// that guard on ordinary prompts, so they now inherit the same window the chat models get.
function imageContextWindow(template, groups) {
  const declared = [];
  for (const group of groups) {
    for (const model of group?.modelList || []) {
      const value = Number(model?.contextWindow);
      if (Number.isFinite(value) && value > 0) declared.push(value);
    }
  }
  const templateValue = Number(template?.contextWindow);
  if (Number.isFinite(templateValue) && templateValue > 0) declared.push(templateValue);
  if (declared.length) return Math.max(...declared);
  return FALLBACK_MODEL.contextWindow;
}
// Codex++ deliberately keeps image models out of /v1/models, so the chat group above can
// never show them. Read the same pool Codex++ uses for its own "Agent access" picker and
// expose it as a separate Accio group: users then choose GPT Image or a Qwen/Wan image
// model in Accio instead of in a hidden plugin setting.
function codexPlusImageCatalog(template, groups) {
  const mode = imageCatalogMode();
  if (mode === "off") return null;
  const contextWindow = imageContextWindow(template, groups);
  let entries;
  try {
    entries = codexPlusImage.imageCatalogEntries(codexPlusImage.imageModelOptions());
  } catch (error) {
    diagnostic("relay.image.catalog_unavailable", { error: errorDetail(error.message || error) });
    return null;
  }
  if (!entries.length) return null;
  const modelList = entries.map(entry => ({
    ...(template || FALLBACK_MODEL),
    modelCode: entry.code,
    modelName: entry.code,
    modelDisplayName: entry.displayName,
    modelDesc: entry.description,
    hoverDesc: entry.description,
    // Image models are not chat models: no reasoning ladder and no multimodal input claim.
    // The window has to stay realistic or Accio's own context guard blocks the turn.
    contextWindow,
    multimodal: false,
    visible: mode === "group",
    isDefault: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    usageLevel: 1,
    usageDesc: "Image generation",
    freeUse: true,
    capabilities: { thinking: false, imageGeneration: true },
  }));
  return { provider: "codexplus-image", providerDisplayName: "Codex++ Image", modelList };
}
function imageCatalogMode() {
  const value = String(process.env.ACCIO_IMAGE_CATALOG || "group").trim().toLowerCase();
  return ["group", "hidden", "off"].includes(value) ? value : "group";
}
function imageRouteMode() {
  const value = String(process.env.ACCIO_IMAGE_ROUTE || "auto").trim().toLowerCase();
  return ["auto", "codexplus", "gateway", "helper", "codex-cli", "off"].includes(value) ? value : "auto";
}
async function providerCatalog(snapshot, options = {}) {
  const template = catalogTemplate(snapshot);
  const sources = providerSourcesEnabled();
  let groups = [];
  if (sources.includes("codexplus")) {
    try {
      groups = codexPlusProviderCatalog(await codexPlus.discover({ userAgent: options.userAgent, force: options.force }), template);
    } catch (error) {
      if (!autoSourceMode() && sources.length === 1) throw error;
    }
  }
  const legacySources = autoSourceMode() && !groups.length ? DEFAULT_AUTO_SOURCES : sources;
  groups = groups.concat(staticProviderCatalog(template, legacySources.filter(source => source !== "codexplus")));
  if (!groups.length) throw new Error("No enabled Accio provider source is available");
  const imageGroup = codexPlusImageCatalog(template, groups);
  if (imageGroup) groups.push(imageGroup);
  return groups;
}
// Accio persists the gateway catalog envelope inside a versioned wrapper:
//   version 2 -> { snapshots: { "GLOBAL::en": <envelope> } }
//   version 3 -> { routeSnapshots: { "<gateway URL>|<account>|<region>|<lang>|<app>|<auto>": { raw, etag, validatedAt } },
//                  legacySnapshots: { "GLOBAL::en": <envelope> } }
// The version 3 route key contains the gateway base URL, so pointing Accio at our loopback relay
// creates a new key and leaves older real-gateway entries behind in the same file. Collect every
// candidate and prefer one that still carries model groups, then the newest, so a stale or empty
// entry cannot shadow the catalog Accio would actually render.
function snapshotCandidates(current) {
  const out = [];
  for (const bucket of ["snapshots", "routeSnapshots", "legacySnapshots"]) {
    const value = current[bucket];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const entry of Object.values(value)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      out.push(entry.raw && typeof entry.raw === "object" ? entry.raw : entry);
    }
  }
  return out;
}
function unwrapSnapshot(snapshot) {
  let current = snapshot;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return current;
    const candidates = snapshotCandidates(current).filter(entry => entry !== current);
    if (!candidates.length) return current;
    const usable = entry => (Array.isArray(entry?.data) && entry.data.some(group => Array.isArray(group?.modelList)) ? 1 : 0);
    current = candidates.slice().sort((a, b) => usable(b) - usable(a)
      || (Number(b?.ext?.serverTime || 0) - Number(a?.ext?.serverTime || 0)))[0];
  }
  return current;
}
async function catalogFromSnapshot(snapshot, options = {}) {
  const source = unwrapSnapshot(snapshot);
  const base = source && typeof source === "object" && !Array.isArray(source) ? JSON.parse(JSON.stringify(source)) : { data: [], ext: {} };
  const groups = await providerCatalog(base, options);
  if (Array.isArray(base.data)) base.data = groups;
  else if (base.data && typeof base.data === "object") {
    if (Array.isArray(base.data.providers)) base.data.providers = groups;
    else if (Array.isArray(base.data.providerList)) base.data.providerList = groups;
    else base.data = { ...base.data, providers: groups };
  } else base.data = groups;
  if (!Object.prototype.hasOwnProperty.call(base, "ext")) base.ext = {};
  return base;
}
function readSnapshot(input) {
  if (input && typeof input === "object" && (input.data || input.snapshots || input.routeSnapshots || input.legacySnapshots || input.version)) return input;
  if (!SNAPSHOT_PATH) return undefined;
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")); } catch (_) { return undefined; }
}
function safeError(value) { return String(value || "Upstream request failed").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 512); }
function bodySummary(body, headers = {}) {
  const byteLength = body ? Buffer.byteLength(Buffer.isBuffer(body) ? body : String(body)) : 0;
  const transport = {
    bodyBytes: byteLength,
    contentType: headers["content-type"] || "",
    contentEncoding: headers["content-encoding"] || "",
  };
  if (!body) return transport;
  try {
    const decoded = decodeContentEncoding(Buffer.isBuffer(body) ? body : String(body), headers["content-encoding"]);
    const payload = JSON.parse(decoded.toString("utf8"));
    const p = payload?.request || payload?.body || payload;
    return {
      ...transport,
      model: p?.model || "",
      selectionName: p?.selectModelName || p?.select_model_name || p?.selectModelNameKey || "",
      image: isImageGenerationPayload(payload),
    };
  } catch (_) {
    return transport;
  }
}
async function requestBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? Buffer.concat(chunks) : undefined; }
const HOP_BY_HOP_REQUEST_HEADERS = new Set(["connection", "content-length", "expect", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"]);
const OMITTED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]);
function forwardedHeaders(req) {
  const connectionTokens = String(req.headers.connection || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const hopByHop = new Set([...HOP_BY_HOP_REQUEST_HEADERS, ...connectionTokens]);
  return Object.fromEntries(Object.entries(req.headers).filter(([name]) => !hopByHop.has(name.toLowerCase())));
}
function forwardedResponseHeaders(headers) {
  return Object.fromEntries([...headers].filter(([name]) => !OMITTED_RESPONSE_HEADERS.has(name.toLowerCase())));
}
async function proxy(req, res, base, bodyOverride, route = "proxy") {
  const u = new URL(req.url, base);
  const headers = forwardedHeaders(req);
  headers["user-agent"] = requestUserAgent(req);
  const summary = bodySummary(bodyOverride, req.headers);
  const target = `${u.host}${u.pathname}`;
  const controller = new AbortController();
  const timeoutMs = route === "image" ? IMAGE_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
  let timeout = setTimeout(() => controller.abort(), timeoutMs);
  const refreshTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), timeoutMs); };
  try {
    const upstream = await fetch(u, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : (bodyOverride ?? await requestBody(req)), duplex: "half", signal: controller.signal });
    diagnostic("relay.upstream", { route, target, status: upstream.status, userAgent: headers["user-agent"], ...summary });
    res.writeHead(upstream.status, forwardedResponseHeaders(upstream.headers));
    if (upstream.body) for await (const chunk of upstream.body) { refreshTimeout(); res.write(chunk); }
    res.end();
  } catch (error) { const cause = error && error.cause ? ` (${error.cause.code || error.cause.message || "cause"})` : ""; const detail = error.name === "AbortError" ? "Upstream gateway request timed out" : `Upstream gateway request failed: ${error.message}${cause}`; diagnostic("relay.error", { route, target, error: errorDetail(detail) }); if (!res.headersSent) reply(res, 502, { error: { message: safeError(detail) } }); else res.end(); }
  finally { clearTimeout(timeout); }
}
function streamFrames(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end();
}
function videoUnsupportedFrame(model) {
  return {
    content: { role: "model", parts: [{ text: "" }] },
    partial: false,
    turnComplete: true,
    errorCode: "ACCIO_VIDEO_UNSUPPORTED",
    errorMessage: "Video generation is not routed by Accio Bridge. Use the harness's native video tool with the Codex++ video gateway. / Accio 桥接不路由视频生成。请在 harness 的原生视频工具中使用 Codex++ 视频网关。",
    customMetadata: { model: "auto", controller_model: String(model || ""), provider: "codexplus_video" },
  };
}
function tryJson(value) { try { return value(); } catch (_) { return null; } }
// Accio image turns. Codex++'s own image gateway goes first because that is what makes the
// user's Codex++ providers (including the Qwen/Wan image models) reachable; the Codex CLI
// bridge stays as a fallback. Nothing is written to the response until an attempt finishes,
// so a failed attempt can still fall through cleanly instead of half-streaming.
async function handleImage(req, res, rawBody, payload) {
  const mode = imageRouteMode();
  const request = payload?.request || payload?.body || payload;
  const controllerModel = String(request?.model || request?.modelName || "").trim();
  if (mode === "off") {
    return streamFrames(res, [codexPlusImage.errorFrame("ACCIO_IMAGE_PROVIDER_DISABLED", "Image generation is switched off (ACCIO_IMAGE_ROUTE=off).", controllerModel)]);
  }
  if (mode !== "codex-cli") {
    if (!payload) return reply(res, 400, { error: { code: "ACCIO_IMAGE_UNPARSEABLE", message: "Could not parse the Accio image request body." } });
    const result = await codexPlusImage.generate(payload, { userAgent: req.headers["user-agent"], timeoutMs: IMAGE_TIMEOUT_MS });
    if (result.ok) {
      diagnostic("relay.image", { via: "codexplus", route: result.route, model: result.meta.model, modelSource: result.meta.modelSource, images: result.items.length });
      return streamFrames(res, codexPlusImage.frames(result, controllerModel));
    }
    diagnostic("relay.image", { via: "codexplus", failed: true, code: result.failure.code, message: safeError(result.failure.message) });
    // Strict modes must report why Codex++ refused instead of quietly spending elsewhere.
    const strict = mode === "codexplus" || mode === "gateway" || mode === "helper";
    if (strict || !IMAGE_BRIDGE) {
      return streamFrames(res, [codexPlusImage.errorFrame(result.failure.code, result.failure.message, controllerModel)]);
    }
    diagnostic("relay.image", { via: "codex-cli", fallbackFrom: result.failure.code });
  }
  if (!IMAGE_BRIDGE) {
    return streamFrames(res, [codexPlusImage.errorFrame("ACCIO_IMAGE_PROVIDER_DISABLED", "No Codex++ image route is available and the Codex CLI image bridge is not running.", controllerModel)]);
  }
  return proxy(req, res, IMAGE_BRIDGE, rawBody, "image");
}
const server = http.createServer(async (req, res) => { if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true, service: "accio-relay" }); if (req.method === "GET" && req.url === "/image/status") return reply(res, 200, imageStatus()); if (req.method === "POST" && req.url === "/agent/prompt/enhance") { const body = await requestBody(req); return proxy(req, res, BRIDGE, body, "enhance"); } if (!req.url.startsWith("/api/")) return reply(res, 404, { error: { message: "Not found" } }); if (req.method === "POST" && req.url === "/api/llm/config/v2") { let input; try { const body = await requestBody(req); input = body ? JSON.parse(body.toString("utf8")) : undefined; } catch (_) {}
  try { const catalog = await catalogFromSnapshot(readSnapshot(input), { userAgent: requestUserAgent(req), force: true }); diagnostic("relay.catalog", { groups: catalog?.data?.length || 0, models: (catalog?.data || []).reduce((sum, group) => sum + (group?.modelList?.length || 0), 0) }); return reply(res, 200, catalog, { "cache-control": "no-store, max-age=0" }); }
  catch (error) { return reply(res, 503, { error: { code: "PROVIDER_CATALOG_UNAVAILABLE", message: safeError(error.message || error) } }); }
} if (req.method === "POST" && req.url.startsWith("/api/adk/llm/generateContent")) { const body = await requestBody(req); let image = false; let video = false; let payload; try { const decoded = decodeContentEncoding(body || Buffer.alloc(0), req.headers["content-encoding"]); payload = body ? JSON.parse(decoded.toString("utf8")) : undefined; image = isImageGenerationPayload(payload); video = isVideoGenerationPayload(payload); } catch (_) {} if (video) { const request = payload?.request || payload?.body || payload; const model = request?.model || request?.modelName || ""; diagnostic("relay.video", { codexplus: isCodexPlusFamilyModel(model), model }); return streamFrames(res, [videoUnsupportedFrame(model)]); } if (image) return handleImage(req, res, body, payload); return proxy(req, res, BRIDGE, body, "text"); } if (!ORIGINAL) return reply(res, 503, { error: { message: "ORIGINAL_GATEWAY_BASE_URL is not configured" } }); return proxy(req, res, ORIGINAL, undefined, "fallback"); });
function imageStatus() {
  const options = tryJson(() => codexPlusImage.imageModelOptions()) || [];
  return {
    ok: true,
    service: "accio-relay-image",
    route: imageRouteMode(),
    catalog: imageCatalogMode(),
    pinned: tryJson(() => codexPlusImage.pinnedImageModel()) || "",
    defaultModel: String(process.env.ACCIO_IMAGE_MODEL || "auto").trim() || "auto",
    bridge: IMAGE_BRIDGE || "",
    models: options.map(option => ({ id: option.id, label: option.label, providerId: option.providerId, providerName: option.providerName, model: option.model, vendorPicks: option.vendorPicks })),
  };
}
// Accio keeps a native realtime channel on the gateway origin (for example /ws/rc/device), and this
// relay answers 404 for it today. A tunnel implementation exists but is EXPERIMENTAL and OFF by
// default: measured on loopback it forwarded the 101 handshake correctly yet only 217 of 246 frame
// bytes (deterministic), while an identical raw TCP forwarder delivered 412 of 412. Corrupting the
// stream is worse than refusing the upgrade, so set RELAY_WS_TUNNEL=1 only while testing.
const WS_TUNNEL_ENABLED = String(process.env.RELAY_WS_TUNNEL || "").trim() === "1";
function originalTarget() { if (!ORIGINAL) return null; try { return new URL(ORIGINAL); } catch (_) { return null; } }
function serializeUpgradeRequest(req) {
  const target = originalTarget();
  const authority = target.port ? `${target.hostname}:${target.port}` : target.hostname;
  const lines = [];
  for (const [name, raw] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    // Host and Content-Length belong to the original hop; Connection/Upgrade are re-added canonically.
    if (lower === "host" || lower === "content-length" || lower === "connection" || lower === "upgrade") continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) lines.push(`${name}: ${value}`);
  }
  lines.push(`Host: ${authority}`, `Connection: ${req.headers.connection || "Upgrade"}`, `Upgrade: ${req.headers.upgrade || "websocket"}`);
  return `${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
}
server.on("upgrade", (req, socket, head) => {
  const target = originalTarget();
  if (!WS_TUNNEL_ENABLED || !target) { socket.destroy(); return; }
  const secure = target.protocol === "https:";
  const port = Number(target.port || (secure ? 443 : 80));
  socket.setNoDelay(true); socket.setTimeout(0);
  // Stop the flowing HTTP socket immediately so nothing is consumed before the tunnel exists.
  socket.pause();
  const upstream = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname, rejectUnauthorized: true })
    : net.connect({ host: target.hostname, port });
  upstream.setTimeout(0);
  if (DEBUG) {
    upstream.setNoDelay(true);
    for (const event of ["error", "close", "end", "timeout"]) {
      socket.on(event, () => console.error(`[ws] client socket ${event}`));
      upstream.on(event, () => console.error(`[ws] upstream ${event}`));
    }
  }
  let opened = false;
  const close = () => { try { upstream.destroy(); } catch (_) {} try { socket.destroy(); } catch (_) {} };
  const start = () => {
    if (opened) return; opened = true;
    try {
      const requestLine = serializeUpgradeRequest(req);
      if (DEBUG) console.error(`[ws] upgrade ${req.url} head=${head ? head.length : 0} requestBytes=${requestLine.length}`);
      upstream.write(requestLine);
      if (head && head.length) socket.unshift(head);
      upstream.pipe(socket);
      if (DEBUG) {
        const tap = new PassThrough();
        tap.on("data", chunk => console.error(`[ws] client->upstream ${chunk.length} bytes`));
        socket.pipe(tap); tap.pipe(upstream);
      } else {
        socket.pipe(upstream);
      }
      socket.resume();
    } catch (_) { close(); }
  };
  upstream.once(secure ? "secureConnect" : "connect", start);
  upstream.once("error", close); upstream.once("close", () => { try { socket.destroy(); } catch (_) {} });
  socket.once("error", close); socket.once("close", () => { try { upstream.destroy(); } catch (_) {} });
});
server.listen(PORT, HOST, () => console.log(`relay listening on http://${HOST}:${PORT}`));
