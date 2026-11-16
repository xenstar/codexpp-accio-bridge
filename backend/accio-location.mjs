import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ACCIO_EXE = "Accio.exe";
const APP_PATH_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Accio.exe",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Accio.exe",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Accio.exe",
];

function runFile(command, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function expandEnvironment(value, env) {
  return String(value || "").replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? String(env[key] || "") : match;
  });
}

export function normalizeAccioExecutable(value, env = process.env) {
  let text = expandEnvironment(value, env).trim();
  if (!text) return "";
  if (text.startsWith('"')) {
    const quoted = text.match(/^"([^"]+Accio\.exe)"?/i);
    if (quoted) text = quoted[1];
  } else {
    const embedded = text.match(/^(.*?Accio\.exe)(?:,|\s|$)/i);
    if (embedded) text = embedded[1];
  }
  return path.normalize(text);
}

export function candidateAccioPaths(env = process.env, home = os.homedir()) {
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const paths = [
    path.join(localAppData, "Programs", "Accio", ACCIO_EXE),
    path.join(localAppData, "Accio", ACCIO_EXE),
    path.join(programFiles, "Accio", ACCIO_EXE),
    path.join(programFilesX86, "Accio", ACCIO_EXE),
  ];
  return [...new Set(paths.map((item) => path.normalize(item)))];
}

function registryExecutable(output) {
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/\bREG_(?:EXPAND_)?SZ\s+(.+)$/i);
    if (match) return normalizeAccioExecutable(match[1]);
  }
  return "";
}

export async function discoverAccioVersion(executable, options = {}) {
  if (!executable || !fs.existsSync(executable) || process.platform !== "win32") return "";
  const { run = runFile } = options;
  const escaped = String(executable).replace(/'/g, "''");
  try {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
      ],
      5000,
    );
    return String(stdout || "").match(/\d+(?:\.\d+){1,3}/)?.[0] || "";
  } catch {
    return "";
  }
}

async function discoverWindowsRegistryPath(run) {
  for (const key of APP_PATH_KEYS) {
    try {
      const { stdout } = await run("reg.exe", ["query", key, "/ve"]);
      const executable = registryExecutable(stdout);
      if (executable && fs.existsSync(executable)) return executable;
    } catch {}
  }
  return "";
}

async function discoverWindowsPathEntry(run) {
  try {
    const { stdout } = await run("where.exe", [ACCIO_EXE]);
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const executable = normalizeAccioExecutable(line);
      if (executable && fs.existsSync(executable)) return executable;
    }
  } catch {}
  return "";
}

export async function discoverAccioExecutable(options = {}) {
  const {
    configuredPath = "",
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
    run = runFile,
  } = options;

  const configured = normalizeAccioExecutable(configuredPath, env);
  if (configured && fs.existsSync(configured)) {
    return { path: configured, source: "configured", exists: true };
  }

  const candidates = candidateAccioPaths(env, home);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { path: candidate, source: "standard", exists: true };
  }

  if (platform === "win32") {
    const pathEntry = await discoverWindowsPathEntry(run);
    if (pathEntry) return { path: pathEntry, source: "path", exists: true };

    const registryPath = await discoverWindowsRegistryPath(run);
    if (registryPath) return { path: registryPath, source: "registry", exists: true };
  }

  return {
    path: configured || candidates[0],
    source: configured ? "configured-missing" : "standard-missing",
    exists: false,
  };
}
