"use strict";

const os = require("node:os");

const BRIDGE_VERSION = "0.1.40";
const USER_AGENT_MAX_LENGTH = 512;

function cleanUserAgent(value) {
  return String(value || "")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, USER_AGENT_MAX_LENGTH);
}

function accioUserAgent() {
  const appVersion = cleanUserAgent(process.env.ACCIO_APP_VERSION || "unknown").replace(/[()]/g, "") || "unknown";
  const platform = process.platform === "win32" ? "Windows" : os.type();
  const release = cleanUserAgent(os.release()).replace(/[()]/g, "") || "unknown";
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  return `Accio/${appVersion} (${platform} ${release}; ${arch}) AccioBridge/${BRIDGE_VERSION}`;
}

function shouldReplaceUserAgent(value) {
  return !value || /^(?:node|undici|electron)(?:\/|$)/i.test(value);
}

function requestUserAgent(req) {
  const raw = req?.headers?.["user-agent"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const sanitized = cleanUserAgent(value);
  return shouldReplaceUserAgent(sanitized) ? accioUserAgent() : sanitized;
}

module.exports = { accioUserAgent, requestUserAgent };
