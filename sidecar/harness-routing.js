"use strict";

const LEGACY_CONVERSATION_TOOL = "query_recent_conversation";
const AIMODE_CONVERSATION_TOOL = "query_recent_conversation_for_aimode";

function normalizeHarnessMcpTransport(args, argsText) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { argsText, mapped: "" };
  }
  const target = String(args.name || args.tool_name || "").trim();
  if (!target) return { argsText, mapped: "" };

  const mappedTarget = target === LEGACY_CONVERSATION_TOOL
    ? AIMODE_CONVERSATION_TOOL
    : target;
  const argumentsWereString = typeof args.arguments === "string";
  if (
    args.arguments != null
    && !argumentsWereString
    && (typeof args.arguments !== "object" || Array.isArray(args.arguments))
  ) {
    return { argsText, mapped: "" };
  }

  let mappedArguments = args.arguments;
  let argumentsChanged = false;
  if (argumentsWereString) {
    try {
      mappedArguments = JSON.parse(mappedArguments);
    } catch (_) {
      return { argsText, mapped: "" };
    }
  }
  if (mappedArguments && typeof mappedArguments === "object" && !Array.isArray(mappedArguments)) {
    mappedArguments = { ...mappedArguments };
    if (
      target === LEGACY_CONVERSATION_TOOL
      && mappedTarget === AIMODE_CONVERSATION_TOOL
      && mappedArguments.request
      && typeof mappedArguments.request === "object"
      && Object.prototype.hasOwnProperty.call(mappedArguments.request, "count")
    ) {
      const { count: _count, ...request } = mappedArguments.request;
      mappedArguments = { ...mappedArguments, request };
      argumentsChanged = true;
    }
    if (argumentsWereString) mappedArguments = JSON.stringify(mappedArguments);
  }
  if (
    target === mappedTarget
    && args.name === target
    && !Object.prototype.hasOwnProperty.call(args, "tool_name")
    && !argumentsChanged
  ) {
    return { argsText, mapped: "" };
  }

  const normalized = {
    ...args,
    action: "mcp",
    name: mappedTarget,
    arguments: mappedArguments,
  };
  delete normalized.tool_name;
  return {
    argsText: JSON.stringify(normalized),
    mapped: mappedTarget === target ? "canonical-transport" : mappedTarget,
  };
}

module.exports = { normalizeHarnessMcpTransport };
