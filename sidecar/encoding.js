"use strict";

const zlib = require("zlib");

function encodingTokens(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim().toLowerCase())
    .filter(item => item && item !== "identity");
}

function decompressOnce(buffer, encoding) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(buffer);
    case "deflate":
      try {
        return zlib.inflateSync(buffer);
      } catch (_) {
        return zlib.inflateRawSync(buffer);
      }
    case "br":
      return zlib.brotliDecompressSync(buffer);
    default: {
      const error = new Error(`Unsupported content encoding: ${encoding}`);
      error.code = "UNSUPPORTED_CONTENT_ENCODING";
      throw error;
    }
  }
}

function decodeContentEncoding(buffer, headerValue, maxBytes = 20 * 1024 * 1024) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  let output = input;
  const encodings = encodingTokens(headerValue);
  for (let index = encodings.length - 1; index >= 0; index -= 1) {
    output = decompressOnce(output, encodings[index]);
    if (output.length > maxBytes) {
      const error = new Error("decoded request body too large");
      error.code = "BODY_TOO_LARGE";
      error.bytes = input.length;
      error.decodedBytes = output.length;
      throw error;
    }
  }

  if (output.length > maxBytes) {
    const error = new Error("request body too large");
    error.code = "BODY_TOO_LARGE";
    error.bytes = input.length;
    error.decodedBytes = output.length;
    throw error;
  }
  return output;
}

module.exports = { decodeContentEncoding };
