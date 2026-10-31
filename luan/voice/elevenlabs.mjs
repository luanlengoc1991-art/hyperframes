// ElevenLabs adapter over REST (no Python SDK). Uses /with-timestamps so word timings come
// back with the audio and no transcription pass is needed for captions or ducking.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BlockedError } from "../orchestrator/lib/pipeline.mjs";
import { settings } from "./config.mjs";

function creds() {
  const s = settings().elevenlabs;
  if (!s.apiKey) throw new BlockedError("Thiếu ELEVENLABS_API_KEY trong luan/.env.local");
  return s;
}

export async function listVoices() {
  const s = creds();
  const res = await fetch(`${s.api}/v1/voices`, {
    headers: { "xi-api-key": s.apiKey },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return (j.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    gender: v.labels?.gender,
    language: v.labels?.language || v.fine_tuning?.language,
  }));
}

/** Character alignment → [{text,start,end}] words, splitting on whitespace. */
export function wordsFromAlignment(al) {
  if (!al?.characters?.length) return [];
  const words = [];
  let cur = null;
  al.characters.forEach((ch, i) => {
    const start = al.character_start_times_seconds[i];
    const end = al.character_end_times_seconds[i];
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    if (!cur) cur = { text: ch, start, end };
    else {
      cur.text += ch;
      cur.end = end;
    }
  });
  if (cur) words.push(cur);
  return words.map((w) => ({
    text: w.text,
    start: Math.round(w.start * 1000) / 1000,
    end: Math.round(w.end * 1000) / 1000,
  }));
}

export async function synthesize({ text, out, voice, speed = 1, language = "vi" }) {
  const s = creds();
  const voiceId = voice || s.voice;
  if (!voiceId)
    throw new BlockedError(
      "Chưa chọn giọng ElevenLabs: đặt ELEVENLABS_VOICE_ID hoặc truyền --voice",
    );
  const body = {
    text,
    model_id: s.model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed },
  };
  // language_code is accepted by the v2.5 / v3 models; harmless to omit for the rest.
  if (/v2_5|v3/.test(s.model)) body.language_code = language;
  const res = await fetch(
    `${s.api}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": s.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(j.audio_base64, "base64"));
  return {
    file: out,
    provider: "elevenlabs",
    voice: voiceId,
    model: s.model,
    chars: text.length,
    words: wordsFromAlignment(j.normalized_alignment || j.alignment),
  };
}
