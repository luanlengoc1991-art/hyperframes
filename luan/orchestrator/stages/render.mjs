// Stages 11–13: validate the composition with HyperFrames (lint + check), render the MP4 and
// verify the actual file with ffprobe. Nothing is reported as finished unless the file exists.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { firstJsonObject, hyperframes, requireTool, run } from "../lib/proc.mjs";

const clean = (s) => stripVTControlCharacters(String(s || ""));

export async function validate(compDir) {
  const lint = await hyperframes(["lint"], { cwd: compDir });
  const check = await hyperframes(["check", "--json"], { cwd: compDir, timeoutMs: 600_000 });
  const tail = (s) => clean(s).split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
  const parsed = firstJsonObject(clean(check.stdout));
  // Collect every finding (objects carrying a severity) wherever the report nests them.
  const findings = [];
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      if (o.severity || o.level)
        findings.push({
          severity: o.severity || o.level,
          rule: o.rule || o.code || "",
          message: String(o.message || "").slice(0, 300),
          at: o.at ?? o.time ?? null,
        });
      else Object.values(o).forEach(walk);
    }
  };
  if (parsed) walk(parsed);
  return {
    lintOk: lint.code === 0,
    lint: tail(lint.stdout + lint.stderr),
    checkOk: check.code === 0 && (parsed?.ok ?? false),
    findings,
    checkRaw: parsed ? null : tail(check.stdout + check.stderr),
  };
}

export async function probeOutput(file) {
  const r = await run(requireTool("ffprobe"), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe không đọc được ${file}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return {
    duration: Number(j.format.duration),
    sizeMB: Math.round((statSync(file).size / 1048576) * 10) / 10,
    video: v
      ? { codec: v.codec_name, width: v.width, height: v.height, fps: v.avg_frame_rate }
      : null,
    audio: a ? { codec: a.codec_name, channels: a.channels } : null,
  };
}

/** Render <compDir> to <projectDir>/renders/<name>.mp4 (SDR) and verify it. */
export async function render(projectDir, { name = "final", onLog = () => {} } = {}) {
  const compDir = join(projectDir, "composition");
  const rendersDir = join(projectDir, "renders");
  mkdirSync(rendersDir, { recursive: true });
  const out = join(rendersDir, `${name}.mp4`);
  const r = await hyperframes(["render", "--output", out, "--sdr"], {
    cwd: compDir,
    timeoutMs: 3_600_000,
  });
  for (const line of clean(r.stdout + r.stderr).split(/\r?\n/))
    if (line.trim() && !/^\[(INFO|DEBUG)\]/.test(line)) onLog(line.trim());
  if (r.code !== 0 || !existsSync(out))
    throw new Error(`Render lỗi: ${clean(r.stderr || r.stdout).slice(-500)}`);
  const info = await probeOutput(out);
  writeFileSync(
    join(rendersDir, `${name}.json`),
    JSON.stringify({ file: out, renderedAt: new Date().toISOString(), ...info }, null, 2),
  );
  return { file: out, ...info };
}
