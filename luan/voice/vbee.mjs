// Vbee adapter (Vietnamese TTS). Same endpoints as mcp/vbee/server.mjs, as a library:
// POST /v1/tts (async) → poll /v1/tts/requests/:id → download audioLink.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BlockedError } from "../orchestrator/lib/pipeline.mjs";
import { settings } from "./config.mjs";

const VOICES_API = "https://vbee.vn/api/public/v1/voices";

function creds() {
  const s = settings().vbee;
  if (!s.appId || !s.token)
    throw new BlockedError("Thiếu VBEE_APP_ID / VBEE_TOKEN trong luan/.env.local");
  return s;
}

async function json(url, init, timeoutMs = 60_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  if (!res.ok) throw new Error(`Vbee ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

export async function listVoices({ language = "vi-VN" } = {}) {
  const url = `${VOICES_API}?language_code=${encodeURIComponent(language)}&limit=100`;
  const j = await json(url, {});
  const list = j.result?.voices || j.voices || j.result || [];
  return list.map((v) => ({
    id: v.code,
    name: v.name,
    gender: v.gender,
    language: v.languageCode || language,
  }));
}

/**
 * Synthesise `text` to `out` (mp3/wav). Returns { file, provider, voice, requestId, chars }.
 * `pollMs`/`timeoutMs` exist for tests.
 */
export async function synthesize({
  text,
  out,
  voice,
  speed = 1,
  format = "mp3",
  pollMs = 3000,
  timeoutMs = 600_000,
}) {
  const s = creds();
  const headers = {
    Authorization: `Bearer ${s.token}`,
    "App-Id": s.appId,
    "Content-Type": "application/json",
  };
  const body = {
    text,
    voiceCode: voice || s.voice,
    mode: "async",
    webhookUrl: s.webhook,
    outputFormat: format,
    bitrate: 128,
    speed,
  };
  const created = await json(`${s.api}/v1/tts`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const requestId = created.requestId || created.result?.requestId;
  if (!requestId)
    throw new Error(`Vbee không trả requestId: ${JSON.stringify(created).slice(0, 300)}`);

  const start = Date.now();
  let done;
  for (;;) {
    const r = await json(`${s.api}/v1/tts/requests/${encodeURIComponent(requestId)}`, { headers });
    const st = r.result || r;
    if (st.status === "COMPLETED" && st.audioLink) {
      done = st;
      break;
    }
    if (st.status === "FAILED")
      throw new Error(`Vbee báo thất bại: ${st.error_message || st.error_code || "FAILED"}`);
    if (Date.now() - start > timeoutMs)
      throw new Error(`Vbee: hết thời gian chờ request ${requestId}`);
    await new Promise((r2) => setTimeout(r2, pollMs));
  }

  const audio = await fetch(done.audioLink, { signal: AbortSignal.timeout(120_000) });
  if (!audio.ok) throw new Error(`Tải audio Vbee thất bại: ${audio.status}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(await audio.arrayBuffer()));
  return {
    file: out,
    provider: "vbee",
    voice: body.voiceCode,
    requestId,
    chars: text.length,
    words: null,
  };
}
