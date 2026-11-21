import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { normalizeHarnessMcpTransport } = require(path.join(here, "..", "sidecar", "harness-routing.js"));

function parse(result) {
  return JSON.parse(result.argsText);
}

const canonical = {
  action: "mcp",
  name: "query_recent_conversation_for_aimode",
  arguments: {
    request: { domain: "icbu", count: 20 },
  },
};
const canonicalText = JSON.stringify(canonical);
assert.deepEqual(normalizeHarnessMcpTransport(canonical, canonicalText), {
  argsText: canonicalText,
  mapped: "",
});
assert.equal(parse(normalizeHarnessMcpTransport(canonical, canonicalText)).arguments.request.count, 20);

const canonicalString = {
  action: "mcp",
  name: "query_recent_conversation_for_aimode",
  arguments: JSON.stringify({ request: { domain: "icbu", count: 20 } }),
};
const canonicalStringText = JSON.stringify(canonicalString);
assert.deepEqual(normalizeHarnessMcpTransport(canonicalString, canonicalStringText), {
  argsText: canonicalStringText,
  mapped: "",
});

const legacyObject = {
  action: "mcp",
  tool_name: "query_recent_conversation",
  arguments: {
    request: { domain: "icbu", count: 20 },
  },
};
const legacyObjectResult = normalizeHarnessMcpTransport(legacyObject, JSON.stringify(legacyObject));
assert.equal(legacyObjectResult.mapped, "query_recent_conversation_for_aimode");
assert.deepEqual(parse(legacyObjectResult), {
  action: "mcp",
  name: "query_recent_conversation_for_aimode",
  arguments: {
    request: { domain: "icbu" },
  },
});

const legacyString = {
  action: "mcp",
  tool_name: "query_recent_conversation",
  arguments: JSON.stringify({ request: { domain: "icbu", count: 20 } }),
};
const legacyStringResult = normalizeHarnessMcpTransport(legacyString, JSON.stringify(legacyString));
const legacyStringPayload = parse(legacyStringResult);
assert.equal(legacyStringResult.mapped, "query_recent_conversation_for_aimode");
assert.equal(legacyStringPayload.name, "query_recent_conversation_for_aimode");
assert.equal(typeof legacyStringPayload.arguments, "string");
assert.deepEqual(JSON.parse(legacyStringPayload.arguments), {
  request: { domain: "icbu" },
});

for (const malformed of [
  "{\"action\":\"mcp\",\"name\":\"query_recent_conversation\",",
  { action: "mcp", name: "query_recent_conversation", arguments: "{bad-json" },
  { action: "mcp", name: "query_recent_conversation", arguments: [] },
]) {
  const text = typeof malformed === "string" ? malformed : JSON.stringify(malformed);
  assert.deepEqual(normalizeHarnessMcpTransport(
    typeof malformed === "string" ? undefined : malformed,
    text,
  ), {
    argsText: text,
    mapped: "",
  });
}

const search = { action: "search", keyword: "latest messages" };
assert.deepEqual(normalizeHarnessMcpTransport(search, JSON.stringify(search)), {
  argsText: JSON.stringify(search),
  mapped: "",
});

console.log("harness routing unit tests passed");
