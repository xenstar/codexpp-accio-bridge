import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayScript = path.join(here, "..", "sidecar", "relay.js");

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : undefined;
}

const observed = [];
const gateway = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/connectors/alibaba/auth") {
    const body = await readJson(req);
    observed.push({
      kind: "native-auth",
      body,
      authorization: req.headers.authorization || "",
      clientType: req.headers["x-client-type"] || "",
      language: req.headers["x-language"] || "",
      localGateway: req.headers["x-test-local-gateway"] === "1",
    });
    if (req.headers["x-language"] === "zh") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: {
        authUrl: "https://login.alibaba.com/authorize?client=accio-test",
        state: "oauth-state-must-not-leak",
        callbackUrl: "http://127.0.0.1:4097/connectors/alibaba/callback",
        accessToken: "nested-access-token-must-not-leak",
      },
    }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/mcp/proxy") {
    res.writeHead(404);
    res.end();
    return;
  }
  const body = await readJson(req);
  observed.push({ kind: "proxy", body, connectorId: req.headers.connectorid || "" });
  const method = body.request?.method;
  res.writeHead(200, { "content-type": "application/json" });
  if (method === "tools/list") {
    res.end(JSON.stringify({
      success: true,
      data: {
        tools: [
          {
            name: "1688_procurement_digital_human_tool",
            description: "Create a 1688 sourcing inquiry",
            inputSchema: { type: "object", properties: { offerName: { type: "string" } } },
          },
          {
            name: "inquiry_data_batch_query",
            description: "Read 1688 inquiry conversations",
            inputSchema: {
              type: "object",
              properties: {
                ds: { type: "string" },
                buyer_loginId: { type: "string" },
              },
            },
          },
          {
            name: "retrieve_im_history",
            description: "Read IM history",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "send_msg",
            description: "Send a supplier message",
            inputSchema: { type: "object", properties: { content: { type: "string" } } },
          },
          {
            name: "query_recent_conversation",
            description: "List recent conversations",
            inputSchema: { type: "object", properties: { request: { type: "object" } } },
          },
          {
            name: "query_recent_conversation_for_aimode",
            description: "List buyer-side recent conversations",
            inputSchema: { type: "object", properties: { request: { type: "object" } } },
          },
          {
            name: "query_conversation_msg_for_aimode",
            description: "Read a known conversation",
            inputSchema: { type: "object", properties: { request: { type: "object" } } },
          },
          {
            name: "start_alibaba_com_auth",
            description: "Generate an Alibaba.com reconnect URL",
            inputSchema: { type: "object", properties: { lang: { type: "string" } } },
          },
          {
            name: "not_on_the_allowlist",
            description: "Filtered out by default",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    }));
    return;
  }
  if (method === "tools/call") {
    if (body.request.params.name === "inquiry_data_batch_query") {
      res.end(JSON.stringify({
        success: true,
        data: {
          content: [{
            type: "text",
            text: JSON.stringify({
              jsonrpc: "2.0",
              id: body.request.id,
              result: {
                content: [{
                  type: "text",
                  text: JSON.stringify({ success: true, data: { resultCount: 1 } }),
                }],
                isError: false,
              },
            }),
          }],
          isError: false,
        },
      }));
      return;
    }
    if (body.request.params.name === "retrieve_im_history") {
      res.end(JSON.stringify({
        success: true,
        data: {
          content: [{
            type: "text",
            text: JSON.stringify({
              jsonrpc: "2.0",
              id: body.request.id,
              result: {
                content: [{
                  type: "text",
                  text: JSON.stringify({ success: false, error_code: "202", error_message: "params error" }),
                }],
                isError: false,
              },
            }),
          }],
          isError: false,
        },
      }));
      return;
    }
    res.end(JSON.stringify({
      success: true,
      data: {
        content: [{ type: "text", text: `called:${body.request.params.name}` }],
        isError: false,
      },
    }));
    return;
  }
  res.end(JSON.stringify({ success: true, data: {} }));
});
await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
const gatewayPort = gateway.address().port;
const localGateway = http.createServer((req, res) => {
  req.headers["x-test-local-gateway"] = "1";
  gateway.emit("request", req, res);
});
await new Promise(resolve => localGateway.listen(0, "127.0.0.1", resolve));
const localGatewayPort = localGateway.address().port;

const relayPort = await freePort();
const mcpPort = await freePort();
const disabledRelayPort = await freePort();
const disabledMcpPort = await freePort();
const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-mcp-catalog-"));
const catalogPath = path.join(catalogDir, "catalog.json");
fs.writeFileSync(catalogPath, JSON.stringify({
  tools: [
    {
      name: "1688_procurement_digital_human_tool",
      description: "Create a 1688 sourcing inquiry",
      inputSchema: { type: "object", properties: { offerName: { type: "string" } } },
    },
    {
      name: "inquiry_data_batch_query",
      description: "Read 1688 inquiry conversations",
      inputSchema: {
        type: "object",
        properties: {
          ds: { type: "string" },
          buyer_loginId: { type: "string" },
        },
      },
    },
    {
      name: "retrieve_im_history",
      description: "Read IM history",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "query_recent_conversation",
      description: "List recent conversations",
      inputSchema: { type: "object", properties: { request: { type: "object" } } },
    },
    {
      name: "query_recent_conversation_for_aimode",
      description: "List buyer-side recent conversations",
      inputSchema: { type: "object", properties: { request: { type: "object" } } },
    },
    {
      name: "send_msg",
      description: "Send a supplier message",
      inputSchema: { type: "object", properties: { content: { type: "string" } } },
    },
    {
      name: "query_conversation_msg_for_aimode",
      description: "Read a known conversation",
      inputSchema: { type: "object", properties: { request: { type: "object" } } },
    },
    {
      name: "start_alibaba_com_auth",
      description: "Generate an Alibaba.com reconnect URL",
      inputSchema: { type: "object", properties: { lang: { type: "string" } } },
    },
    {
      name: "not_on_the_allowlist",
      description: "Filtered out by default",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}), "utf8");
const relay = spawn(process.execPath, [relayScript], {
  env: {
    ...process.env,
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: String(relayPort),
    ACCIO_MCP_DEVELOPMENT_SERVER: "1",
    ACCIO_MCP_PORT: String(mcpPort),
    BRIDGE_URL: "http://127.0.0.1:1",
    ORIGINAL_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
    ACCIO_LOCAL_GATEWAY_BASE_URL: `http://127.0.0.1:${localGatewayPort}`,
    ACCIO_PROVIDER_SOURCES: "codexplus",
    ACCIO_BRIDGE_DIAGNOSTICS_PATH: "",
    ACCIO_MCP_CATALOG_PATH: catalogPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayLog = "";
relay.stdout.on("data", chunk => { relayLog += chunk.toString(); });
relay.stderr.on("data", chunk => { relayLog += chunk.toString(); });
let disabledRelay = null;

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}\n${relayLog}`);
}

async function rpc(method, params, id) {
  const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

try {
  await waitFor(`http://127.0.0.1:${relayPort}/health`);
  await waitFor(`http://127.0.0.1:${mcpPort}/health`);

  const before = await fetch(`http://127.0.0.1:${mcpPort}/health`).then(response => response.json());
  assert.equal(before.hasToken, false);

  const capture = await fetch(`http://127.0.0.1:${relayPort}/api/mcp/proxy`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      connectorid: "ali1688",
      "x-language": "en",
    },
    body: JSON.stringify({
      accessToken: "test-accio-token",
      connectId: "ali1688:test-account",
      request: { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
    }),
  });
  assert.equal(capture.status, 200);

  const after = await fetch(`http://127.0.0.1:${mcpPort}/health`).then(response => response.json());
  assert.equal(after.hasToken, true);
  assert.equal(after.hasGatewayAuthorization, false);
  assert.equal(after.hasConnectId, true);
  assert.ok(!JSON.stringify(after).includes("test-accio-token"), "health must never expose the token");

  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18" }, 1);
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, "accio-mcp");
  assert.equal(initialized.body.result.protocolVersion, "2025-06-18");

  const listed = await rpc("tools/list", {}, 2);
  assert.equal(listed.status, 200);
  const names = listed.body.result.tools.map(tool => tool.name);
  assert.deepEqual(names.sort(), [
    "1688_procurement_digital_human_tool",
    "inquiry_data_batch_query",
    "query_conversation_msg_for_aimode",
    "query_recent_conversation",
    "query_recent_conversation_for_aimode",
    "retrieve_im_history",
    "send_msg",
    "start_alibaba_com_auth",
  ]);

  const called = await rpc("tools/call", { name: "send_msg", arguments: { content: "hello" } }, 3);
  assert.equal(called.status, 200);
  assert.equal(called.body.result.content[0].text, "called:send_msg");
  assert.equal(called.body.result.isError, false);

  const replay = observed.at(-1);
  assert.equal(replay.body.accessToken, "test-accio-token");
  assert.equal(replay.body.connectId, "ali1688:test-account");
  assert.equal(replay.connectorId, "ali1688");
  assert.equal(replay.body.request.method, "tools/call");
  assert.equal(replay.body.request.params.name, "send_msg");
  assert.deepEqual(replay.body.request.params.arguments, { content: "hello" });

  const inquiryArgs = { ds: "20261117", buyer_loginId: "buyer-test" };
  const inquiry = await rpc("tools/call", { name: "inquiry_data_batch_query", arguments: inquiryArgs }, 4);
  assert.equal(inquiry.status, 200);
  assert.equal(inquiry.body.result.isError, false);
  assert.equal(inquiry.body.result.content.length, 1);
  assert.deepEqual(JSON.parse(inquiry.body.result.content[0].text), {
    success: true,
    data: { resultCount: 1 },
  });
  const inquiryReplay = observed.at(-1);
  assert.deepEqual(inquiryReplay.body.request.params.arguments, inquiryArgs);

  const history = await rpc("tools/call", { name: "retrieve_im_history", arguments: {} }, 5);
  assert.equal(history.status, 200);
  assert.equal(history.body.result.isError, true);
  assert.deepEqual(JSON.parse(history.body.result.content[0].text), {
    success: false,
    error_code: "202",
    error_message: "params error",
  });

  const authWithoutCapture = await rpc("tools/call", { name: "start_alibaba_com_auth", arguments: { lang: "en" } }, 6);
  assert.equal(authWithoutCapture.status, 200);
  assert.equal(authWithoutCapture.body.result.isError, true);
  assert.match(authWithoutCapture.body.result.content[0].text, /Connectors -> Alibaba\.com/);

  const nativeProxy = await fetch(`http://127.0.0.1:${relayPort}/connectors/alibaba/auth`, {
    method: "POST",
    headers: {
      authorization: "Basic test-gateway-authorization",
      accept: "application/json",
    },
  });
  assert.equal(nativeProxy.status, 200);
  const capturedNativeAuth = observed.at(-1);
  assert.equal(capturedNativeAuth.kind, "native-auth");
  assert.equal(capturedNativeAuth.authorization, "Basic test-gateway-authorization");
  assert.equal(capturedNativeAuth.localGateway, true);
  assert.equal(capturedNativeAuth.body, undefined);

  const authorized = await fetch(`http://127.0.0.1:${mcpPort}/health`).then(response => response.json());
  assert.equal(authorized.hasGatewayAuthorization, true);
  assert.ok(!JSON.stringify(authorized).includes("test-gateway-authorization"), "health must never expose gateway authorization");

  const proxyCallsBeforeAuth = observed.filter(event => event.kind === "proxy").length;
  const auth = await rpc("tools/call", { name: "start_alibaba_com_auth", arguments: { lang: "en" } }, 7);
  assert.equal(auth.status, 200);
  assert.equal(auth.body.result.isError, false);
  assert.deepEqual(JSON.parse(auth.body.result.content[0].text), {
    success: true,
    login_url: "https://login.alibaba.com/authorize?client=accio-test",
  });
  assert.equal(observed.filter(event => event.kind === "proxy").length, proxyCallsBeforeAuth);
  const nativeAuth = observed.at(-1);
  assert.equal(nativeAuth.kind, "native-auth");
  assert.equal(nativeAuth.authorization, "Basic test-gateway-authorization");
  assert.equal(nativeAuth.localGateway, true);
  assert.equal(nativeAuth.clientType, "");
  assert.equal(nativeAuth.language, "");
  assert.equal(nativeAuth.body, undefined);

  const conversationArgs = {
    request: {
      conversationId: "sender_receiver_icbu",
      limitTimeStamp: 1734567890000,
      count: 10,
    },
  };
  const conversation = await rpc("tools/call", {
    name: "query_conversation_msg_for_aimode",
    arguments: conversationArgs,
  }, 8);
  assert.equal(conversation.status, 200);
  assert.equal(conversation.body.result.content[0].text, "called:query_conversation_msg_for_aimode");
  const conversationReplay = observed.at(-1);
  assert.deepEqual(conversationReplay.body.request.params.arguments, conversationArgs);

  disabledRelay = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: String(disabledRelayPort),
      ACCIO_MCP_DEVELOPMENT_SERVER: "",
      ACCIO_MCP_PORT: String(disabledMcpPort),
      BRIDGE_URL: "http://127.0.0.1:1",
      ORIGINAL_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
      ACCIO_LOCAL_GATEWAY_BASE_URL: `http://127.0.0.1:${localGatewayPort}`,
      ACCIO_PROVIDER_SOURCES: "codexplus",
      ACCIO_BRIDGE_DIAGNOSTICS_PATH: "",
      ACCIO_MCP_CATALOG_PATH: catalogPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  disabledRelay.stdout.on("data", chunk => { relayLog += chunk.toString(); });
  disabledRelay.stderr.on("data", chunk => { relayLog += chunk.toString(); });
  await waitFor(`http://127.0.0.1:${disabledRelayPort}/health`);
  await assert.rejects(
    fetch(`http://127.0.0.1:${disabledMcpPort}/health`),
    "the reverse MCP listener must stay closed unless explicitly enabled",
  );

  console.log("mcp tests passed");
} finally {
  disabledRelay?.kill();
  relay.kill();
  await new Promise(resolve => localGateway.close(resolve));
  await new Promise(resolve => gateway.close(resolve));
  fs.rmSync(catalogDir, { recursive: true, force: true });
}
