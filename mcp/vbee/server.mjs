#!/usr/bin/env node
// Vbee MCP server: Vietnamese text-to-speech and speech-to-text from Vbee
// (https://studio.vbee.vn/apps) for Claude / Cursor, so voiceovers and
// transcripts can be dropped straight into HyperFrames projects.
// API reference: https://api-docs.vbee.vn/llms.txt
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));

// Credentials come from the environment, or from a .env file next to this
// script (kept out of git) so the token can be pasted in without touching the
// MCP client config.
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadDotEnv(join(HERE, ".env"));

const API = (process.env.VBEE_API_BASE || "https://api.vbee.vn").replace(/\/+$/, "");
const VOICES_API = "https://vbee.vn/api/public/v1/voices";
// Batch TTS requires a webhook even when we poll for the result instead.
const WEBHOOK = process.env.VBEE_WEBHOOK_URL || "https://example.com/vbee-webhook";
const DEFAULT_VOICE = process.env.VBEE_VOICE_CODE || "hn_female_ngochuyen_full_48k-fhg";
const PROJECTS_ROOT =
  process.env.HYPERFRAMES_PROJECTS_DIR ||
  (existsSync("D:\\") ? "D:\\HyperFrames Projects" : join(HERE, "output"));
const POLL_MS = 3000;
const TIMEOUT_MS = 10 * 60_000;

function credentials() {
  const appId = process.env.VBEE_APP_ID;
  const token = process.env.VBEE_TOKEN;
  if (!appId || !token) {
    throw new Error(
      "Thiếu VBEE_APP_ID hoặc VBEE_TOKEN. Tạo ứng dụng ở https://studio.vbee.vn/apps rồi ghi vào " +
        join(HERE, ".env") +
        " (xem .env.example).",
    );
  }
  return { appId, token };
}

function authHeaders(extra = {}) {
  const { appId, token } = credentials();
  return { Authorization: `Bearer ${token}`, "App-Id": appId, ...extra };
}

async function readError(res) {
  const body = await res.text();
  try {
    const j = JSON.parse(body);
    const e = j.error || j;
    return `${res.status} ${e.code || ""} ${e.message || e.error_message || body}`.trim();
  } catch {
    return `${res.status} ${body.slice(0, 500)}`;
  }
}

async function callJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Vbee API lỗi: ${await readError(res)}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Relative paths land in a HyperFrames project when one is named, else in the projects root.
function resolveOut(path, project) {
  if (isAbsolute(path)) return path;
  return project ? join(PROJECTS_ROOT, project, path) : join(PROJECTS_ROOT, path);
}

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Tải audio thất bại: ${res.status}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return statSync(file).size;
}

async function getTtsRequest(requestId) {
  return callJson(`${API}/v1/tts/requests/${encodeURIComponent(requestId)}`, {
    headers: authHeaders(),
  });
}

async function waitTts(requestId) {
  const start = Date.now();
  for (;;) {
    const r = await getTtsRequest(requestId);
    if (r.status === "COMPLETED" && r.audioLink) return r;
    if (r.status === "FAILED")
      throw new Error(`Vbee báo thất bại: ${r.error_message || r.error_code || "FAILED"}`);
    if (Date.now() - start > TIMEOUT_MS) throw new Error(`Hết thời gian chờ request ${requestId}`);
    await sleep(POLL_MS);
  }
}

async function waitStt(transcriptId) {
  const start = Date.now();
  for (;;) {
    const r = await callJson(`${API}/v1/stt/transcripts/${encodeURIComponent(transcriptId)}`, {
      headers: authHeaders(),
    });
    if (r.status === "COMPLETED") return r;
    if (r.status === "FAILED") throw new Error(`Nhận dạng thất bại (transcriptId ${transcriptId})`);
    if (Date.now() - start > TIMEOUT_MS)
      throw new Error(`Hết thời gian chờ transcript ${transcriptId}`);
    await sleep(POLL_MS);
  }
}

function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

const ok = (data) => ({
  content: [
    { type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
  ],
});
const fail = (e) => ({ content: [{ type: "text", text: String(e?.message || e) }], isError: true });

const server = new McpServer(
  { name: "vbee", version: "1.0.0" },
  {
    instructions:
      "Vbee: giọng đọc tiếng Việt (TTS) và nhận dạng giọng nói (STT). Dùng để lồng tiếng / voiceover cho video HyperFrames " +
      "và lấy phụ đề có thời gian. Chưa biết mã giọng thì gọi vbee_list_voices trước. vbee_text_to_speech tự chờ và tải file " +
      "về dự án (mặc định assets/voice/). Link audio của Vbee chỉ sống 3 phút; cần lại thì gọi vbee_get_tts_request.",
  },
);

server.registerTool(
  "vbee_list_voices",
  {
    title: "Danh sách giọng Vbee",
    description:
      "List Vbee voices (code, name, gender, language, demo link, credit factor). Call before vbee_text_to_speech to pick a voice_code. Paginate with cursor.",
    inputSchema: {
      language_code: z.string().default("vi-VN").describe("Language code, e.g. vi-VN, en-US"),
      gender: z.enum(["male", "female"]).optional(),
      voice_ownership: z
        .enum(["VBEE", "COMMUNITY", "PERSONAL"])
        .default("VBEE")
        .describe("VBEE stock voices, COMMUNITY, or PERSONAL (your cloned voices)"),
      code: z.string().optional().describe("Look up one exact voice code"),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().optional().describe("next_cursor from a previous page"),
    },
  },
  async ({ language_code, gender, voice_ownership, code, limit, cursor }) => {
    try {
      const q = new URLSearchParams({
        voiceOwnership: voice_ownership,
        languageCode: language_code,
        limit: String(limit),
      });
      if (gender) q.set("gender", gender);
      if (code) q.set("code", code);
      if (cursor) q.set("cursor", cursor);
      const j = await callJson(`${VOICES_API}?${q}`, { headers: authHeaders() });
      const r = j.result || {};
      return ok({
        voices: r.voices || [],
        next_cursor: r.pagination?.has_next_page ? r.pagination.next_cursor : null,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "vbee_text_to_speech",
  {
    title: "Vbee: văn bản thành giọng nói",
    description:
      "Turn text (up to 100,000 chars, Vietnamese or other supported languages) into speech with a Vbee voice, wait for it, and save the audio file. Use for voiceovers in HyperFrames videos. Returns the saved path.",
    inputSchema: {
      text: z
        .string()
        .min(1)
        .max(100_000)
        .describe("Text to read. Line breaks become paragraph pauses."),
      voice_code: z.string().default(DEFAULT_VOICE).describe("Voice code from vbee_list_voices"),
      project: z
        .string()
        .optional()
        .describe(
          "HyperFrames project folder name in D:\\HyperFrames Projects; relative out_path is placed inside it",
        ),
      out_path: z
        .string()
        .optional()
        .describe(
          "Output file, absolute or relative to the project. Default assets/voice/vbee-<requestId>.<format>",
        ),
      output_format: z.enum(["mp3", "wav"]).default("mp3"),
      speed: z.number().min(0.25).max(1.9).default(1.0),
      bitrate: z
        .union([z.literal(8), z.literal(16), z.literal(32), z.literal(64), z.literal(128)])
        .default(128),
      sample_rate: z
        .union([8000, 16000, 22050, 24000, 32000, 44100, 48000].map((n) => z.literal(n)))
        .optional()
        .describe("Hz; default is the highest the voice supports"),
      emphasis_intensity: z
        .number()
        .int()
        .min(0)
        .max(100)
        .multipleOf(10)
        .optional()
        .describe("Emphasis 0-100 step 10, only some voices"),
      pauses: z
        .object({
          sentence: z.number().min(0.1).max(10).optional().describe("After '.', default 0.45s"),
          comma: z.number().min(0.1).max(10).optional().describe("After ',', default 0.25s"),
          semicolon: z.number().min(0.1).max(10).optional().describe("After ';', default 0.3s"),
          paragraph: z.number().min(0).max(10).optional().describe("Line break, default 0.6s"),
        })
        .optional(),
    },
  },
  async (a) => {
    try {
      const body = {
        text: a.text,
        voiceCode: a.voice_code,
        mode: "async",
        webhookUrl: WEBHOOK,
        outputFormat: a.output_format,
        bitrate: a.bitrate,
        speed: a.speed,
      };
      if (a.sample_rate) body.sampleRate = a.sample_rate;
      if (a.emphasis_intensity !== undefined) body.emphasisIntensity = a.emphasis_intensity;
      if (a.pauses) {
        const p = a.pauses;
        body.clientPause = Object.fromEntries(
          [
            ["sentenceBreak", p.sentence],
            ["mediumBreak", p.comma],
            ["majorBreak", p.semicolon],
            ["paragraphBreak", p.paragraph],
          ].filter(([, v]) => v !== undefined),
        );
      }
      const created = await callJson(`${API}/v1/tts`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const requestId = created.requestId;
      if (!requestId) throw new Error(`Vbee không trả requestId: ${JSON.stringify(created)}`);
      const done = await waitTts(requestId);
      const file = resolveOut(
        a.out_path || join("assets", "voice", `vbee-${requestId}.${a.output_format}`),
        a.project,
      );
      const bytes = await download(done.audioLink, file);
      return ok({ requestId, voice_code: a.voice_code, file, bytes });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "vbee_get_tts_request",
  {
    title: "Vbee: lấy lại kết quả TTS",
    description:
      "Check a Vbee TTS request by requestId and get a fresh audio link (links expire after 3 minutes; audio is kept 3 days). Pass out_path to download it again.",
    inputSchema: {
      request_id: z.string().min(1),
      project: z.string().optional(),
      out_path: z
        .string()
        .optional()
        .describe("Download the audio here when the request is COMPLETED"),
    },
  },
  async ({ request_id, project, out_path }) => {
    try {
      const r = await getTtsRequest(request_id);
      if (out_path && r.status === "COMPLETED" && r.audioLink) {
        const file = resolveOut(out_path, project);
        return ok({ ...r, file, bytes: await download(r.audioLink, file) });
      }
      return ok(r);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "vbee_speech_to_text",
  {
    title: "Vbee: giọng nói thành văn bản",
    description:
      "Transcribe a WAV file (< 100 MB) or a WAV URL with Vbee speech-to-text, wait for the result, and return the transcript with timed utterances. Optionally write an .srt next to it for captions. Convert other formats to WAV first (ffmpeg).",
    inputSchema: {
      file_path: z.string().optional().describe("Local .wav file (8000-48000 Hz)"),
      audio_url: z
        .string()
        .url()
        .optional()
        .describe("HTTP(S) URL of a .wav file, instead of file_path"),
      srt_path: z
        .string()
        .optional()
        .describe("Also save the utterances as SRT here (absolute, or relative to the WAV file)"),
    },
  },
  async ({ file_path, audio_url, srt_path }) => {
    try {
      if (!file_path && !audio_url) throw new Error("Cần file_path hoặc audio_url.");
      const form = new FormData();
      form.set("mode", "async");
      if (file_path) {
        const abs = resolve(file_path);
        if (extname(abs).toLowerCase() !== ".wav")
          throw new Error(
            "Vbee STT chỉ nhận WAV. Chuyển bằng: ffmpeg -i in.mp3 -ar 16000 -ac 1 out.wav",
          );
        form.set(
          "audioContent",
          new Blob([readFileSync(abs)], { type: "audio/wav" }),
          basename(abs),
        );
      } else {
        form.set("audioUrl", audio_url);
      }
      const created = await callJson(`${API}/v1/stt`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      const r = created.status === "COMPLETED" ? created : await waitStt(created.transcriptId);
      let srt;
      if (srt_path) {
        srt = isAbsolute(srt_path)
          ? srt_path
          : join(file_path ? dirname(resolve(file_path)) : PROJECTS_ROOT, srt_path);
        const cues = (r.utterances || []).map(
          (u, i) => `${i + 1}\n${srtTime(u.startTime)} --> ${srtTime(u.endTime)}\n${u.text}\n`,
        );
        mkdirSync(dirname(srt), { recursive: true });
        writeFileSync(srt, cues.join("\n"), "utf8");
      }
      return ok({ ...r, srt_file: srt });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
