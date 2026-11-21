"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");
const { diagnostic } = require("./diagnostics.js");

// Accio puts its gateway access token in the JSON body of /api/mcp/proxy, not
// in an Authorization header. The relay captures that body and hands the token
// to this module, which exposes the same MCP catalog to Codex++ over a local
// streamable-HTTP endpoint.
const ALIBABA_AUTH_TOOL = "start_alibaba_com_auth";
const LOCAL_GATEWAY_BASE = "http://127.0.0.1:4097";
const CONNECTOR_AUTH_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TOOLS = [
  "work_create_Inquiry",
  "update_inquiry_task_requirements",
  "get_task_progress_summary",
  "list_inquiry_tasks",
  "get_inquiry_blockers",
  "sendInstructToSellerAgent",
  "set_auto_chat",
  "send_msg",
  "1688_procurement_digital_human_tool",
  "inquiry_data_batch_query",
  "inquiry_data_query",
  "inquiry_data_load",
  "retrieve_im_history",
  "query_recent_conversation",
  "query_recent_conversation_for_aimode",
  "query_conversation_msg_for_aimode",
  "start_alibaba_com_auth",
  "retrieve_reception_state",
];

const state = {
  accessToken: "",
  connectId: "",
  connectorId: "",
  teamId: "",
  language: "",
  capturedAt: 0,
  gatewayBase: "",
  localGatewayBase: LOCAL_GATEWAY_BASE,
  gatewayAuthorization: "",
  connectorAuthAt: 0,
  tools: null,
  toolsAt: 0,
  catalogTools: null,
  catalogAt: 0,
  lastTool: "",
  lastError: "",
};

function toolsFromCatalogValue(value) {
  if (!value) return [];
  if (typeof value === "string") {
    try { return toolsFromCatalogValue(JSON.parse(value)); } catch (_) { return []; }
  }
  if (Array.isArray(value)) return value.filter(tool => tool && typeof tool.name === "string");
  if (Array.isArray(value.tools)) return value.tools.filter(tool => tool && typeof tool.name === "string");
  if (value.tools && typeof value.tools === "object") {
    return Object.values(value.tools).filter(tool => tool && typeof tool.name === "string");
  }
  if (value.result) return toolsFromCatalogValue(value.result);
  if (value.data) return toolsFromCatalogValue(value.data);
  return [];
}

function catalogCandidates() {
  const explicit = String(process.env.ACCIO_MCP_CATALOG_PATH || "").trim();
  if (explicit) return fs.existsSync(explicit) ? [explicit] : [];
  const accounts = path.join(os.homedir(), ".accio", "accounts");
  if (!fs.existsSync(accounts)) return [];
  const files = [];
  for (const account of fs.readdirSync(accounts, { withFileTypes: true })) {
    if (!account.isDirectory()) continue;
    const objects = path.join(accounts, account.name, "prepared-artifacts", "mcp-catalog", "objects");
    if (!fs.existsSync(objects)) continue;
    for (const entry of fs.readdirSync(objects, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) files.push(path.join(objects, entry.name));
    }
  }
  return files
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(item => item.file);
}

function catalogTools() {
  if (state.catalogTools && Date.now() - state.catalogAt < 300000) return state.catalogTools;
  for (const file of catalogCandidates()) {
    try {
      const tools = toolsFromCatalogValue(JSON.parse(fs.readFileSync(file, "utf8")));
      if (tools.length) {
        state.catalogTools = tools;
        state.catalogAt = Date.now();
        return tools;
      }
    } catch (_) {
      // A partially written cache object is skipped; the next object is tried.
    }
  }
  return [];
}

function allowedTools() {
  const raw = String(process.env.ACCIO_MCP_TOOL_ALLOWLIST || "").trim();
  if (raw === "*") return null;
  if (!raw) return new Set(DEFAULT_TOOLS);
  return new Set(raw.split(",").map(value => value.trim()).filter(Boolean));
}

function publicStatus() {
  return {
    ok: true,
    service: "accio-mcp",
    hasToken: Boolean(state.accessToken),
    hasGatewayAuthorization: Boolean(gatewayAuthorization()),
    capturedAt: state.capturedAt || null,
    tokenAgeMs: state.capturedAt ? Date.now() - state.capturedAt : null,
    hasConnectId: Boolean(state.connectId),
    tools: Array.isArray(state.tools) ? state.tools.length : 0,
    lastTool: state.lastTool || "",
    lastError: state.lastError || "",
  };
}

function capture(body, headers = {}) {
  let payload;
  try {
    payload = Buffer.isBuffer(body) ? JSON.parse(body.toString("utf8")) : body;
  } catch (_) {
    return false;
  }
  if (!payload || typeof payload !== "object" || typeof payload.accessToken !== "string" || !payload.accessToken) {
    return false;
  }
  state.accessToken = payload.accessToken;
  state.connectId = String(payload.connectId || "");
  state.connectorId = String(
    headers.connectorid
    || headers["x-connector-id"]
    || (state.connectId.includes(":") ? state.connectId.split(":")[0] : "")
    || "",
  );
  state.teamId = String(payload.teamId || "");
  state.language = String(payload.language || headers["x-language"] || "");
  state.capturedAt = Date.now();
  state.lastError = "";
  return true;
}

function gatewayAuthorization() {
  if (!state.gatewayAuthorization) return "";
  if (Date.now() - state.connectorAuthAt > CONNECTOR_AUTH_TTL_MS) {
    state.gatewayAuthorization = "";
    state.connectorAuthAt = 0;
    return "";
  }
  return state.gatewayAuthorization;
}

function captureConnectorAuthorization(pathname, headers = {}) {
  if (!/^\/connectors\/alibaba\/auth\/?$/.test(String(pathname || ""))) return false;
  const authorization = String(headers.authorization || "").trim();
  if (!authorization) return false;
  state.gatewayAuthorization = authorization;
  state.connectorAuthAt = Date.now();
  state.lastError = "";
  return true;
}

function setGateway(base) {
  state.gatewayBase = String(base || "").replace(/\/$/, "");
}

function setLocalGateway(base) {
  state.localGatewayBase = String(base || LOCAL_GATEWAY_BASE).replace(/\/$/, "");
}

function parsePayload(text, contentType = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (contentType.includes("text/event-stream") || trimmed.startsWith("data:") || trimmed.startsWith("event:")) {
    let last = null;
    for (const line of trimmed.split(/\r?\n/)) {
      const value = line.trim();
      if (!value.startsWith("data:")) continue;
      const data = value.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { last = JSON.parse(data); } catch (_) {}
    }
    return last;
  }
  return JSON.parse(trimmed);
}

async function gatewayRpc(method, params, id) {
  if (!state.gatewayBase) throw new Error("Accio gateway URL is not configured.");
  if (!state.accessToken) {
    throw new Error("Accio MCP token is not captured yet. Open a routed Accio window once, then retry.");
  }
  const url = new URL("/api/mcp/proxy", state.gatewayBase);
  const payload = {
    accessToken: state.accessToken,
    request: { jsonrpc: "2.0", id: id || 1, method, params: params || {} },
  };
  if (state.connectId) payload.connectId = state.connectId;
  if (state.teamId) payload.teamId = state.teamId;
  if (state.language) payload.language = state.language;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (state.language) headers["x-language"] = state.language;
  if (state.teamId) headers["x-team-id"] = state.teamId;
  if (state.connectorId) headers.connectorid = state.connectorId;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.ACCIO_MCP_TIMEOUT_MS || 120000)),
  });
  const text = await response.text();
  let decoded;
  try {
    decoded = parsePayload(text, response.headers.get("content-type") || "");
  } catch (error) {
    throw new Error(`Accio MCP returned an unreadable response (HTTP ${response.status}): ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Accio MCP HTTP ${response.status}: ${decoded?.message || text.slice(0, 200)}`);
  }
  if (decoded && typeof decoded === "object" && decoded.success === false) {
    throw new Error(decoded.message || "Accio MCP request failed.");
  }
  if (decoded && typeof decoded === "object" && "data" in decoded) return decoded.data;
  return decoded;
}

function safeAuthUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : "";
  } catch (_) {
    return "";
  }
}

function connectorAuthError(status) {
  const suffix = status ? ` (HTTP ${status})` : "";
  return new Error(
    `Accio could not start the Alibaba.com connector authorization${suffix}. `
    + "Open Accio -> Connectors -> Alibaba.com and choose Connect / Reconnect.",
  );
}

async function nativeAlibabaAuth(lang) {
  if (!state.localGatewayBase) throw new Error("Accio local gateway URL is not configured.");
  const authorization = gatewayAuthorization();
  if (!authorization) {
    throw new Error(
      "Accio gateway authorization is not captured yet. Open Accio -> Connectors -> Alibaba.com "
      + "and choose Connect / Reconnect once, then retry from Codex.",
    );
  }
  const url = new URL("/connectors/alibaba/auth", state.localGatewayBase);
  const headers = {
    authorization,
    accept: "application/json",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(Number(process.env.ACCIO_CONNECTOR_AUTH_TIMEOUT_MS || 30000)),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      state.gatewayAuthorization = "";
      state.connectorAuthAt = 0;
    }
    throw connectorAuthError(response.status);
  }

  const text = await response.text();
  let decoded;
  try {
    decoded = parsePayload(text, response.headers.get("content-type") || "");
  } catch (_) {
    throw new Error("Accio returned an unreadable Alibaba.com connector authorization response.");
  }
  if (decoded && typeof decoded === "object" && decoded.success === false) {
    throw connectorAuthError(response.status);
  }
  const data = decoded && typeof decoded === "object" && decoded.data && typeof decoded.data === "object"
    ? decoded.data
    : decoded;
  const authUrl = safeAuthUrl(data?.authUrl || data?.auth_url || data?.login_url);
  if (!authUrl) {
    throw connectorAuthError(response.status);
  }
  return authUrl;
}

function alibabaAuthResult(id, loginUrl) {
  return mcpResult(id, {
    content: [{
      type: "text",
      text: JSON.stringify({ success: true, login_url: loginUrl }),
    }],
    isError: false,
  });
}

async function listTools(force) {
  const fresh = state.tools && Date.now() - state.toolsAt < 300000;
  if (fresh && !force) return state.tools;
  let raw = catalogTools();
  if (!raw.length) {
    const result = await gatewayRpc("tools/list", {}, 1);
    raw = toolsFromCatalogValue(result);
  }
  const allow = allowedTools();
  const tools = raw
    .filter(tool => tool && typeof tool.name === "string")
    .filter(tool => !allow || allow.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || { type: "object", properties: {} },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    }));
  state.tools = tools;
  state.toolsAt = Date.now();
  return tools;
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcEnvelope(value) {
  return value
    && typeof value === "object"
    && value.jsonrpc === "2.0"
    && ("result" in value || "error" in value);
}

function normalizeCallResult(value) {
  if (rpcEnvelope(value)) {
    if (value.error) {
      return {
        content: [{ type: "text", text: JSON.stringify(value.error) }],
        isError: true,
      };
    }
    return normalizeCallResult(value.result);
  }
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    const content = [];
    let isError = Boolean(value.isError);
    for (const item of value.content) {
      if (item?.type === "text" && typeof item.text === "string") {
        let nested;
        try { nested = JSON.parse(item.text); } catch (_) {}
        if (rpcEnvelope(nested)) {
          const normalized = normalizeCallResult(nested);
          content.push(...normalized.content);
          isError = isError || normalized.isError;
          continue;
        }
        if (nested && typeof nested === "object" && nested.success === false) {
          isError = true;
        }
      }
      content.push(item);
    }
    return { ...value, content, isError };
  }
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? null) }],
    isError: false,
  };
}

async function handleRpc(message) {
  const id = message.id;
  const method = message.method;
  if (method === "initialize") {
    return mcpResult(id, {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "accio-mcp", version: "0.1.0" },
    });
  }
  if (method === "ping") return mcpResult(id, {});
  if (method === "tools/list") {
    try {
      return mcpResult(id, { tools: await listTools(false) });
    } catch (error) {
      state.lastError = error.message;
      return mcpError(id, -32000, error.message);
    }
  }
  if (method === "tools/call") {
    const name = message.params?.name;
    if (!name) return mcpError(id, -32602, "tools/call requires params.name");
    state.lastTool = String(name);
    try {
      if (name === ALIBABA_AUTH_TOOL) {
        const loginUrl = await nativeAlibabaAuth(message.params?.arguments?.lang);
        return alibabaAuthResult(id, loginUrl);
      }
      const result = await gatewayRpc("tools/call", message.params, id || 1);
      return mcpResult(id, normalizeCallResult(result));
    } catch (error) {
      state.lastError = error.message;
      return mcpResult(id, {
        content: [{ type: "text", text: error.message }],
        isError: true,
      });
    }
  }
  return mcpError(id, -32601, `Unsupported method: ${method}`);
}

function startMcpServer(options = {}) {
  const host = options.host || process.env.ACCIO_MCP_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.ACCIO_MCP_PORT || 43103);
  if (options.gatewayBase) setGateway(options.gatewayBase);
  if (options.localGatewayBase) setLocalGateway(options.localGatewayBase);

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host || "mcp.invalid"}`).pathname;
    if (req.method === "GET" && (pathname === "/health" || pathname === "/")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(publicStatus()));
      return;
    }
    if (req.method === "DELETE" && pathname === "/mcp") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method !== "POST" || pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (_) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(mcpError(null, -32700, "Invalid JSON")));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses = [];
    for (const message of messages) {
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") continue;
      if (message.id === undefined || message.id === null) continue;
      responses.push(await handleRpc(message));
    }
    if (!responses.length) {
      res.writeHead(202, { "content-type": "application/json" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
  });

  server.on("error", error => {
    state.lastError = error.message;
    diagnostic("mcp.server", { error: error.message });
  });
  server.listen(port, host, () => {
    diagnostic("mcp.server", { listening: `${host}:${port}` });
  });
  return server;
}

module.exports = {
  capture,
  captureConnectorAuthorization,
  gatewayAuthorization,
  setGateway,
  setLocalGateway,
  startMcpServer,
  publicStatus,
  listTools,
  gatewayRpc,
};
