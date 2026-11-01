#!/usr/bin/env node
// LUAN AI Video Studio — local engine. The desktop app talks to this HTTP API on 127.0.0.1;
// it drives the orchestrator (analyze → storyboard → compose → validate → render), the live
// preview, the storyboard editor, HyperFrames Studio, the sound library, voice-over and Claude.
// Local mode for this machine; the multi-user backend comes later.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../orchestrator/cli.mjs";
import { findClaude, runClaude } from "../orchestrator/lib/claude.mjs";
import { Pipeline } from "../orchestrator/lib/pipeline.mjs";
import { findTool, firstJsonObject, hyperframes } from "../orchestrator/lib/proc.mjs";
import { ensureProxies, ensureProxy, proxyReady } from "../orchestrator/lib/proxy.mjs";
import { listSounds, SOUND_LIBRARY, soundPath } from "../orchestrator/lib/sounds.mjs";
import { compose, readStory } from "../orchestrator/stages/compose.mjs";
import { sanitizeStory } from "../orchestrator/stages/motion.mjs";
import { planStory } from "../orchestrator/stages/plan.mjs";
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
const TRASH = join(STUDIO_ROOT, "_trash");
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
mkdirSync(PROJECTS, { recursive: true });
loadEnv();

// ---------- helpers ----------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Private-Network": "true",
};

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...CORS,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 4e6) throw new Error("Dữ liệu gửi lên quá lớn");
  }
  return s ? JSON.parse(s) : {};
}

const readJson = (f, fallback = null) =>
  existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback;
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2));

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
  ".webp": "image/webp",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// The desktop UI is served from here too, so the app window talks to one origin
// (WebView2 blocks pages from its own scheme calling 127.0.0.1).
const UI_DIR = resolve(process.env.LUAN_UI_DIR || join(REPO, "luan", "desktop", "dist"));
// The HyperFrames player and runtime for the in-app preview, from this checkout.
const HF_FILES = {
  "player.js": join(REPO, "packages", "player", "dist", "hyperframes-player.global.js"),
  "runtime.js": join(REPO, "packages", "core", "dist", "hyperframe.runtime.iife.js"),
};

function serveFile(req, res, file, extraHead = {}) {
  if (!file || !existsSync(file) || !statSync(file).isFile())
    return send(res, 404, { error: "Không tìm thấy file" });
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  const head = { "Content-Type": type, "Accept-Ranges": "bytes", ...CORS, ...extraHead };
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

function renderList(dir) {
  const rendersDir = join(dir, "renders");
  return existsSync(rendersDir)
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
}

function projectInfo(id) {
  const dir = projectDir(id);
  const meta = readJson(join(dir, "project.json"), { name: id, sources: [] });
  const pipe = readJson(join(dir, "pipeline.json"), { stages: {} });
  const report = readJson(join(dir, "analysis", "footage-report.json"));
  const story = readJson(join(dir, "story.json"));
  const timeline = readJson(join(dir, "timeline.json"));
  return {
    id,
    ...meta,
    claudeSession: undefined,
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
    story: story ? { beats: story.beats.length, aiPlanned: Boolean(story.aiPlanned) } : null,
    total: timeline?.total ?? null,
    hasComposition: existsSync(join(dir, "composition", "index.html")),
    renders: renderList(dir),
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
          story: null,
          total: null,
          hasComposition: false,
          renders: [],
          updatedAt: 0,
          error: String(error?.message || error),
        };
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What the editor needs: the placed timeline, the editable story and the sentences. */
function editorState(id) {
  const dir = projectDir(id);
  const edl = readJson(join(dir, "edl.json"));
  return {
    timeline: readJson(join(dir, "timeline.json")),
    story: readStory(dir),
    brief: readJson(join(dir, "brief.json")),
    // Word timings stay on the engine; the editor needs the sentences only.
    rows: (edl?.rows || []).map(({ words: _words, ...r }) => r),
    images: (readJson(join(dir, "analysis", "footage-report.json"))?.items || [])
      .filter((a) => a.kind === "image")
      .map((a) => ({ id: a.id, name: basename(a.path) })),
    proxies: proxiesState(dir),
  };
}

function proxiesState(dir) {
  const f = join(dir, "composition", "assets", "footage");
  if (!existsSync(f)) return { ready: 0, total: 0 };
  const files = readdirSync(f).filter((n) => /\.(mov|mp4|m4v|mkv|webm)$/i.test(n));
  return { ready: files.filter((n) => proxyReady(dir, join(f, n))).length, total: files.length };
}

/** Compose and report a blocked compose (hand-edited composition) as an error. */
function composeNow(dir, opts = {}) {
  try {
    return compose(dir, opts);
  } catch (error) {
    if (error?.name === "BlockedError") error.status = 409;
    throw error;
  }
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
  const emit = (type, text, extra = {}) => {
    const e = { type, text, at: Date.now(), ...extra };
    job.log.push(e);
    if (job.log.length > 3000) job.log.shift();
    for (const res of job.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const log = (text) => emit("log", text);
  log.event = (e) => {
    if (e.kind === "thinking") {
      // One progress line per ~400 thinking tokens, not one per delta.
      if (e.tokens - (job.lastThinking || 0) < 400) return;
      job.lastThinking = e.tokens;
      return emit("thinking", `Claude đang suy nghĩ… (${e.tokens} token)`);
    }
    emit(e.kind === "tool" ? "tool" : "ai", e.kind === "tool" ? `${e.name}: ${e.text}` : e.text);
  };
  work(log)
    .then((result) => {
      job.status = "done";
      job.result = result;
      emit("done", "Xong", { result });
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

const STEPS = ["analyze", "plan", "compose", "validate", "render"];

async function runSteps(id, steps, log, { force = false } = {}) {
  const dir = projectDir(id);
  const meta = readJson(join(dir, "project.json"));
  const brief = readJson(join(dir, "brief.json"), {});
  for (const step of steps) {
    log(`▶ ${step}`);
    if (step === "analyze") {
      await analyze({ project: dir, sources: meta.sources, log });
    } else if (step === "plan") {
      // The storyboard needs the sentence list, which the first compose writes.
      if (!existsSync(join(dir, "edl.json"))) composeNow(dir, { force });
      const r = await planStory(dir, { onEvent: log.event });
      log(
        `Storyboard: ${r.beats} hiệu ứng · chương: ${r.chapters.join(", ") || "–"} · ${r.corrections} sửa lỗi phụ đề${r.dropped.length ? ` · bỏ ${r.dropped.length} thẻ có số liệu không có trong lời nói` : ""}`,
      );
    } else if (step === "compose") {
      const pipe = new Pipeline(dir);
      const r = await pipe.stage("compose", { at: Date.now() }, async () =>
        composeNow(dir, { force }),
      );
      if (r.status === "blocked") throw new Error(pipe.state.stages.compose.error);
      const o = r.output;
      log(
        `Dựng ${o.clips} clip, ${o.kept}/${o.sentences} câu, ${o.beats} hiệu ứng, ${o.captions} nhóm phụ đề, ${o.sfx} SFX${o.music ? ", có nhạc nền" : ""} · ${o.duration}s`,
      );
      // Preview proxies in the background of this job (renders use the originals).
      await ensureProxies(dir, log);
    } else if (step === "validate") {
      const v = await validate(join(dir, "composition"));
      log(`Lint: ${v.lintOk ? "đạt" : "lỗi"} · Check: ${v.checkOk ? "đạt" : "lỗi"}`);
      for (const f of v.findings.filter((x) => x.severity === "error" || x.severity === "warning"))
        log(`  ${f.severity} ${f.rule}: ${f.message}`);
      if (!v.lintOk || !v.checkOk) throw new Error("Kiểm tra composition chưa đạt, xem log");
    } else if (step === "render") {
      const pipe = new Pipeline(dir);
      const r = await pipe.stage("render", { at: Date.now() }, () =>
        render(dir, {
          name: `final-${Date.now()}`,
          quality: brief.quality || "standard",
          onLog: log,
        }),
      );
      log(
        `MP4: ${basename(r.output.file)} · ${r.output.duration.toFixed(1)}s · ${r.output.video?.width}×${r.output.video?.height} · ${r.output.sizeMB} MB`,
      );
    }
  }
  return projectInfo(id);
}

// ---------- Claude chat (local mode: Claude Code on this machine) ----------

const CLI = join(REPO, "luan", "orchestrator", "cli.mjs").replace(/\\/g, "/");
const CLAUDE_RULES = `Bạn là AI Creative Director của LUAN AI VIDEO STUDIO, đang làm trong thư mục một dự án video bất động sản (HyperFrames).
Các file của dự án:
- brief.json: title, subtitle, cta, hotline, targetDuration, captions, corrections [{from,to}] (sửa chữ phụ đề nghe sai), quality (draft|standard|high), notes.
- edl.json: rows = từng câu nói (id, source, sourceIn, sourceOut, text, keep, captionText tuỳ chọn để sửa chữ phụ đề của câu đó). Bỏ câu: keep=false.
- story.json: storyboard hiệu ứng. theme {accent, brand}, keywords [], music {enabled, rel, volume}, sfx {enabled, volume}, beats [].
  Beat: type hook|card|full|stats|badge|outro; card/full/stats/badge gắn "row" (id câu trong edl) + "offset" (giây từ đầu câu) + duration;
  trường: chapter, index, kicker, title, accent, note, sub, label, image (id ảnh), stat {value, unit, label}, dates [{label, value}], bullets [], rows [{value, unit, label}] (cho stats).
  hook: mở đầu (không có row); outro: kết (title, sub, label=hotline).
- timeline.json (chỉ đọc): thời điểm thật của từng câu (rows), từng beat, phụ đề — dùng để biết "giây thứ X" là câu nào.
- composition/ là file sinh tự động từ các file trên — KHÔNG sửa trực tiếp trừ khi người dùng yêu cầu chỉnh thứ mà storyboard không làm được.
Sau khi sửa brief/edl/story, LUÔN chạy: node "${CLI}" compose --project .
Chỉ chạy validate (node "${CLI}" validate --project .) khi được yêu cầu kiểm tra; chỉ render khi người dùng yêu cầu xuất video.
Không bịa giá bán, pháp lý, ngày tháng, quy mô: con số trên màn hình phải có trong lời nói hoặc brief. Không xoá file nguồn.
Trả lời ngắn gọn bằng tiếng Việt, nói rõ đã đổi gì.`;

function chatFile(dir) {
  return join(dir, "chat.json");
}

async function chatWithClaude(id, message, log, context = {}) {
  const dir = projectDir(id);
  const meta = readJson(join(dir, "project.json"));
  const history = readJson(chatFile(dir), []);
  const ctx = [];
  if (Number.isFinite(context.time))
    ctx.push(`Người dùng đang đứng ở giây ${context.time.toFixed(1)} trên timeline.`);
  if (context.beat) ctx.push(`Beat đang chọn: ${context.beat}.`);
  const prompt = `${meta.claudeSession ? "" : `${CLAUDE_RULES}\n\n`}${ctx.join(" ")}\nYêu cầu: ${message}`;
  const turn = { role: "user", text: message, at: Date.now() };
  const reply = { role: "ai", text: "", tools: [], at: 0 };
  const r = await runClaude(prompt, {
    cwd: dir,
    resume: meta.claudeSession || null,
    tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(node:*)"],
    addDirs: [join(REPO, "skills")],
    onEvent: (e) => {
      if (e.kind === "tool") reply.tools.push(`${e.name}: ${e.text}`);
      if (e.kind === "text") reply.text += (reply.text ? "\n" : "") + e.text;
      log.event(e);
    },
  }).catch((error) => {
    // A stale session id (Claude Code was reinstalled) is dropped so the next turn starts fresh.
    if (meta.claudeSession) writeJson(join(dir, "project.json"), { ...meta, claudeSession: null });
    throw error;
  });
  reply.text = r.text || reply.text;
  reply.at = Date.now();
  writeJson(join(dir, "project.json"), {
    ...readJson(join(dir, "project.json")),
    claudeSession: r.session,
  });
  writeJson(chatFile(dir), [...history, turn, reply].slice(-200));
  return { reply: reply.text, cost: r.cost };
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

// ---------- preview (composition served with proxy footage) ----------

async function servePreview(req, res, id, rel) {
  const dir = projectDir(id);
  const comp = join(dir, "composition");
  const file = inside(comp, rel || "index.html");
  if (!file) return send(res, 404, { error: "Không tìm thấy" });
  if (
    /^assets[\\/]footage[\\/]/i.test(rel) &&
    /\.(mov|mp4|m4v|mkv|webm)$/i.test(rel) &&
    existsSync(file)
  ) {
    // The player gets the light H.264 proxy (made now if missing); renders use the original.
    try {
      return serveFile(req, res, await ensureProxy(dir, file), { "Content-Type": "video/mp4" });
    } catch {
      return serveFile(req, res, file);
    }
  }
  return serveFile(req, res, file, { "Cache-Control": "no-store" });
}

// ---------- routes ----------

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = decodeURIComponent(url.pathname);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...CORS,
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  try {
    if (req.method === "GET" && p === "/api/health") {
      return send(res, 200, {
        ok: true,
        studioRoot: STUDIO_ROOT,
        soundLibrary: SOUND_LIBRARY,
        tools: {
          ffmpeg: Boolean(findTool("ffmpeg")),
          whisper: whisperAvailable(),
          claude: Boolean(findClaude()),
          claudeApi: Boolean(process.env.ANTHROPIC_API_KEY),
          sounds: existsSync(SOUND_LIBRARY),
        },
        voice: voice.status(),
      });
    }
    if (req.method === "GET" && p.startsWith("/hf/") && HF_FILES[p.slice(4)])
      return serveFile(req, res, HF_FILES[p.slice(4)]);
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
      writeJson(join(projectDir(id), "project.json"), {
        name: name.trim(),
        sources: srcs,
        createdAt: new Date().toISOString(),
      });
      return send(res, 200, projectInfo(id));
    }
    let m = /^\/api\/projects\/([^/]+)(\/[a-z-]+)?$/.exec(p);
    if (m) {
      const [, id, action = ""] = m;
      if (!SLUG.test(id) || !existsSync(join(projectDir(id), "project.json")))
        return send(res, 404, { error: "Không có dự án này" });
      const dir = projectDir(id);
      if (req.method === "GET" && action === "") return send(res, 200, projectInfo(id));
      if (req.method === "DELETE" && action === "") {
        // Never deleted outright: moved to _trash, restorable by moving the folder back.
        mkdirSync(TRASH, { recursive: true });
        renameSync(dir, join(TRASH, `${id}-${Date.now()}`));
        return send(res, 200, { ok: true });
      }
      if (req.method === "PUT" && action === "/meta") {
        const { name } = await readBody(req);
        if (!name?.trim()) return send(res, 400, { error: "Cần tên dự án" });
        writeJson(join(dir, "project.json"), {
          ...readJson(join(dir, "project.json")),
          name: name.trim().slice(0, 120),
        });
        return send(res, 200, projectInfo(id));
      }
      if (req.method === "PUT" && action === "/brief") {
        const brief = await readBody(req);
        writeJson(join(dir, "brief.json"), brief);
        return send(res, 200, projectInfo(id));
      }
      if (req.method === "PUT" && action === "/sources") {
        const { sources } = await readBody(req);
        const meta = readJson(join(dir, "project.json"));
        meta.sources = (sources || []).map((s) => resolve(String(s))).filter((s) => existsSync(s));
        writeJson(join(dir, "project.json"), meta);
        return send(res, 200, projectInfo(id));
      }
      if (req.method === "PUT" && action === "/edl") {
        const { keep, captionText } = await readBody(req);
        const edl = readJson(join(dir, "edl.json"));
        if (!edl) return send(res, 400, { error: "Chưa có EDL: chạy Phân tích + Dựng trước" });
        for (const r of edl.rows) {
          if (keep && r.id in keep) r.keep = Boolean(keep[r.id]);
          if (captionText && r.id in captionText) {
            const t = String(captionText[r.id] ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (t && t !== r.text) r.captionText = t.slice(0, 400);
            else delete r.captionText;
          }
        }
        writeJson(join(dir, "edl.json"), edl);
        return send(res, 200, projectInfo(id));
      }
      if (req.method === "GET" && action === "/editor") {
        if (
          !existsSync(join(dir, "timeline.json")) &&
          existsSync(join(dir, "analysis", "footage-report.json"))
        )
          composeNow(dir);
        return send(res, 200, editorState(id));
      }
      if (req.method === "PUT" && action === "/story") {
        const { story, force } = await readBody(req);
        const edl = readJson(join(dir, "edl.json"));
        const clean = sanitizeStory(story, { rowIds: new Set((edl?.rows || []).map((r) => r.id)) });
        const prev = readJson(join(dir, "story.json"));
        writeJson(join(dir, "story.json"), { ...clean, aiPlanned: prev?.aiPlanned || false });
        try {
          composeNow(dir, { force: Boolean(force) });
        } catch (error) {
          if (error.status === 409) return send(res, 409, { error: error.message, blocked: true });
          throw error;
        }
        return send(res, 200, editorState(id));
      }
      if (req.method === "POST" && action === "/recompose") {
        const { force } = await readBody(req);
        try {
          composeNow(dir, { force: Boolean(force) });
        } catch (error) {
          if (error.status === 409) return send(res, 409, { error: error.message, blocked: true });
          throw error;
        }
        return send(res, 200, editorState(id));
      }
      if (req.method === "POST" && action === "/run") {
        const { steps, force } = await readBody(req);
        const list = (steps || STEPS).filter((s) => STEPS.includes(s));
        const job = startJob(id, list.join("+"), (log) =>
          runSteps(id, list, log, { force: Boolean(force) }),
        );
        return send(res, 200, { job: job.id });
      }
      if (req.method === "GET" && action === "/chat")
        return send(res, 200, readJson(chatFile(dir), []));
      if (req.method === "POST" && action === "/chat") {
        const { message, context, reset } = await readBody(req);
        if (reset) {
          writeJson(join(dir, "project.json"), {
            ...readJson(join(dir, "project.json")),
            claudeSession: null,
          });
          writeJson(chatFile(dir), []);
          return send(res, 200, { ok: true });
        }
        if (!message?.trim()) return send(res, 400, { error: "Tin nhắn trống" });
        const job = startJob(id, "chat", (log) =>
          chatWithClaude(id, message.trim(), log, context || {}),
        );
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
    m = /^\/preview\/([^/]+)\/?(.*)$/.exec(p);
    if (req.method === "GET" && m && SLUG.test(m[1]) && existsSync(projectDir(m[1])))
      return servePreview(req, res, m[1], m[2]);
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
        ...CORS,
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
    if (req.method === "GET" && p === "/api/library/sounds") {
      const role = url.searchParams.get("role");
      const all = listSounds();
      return send(res, 200, role ? all.filter((s) => s.role === role) : all);
    }
    if (req.method === "GET" && p.startsWith("/library/sound/"))
      return serveFile(req, res, soundPath(p.slice("/library/sound/".length)));
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
    send(res, error?.status || (error?.name === "BlockedError" ? 409 : 500), {
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
