// Preview proxies: light H.264 copies of the footage for the in-app player (WebView2 cannot decode
// iPhone HEVC). They live in <project>/cache/proxy and are used only for preview; renders always
// read the original files.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { requireTool, run } from "./proc.mjs";

const VIDEO = new Set([".mov", ".mp4", ".m4v", ".mkv", ".webm"]);

export const proxyPath = (projectDir, file) =>
  join(projectDir, "cache", "proxy", `${basename(file, extname(file))}.mp4`);

export function proxyReady(projectDir, file) {
  const p = proxyPath(projectDir, file);
  return existsSync(p) && statSync(p).mtimeMs >= statSync(file).mtimeMs;
}

const running = new Map();

/** Make one proxy (540 px wide, fast start); concurrent callers share the same job. */
export function ensureProxy(projectDir, file) {
  const out = proxyPath(projectDir, file);
  if (proxyReady(projectDir, file)) return Promise.resolve(out);
  if (running.has(out)) return running.get(out);
  const job = (async () => {
    mkdirSync(join(projectDir, "cache", "proxy"), { recursive: true });
    const tmp = `${out}.part.mp4`;
    const r = await run(
      requireTool("ffmpeg"),
      [
        "-v",
        "error",
        "-y",
        "-i",
        file,
        "-vf",
        "scale=540:-2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "27",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        tmp,
      ],
      { timeoutMs: 30 * 60_000 },
    );
    if (r.code !== 0 || !existsSync(tmp))
      throw new Error(`Không tạo được bản xem trước: ${r.stderr.slice(-300)}`);
    renameSync(tmp, out);
    return out;
  })().finally(() => running.delete(out));
  running.set(out, job);
  return job;
}

/** Proxies for every footage file of the composition. */
export async function ensureProxies(projectDir, log = () => {}) {
  const dir = join(projectDir, "composition", "assets", "footage");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => VIDEO.has(extname(n).toLowerCase()))) {
    const file = join(dir, f);
    if (proxyReady(projectDir, file)) continue;
    log(`Tạo bản xem trước: ${f}`);
    out.push(await ensureProxy(projectDir, file));
  }
  return out;
}
