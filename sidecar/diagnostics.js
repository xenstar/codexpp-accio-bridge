"use strict";

const fs = require("fs");
const path = require("path");

const LOG_PATH = String(process.env.ACCIO_BRIDGE_DIAGNOSTICS_PATH || "").trim();

function clean(value, maxLength = 240) {
  if (value == null) return "";
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function errorDetail(text) {
  const raw = clean(text, 1200);
  if (!raw) return "";
  try {
    const payload = JSON.parse(text);
    const error = payload?.error;
    const code = clean(error?.code || payload?.code, 120);
    const message = clean(error?.message || payload?.message || payload?.detail, 480);
    if (code || message) return [code, message].filter(Boolean).join(": ");
  } catch (_) {
    // Non-JSON errors are already bounded below.
  }
  return raw.slice(0, 480);
}

function diagnostic(event, fields = {}) {
  if (!LOG_PATH) return;
  const record = {
    at: new Date().toISOString(),
    event: clean(event, 80),
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    record[name] = typeof value === "number" || typeof value === "boolean"
      ? value
      : clean(value);
  }
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch (_) {
    // Diagnostics must never break the model path.
  }
}

module.exports = { diagnostic, errorDetail };
