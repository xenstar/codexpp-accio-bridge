import createBackend from "../backend/main.mjs";

const log = (message, detail) => {
  const suffix = detail == null ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${new Date().toISOString()} ${message}${suffix}`);
};

const emit = (event, payload) => log(`event:${event}`, payload);
const backend = createBackend({
  config: process.env.ACCIO_PATH ? { accioPath: process.env.ACCIO_PATH } : {},
  emit,
  log,
});

let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log(`stopping:${signal}`);
  try {
    await backend.stop();
  } catch (error) {
    log("stop-failed", error?.stack || error?.message || String(error));
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

try {
  const result = await backend.restartAccio();
  log("launch-result", result);
  if (result?.ok === false) process.exitCode = 2;
} catch (error) {
  log("launch-failed", error?.stack || error?.message || String(error));
  process.exit(1);
}

setInterval(() => {}, 60 * 60 * 1000);
