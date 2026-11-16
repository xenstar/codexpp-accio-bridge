"use strict";

const ASK_USER_MODES = new Set(["form", "chat", "fields", "palette"]);

function toolArgumentText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return "";
    }
  }
  return String(value);
}

function appendToolFragment(current, fragment) {
  const base = toolArgumentText(current);
  const next = toolArgumentText(fragment);
  if (!next) return base;
  if (!base) return next;
  if (next === base || base.endsWith(next)) return base;
  if (next.startsWith(base)) return next;
  return `${base}${next}`;
}

function completeJson(value) {
  const text = toolArgumentText(value).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (_) {
    return undefined;
  }
}

function balancedJsonSlice(text, start) {
  const first = text[start];
  const last = first === "{" ? "}" : first === "[" ? "]" : "";
  if (!last) return "";
  let depth = 0;
  let escaped = false;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === first) depth += 1;
    else if (char === last) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return "";
}

function parseToolArguments(value) {
  const text = toolArgumentText(value).trim();
  if (!text) return undefined;
  const direct = completeJson(text);
  if (direct !== undefined) return direct;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    const candidate = balancedJsonSlice(text, index);
    if (!candidate) continue;
    const parsed = completeJson(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function appendToolArguments(current, fragment) {
  if (fragment && typeof fragment === "object") return toolArgumentText(fragment);
  const base = toolArgumentText(current);
  const next = toolArgumentText(fragment);
  if (!next) return base;
  if (!base) return next;
  const baseComplete = completeJson(base);
  const nextComplete = completeJson(next);
  if (nextComplete !== undefined && baseComplete === undefined) return next;
  if (baseComplete !== undefined && nextComplete !== undefined) {
    if (next === base || next.startsWith(base) || base.endsWith(next)) return next.length >= base.length ? next : base;
    return next.length >= base.length ? next : base;
  }
  return appendToolFragment(base, next);
}

function preferCompleteArguments(current, complete) {
  const base = toolArgumentText(current);
  const next = toolArgumentText(complete);
  if (!next || next === "{}") return base || next;
  if (!base || base === "{}") return next;
  const baseComplete = completeJson(base);
  const nextComplete = completeJson(next);
  if (nextComplete !== undefined && baseComplete === undefined) return next;
  if (baseComplete !== undefined && nextComplete === undefined) return base;
  if (next.startsWith(base) || next.length >= base.length) return next;
  return base;
}

function shortQuestion(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function questionFromObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return shortQuestion(value.question || value.text || value.prompt || value.message || value.content);
}

function validFormQuestions(value) {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 4
    && value.every(item => item
      && typeof item.question === "string"
      && typeof item.header === "string"
      && Array.isArray(item.options)
      && item.options.length >= 2
      && item.options.length <= 8
      && item.options.every(option => option && typeof option.label === "string" && typeof option.description === "string"));
}

function validFields(value) {
  return Array.isArray(value)
    && value.length >= 1
    && value.every(item => item && typeof item.id === "string" && typeof item.label === "string");
}

function validPalettes(value) {
  return Array.isArray(value)
    && value.length >= 1
    && value.every(item => item
      && typeof item.id === "string"
      && typeof item.label === "string"
      && Array.isArray(item.colors)
      && item.colors.length >= 1);
}

function normalizeAskUserArguments(value, fallbackQuestion = "") {
  const rawText = toolArgumentText(value).trim();
  let parsed = parseToolArguments(rawText);
  if (parsed === undefined && rawText && !/^[\[{]/.test(rawText) && rawText !== "[object Object]") parsed = rawText;

  if (typeof parsed === "string") {
    const question = shortQuestion(parsed);
    return question ? JSON.stringify({ mode: "chat", question }) : null;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const mode = String(parsed.mode || "").trim().toLowerCase();
    if (mode === "sensitive") return null;
    if (ASK_USER_MODES.has(mode)) {
      if (mode === "form" && validFormQuestions(parsed.questions)) return JSON.stringify(parsed);
      if (mode === "chat" && shortQuestion(parsed.question)) return JSON.stringify(parsed);
      if (mode === "fields" && shortQuestion(parsed.question) && validFields(parsed.fields)) return JSON.stringify(parsed);
      if (mode === "palette" && shortQuestion(parsed.question) && validPalettes(parsed.palettes)) return JSON.stringify(parsed);
    }
    if (validFormQuestions(parsed.questions)) return JSON.stringify({ mode: "form", questions: parsed.questions });
    if (shortQuestion(parsed.question) && validFields(parsed.fields)) {
      return JSON.stringify({ mode: "fields", question: shortQuestion(parsed.question), fields: parsed.fields });
    }
    if (shortQuestion(parsed.question) && validPalettes(parsed.palettes)) {
      return JSON.stringify({ mode: "palette", question: shortQuestion(parsed.question), palettes: parsed.palettes });
    }
    const question = questionFromObject(parsed);
    if (question) return JSON.stringify({ mode: "chat", question });
  }

  const question = shortQuestion(fallbackQuestion);
  return question ? JSON.stringify({ mode: "chat", question }) : null;
}

function filePath(value) {
  return filePathAtDepth(value, 0);
}

function unwrapJsonValue(value, depth) {
  if (depth >= 6 || typeof value !== "string") return value;
  const text = value.trim();
  if (!text || !/^[\[{"]/.test(text)) return value;
  try {
    const parsed = JSON.parse(text);
    return parsed === value ? value : parsed;
  } catch (_) {
    return value;
  }
}

function filePathAtDepth(value, depth) {
  if (depth >= 6) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    const unwrapped = unwrapJsonValue(text, depth);
    return unwrapped === text ? text : filePathAtDepth(unwrapped, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const pathValue = filePathAtDepth(item, depth + 1);
      if (pathValue) return pathValue;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const pathValue = value.path ?? value.absolutePath ?? value.file_path ?? value.filePath ?? value.url;
  return filePathAtDepth(pathValue, depth + 1);
}

function normalizePresentFilesArguments(value) {
  const parsed = parseToolArguments(value);
  const source = parsed === undefined ? value : parsed;
  let candidates = [];

  if (Array.isArray(source)) candidates = source;
  else if (source && typeof source === "object") {
    const files = source.files ?? source.file_paths ?? source.filePaths ?? source.paths;
    if (Array.isArray(files)) candidates = files;
    else if (files != null) candidates = [files];
    else candidates = [source.path ?? source.absolutePath ?? source.file_path ?? source.filePath ?? source.url];
  } else if (source != null) candidates = [source];

  const files = candidates.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      const pathValue = filePath(item);
      return pathValue ? [{ path: pathValue }] : [];
    }
    const pathValue = filePath(item);
    if (!pathValue) return [];
    const file = { ...item, path: pathValue };
    if (file.label != null && typeof file.label !== "string") delete file.label;
    return [file];
  });

  return files.length ? JSON.stringify({ files }) : null;
}

module.exports = {
  appendToolArguments,
  appendToolName: appendToolFragment,
  normalizeAskUserArguments,
  normalizeToolArguments(name, value, fallbackQuestion = "") {
    const normalizedName = String(name || "").trim().toLowerCase();
    if (normalizedName === "ask_user") {
      return normalizeAskUserArguments(value, fallbackQuestion);
    }
    if (normalizedName === "present_files") return normalizePresentFilesArguments(value);
    const parsed = parseToolArguments(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify(parsed);
    return toolArgumentText(value).trim() || "{}";
  },
  parseToolArguments,
  preferCompleteArguments,
  toolArgumentText,
};
