import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("agentStatus attempted a network request during background discovery");
};

try {
  const { default: createBackend } = await import("../backend/main.mjs");
  const backend = createBackend({
    config: {},
    emit: () => {},
    log: () => {},
  });

  const status = await backend.agentStatus();
  assert.equal(fetchCalls, 0, "background Agent Access status must not contact Codex++");
  assert.equal(typeof status.running, "boolean");
  assert.equal(typeof status.managed, "boolean");
  assert.equal(
    status.externalRunning,
    status.running && !status.managed,
    "externalRunning must describe an unmanaged running Accio",
  );
  console.log("agent status background-discovery test passed");
} finally {
  globalThis.fetch = originalFetch;
}
