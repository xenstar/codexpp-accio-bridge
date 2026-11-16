"use strict";

// Codex++ image gateway client for Accio.
//
// Codex++ keeps image models out of the chat model list on purpose (gateway/route.rs
// `chat_models()` filters them) and serves them from a dedicated endpoint. Accio speaks a
// Gemini-style ADK contract instead, so this module translates Accio image requests into
// Codex++'s OpenAI image API and turns the reply back into Accio ADK SSE frames.
//
// Two upstream shapes are picked automatically, both read-only against Codex++ state:
//   route "gateway"  POST <helper>/gw/accio/v1/images/generations
//                    Needs a gateway binding for agent "accio", which Codex++ only creates
//                    once Accio is in its agent catalog. Highest fidelity: Codex++ resolves
//                    the per-agent image model itself.
//   route "helper"   POST <helper>/v1/images/generations
//                    No binding needed. Codex++ handles it as the Codex agent's image model
//                    when Codex is pointed at the gateway, which is the shipped default.
//
// Codex++ state files hold live API keys. Only the fields listed here are read, and no
// token or key ever leaves this module into a log line or an error message.

const fs = require("node:fs");
const path = require("node:path");

const codexPlus = require(path.join(__dirname, "codexplus.js"));
const { requestUserAgent } = require(path.join(__dirname, "client-identity.js"));
const { diagnostic } = require(path.join(__dirname, "diagnostics.js"));

const AGENT_ID = "accio";
const IMAGE_CODE_PREFIX = "codexplus-image/";
const CHATGPT_IMAGE_MODEL = "gpt-image-2";
const CODEX_GATEWAY_RELAY_ID = "codex-plus-gateway";
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// Mirrors IMAGE_MODEL_MARKS in Codex++ gateway/images.rs so the picker agrees with the app.
const IMAGE_MODEL_MARKS = [
  "image",
  "imagine",
  "dall-e",
  "imagen",
  "flux",
  "seedream",
  "cogview",
  "wanx",
  "kolors",
  "stable-diffusion",
  "sdxl",
  "midjourney",
];

// OpenAI image models accept these three sizes plus "auto".
const OPENAI_SIZE_BY_RATIO = new Map([
  ["1:1", "1024x1024"],
  ["16:9", "1536x1024"],
  ["4:3", "1536x1024"],
  ["3:2", "1536x1024"],
  ["9:16", "1024x1536"],
  ["3:4", "1024x1536"],
  ["2:3", "1024x1536"],
]);

function flag(name) {
  return String(process.env[name] || "").trim().toLowerCase();
}

function isImageModel(model) {
  const value = String(model || "").trim().toLowerCase();
  if (!value) return false;
  // Same rule as Codex++: judge the last "/"-separated segment, ignore the provider prefix.
  const name = value.split("/").pop() || value;
  return IMAGE_MODEL_MARKS.some(mark => name.includes(mark));
}

function splitModelList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

// Codex++ masks account names before it shows them to an agent (gateway/accounts.rs
// `mask_account_name`). Accio would otherwise render a user's email in its model picker,
// so the same shape is applied here: keep the first two and last two characters of the
// local part, keep the domain, and never touch anything that is not an email.
function maskToken(value) {
  const chars = Array.from(value);
  if (chars.length <= 4) return "*".repeat(chars.length);
  return `${chars.slice(0, 2).join("")}****${chars.slice(-2).join("")}`;
}

function maskAccountName(name) {
  return String(name || "").split(/\s+/).map(word => {
    const at = word.indexOf("@");
    if (at <= 0) return word;
    const local = word.slice(0, at);
    const domain = word.slice(at + 1);
    if (!domain.includes(".") || domain.endsWith(".")) return word;
    return `${maskToken(local)}@${domain}`;
  }).join(" ");
}

function gatewayFile() {
  return path.join(codexPlus.codexPlusStateDir(), "gateway.json");
}

function settingsFile() {
  return path.join(codexPlus.codexPlusStateDir(), "settings.json");
}

// Codex++ treats an official-login ChatGPT account as "the backend picks the image model",
// labelled with the Codex CLI image name. is_official_login_profile + Responses + no API
// transport, reduced to the fields we are allowed to read.
function isOfficialAccount(relay) {
  return (
    String(relay?.relayMode || "").toLowerCase() === "official" &&
    !relay?.officialMixApiKey &&
    String(relay?.protocol || "") === "responses" &&
    !String(relay?.upstreamBaseUrl || "").trim()
  );
}

// One entry per image model Codex++ would actually route to, in pool order.
function imageModelOptions() {
  const gateway = readJsonFile(gatewayFile());
  const providers = Array.isArray(gateway?.providers) ? gateway.providers : [];
  const options = [];
  const seen = new Set();
  for (const entry of providers) {
    if (!entry || entry.enabled === false) continue;
    const relay = entry.relay || {};
    const providerId = String(relay.id || "").trim();
    if (!providerId) continue;
    const displayName = maskAccountName(String(relay.name || providerId));
    if (isOfficialAccount(relay)) {
      const id = `${providerId}/${CHATGPT_IMAGE_MODEL}`;
      if (!seen.has(id)) {
        seen.add(id);
        options.push({
          providerId,
          providerName: displayName,
          model: CHATGPT_IMAGE_MODEL,
          vendorPicks: true,
          id,
          label: `${displayName} · ${CHATGPT_IMAGE_MODEL}`,
        });
      }
      continue;
    }
    for (const model of splitModelList(relay.modelList)) {
      if (!isImageModel(model)) continue;
      const id = `${providerId}/${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      options.push({
        providerId,
        providerName: displayName,
        model,
        vendorPicks: false,
        id,
        label: `${displayName} · ${model}`,
      });
    }
  }
  return options;
}

// Codex++'s own per-agent pick, if the user has set one. Empty string means "auto".
function pinnedImageModel() {
  const gateway = readJsonFile(gatewayFile());
  const map = gateway?.imageModels || gateway?.image_models;
  if (!map || typeof map !== "object") return "";
  return String(map[AGENT_ID] ?? "").trim();
}

function accioBinding() {
  const gateway = readJsonFile(gatewayFile());
  const binding = gateway?.bindings?.[AGENT_ID];
  if (!binding || binding.enabled !== true) return null;
  const token = String(binding.token || "").trim();
  return token ? { token } : null;
}

function codexOnGateway() {
  const settings = readJsonFile(settingsFile());
  const active = String(settings?.activeRelayId ?? settings?.active_relay_id ?? "").trim();
  return active === CODEX_GATEWAY_RELAY_ID;
}

// Pick the upstream. Returns { mode, endpoint, headers } or { error, detail }.
async function planRoute(options = {}) {
  const forced = flag("ACCIO_IMAGE_ROUTE");
  if (forced === "off" || forced === "codex-cli") {
    return { error: "DISABLED", detail: `ACCIO_IMAGE_ROUTE=${forced || "off"}` };
  }
  const discovered = await codexPlus.discover({ userAgent: options.userAgent, force: options.force });
  const baseUrl = discovered?.baseUrl || "";
  if (!baseUrl) return { error: "CODEXPLUS_UNAVAILABLE", detail: "no loopback endpoint discovered" };
  const binding = accioBinding();
  if (binding) {
    return {
      mode: "gateway",
      endpoint: `${baseUrl}/gw/${AGENT_ID}/v1`,
      headers: { authorization: `Bearer ${binding.token}` },
    };
  }
  if (forced === "gateway") {
    return { error: "NO_BINDING", detail: `Codex++ has no enabled gateway binding for agent "${AGENT_ID}"` };
  }
  if (!codexOnGateway()) {
    return {
      error: "CODEX_NOT_ON_GATEWAY",
      detail: `Codex++ activeRelayId is not "${CODEX_GATEWAY_RELAY_ID}", so the helper image path would bypass the provider pool`,
    };
  }
  return { mode: "helper", endpoint: `${baseUrl}/v1`, headers: {} };
}

function textOfParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter(part => typeof part?.text === "string" && part.text.trim())
    .map(part => part.text.trim())
    .join("\n");
}

// Accio sends the whole conversation; the image prompt is the newest user text. Fall back
// through older user turns, then any text, so an agent that only emits tool results still
// produces a usable prompt instead of an empty one.
function promptFromPayload(payload) {
  const contents = Array.isArray(payload?.contents) ? payload.contents : [];
  const userTurns = contents
    .filter(content => content?.role === "user")
    .map(content => textOfParts(content.parts))
    .filter(Boolean);
  if (userTurns.length) return userTurns[userTurns.length - 1];
  const anyTurn = contents.map(content => textOfParts(content.parts)).filter(Boolean);
  if (anyTurn.length) return anyTurn[anyTurn.length - 1];
  const system = payload?.systemInstruction ?? payload?.system_instruction;
  return textOfParts(system?.parts) || "Generate one image.";
}

function inlineBytes(part) {
  const inlineData = part?.inlineData ?? part?.inline_data;
  const data = String(inlineData?.data || "");
  if (!data) return null;
  return {
    mimeType: String(inlineData?.mimeType ?? inlineData?.mime_type ?? "image/png"),
    data,
  };
}

function referenceImages(payload) {
  const out = [];
  for (const content of Array.isArray(payload?.contents) ? payload.contents : []) {
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      const inline = inlineBytes(part);
      if (inline) {
        out.push(inline);
        continue;
      }
      const fileData = part?.fileData ?? part?.file_data;
      const uri = String(fileData?.fileUri ?? fileData?.file_uri ?? fileData?.url ?? "");
      if (uri.startsWith("data:")) {
        const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(uri);
        if (match) out.push({ mimeType: match[1], data: match[2] });
      } else if (/^https?:\/\//i.test(uri)) {
        out.push({ url: uri });
      }
    }
  }
  return out;
}

// Accio builds generationConfig two ways depending on the adapter: as an object for the ADK
// gateway request, and as a JSON string in its Gemini-style path (`generationConfig:
// JSON.stringify(...)`). Reading it as an object only would silently drop the image signal and
// the requested aspect ratio, so every reader goes through here.
function generationConfigOf(source) {
  const raw = source?.generationConfig ?? source?.generation_config;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {
      // Not JSON after all: treat it as no config rather than failing the turn.
    }
  }
  return {};
}

function imageConfigOf(payload) {
  const generationConfig = generationConfigOf(payload);
  return generationConfig.imageConfig ?? generationConfig.image_config ?? {};
}

// Only send `size` when we are confident the upstream understands it. DashScope-style
// endpoints reject unknown sizes, so an explicit Accio size is normalised and a bare
// aspectRatio is only translated for OpenAI-style models.
function sizeFor(model, imageConfig) {
  const explicit = String(imageConfig.imageSize ?? imageConfig.image_size ?? "").trim();
  const parsed = /^(\d+)\s*[x*×]\s*(\d+)$/i.exec(explicit);
  if (parsed) return { width: Number(parsed[1]), height: Number(parsed[2]) };
  const ratio = String(imageConfig.aspectRatio ?? imageConfig.aspect_ratio ?? "").trim();
  const openai = OPENAI_SIZE_BY_RATIO.get(ratio);
  if (openai && /gpt-image|dall-e|imagen|sdxl|flux/i.test(String(model || ""))) {
    const [width, height] = openai.split("x").map(Number);
    return { width, height };
  }
  return null;
}

function sizeString(model, size) {
  if (!size) return null;
  // DashScope uses "W*H"; OpenAI uses "WxH".
  return /wan|qwen-image|seedream|cogview|kolors/i.test(String(model || ""))
    ? `${size.width}*${size.height}`
    : `${size.width}x${size.height}`;
}

function imageModelCode(value) {
  const raw = String(value || "").trim();
  return raw.startsWith(IMAGE_CODE_PREFIX) ? raw.slice(IMAGE_CODE_PREFIX.length) : "";
}

// Precedence: the image model Accio selected, then the plugin default, then Codex++ auto.
function resolveImageModel(payload, options = {}) {
  const selected =
    imageModelCode(payload?.model) ||
    imageModelCode(payload?.modelName) ||
    imageModelCode(options.selectedModel);
  const configured = String(process.env.ACCIO_IMAGE_MODEL || options.imageModel || "").trim();
  const choice = selected || (configured && configured !== "auto" ? configured : "");
  if (!choice) return { model: "", providerId: "", source: "auto" };
  const [providerId, ...rest] = choice.split("/");
  const model = rest.length ? rest.join("/") : choice;
  return { model, providerId: rest.length ? providerId : "", source: selected ? "accio" : "plugin" };
}

function buildMultipart(fields, files) {
  const boundary = `----AccioBridge${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8",
    ));
  }
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      "utf8",
    ));
    parts.push(Buffer.from(file.data, "base64"));
    parts.push(Buffer.from("\r\n", "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

function extensionFor(mimeType) {
  if (/jpeg|jpg/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  return "png";
}

// Build the Codex++ request. Reference images go to /images/edits as multipart, matching
// OpenAI; a plain request goes to /images/generations as JSON.
function buildRequest(payload, route, context = {}) {
  // Accio serialises the ADK request message itself, so model/contents/generationConfig sit at the
  // top level. The text bridge and relay both tolerate a `{request: {...}}` envelope, and an
  // otherwise identical image turn sent that way used to lose the selected model, the prompt and the
  // requested size without any error. Unwrapping once here keeps the two paths consistent.
  const request = payload?.request || payload?.body || payload;
  const resolved = resolveImageModel(request, context);
  const imageConfig = imageConfigOf(request);
  const references = referenceImages(request);
  const prompt = promptFromPayload(request);
  const size = sizeFor(resolved.model, imageConfig);
  const sizeValue = sizeString(resolved.model, size);
  const edits = references.length > 0;
  const suffix = edits ? "images/edits" : "images/generations";
  const url = `${route.endpoint}/${suffix}`;

  if (edits) {
    const files = references
      .filter(image => !image.url)
      .map((image, index) => ({
        field: "image",
        filename: `reference-${index + 1}.${extensionFor(image.mimeType)}`,
        mimeType: image.mimeType,
        data: image.data,
      }));
    if (!files.length) {
      return {
        url,
        edits,
        model: resolved.model,
        source: resolved.source,
        failure: {
          code: "ACCIO_IMAGE_REFERENCE_UNRESOLVED",
          message: "Reference images are remote URLs, which the Codex++ image gateway edits endpoint does not accept.",
        },
      };
    }
    const fields = { prompt };
    if (resolved.model) fields.model = resolved.model;
    if (sizeValue) fields.size = sizeValue;
    const multipart = buildMultipart(fields, files);
    return {
      url,
      edits,
      model: resolved.model,
      source: resolved.source,
      contentType: multipart.contentType,
      body: multipart.body,
    };
  }

  const json = { prompt, n: 1 };
  if (resolved.model) json.model = resolved.model;
  if (sizeValue) json.size = sizeValue;
  return {
    url,
    edits,
    model: resolved.model,
    source: resolved.source,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(json), "utf8"),
  };
}

function mimeTypeForBase64(data) {
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("UklGR")) return "image/webp";
  if (data.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

async function downloadBase64(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`image download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw new Error("image download too large");
    return bytes.toString("base64");
  } finally {
    clearTimeout(timer);
  }
}

// Codex++ inlines url-only replies for gateway agents, but the helper route may still hand
// back a link. Resolve every item to base64 so Accio always gets real image bytes.
async function normalizeItems(payload, timeoutMs) {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const out = [];
  for (const item of items) {
    let data = String(item?.b64_json || "");
    let mimeType = "";
    if (!data) {
      const url = String(item?.url || "");
      const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(url);
      if (dataUrl) {
        mimeType = dataUrl[1];
        data = dataUrl[2];
      } else if (/^https?:\/\//i.test(url)) {
        data = await downloadBase64(url, timeoutMs);
      }
    }
    if (!data) continue;
    out.push({
      data,
      mimeType: mimeType || mimeTypeForBase64(data),
      revisedPrompt: String(item?.revised_prompt || ""),
    });
  }
  return out;
}

function errorFromUpstream(status, text) {
  let message = "";
  try {
    const parsed = JSON.parse(text);
    message = String(parsed?.error?.message || parsed?.message || parsed?.error || "");
  } catch (_) {
    message = String(text || "");
  }
  message = message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
  // Codex++ answers in Chinese; keep the meaning but make it actionable in English.
  if (/没有为|网关模式没有|not enabled for/i.test(message)) {
    return { code: "ACCIO_IMAGE_NO_BINDING", message: "Codex++ has no gateway binding for Accio yet. Ask the Codex++ maintainer to add Accio to the agent list, or keep the helper route." };
  }
  if (/token 无效|invalid token|unauthorized/i.test(message)) {
    return { code: "ACCIO_IMAGE_TOKEN", message: "The Codex++ gateway token for Accio is stale. Re-apply gateway mode in Codex++." };
  }
  if (/已关闭|image generation is off/i.test(message)) {
    return { code: "ACCIO_IMAGE_OFF", message: `Image generation is switched off for Accio in the Codex++ gateway (HTTP ${status}).` };
  }
  if (/没有能生图的模型|no image model/i.test(message)) {
    return { code: "ACCIO_IMAGE_NO_POOL", message: "No enabled Codex++ provider has an image model. Add one (for example gpt-image-2, wan2.7-image-pro or qwen-image-3.0-pro) to a provider." };
  }
  if (/已删除或关闭|deleted or disabled/i.test(message)) {
    return { code: "ACCIO_IMAGE_PROVIDER_GONE", message: `The provider behind the selected image model was removed or disabled in Codex++ (HTTP ${status}).` };
  }
  return { code: `ACCIO_IMAGE_HTTP_${status}`, message: message || `Codex++ image gateway answered HTTP ${status}.` };
}

// One attempt against Codex++. Returns { ok, items, meta } or { ok: false, failure }.
async function generate(payload, context = {}) {
  const timeoutMs = Number(context.timeoutMs) || 600000;
  const userAgent = context.userAgent || "";
  let route;
  try {
    route = await planRoute({ userAgent, force: context.force });
  } catch (error) {
    return {
      ok: false,
      route: null,
      failure: { code: error?.code || "CODEXPLUS_UNAVAILABLE", message: error?.message || String(error) },
    };
  }
  if (route.error) return { ok: false, route, failure: { code: route.error, message: route.detail } };

  const request = buildRequest(payload, route, context);
  if (request.failure) return { ok: false, route, failure: request.failure };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": request.contentType,
        "user-agent": requestUserAgent({ headers: { "user-agent": userAgent } }),
        ...route.headers,
      },
      body: request.body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const detail = error?.name === "AbortError"
      ? `Codex++ image request timed out after ${timeoutMs} ms`
      : (error?.message || String(error));
    diagnostic("image.codexplus.error", { route: route.mode, target: request.url, error: detail });
    return { ok: false, route, failure: { code: "ACCIO_IMAGE_UNREACHABLE", message: detail } };
  }
  clearTimeout(timer);

  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = null;
  }
  if (!response.ok) {
    const failure = errorFromUpstream(response.status, text);
    diagnostic("image.codexplus.error", { route: route.mode, target: request.url, status: response.status, error: failure.message });
    return { ok: false, route, failure };
  }
  let items;
  try {
    items = await normalizeItems(parsed, timeoutMs);
  } catch (error) {
    return { ok: false, route, failure: { code: "ACCIO_IMAGE_INLINE_FAILED", message: error?.message || String(error) } };
  }
  if (!items.length) {
    return { ok: false, route, failure: { code: "ACCIO_IMAGE_EMPTY_REPLY", message: "Codex++ image gateway answered without any image data." } };
  }
  diagnostic("image.codexplus.ok", {
    route: route.mode,
    status: response.status,
    images: items.length,
    model: request.model || "auto",
    modelSource: request.source,
    edits: request.edits,
  });
  return {
    ok: true,
    route: route.mode,
    items,
    meta: {
      model: request.model || "auto",
      modelSource: request.source,
      route: route.mode,
      edits: request.edits,
      revisedPrompt: items[0]?.revisedPrompt || "",
    },
  };
}

// Accio renders a normal ADK turn, so the image arrives as inlineData parts.
function frames(result, controllerModel) {
  const parts = result.items.map(item => ({ inlineData: { mimeType: item.mimeType, data: item.data } }));
  return [{
    content: { role: "model", parts },
    partial: false,
    turnComplete: true,
    finishReason: "STOP",
    customMetadata: {
      model: result.meta.model,
      controller_model: controllerModel || "",
      provider: "codexplus_image",
      route: result.meta.route,
      edits: result.meta.edits,
      revised_prompt: result.meta.revisedPrompt,
    },
  }];
}

function errorFrame(code, message, controllerModel) {
  return {
    content: { role: "model", parts: [{ text: "" }] },
    partial: false,
    turnComplete: true,
    errorCode: String(code),
    errorMessage: String(message),
    customMetadata: { model: "auto", controller_model: controllerModel || "", provider: "codexplus_image" },
  };
}

function imageCatalogEntries(options) {
  return options.map(option => ({
    code: `${IMAGE_CODE_PREFIX}${option.id}`,
    // Codex++ labels its own subscription backend as "GPT Image" (gateway-model.ts
    // `imageModelLabel`); reuse that so the Accio picker reads the same way as the
    // Codex++ UI. Provider models keep their vendor name since that is what the user
    // added and what they will recognise.
    displayName: option.vendorPicks ? "GPT Image" : option.model,
    description: option.vendorPicks
      ? "Image generation through your ChatGPT subscription"
      : `Image generation via ${option.providerName}`,
    providerId: option.providerId,
    providerName: option.providerName,
    model: option.model,
    vendorPicks: option.vendorPicks,
  }));
}

module.exports = {
  AGENT_ID,
  CHATGPT_IMAGE_MODEL,
  IMAGE_CODE_PREFIX,
  IMAGE_MODEL_MARKS,
  buildRequest,
  errorFrame,
  frames,
  generate,
  generationConfigOf,
  imageCatalogEntries,
  imageModelCode,
  imageModelOptions,
  isImageModel,
  normalizeItems,
  pinnedImageModel,
  planRoute,
  promptFromPayload,
  referenceImages,
  resolveImageModel,
  sizeFor,
  sizeString,
};
