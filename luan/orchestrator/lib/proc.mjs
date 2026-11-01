// Run external tools (ffmpeg, ffprobe, the HyperFrames CLI) and find them on this machine.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const IS_WIN = process.platform === "win32";

/** Run a command; resolves with its exit code and full output, never rejects on a non-zero exit. */
export function run(cmd, args, { cwd, timeoutMs = 0, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(error.message) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// A fresh `winget install Gyan.FFmpeg` is not on PATH until the shell restarts.
function wingetFfmpegBin() {
  const base = join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  if (!existsSync(base)) return null;
  for (const pkg of readdirSync(base).filter((d) => d.startsWith("Gyan.FFmpeg"))) {
    for (const build of readdirSync(join(base, pkg))) {
      const bin = join(base, pkg, build, "bin");
      if (existsSync(join(bin, IS_WIN ? "ffmpeg.exe" : "ffmpeg"))) return bin;
    }
  }
  return null;
}

/** Absolute path of a tool on PATH (or ffmpeg/ffprobe from winget), or null. */
export function findTool(name) {
  const file = IS_WIN ? `${name}.exe` : name;
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, file))) return join(dir, file);
  }
  if (name === "ffmpeg" || name === "ffprobe") {
    const bin = wingetFfmpegBin();
    if (bin) return join(bin, file);
  }
  return null;
}

export function requireTool(name) {
  const path = findTool(name);
  if (!path) throw new Error(`${name} không có trên máy. Cài FFmpeg: winget install Gyan.FFmpeg`);
  return path;
}

/**
 * The first complete JSON object in mixed CLI output (logs may come before or after it).
 * Returns null when there is none.
 */
export function firstJsonObject(text) {
  const s = String(text || "");
  for (let i = s.indexOf("{"); i >= 0; i = s.indexOf("{", i + 1)) {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(s.slice(i, j + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

// npx ships with Node as a script; running it with this Node avoids a shell (npx is a .cmd on Windows).
const NPX_CLI = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");

/** `npx hyperframes <args>`, without a shell, so arguments with spaces or quotes pass through intact. */
export function hyperframes(args, opts = {}) {
  const all = ["--yes", "hyperframes", ...args];
  if (existsSync(NPX_CLI)) return run(process.execPath, [NPX_CLI, ...all], opts);
  if (!IS_WIN) return run("npx", all, opts);
  const quoted = all.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
  return run("npx", quoted, { ...opts, shell: true });
}
