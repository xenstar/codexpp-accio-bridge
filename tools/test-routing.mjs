import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeScript = path.join(here, "..", "sidecar", "bridge.js");
const relayScript = path.join(here, "..", "sidecar", "relay.js");
const require = createRequire(import.meta.url);
const { decodeContentEncoding } = require(path.join(here, "..", "sidecar", "encoding.js"));
const { requestUserAgent } = require(path.join(here, "..", "sidecar", "client-identity.js"));
const {
  appendToolArguments,
  appendToolName,
  normalizeToolArguments,
  parseToolArguments,
  preferCompleteArguments,
} = require(path.join(here, "..", "sidecar", "tool-stream.js"));
const models = ["gpt-5.6-luna", "opencode-go/deepseek-v4.1-flash", "qwentokenplan/wan3.0-video"];
const accioUserAgent = "Accio/1.2.3 (Windows 10.0.26300; x86_64) Accio Work";
const relayCatalogUserAgent = "Accio/1.2.3 Catalog (Windows 10.0.26300; x86_64)";
process.env.ACCIO_APP_VERSION = "9.9.9";
// Taken from the manifest so the User-Agent assertions cannot drift behind a release bump.
const packageVersion = JSON.parse(fs.readFileSync(path.join(here, "..", "codexpp.json"), "utf8")).version;
process.env.ACCIO_BRIDGE_VERSION = packageVersion;
const observedModels = [];
const observedEnhancements = [];
const observedToolRequests = [];
const observedDiscoveryUserAgents = [];
const observedModelUserAgents = [];
const observedEnhancementUserAgents = [];
const observedImageRequests = [];
const observedArtifactRequests = [];
const observedNativeVideoRequests = [];
let bridgeLogs = "";

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const codexPlus = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    observedDiscoveryUserAgents.push(req.headers["user-agent"] || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: models.map(id => ({ id, owned_by: "codex-plus", display_name: id })),
    }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/api/adk/llm/generateContent")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observedNativeVideoRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: {\"native\":true}\n\ndata: [DONE]\n\n");
    return;
  }
  if (req.method === "POST" && req.url === "/v1/responses") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.stream === false && request.instructions?.includes("Rewrite or improve the user's draft prompt")) {
      observedEnhancements.push(request);
      observedEnhancementUserAgents.push(req.headers["user-agent"] || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "Please rewrite this request more clearly." }],
        }],
      }));
      return;
    }
    observedModels.push(request.model);
    observedModelUserAgents.push(req.headers["user-agent"] || "");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const inputText = JSON.stringify(request.input || []);
    if (inputText.includes("ARTIFACT_STATE_")) observedArtifactRequests.push(request);
    if (inputText.includes("ARTIFACT_STATE_PRESENT_DONE")) {
      res.write(`data: ${JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "fc_item_artifact_cleanup",
          type: "function_call",
          call_id: "call_artifact_cleanup",
          name: "bash",
          arguments: "{\"command\":\"Remove-Item -Force final.png\"}",
        },
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
      res.end();
      return;
    }
    if (request.tools?.length) {
      observedToolRequests.push(request);
      if (inputText.includes("ASK_USER_")) {
        const scenario = /ASK_USER_([A-Z_]+)/.exec(inputText)?.[1] || "";
        const visibleText = scenario === "SUPPRESS" ? "" : scenario === "EMPTY"
          ? "Describe the image you want."
          : scenario === "OBJECT"
            ? "Choose a visual direction."
            : "";
        const argumentsValue = scenario === "OBJECT"
          ? { question: "Pick a visual style" }
          : scenario === "FORM"
            ? {
                mode: "form",
                questions: [{
                  header: "Size",
                  question: "Which size?",
                  options: [
                    { label: "Square", description: "1:1 aspect ratio" },
                    { label: "Wide", description: "16:9 aspect ratio" },
                  ],
                }],
              }
            : "";
        if (visibleText) {
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: visibleText })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({
          type: "response.output_item.added",
          item: {
            id: `fc_item_${scenario.toLowerCase()}`,
            type: "function_call",
            call_id: `call_${scenario.toLowerCase()}`,
            name: "ask_user",
            arguments: argumentsValue,
          },
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: `fc_item_${scenario.toLowerCase()}`,
          call_id: `call_${scenario.toLowerCase()}`,
          name: "ask_user",
          arguments: argumentsValue,
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
        res.end();
        return;
      }
      if (inputText.includes("PRESENT_FILES_PATH")) {
        const argumentsValue = "{\"path\":\"C:\\\\work\\\\image.png\"}";
        res.write(`data: ${JSON.stringify({
          type: "response.output_item.added",
          item: {
            id: "fc_item_present_files",
            type: "function_call",
            call_id: "call_present_files",
            name: "present_files",
            arguments: argumentsValue,
          },
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
        res.end();
        return;
      }
      const timeoutScenario = /TOOL_TIMEOUT_(MISSING|EXPLICIT|NO_SCHEMA)/.exec(inputText)?.[1];
      if (timeoutScenario) {
        const argumentsValue = timeoutScenario === "EXPLICIT"
          ? { command: "Get-Date", timeoutMs: 5000 }
          : { command: "Get-Date" };
        res.write(`data: ${JSON.stringify({
          type: "response.output_item.added",
          item: {
            id: "fc_item_timeout",
            type: "function_call",
            call_id: "call_timeout",
            name: "bash",
            arguments: argumentsValue,
          },
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({
        type: "response.output_item.added",
        item: {
          id: "fc_item_echo",
          type: "function_call",
          call_id: "call_tool_echo",
          name: "echo",
          arguments: "",
        },
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_item_echo",
        delta: "{\"value\":\"o",
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_item_echo",
        delta: "{\"value\":\"ok\"}",
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id: "fc_item_echo",
        call_id: "call_tool_echo",
        arguments: "{\"value\":\"ok\"}",
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "fc_item_echo",
          type: "function_call",
          call_id: "call_tool_echo",
          name: "echo",
          arguments: "",
        },
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise(resolve => codexPlus.listen(0, "127.0.0.1", resolve));
const codexPlusPort = codexPlus.address().port;
const imageBridge = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  observedImageRequests.push({
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    userAgent: req.headers["user-agent"] || "",
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({
    content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] },
    partial: false,
    turnComplete: true,
    finishReason: "STOP",
  })}\n\n`);
  res.end();
});
await new Promise(resolve => imageBridge.listen(0, "127.0.0.1", resolve));
const imageBridgePort = imageBridge.address().port;
const bridgePort = await freePort();
const relayPort = await freePort();
const bridge = spawn(process.execPath, [bridgeScript], {
  env: {
    ...process.env,
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: String(bridgePort),
    CODEXPLUS_BASE_URL: `http://127.0.0.1:${codexPlusPort}`,
    CODEXPLUS_DISCOVERY_ONLY_EXPLICIT: "1",
    ACCIO_PROVIDER_SOURCES: "codexplus",
    OPENAI_API_KEY: "",
    OMNIROUTE_API_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", chunk => { bridgeLogs += chunk.toString(); });
bridge.stderr.on("data", chunk => { bridgeLogs += chunk.toString(); });
const relay = spawn(process.execPath, [relayScript], {
  env: {
    ...process.env,
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: String(relayPort),
    BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
    ACCIO_IMAGE_BRIDGE_URL: `http://127.0.0.1:${imageBridgePort}`,
    ORIGINAL_GATEWAY_BASE_URL: `http://127.0.0.1:${codexPlusPort}`,
    ACCIO_PROVIDER_SOURCES: "codexplus",
    CODEXPLUS_BASE_URL: `http://127.0.0.1:${codexPlusPort}`,
    CODEXPLUS_DISCOVERY_ONLY_EXPLICIT: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayLogs = "";
relay.stdout.on("data", chunk => { relayLogs += chunk.toString(); });
relay.stderr.on("data", chunk => { relayLogs += chunk.toString(); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`bridge did not become healthy: ${bridgeLogs}`);
}

async function waitForRelayHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${relayPort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`relay did not become healthy: ${relayLogs}`);
}

async function sendCase(model, selectionName, expectedModel, options = {}) {
  const userAgent = options.userAgent ?? accioUserAgent;
  const port = options.port ?? bridgePort;
  const payload = {
    request: {
      model,
      selectModelName: selectionName,
      [options.messageField || "messages"]: [{ role: "user", content: "Reply with ok" }],
    },
  };
  const serialized = Buffer.from(JSON.stringify(payload));
  const requestBody = options.gzip ? zlib.gzipSync(serialized) : serialized;
  const response = await fetch(`http://127.0.0.1:${port}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": userAgent,
      ...(options.gzip ? { "content-encoding": "gzip" } : {}),
    },
    body: requestBody,
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(observedModels.at(-1), expectedModel);
  assert.equal(observedModelUserAgents.at(-1), userAgent);
}

async function sendRelayCatalog() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/llm/config/v2`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": relayCatalogUserAgent },
    body: JSON.stringify({ data: [] }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  const payload = JSON.parse(responseText);
  assert.equal(payload.data[0].provider, "codexplus");
  return payload;
}

async function sendToolCase() {
  const response = await fetch(`http://127.0.0.1:${bridgePort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: "1Nova-toolhelper",
        selectModelName: "",
        contents: [
          { role: "user", parts: [{ text: "Use the echo tool." }] },
          {
            role: "model",
            parts: [{
              functionCall: {
                id: "call_previous",
                name: "echo",
                argsJson: "{\"value\":\"first\"}",
              },
            }],
          },
          {
            role: "function",
            parts: [{
              functionResponse: {
                id: "call_previous",
                name: "echo",
                responseJson: "{\"value\":\"first\"}",
              },
            }],
          },
        ],
        tools: [{
          functionDeclarations: [{
            name: "echo",
            description: "Echo a value.",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          }],
        }],
        toolChoice: { functionCall: { name: "echo" } },
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const request = observedToolRequests.at(-1);
  assert.equal(request.model, "auto");
  assert.deepEqual(request.tools.map(tool => tool.name), ["echo"]);
  assert.deepEqual(request.tool_choice, { type: "function", name: "echo" });
  assert.ok(request.input.some(item => item.type === "function_call" && item.call_id === "call_previous"));
  assert.ok(request.input.some(item => item.type === "function_call_output" && item.call_id === "call_previous"));
  assert.equal(observedModelUserAgents.at(-1), accioUserAgent);
  const frames = responseText.split(/\r?\n\r?\n/)
    .map(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"))
    .filter(data => data && data !== "[DONE]")
    .map(data => JSON.parse(data));
  const functionCalls = frames.flatMap(frame => frame.content?.parts || []).map(part => part.functionCall).filter(Boolean);
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].name, "echo");
  assert.equal(functionCalls[0].id, "call_tool_echo");
  assert.equal(functionCalls[0].argsJson, "{\"value\":\"ok\"}");
}

async function sendAskUserCase(scenario) {
  const contents = scenario === "PRIOR"
    ? [
        { role: "model", parts: [{ text: "What image should I create?" }] },
        { role: "user", parts: [{ text: "ASK_USER_PRIOR" }] },
      ]
    : [{ role: "user", parts: [{ text: `ASK_USER_${scenario}` }] }];
  const response = await fetch(`http://127.0.0.1:${bridgePort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: "codexplus/gpt-5.6-luna",
        contents,
        tools: [{
          functionDeclarations: [{
            name: "ask_user",
            description: "Ask the user a question.",
            parameters: {
              type: "object",
              required: ["mode"],
              properties: { mode: { type: "string" }, question: { type: "string" } },
            },
          }],
        }],
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const frames = responseText.split(/\r?\n\r?\n/)
    .map(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"))
    .filter(data => data && data !== "[DONE]")
    .map(data => JSON.parse(data));
  return frames.flatMap(frame => frame.content?.parts || []).map(part => part.functionCall).filter(Boolean);
}

async function sendPresentFilesCase() {
  const response = await fetch(`http://127.0.0.1:${bridgePort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: "codexplus/gpt-5.6-luna",
        contents: [{ role: "user", parts: [{ text: "PRESENT_FILES_PATH" }] }],
        tools: [{
          functionDeclarations: [{
            name: "present_files",
            description: "Present generated files.",
            parameters: {
              type: "object",
              required: ["files"],
              properties: {
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["path"],
                    properties: {
                      path: { type: "string" },
                      label: { type: "string" },
                    },
                  },
                },
              },
            },
          }],
        }],
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const frames = responseText.split(/\r?\n\r?\n/)
    .map(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"))
    .filter(data => data && data !== "[DONE]")
    .map(data => JSON.parse(data));
  return frames.flatMap(frame => frame.content?.parts || []).map(part => part.functionCall).filter(Boolean);
}

async function sendBashTimeoutCase(scenario) {
  const properties = { command: { type: "string" } };
  if (scenario === "MISSING") properties.timeoutSeconds = { type: "number", description: "Maximum execution time in seconds." };
  if (scenario === "EXPLICIT") properties.timeoutMs = { type: "number", description: "Maximum execution time in milliseconds." };
  const response = await fetch(`http://127.0.0.1:${bridgePort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: "codexplus/gpt-5.6-luna",
        contents: [{ role: "user", parts: [{ text: `TOOL_TIMEOUT_${scenario}` }] }],
        tools: [{
          functionDeclarations: [{
            name: "bash",
            description: "Run a shell command.",
            parameters: { type: "object", required: ["command"], properties },
          }],
        }],
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const frames = responseText.split(/\r?\n\r?\n/)
    .map(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"))
    .filter(data => data && data !== "[DONE]")
    .map(data => JSON.parse(data));
  return frames.flatMap(frame => frame.content?.parts || []).map(part => part.functionCall).filter(Boolean);
}

async function sendArtifactGuardCase() {
  const response = await fetch(`http://127.0.0.1:${bridgePort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: "codexplus/gpt-5.6-luna",
        contents: [{ role: "user", parts: [{ text: "ARTIFACT_GUARD" }] }],
        tools: [{
          functionDeclarations: [
            { name: "image_generate", description: "Generate an image.", parameters: { type: "object", properties: {} } },
            { name: "present_files", description: "Present generated files.", parameters: { type: "object", properties: {} } },
          ],
        }],
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  return observedToolRequests.at(-1);
}

async function sendArtifactStateCase(scenario) {
  const contents = [
    { role: "user", parts: [{ text: `ARTIFACT_STATE_${scenario}` }] },
    {
      role: "model",
      parts: [{
        functionCall: {
          id: "call_image_done",
          name: "image_generate",
          argsJson: "{\"prompt\":\"A red circle\"}",
        },
      }],
    },
    {
      role: "function",
      parts: [{
        functionResponse: {
          id: "call_image_done",
          name: "image_generate",
          responseJson: {
            success: true,
            data: "Generated image: C:\\work\\image.png",
          },
        },
      }],
    },
  ];
  if (scenario !== "IMAGE_DONE") {
    contents.push(
      {
        role: "model",
        parts: [{
          functionCall: {
            id: "call_present_done",
            name: "present_files",
            argsJson: "{\"files\":[{\"path\":\"C:\\\\work\\\\image.png\"}]}",
          },
        }],
      },
      {
        role: "function",
        parts: [{
          functionResponse: {
            id: "call_present_done",
            name: "present_files",
            responseJson: scenario === "PRESENT_FAILED"
              ? {
                  success: false,
                  data: "No valid files with non-empty paths were provided.",
                  error: "No valid files with non-empty paths were provided.",
                }
              : {
                  success: true,
                  data: "Presented 1 file(s): C:\\work\\image.png",
                  error: "",
                },
          },
        }],
      },
    );
  }
  const response = await fetch(`http://127.0.0.1:${bridgePort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: "codexplus/gpt-5.6-luna",
        contents,
        tools: [{
          functionDeclarations: [
            { name: "image_generate", description: "Generate an image.", parameters: { type: "object", properties: {} } },
            { name: "present_files", description: "Present generated files.", parameters: { type: "object", properties: {} } },
            { name: "bash", description: "Run a shell command.", parameters: { type: "object", properties: {} } },
            { name: "process", description: "Run a process.", parameters: { type: "object", properties: {} } },
            { name: "echo", description: "Echo a value.", parameters: { type: "object", properties: {} } },
          ],
        }],
        toolChoice: scenario === "PRESENT_DONE" ? { functionCall: { name: "bash" } } : undefined,
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const frames = responseText.split(/\r?\n\r?\n/)
    .map(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"))
    .filter(data => data && data !== "[DONE]")
    .map(data => JSON.parse(data));
  return {
    request: observedArtifactRequests.at(-1),
    calls: frames.flatMap(frame => frame.content?.parts || []).map(part => part.functionCall).filter(Boolean),
  };
}

async function sendEnhancementCase(model = "") {
  const request = {
    text: "make this product description clearer",
    requestId: "11111111-1111-4111-8111-111111111111",
    ctx: { conversationId: "test-conversation" },
  };
  if (model) request.model = model;
  const response = await fetch(`http://127.0.0.1:${bridgePort}/agent/prompt/enhance`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify(request),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const payload = JSON.parse(responseText);
  assert.equal(payload.success, true);
  assert.equal(typeof payload.data.text, "string");
  assert.ok(payload.data.text.length > 0);
  assert.equal(observedEnhancementUserAgents.at(-1), accioUserAgent);
  return observedEnhancements.at(-1);
}

async function sendImageRoutingCase() {
  const before = observedModels.length;
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: "gpt-image-2",
        contents: [{ role: "user", parts: [{ text: "Generate a red circle." }] }],
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.match(responseText, /"inlineData"/);
  assert.equal(observedImageRequests.length, 1);
  assert.equal(observedImageRequests[0].body.request.model, "gpt-image-2");
  assert.equal(observedImageRequests[0].userAgent, accioUserAgent);
  assert.equal(observedModels.length, before);
}

async function sendCodexPlusVideoCase() {
  const modelBefore = observedModels.length;
  const nativeBefore = observedNativeVideoRequests.length;
  const model = "codexplus/qwentokenplan/wan3.0-video";
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model,
        contents: [{ role: "user", parts: [{ text: "Generate a short video." }] }],
        generationConfig: { responseModalities: ["VIDEO"] },
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.match(responseText, /"errorCode":"ACCIO_VIDEO_UNSUPPORTED"/);
  assert.equal(observedModels.length, modelBefore, "Codex++ video must not be sent to the chat bridge");
  assert.equal(observedNativeVideoRequests.length, nativeBefore, "Codex++ video must not use Accio's gateway");
}

async function sendNativeVideoCase() {
  const nativeBefore = observedNativeVideoRequests.length;
  const modelBefore = observedModels.length;
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: "qwentokenplan/wan3.0-video",
        contents: [{ role: "user", parts: [{ text: "Generate a short native video." }] }],
        generationConfig: { responseModalities: ["VIDEO"] },
      },
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.match(responseText, /"errorCode":"ACCIO_VIDEO_UNSUPPORTED"/);
  assert.equal(observedNativeVideoRequests.length, nativeBefore, "Accio Bridge must not spend on Accio's paid video gateway");
  assert.equal(observedModels.length, modelBefore, "video must not be sent to the chat bridge");
}

// An `codexplus-image/...` code is a picker entry for the image engine, not a chat model, and Accio
// has no client-side notion of one (it reads no image capability flag). So the same code must route
// to the generator only when the turn explicitly asks for IMAGE output, and to a Codex++ chat model
// otherwise. This is the rule that stops "I selected GPT Image, then said hello" from spending a
// billable image generation.
async function sendImageCodeVersusTextCase() {
  const groupCode = "codexplus-image/chatgpt/gpt-image-2";
  const imageBefore = observedImageRequests.length;
  const modelBefore = observedModels.length;

  const explicit = await fetch(`http://127.0.0.1:${relayPort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: groupCode,
        contents: [{ role: "user", parts: [{ text: "Draw a red circle." }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } },
      },
    }),
  });
  const explicitText = await explicit.text();
  assert.equal(explicit.status, 200, explicitText);
  assert.match(explicitText, /"inlineData"/);
  assert.equal(observedImageRequests.length, imageBefore + 1);
  assert.equal(observedImageRequests.at(-1).body.request.model, groupCode);
  assert.equal(observedModels.length, modelBefore, "an explicit image turn must not reach the text bridge");

  // Accio's Gemini-style adapter sends generationConfig as a JSON string; the signal still counts.
  const stringConfig = await fetch(`http://127.0.0.1:${relayPort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: groupCode,
        contents: [{ role: "user", parts: [{ text: "Draw a blue square." }] }],
        generationConfig: JSON.stringify({ responseModalities: ["TEXT", "IMAGE"] }),
      },
    }),
  });
  assert.match(await stringConfig.text(), /"inlineData"/);
  assert.equal(observedImageRequests.length, imageBefore + 2);

  const chat = await fetch(`http://127.0.0.1:${relayPort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": accioUserAgent },
    body: JSON.stringify({
      request: {
        model: groupCode,
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    }),
  });
  const chatText = await chat.text();
  assert.equal(chat.status, 200, chatText);
  assert.doesNotMatch(chatText, /"inlineData"/, "a plain chat turn must not return an image");
  assert.equal(observedImageRequests.length, imageBefore + 2, "a plain chat turn must not generate an image");
  assert.equal(observedModels.length, modelBefore + 1);
  assert.equal(observedModels.at(-1), "auto", "an image code on the text path must fall back to Codex++ auto");
}

async function sendWithoutUserAgent() {
  const payload = JSON.stringify({
    request: {
      model: "codexplus/gpt-5.6-luna",
      messages: [{ role: "user", content: "Reply with ok" }],
    },
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: relayPort,
      path: "/api/adk/llm/generateContent",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

try {
  assert.equal(appendToolName("", "web_fetch"), "web_fetch");
  assert.equal(appendToolName("web_fetch", "web_fetch"), "web_fetch");
  assert.equal(appendToolName("web_", "fetch"), "web_fetch");
  assert.equal(appendToolName("web_fetch", "_fetch"), "web_fetch");
  assert.equal(appendToolName("web_", "web_fetch"), "web_fetch");
  assert.equal(appendToolArguments("{\"value\":\"o", "{\"value\":\"ok\"}"), "{\"value\":\"ok\"}");
  assert.equal(appendToolArguments("{\"value\":", "\"ok\"}"), "{\"value\":\"ok\"}");
  assert.equal(appendToolArguments("{\"value\":", "{\"value\":\"recovered\"}"), "{\"value\":\"recovered\"}");
  assert.equal(preferCompleteArguments("{\"value\":\"ok\"}", ""), "{\"value\":\"ok\"}");
  assert.equal(preferCompleteArguments("{\"value\":\"ok\"}", "{}"), "{\"value\":\"ok\"}");
  assert.equal(preferCompleteArguments("{\"value\":\"ok\"}", "{\"value\""), "{\"value\":\"ok\"}");
  assert.equal(
    normalizeToolArguments("ask_user", "", "Describe the image you want."),
    "{\"mode\":\"chat\",\"question\":\"Describe the image you want.\"}",
  );
  assert.equal(
    normalizeToolArguments("ask_user", { question: "Pick a visual style" }, ""),
    "{\"mode\":\"chat\",\"question\":\"Pick a visual style\"}",
  );
  assert.equal(normalizeToolArguments("ask_user", "", ""), null);
  assert.equal(normalizeToolArguments("ask_user", { mode: "sensitive" }, "What image?"), null);
  assert.deepEqual(
    parseToolArguments("{\"mode\":\"chat\",\"question\":\"A\"}{\"mode\":\"chat\",\"question\":\"B\"}"),
    { mode: "chat", question: "A" },
  );
  assert.equal(
    normalizeToolArguments("image_generate", { prompt: "A red circle" }, ""),
    "{\"prompt\":\"A red circle\"}",
  );
  assert.equal(
    normalizeToolArguments("present_files", "{\"path\":\"C:\\\\work\\\\image.png\"}", ""),
    "{\"files\":[{\"path\":\"C:\\\\work\\\\image.png\"}]}",
  );
  assert.equal(
    normalizeToolArguments("present_files", "{\"files\":[\"C:\\\\work\\\\image.png\"]}", ""),
    "{\"files\":[{\"path\":\"C:\\\\work\\\\image.png\"}]}",
  );
  assert.equal(
    normalizeToolArguments("present_files", {
      files: [{ path: "C:\\work\\image.png", label: "Final image" }],
    }, ""),
    "{\"files\":[{\"path\":\"C:\\\\work\\\\image.png\",\"label\":\"Final image\"}]}",
  );
  assert.equal(
    normalizeToolArguments("present_files", { paths: ["C:\\work\\a.png", "C:\\work\\b.png"] }, ""),
    "{\"files\":[{\"path\":\"C:\\\\work\\\\a.png\"},{\"path\":\"C:\\\\work\\\\b.png\"}]}",
  );
  assert.equal(
    normalizeToolArguments("present_files", {
      files: [{ path: JSON.stringify([{ file_path: "C:\\work\\nested.png" }]) }],
    }, ""),
    "{\"files\":[{\"path\":\"C:\\\\work\\\\nested.png\"}]}",
    "a JSON-array path returned by the model must resolve to its plain path",
  );
  assert.equal(
    normalizeToolArguments("present_files", {
      files: [JSON.stringify([{ path: JSON.stringify({ filePath: "C:\\work\\double.png" }) }])],
    }, ""),
    "{\"files\":[{\"path\":\"C:\\\\work\\\\double.png\"}]}",
    "nested JSON must be unwrapped recursively",
  );
  assert.equal(normalizeToolArguments("present_files", { files: [] }, ""), null);
  const encodingProbe = Buffer.from('{"ok":true}');
  for (const [encoding, compress] of [["gzip", zlib.gzipSync], ["deflate", zlib.deflateSync], ["br", zlib.brotliCompressSync]]) {
    assert.deepEqual(decodeContentEncoding(compress(encodingProbe), encoding), encodingProbe);
  }
  assert.equal(requestUserAgent({ headers: { "user-agent": "  Accio/1.0\tAgent  " } }), "Accio/1.0 Agent");
  assert.equal(requestUserAgent({ headers: { "user-agent": "A".repeat(600) } }).length, 512);
  const generatedUserAgent = requestUserAgent({ headers: { "user-agent": "node" } });
  assert.match(generatedUserAgent, /^Accio\/9\.9\.9 \(/);
  assert.ok(generatedUserAgent.endsWith(`AccioBridge/${packageVersion}`), generatedUserAgent);
  assert.equal(requestUserAgent({ headers: {} }), generatedUserAgent);
  await waitForHealth();
  await waitForRelayHealth();
  await sendRelayCatalog();
  assert.equal(observedDiscoveryUserAgents[0], relayCatalogUserAgent);
  models.push("gpt-5.6-fresh-model");
  const refreshedCatalog = await sendRelayCatalog();
  assert.ok(
    refreshedCatalog.data[0].modelList.some(model => model.modelCode === "codexplus/gpt-5.6-fresh-model"),
    "new Codex++ models must appear on the next catalog request",
  );
  assert.ok(
    !refreshedCatalog.data[0].modelList.some(model => model.modelCode === "codexplus/qwentokenplan/wan3.0-video"),
    "video-only models must stay out of the Codex++ chat catalog",
  );
  await sendCase("codexplus/gpt-5.6-luna", "", "gpt-5.6-luna", { port: relayPort });
  await sendCase("1Drift-F8hS9mK7pL2n", "opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash");
  await sendCase("1Helix-siFj8Dhud0Uh", "codexplus/gpt-5.6-luna", "gpt-5.6-luna");
  await sendCase("codexplus/gpt-5.6-luna", "opencode-go/deepseek-v4.1-flash", "gpt-5.6-luna");
  await sendCase("1Helix-siFj8Dhud0Uh", "gpt-5.6-luna", "gpt-5.6-luna", { gzip: true, messageField: "contents" });
  await sendToolCase();
  assert.ok(!String(observedToolRequests.at(-1).instructions || "").includes("Accio artifact delivery"));
  const emptyAskUser = await sendAskUserCase("EMPTY");
  assert.equal(emptyAskUser.length, 1);
  assert.deepEqual(JSON.parse(emptyAskUser[0].argsJson), {
    mode: "chat",
    question: "Describe the image you want.",
  });
  const objectAskUser = await sendAskUserCase("OBJECT");
  assert.equal(objectAskUser.length, 1);
  assert.deepEqual(JSON.parse(objectAskUser[0].argsJson), {
    mode: "chat",
    question: "Pick a visual style",
  });
  const formAskUser = await sendAskUserCase("FORM");
  assert.equal(formAskUser.length, 1);
  assert.equal(JSON.parse(formAskUser[0].argsJson).mode, "form");
  const suppressedAskUser = await sendAskUserCase("SUPPRESS");
  assert.equal(suppressedAskUser.length, 0);
  const priorAskUser = await sendAskUserCase("PRIOR");
  assert.equal(priorAskUser.length, 1);
  assert.deepEqual(JSON.parse(priorAskUser[0].argsJson), {
    mode: "chat",
    question: "What image should I create?",
  });
  const presentFiles = await sendPresentFilesCase();
  assert.equal(presentFiles.length, 1);
  assert.deepEqual(JSON.parse(presentFiles[0].argsJson), {
    files: [{ path: "C:\\work\\image.png" }],
  });
  const missingTimeout = await sendBashTimeoutCase("MISSING");
  assert.equal(missingTimeout.length, 1);
  assert.deepEqual(JSON.parse(missingTimeout[0].argsJson), {
    command: "Get-Date",
    timeoutSeconds: 60,
  });
  const explicitTimeout = await sendBashTimeoutCase("EXPLICIT");
  assert.equal(explicitTimeout.length, 1);
  assert.deepEqual(JSON.parse(explicitTimeout[0].argsJson), {
    command: "Get-Date",
    timeoutMs: 5000,
  });
  const noSchemaTimeout = await sendBashTimeoutCase("NO_SCHEMA");
  assert.equal(noSchemaTimeout.length, 1);
  assert.deepEqual(JSON.parse(noSchemaTimeout[0].argsJson), {
    command: "Get-Date",
  });
  const artifactGuardRequest = await sendArtifactGuardCase();
  assert.match(artifactGuardRequest.instructions, /Accio artifact delivery:/);
  assert.match(artifactGuardRequest.instructions, /Never place JSON text inside the path field/);
  assert.match(artifactGuardRequest.instructions, /Do not copy, move, rename, delete, recycle/);
  const imageDone = await sendArtifactStateCase("IMAGE_DONE");
  assert.deepEqual(imageDone.request.tools.map(tool => tool.name), ["image_generate", "present_files", "echo"]);
  assert.ok(!imageDone.request.tools.some(tool => ["bash", "process"].includes(tool.name)));
  const presentFailed = await sendArtifactStateCase("PRESENT_FAILED");
  assert.ok(presentFailed.request.tools.some(tool => tool.name === "present_files"));
  assert.ok(!presentFailed.request.tools.some(tool => ["bash", "process"].includes(tool.name)));
  const presentDone = await sendArtifactStateCase("PRESENT_DONE");
  assert.deepEqual(presentDone.request.tools || [], []);
  assert.equal(presentDone.request.tool_choice, "none");
  assert.equal(presentDone.calls.length, 0, "a shell cleanup call after present_files must be suppressed");
  await sendImageRoutingCase();
  await sendImageCodeVersusTextCase();
  await sendCodexPlusVideoCase();
  await sendNativeVideoCase();
  const defaultEnhancement = await sendEnhancementCase();
  assert.equal(defaultEnhancement.model, "auto");
  const selectedEnhancement = await sendEnhancementCase("codexplus/gpt-5.6-luna");
  assert.equal(selectedEnhancement.model, "gpt-5.6-luna");
  const imageCodeEnhancement = await sendEnhancementCase("codexplus-image/qwentokenplan/wan2.7-image-pro");
  assert.equal(imageCodeEnhancement.model, "auto", "enhancement must not post an image id to the chat endpoint");
  assert.ok(observedDiscoveryUserAgents.includes(accioUserAgent));
  const observedBeforeProbe = observedModels.length;
  const probeResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/adk/llm/generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "1Helix-siFj8Dhud0Uh",
      select_model_name: "gpt-5.6-luna",
      request_id: "metadata-only-probe",
    }),
  });
  assert.equal(probeResponse.status, 200);
  await probeResponse.text();
  assert.equal(observedModels.length, observedBeforeProbe);
  const fallbackResponse = await sendWithoutUserAgent();
  assert.equal(fallbackResponse.status, 200, fallbackResponse.text);
  assert.match(observedModelUserAgents.at(-1), /^Accio\/9\.9\.9 \(/);
  assert.ok(observedModelUserAgents.at(-1).endsWith(`AccioBridge/${packageVersion}`), observedModelUserAgents.at(-1));
  console.log("routing tests passed");
} finally {
  bridge.kill();
  relay.kill();
  await new Promise(resolve => imageBridge.close(resolve));
  await new Promise(resolve => codexPlus.close(resolve));
}
