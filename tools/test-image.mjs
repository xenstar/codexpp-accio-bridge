// Tests for the Codex++ image gateway route: model discovery, Accio ADK translation,
// request shape, and reply normalization. Codex++ state is faked in a temp directory so
// nothing reads or writes the real gateway.json.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const image = require("../sidecar/codexplus-image.js");

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

const gatewayPool = {
  providers: [
    {
      enabled: true,
      relay: {
        id: "chatgpt",
        name: "ChatGPT Plus someone@example.com",
        protocol: "responses",
        relayMode: "official",
        officialMixApiKey: false,
        upstreamBaseUrl: "",
        modelList: "gpt-6.1-sol\ngpt-6-luna",
      },
    },
    {
      enabled: true,
      relay: {
        id: "qwentokenplan",
        name: "QwenTokenPlan",
        protocol: "chatCompletions",
        relayMode: "pureApi",
        officialMixApiKey: false,
        upstreamBaseUrl: "https://example.invalid/compatible-mode/v1",
        modelList: "deepseek-v4-pro\nauto\nwan2.7-image\nwan2.7-image-pro\nwan3.0-video\nqwen-image-3.0-pro",
      },
    },
    {
      enabled: false,
      relay: {
        id: "off",
        name: "Disabled Pool",
        protocol: "chatCompletions",
        relayMode: "pureApi",
        upstreamBaseUrl: "https://example.invalid/v1",
        modelList: "flux-1-dev",
      },
    },
  ],
  bindings: {},
};

const hits = [];
function makeHelper(onRequest) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    hits.push({ url: req.url, method: req.method, headers: req.headers, body: body.toString("utf8") });
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-6-luna", owned_by: "codex-plus" }] }));
      return;
    }
    const answer = onRequest
      ? onRequest(req.url, body.toString("utf8"))
      : { status: 200, reply: { data: [{ b64_json: PNG_B64 }] } };
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.reply));
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

const payload = {
  model: "codexplus/gpt-6-luna",
  contents: [
    { role: "user", parts: [{ text: "Make a square logo." }] },
    { role: "model", parts: [{ text: "Working on it." }] },
    { role: "user", parts: [{ text: "Now a vertical banner." }] },
  ],
  generationConfig: { imageConfig: { aspectRatio: "9:16", imageSize: "1024x1536" } },
};

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-image-state-"));
  fs.writeFileSync(path.join(stateDir, "gateway.json"), JSON.stringify(gatewayPool));
  fs.writeFileSync(path.join(stateDir, "settings.json"), JSON.stringify({ activeRelayId: "codex-plus-gateway" }));
  process.env.CODEX_PLUS_STATE_DIR = stateDir;
  process.env.CODEXPLUS_DISCOVERY_TTL_MS = "0";

  assert.equal(image.isImageModel("wan2.7-image"), true);
  assert.equal(image.isImageModel("qwentokenplan/wan2.7-image-pro"), true);
  assert.equal(image.isImageModel("qwen-image-3.0-pro"), true);
  assert.equal(image.isImageModel("FLUX.1-dev"), true);
  assert.equal(image.isImageModel("wan3.0-video"), false, "video is not an image model");
  assert.equal(image.isImageModel("gpt-6-luna"), false);
  assert.equal(image.isImageModel("deepseek-v4-pro"), false);

  const options = image.imageModelOptions();
  assert.deepEqual(options.map(o => o.id), [
    "chatgpt/gpt-image-2",
    "qwentokenplan/wan2.7-image",
    "qwentokenplan/wan2.7-image-pro",
    "qwentokenplan/qwen-image-3.0-pro",
  ]);
  assert.equal(options[0].vendorPicks, true);
  assert.ok(!JSON.stringify(options).includes("someone@example.com"), "account email must not leak");

  const entries = image.imageCatalogEntries(options);
  assert.equal(entries[0].code, "codexplus-image/chatgpt/gpt-image-2");
  assert.equal(entries[2].code, "codexplus-image/qwentokenplan/wan2.7-image-pro");

  assert.equal(image.promptFromPayload(payload), "Now a vertical banner.");
  assert.equal(image.promptFromPayload({ contents: [] }), "Generate one image.");

  process.env.ACCIO_IMAGE_MODEL = "auto";
  assert.deepEqual(image.resolveImageModel(payload), { model: "", providerId: "", source: "auto" });
  assert.deepEqual(
    image.resolveImageModel({ model: "codexplus-image/qwentokenplan/wan2.7-image-pro" }),
    { model: "wan2.7-image-pro", providerId: "qwentokenplan", source: "accio" },
  );
  process.env.ACCIO_IMAGE_MODEL = "qwentokenplan/qwen-image-3.0-pro";
  assert.deepEqual(
    image.resolveImageModel(payload),
    { model: "qwen-image-3.0-pro", providerId: "qwentokenplan", source: "plugin" },
  );
  process.env.ACCIO_IMAGE_MODEL = "auto";

  // Accio posts the ADK request message flat, but the text bridge and relay both tolerate a
  // `{request: {...}}` envelope. An image turn sent that way used to lose the selected model, the
  // prompt and the requested size with no error at all, so the two shapes must build identically.
  const flatImageTurn = {
    model: "codexplus-image/qwentokenplan/wan2.7-image-pro",
    contents: [{ role: "user", parts: [{ text: "A paper boat on water." }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { imageSize: "768*1024" } },
  };
  const helperRoute = { mode: "helper", endpoint: "http://127.0.0.1:9", headers: {} };
  const builtFlat = image.buildRequest(flatImageTurn, helperRoute, {});
  const builtWrapped = image.buildRequest({ request: flatImageTurn }, helperRoute, {});
  assert.equal(builtFlat.model, "wan2.7-image-pro");
  assert.equal(builtFlat.source, "accio");
  assert.deepEqual(
    JSON.parse(builtWrapped.body.toString("utf8")),
    JSON.parse(builtFlat.body.toString("utf8")),
    "a wrapped image turn must keep the model, prompt and size",
  );

  assert.deepEqual(image.sizeFor("gpt-image-2", { aspectRatio: "9:16" }), { width: 1024, height: 1536 });
  assert.equal(image.sizeString("gpt-image-2", { width: 1024, height: 1536 }), "1024x1536");
  assert.equal(image.sizeString("wan2.7-image-pro", { width: 1024, height: 1536 }), "1024*1536");
  assert.equal(image.sizeFor("wan2.7-image-pro", { aspectRatio: "9:16" }), null, "no ratio table for Wan");
  assert.deepEqual(image.sizeFor("wan2.7-image-pro", { imageSize: "768*1024" }), { width: 768, height: 1024 });
  assert.equal(image.sizeFor("gpt-image-2", { aspectRatio: "7:3" }), null);

  const { server, port } = await makeHelper();
  process.env.CODEXPLUS_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ACCIO_IMAGE_ROUTE = "auto";
  const route = await image.planRoute({});
  assert.equal(route.mode, "helper", "no accio binding yet");
  assert.equal(route.endpoint, `http://127.0.0.1:${port}/v1`);

  const gen = await image.generate({ ...payload, model: "codexplus-image/qwentokenplan/wan2.7-image-pro" }, {});
  assert.equal(gen.ok, true, JSON.stringify(gen.failure));
  assert.equal(gen.items[0].data, PNG_B64);
  assert.equal(gen.items[0].mimeType, "image/png");
  const sent = hits.at(-1);
  assert.equal(sent.url, "/v1/images/generations");
  assert.equal(JSON.parse(sent.body).model, "wan2.7-image-pro");
  assert.equal(JSON.parse(sent.body).prompt, "Now a vertical banner.");
  assert.equal(JSON.parse(sent.body).size, "1024*1536");
  assert.match(sent.headers["user-agent"], /^Accio\//, "the provider must see an Accio agent identity");

  const edited = await image.generate({
    model: "codexplus/gpt-6-luna",
    contents: [{ role: "user", parts: [
      { text: "Recolour this banner." },
      { inlineData: { mimeType: "image/png", data: PNG_B64 } },
    ] }],
  }, {});
  assert.equal(edited.ok, true, JSON.stringify(edited.failure));
  assert.equal(hits.at(-1).url, "/v1/images/edits");
  assert.match(hits.at(-1).headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.ok(hits.at(-1).body.includes("Recolour this banner."), "prompt travels in the multipart body");

  const assetServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from("fake-png-bytes"));
  });
  await new Promise(resolve => assetServer.listen(0, "127.0.0.1", resolve));
  const items = await image.normalizeItems({
    data: [{ url: `http://127.0.0.1:${assetServer.address().port}/a.png` }, { url: "" }],
  }, 5000);
  assert.equal(items.length, 1);
  assert.equal(items[0].data, PNG_B64);
  await close(assetServer);

  gatewayPool.bindings = { accio: { enabled: true, token: "cpx-gw-accio-test" } };
  fs.writeFileSync(path.join(stateDir, "gateway.json"), JSON.stringify(gatewayPool));
  const upgraded = await image.planRoute({});
  assert.equal(upgraded.mode, "gateway");
  assert.equal(upgraded.endpoint, `http://127.0.0.1:${port}/gw/accio/v1`);
  const routed = await image.generate(payload, {});
  assert.equal(routed.ok, true, JSON.stringify(routed.failure));
  assert.equal(hits.at(-1).url, "/gw/accio/v1/images/generations");
  assert.equal(hits.at(-1).headers.authorization, "Bearer cpx-gw-accio-test");

  const { server: failServer, port: failPort } = await makeHelper(() => ({
    status: 400,
    reply: { error: { message: "Codex++ 网关的供应商池里没有能生图的模型" } },
  }));
  process.env.CODEXPLUS_BASE_URL = `http://127.0.0.1:${failPort}`;
  const failure = await image.generate(payload, {});
  assert.equal(failure.ok, false);
  assert.equal(failure.failure.code, "ACCIO_IMAGE_NO_POOL");
  assert.match(failure.failure.message, /No enabled Codex\+\+ provider/);
  await close(failServer);

  const okFrames = image.frames(routed, "codexplus/gpt-6-luna");
  assert.equal(okFrames[0].content.parts[0].inlineData.data, PNG_B64);
  assert.equal(okFrames[0].turnComplete, true);
  assert.equal(okFrames[0].finishReason, "STOP");
  assert.equal(okFrames[0].customMetadata.provider, "codexplus_image");

  await close(server);
  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log("image tests passed");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
