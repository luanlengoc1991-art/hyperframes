#!/usr/bin/env node
// LUAN AI Video Studio — local engine. The desktop app talks to this HTTP API on 127.0.0.1;
// it drives the orchestrator (analyze → compose → validate → render), HyperFrames Studio,
// voice-over and Claude. Local mode for this machine; the multi-user backend comes later.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../orchestrator/cli.mjs";
import { Pipeline } from "../orchestrator/lib/pipeline.mjs";
import { findTool, firstJsonObject, hyperframes } from "../orchestrator/lib/proc.mjs";
import { compose } from "../orchestrator/stages/compose.mjs";
import { render, validate } from "../orchestrator/stages/render.mjs";
import { whisperAvailable } from "../orchestrator/stages/transcribe.mjs";
import { ENV_FILE, loadEnv } from "../voice/config.mjs";
import * as voice from "../voice/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PORT = Number(process.env.LUAN_ENGINE_PORT || 4500);
const STUDIO_ROOT = resolve(
  process.env.LUAN_STUDIO_ROOT || "D:/CLAUDE CURSO WEBSITE LUAN/LUAN AI VIDEO STUDIO",
);
const PROJECTS = join(STUDIO_ROOT, "_projects");
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
mkdirSync(PROJECTS, { recursive: true });
loadEnv();

// ---------- helpers ----------

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 2e6) throw new Error("Dữ liệu gửi lên quá lớn");
  }
  return s ? JSON.parse(s) : {};
}

const readJson = (f, fallback = null) =>
  existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback;

function inside(root, rel) {
  const full = resolve(root, rel);
  return full === resolve(root) || full.startsWith(resolve(root) + sep) ? full : null;
}

const MIME = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// The desktop UI is served from here too, so the app window talks to one origin
// (WebView2 blocks pages from its own scheme calling 127.0.0.1).
const UI_DIR = resolve(process.env.LUAN_UI_DIR || join(REPO, "luan", "desktop", "dist"));

function serveFile(req, res, file) {
  if (!file || !existsSync(file) || !statSync(file).isFile())
    return send(res, 404, { error: "Không tìm thấy file" });
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  const head = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
  };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      ...head,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...head, "Content-Length": size });
    createReadStream(file).pipe(res);
  }
}

function slugify(name) {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/gi, "d")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 50) || "du-an"
  );
}

// ---------- projects ----------

const projectDir = (id) => join(PROJECTS, id);

function projectInfo(id) {
  const dir = projectDir(id);
  const meta = readJson(join(dir, "project.json"), { name: id, sources: [] });
  const pipe = readJson(join(dir, "pipeline.json"), { stages: {} });
  const rendersDir = join(dir, "renders");
  const renders = existsSync(rendersDir)
    ? readdirSync(rendersDir)
        .filter((f) => f.endsWith(".mp4"))
        .map((f) => ({
          ...readJson(join(rendersDir, f.replace(/\.mp4$/, ".json")), {}),
          // Relative to the project (the sidecar JSON holds an absolute path).
          file: `renders/${f}`,
          mtime: statSync(join(rendersDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)
    : [];
  const report = readJson(join(dir, "analysis", "footage-report.json"));
  return {
    id,
    ...meta,
    brief: readJson(join(dir, "brief.json")),
    stages: Object.fromEntries(
      Object.entries(pipe.stages).map(([k, v]) => [
        k,
        { status: v.status, error: v.error || null, finishedAt: v.finishedAt || null },
      ]),
    ),
    report: report
      ? {
          items: report.items.map((a) => ({
            id: a.id,
            kind: a.kind,
            role: a.role,
            duration: a.duration,
            video: a.video,
            flags: a.flags,
            contactSheet: a.contactSheet ? `analysis/${a.id}/contact.jpg` : null,
            integratedLufs: a.integratedLufs,
            truePeakDbtp: a.truePeakDbtp,
          })),
          transcripts: report.transcripts,
        }
      : null,
    edl: readJson(join(dir, "edl.json")),
    hasComposition: existsSync(join(dir, "composition", "index.html")),
    renders,
    updatedAt: statSync(dir).mtimeMs,
  };
}

function listProjects() {
  return readdirSync(PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PROJECTS, d.name, "project.json")))
    .map((d) => {
      // One damaged project file must not hide every other project.
      try {
        return projectInfo(d.name);
      } catch (error) {
        return {
          id: d.name,
          name: d.name,
          sources: [],
          brief: null,
          stages: {},
          report: null,
          edl: null,
          hasComposition: false,
          renders: [],
          updatedAt: 0,
          error: String(error?.message || error),
        };
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------- jobs (long tasks, streamed over SSE) ----------

const jobs = new Map();

function startJob(projectId, kind, work) {
  const job = {
    id: randomUUID(),
    projectId,
    kind,
    status: "running",
    log: [],
    listeners: new Set(),
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  const emit = (type, text) => {
    const e = { type, text, at: Date.now() };
    job.log.push(e);
    if (job.log.length > 3000) job.log.shift();
    for (const res of job.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  work((text) => emit("log", text))
    .then((result) => {
      job.status = "done";
      job.result = result;
      emit("done", "Xong");
    })
    .catch((error) => {
      job.status = error?.name === "BlockedError" ? "blocked" : "failed";
      emit("error", String(error?.message || error));
    })
    .finally(() => {
      for (const res of job.listeners) res.end();
      job.listeners.clear();
    });
  return job;
}

const STEPS = ["analyze", "compose", "validate", "render"];

async function runSteps(id, steps, log) {
  const dir = projectDir(id);
  const meta = readJson(join(dir, "project.json"));
  for (const step of steps) {
    log(`▶ ${step}`);
    if (step === "analyze") {
      await analyze({ project: dir, sources: meta.sources, log });
    } else if (step === "compose") {
      const pipe = new Pipeline(dir);
      const r = await pipe.stage("compose", { at: Date.now() }, async () => compose(dir));
      log(
        `Dựng ${r.output.clips} clip, ${r.output.kept}/${r.output.sentences} câu, ${r.output.duration}s, ${r.output.captions} nhóm phụ đề`,
      );
    } else if (step === "validate") {
      const v = await validate(join(dir, "composition"));
      log(`Lint: ${v.lintOk ? "đạt" : "lỗi"} · Check: ${v.checkOk ? "đạt" : "lỗi"}`);
      for (const f of v.findings.filter((x) => x.severity !== "info"))
        log(`  ${f.severity} ${f.rule}: ${f.message}`);
      if (!v.lintOk || !v.checkOk) throw new Error("Kiểm tra composition chưa đạt, xem log");
    } else if (step === "render") {
      const pipe = new Pipeline(dir);
      const r = await pipe.stage("render", { at: Date.now() }, () =>
        render(dir, { name: `final-${Date.now()}`, onLog: log }),
      );
      log(
        `MP4: ${basename(r.output.file)} · ${r.output.duration.toFixed(1)}s · ${r.output.video?.width}×${r.output.video?.height} · ${r.output.sizeMB} MB`,
      );
    }
  }
  return projectInfo(id);
}

// ---------- Claude (local mode: Claude Code on this machine; API mode when a key exists) ----------

function findClaude() {
  const onPath = findTool("claude");
  if (onPath) return onPath;
  const found = [];
  for (const ext of [".vscode", ".cursor", ".windsurf"]) {
    const base = join(homedir(), ext, "extensions");
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).filter((n) => n.startsWith("anthropic.claude-code-"))) {
      const p = join(
        base,
        d,
        "resources",
        "native-binary",
        process.platform === "win32" ? "claude.exe" : "claude",
      );
      if (existsSync(p)) found.push({ p, m: statSync(p).mtimeMs });
    }
  }
  return found.sort((a, b) => b.m - a.m)[0]?.p ?? null;
}

const CLAUDE_RULES = `Bạn là AI Creative Director của LUAN AI VIDEO STUDIO, đang làm trong thư mục một dự án video.
Cấu trúc: project.json (nguồn tư liệu), brief.json (tiêu đề, phụ đề, CTA, hotline, thời lượng mục tiêu, captions),
analysis/footage-report.json + analysis/<id>/transcript.json, edl.json (mỗi câu một dòng, "keep" true/false),
composition/ (project HyperFrames: index.html, compositions/*.html).
Quy trình sửa: chỉnh brief.json hoặc edl.json (bật/tắt câu, đổi thứ tự rows), rồi chạy
  node "${join(REPO, "luan", "orchestrator", "cli.mjs").replace(/\\/g, "/")}" compose --project .
  node "${join(REPO, "luan", "orchestrator", "cli.mjs").replace(/\\/g, "/")}" validate --project .
Chỉ render khi người dùng yêu cầu xuất video: ... cli.mjs render --project .
Có thể sửa trực tiếp composition/*.html theo chuẩn HyperFrames (đọc ${join(REPO, "skills", "hyperframes", "SKILL.md").replace(/\\/g, "/")}).
Không bịa giá bán, pháp lý, ngày tháng, quy mô. Không xoá file nguồn. Trả lời ngắn gọn bằng tiếng Việt.`;

function chatWithClaude(id, message, log) {
  return new Promise((resolveP, reject) => {
    const bin = findClaude();
    if (!bin)
      return reject(
        Object.assign(new Error("Không tìm thấy Claude Code trên máy"), { name: "BlockedError" }),
      );
    const dir = projectDir(id);
    const meta = readJson(join(dir, "project.json"));
    const args = [
      "-p",
      `${CLAUDE_RULES}\n\nYêu cầu: ${message}`,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(node:*)",
      "Bash(npx hyperframes:*)",
      "Bash(npx --yes hyperframes:*)",
      "--add-dir",
      join(REPO, "skills"),
    ];
    if (meta.claudeSession) args.push("--resume", meta.claudeSession);
    const p = spawn(bin, args, { cwd: dir, windowsHide: true });
    let buf = "";
    let session = meta.claudeSession || null;
    let finalText = "";
    p.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = line ? firstJsonObject(line) : null;
        if (!m) continue;
        if (m.session_id) session = m.session_id;
        if (m.type === "assistant")
          for (const c2 of m.message?.content || []) {
            if (c2.type === "text" && c2.text.trim()) log(c2.text);
            if (c2.type === "tool_use")
              log(
                `⚙ ${c2.name}: ${String(c2.input?.description || c2.input?.command || c2.input?.file_path || "").slice(0, 140)}`,
              );
          }
        if (m.type === "result") finalText = m.result || "";
      }
    });
    p.stderr.on("data", (c) => log(String(c).slice(0, 300)));
    p.on("close", (code) => {
      if (session)
        writeFileSync(
          join(dir, "project.json"),
          JSON.stringify({ ...meta, claudeSession: session }, null, 2),
        );
      if (code === 0) resolveP({ reply: finalText });
      else reject(new Error(`Claude kết thúc với mã ${code}`));
    });
  });
}

// ---------- settings ----------

function writeEnvKeys(updates) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[A-Z0-9_]+$/.test(k)) continue;
    const clean = String(v ?? "").replace(/[\r\n]/g, "");
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${clean}`;
    else lines.push(`${k}=${clean}`);
    process.env[k] = clean;
  }
  writeFileSync(ENV_FILE, lines.join("\n"));
}

const VOICE_KEYS = [
  "VBEE_APP_ID",
  "VBEE_TOKEN",
  "VBEE_VOICE_CODE",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_MODEL",
  "LUAN_TTS_MAX_CHARS",
];

// ---------- routes ----------

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = decodeURIComponent(url.pathname);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Allow-Methods": "GET,POST,PUT",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  try {
    if (req.method === "GET" && p === "/api/health") {
      return send(res, 200, {
        ok: true,
        studioRoot: STUDIO_ROOT,
        tools: {
          ffmpeg: Boolean(findTool("ffmpeg")),
          whisper: whisperAvailable(),
          claude: Boolean(findClaude()),
          claudeApi: Boolean(process.env.ANTHROPIC_API_KEY),
        },
        voice: voice.status(),
      });
    }
    if (req.method === "GET" && p === "/api/projects") return send(res, 200, listProjects());
    if (req.method === "POST" && p === "/api/projects") {
      const { name, sources } = await readBody(req);
      if (!name?.trim()) return send(res, 400, { error: "Cần tên dự án" });
      const srcs = (sources || []).map((s) => resolve(String(s))).filter((s) => existsSync(s));
      if (!srcs.length)
        return send(res, 400, { error: "Cần ít nhất một thư mục hoặc file tư liệu có thật" });
      let id = slugify(name);
      for (let n = 2; existsSync(projectDir(id)); n++) id = `${slugify(name)}-${n}`;
      mkdirSync(projectDir(id), { recursive: true });
      writeFileSync(
        join(projectDir(id), "project.json"),
        JSON.stringify(
          { name: name.trim(), sources: srcs, createdAt: new Date().toISOString() },
          null,
          2,
        ),
      );
      return send(res, 200, projectInfo(id));
    }
    let m = /^\/api\/projects\/([^/]+)(\/[a-z-]+)?$/.exec(p);
    if (m) {
      const [, id, action = ""] = m;
      if (!SLUG.test(id) || !existsSync(join(projectDir(id), "project.json")))
        return send(res, 404, { error: "Không có dự án này" });
      const dir = projectDir(id);
      if (req.method === "GET" && action === "") return send(res, 200, projectInfo(id));
      if (req.method === "PUT" && action === "/brief") {
        const brief = await readBody(req);
        writeFileSync(join(dir, "brief.json"), JSON.stringify(brief, null, 2));
        return send(res, 200, projectInfo(id));
      }
      if (req.method === "PUT" && action === "/sources") {
        const { sources } = await readBody(req);
        const meta = readJson(join(dir, "project.json"));
        meta.sources = (sources || []).map((s) => resolve(String(s))).filter((s) => existsSync(s));
        writeFileSync(join(dir, "project.json"), JSON.stringify(meta, null, 2));
        return send(res, 200, projectInfo(id));
      }
      if (req.method === "PUT" && action === "/edl") {
        const { keep } = await readBody(req);
        const edl = readJson(join(dir, "edl.json"));
        if (!edl) return send(res, 400, { error: "Chưa có EDL: chạy Phân tích + Dựng trước" });
        for (const r of edl.rows) if (r.id in (keep || {})) r.keep = Boolean(keep[r.id]);
        writeFileSync(join(dir, "edl.json"), JSON.stringify(edl, null, 2));
        return send(res, 200, projectInfo(id));
      }
      if (req.method === "POST" && action === "/run") {
        const { steps } = await readBody(req);
        const list = (steps || STEPS).filter((s) => STEPS.includes(s));
        const job = startJob(id, list.join("+"), (log) => runSteps(id, list, log));
        return send(res, 200, { job: job.id });
      }
      if (req.method === "POST" && action === "/chat") {
        const { message } = await readBody(req);
        if (!message?.trim()) return send(res, 400, { error: "Tin nhắn trống" });
        const job = startJob(id, "chat", (log) => chatWithClaude(id, message.trim(), log));
        return send(res, 200, { job: job.id });
      }
      if (req.method === "POST" && action === "/voice") {
        const { text, provider, dryRun } = await readBody(req);
        const out = join(dir, "composition", "assets", "voice", `voice-${Date.now()}.mp3`);
        const job = startJob(id, "voice", async (log) => {
          const r = await voice.synthesize({
            text,
            out,
            provider: provider || "auto",
            dryRun: Boolean(dryRun),
          });
          log(JSON.stringify({ ...r, words: r.words ? r.words.length : null }));
          return r;
        });
        return send(res, 200, { job: job.id });
      }
      if (req.method === "POST" && action === "/studio") {
        const comp = join(dir, "composition");
        if (!existsSync(join(comp, "index.html")))
          return send(res, 400, { error: "Chưa có composition: chạy Dựng trước" });
        const r = await hyperframes(["preview", comp, "--no-open", "--json"], {
          cwd: comp,
          timeoutMs: 120_000,
        });
        const j = firstJsonObject(r.stdout);
        return j?.ok
          ? send(res, 200, { url: j.result.studioUrl })
          : send(res, 500, { error: (r.stderr || r.stdout).slice(-400) });
      }
      if (req.method === "POST" && action === "/open-folder") {
        spawn("explorer.exe", [dir], { detached: true }).unref();
        return send(res, 200, { ok: true });
      }
    }
    m = /^\/api\/jobs\/([^/]+)(\/events)?$/.exec(p);
    if (m && req.method === "GET") {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "Không có job" });
      if (!m[2])
        return send(res, 200, {
          id: job.id,
          kind: job.kind,
          status: job.status,
          log: job.log,
          result: job.result ?? null,
        });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Private-Network": "true",
      });
      for (const e of job.log) res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (job.status === "running") job.listeners.add(res);
      else res.end();
      req.on("close", () => job.listeners.delete(res));
      return;
    }
    if (req.method === "GET" && p === "/api/jobs") {
      return send(
        res,
        200,
        [...jobs.values()]
          .map((j) => ({
            id: j.id,
            projectId: j.projectId,
            kind: j.kind,
            status: j.status,
            startedAt: j.startedAt,
          }))
          .reverse(),
      );
    }
    if (p === "/api/settings/voice") {
      if (req.method === "PUT") {
        const body = await readBody(req);
        writeEnvKeys(
          Object.fromEntries(Object.entries(body).filter(([k]) => VOICE_KEYS.includes(k))),
        );
      }
      return send(res, 200, voice.status());
    }
    if (req.method === "GET" && p.startsWith("/api/voices/")) {
      return send(res, 200, await voice.listVoices(p.split("/").pop()));
    }
    m = /^\/files\/([^/]+)\/(.+)$/.exec(p);
    if (req.method === "GET" && m && SLUG.test(m[1]))
      return serveFile(req, res, inside(projectDir(m[1]), m[2]));
    if (req.method === "GET" && !p.startsWith("/api/")) {
      const file = inside(UI_DIR, p === "/" ? "index.html" : p.slice(1));
      if (file && existsSync(file) && statSync(file).isFile()) return serveFile(req, res, file);
      if (existsSync(join(UI_DIR, "index.html")))
        return serveFile(req, res, join(UI_DIR, "index.html"));
    }
    send(res, 404, { error: "Không tìm thấy" });
  } catch (error) {
    send(res, error?.name === "BlockedError" ? 409 : 500, {
      error: String(error?.message || error),
    });
  }
});

// Listen only when run directly (the desktop app starts it); tests import `server` instead.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, "127.0.0.1", () =>
    console.log(`LUAN AI Video Studio engine: http://127.0.0.1:${PORT} · dự án: ${PROJECTS}`),
  );
}
