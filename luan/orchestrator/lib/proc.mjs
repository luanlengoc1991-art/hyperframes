// Run external tools (ffmpeg, ffprobe, the HyperFrames CLI) and find them on this machine.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

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

/** `npx hyperframes <args>`; npx is a .cmd on Windows, so it needs a shell and quoted arguments. */
export function hyperframes(args, opts = {}) {
  const all = ["--yes", "hyperframes", ...args];
  if (!IS_WIN) return run("npx", all, opts);
  const quoted = all.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
  return run("npx", quoted, { ...opts, shell: true });
}
