// Voice provider settings. Secrets come from the environment or luan/.env.local (git-ignored);
// they never go into the repo or the desktop app.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// LUAN_ENV_FILE lets tests point at a scratch file instead of the real secrets.
export const ENV_FILE =
  process.env.LUAN_ENV_FILE || join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");

let loaded = false;
export function loadEnv(file = ENV_FILE) {
  if (loaded) return;
  loaded = true;
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

export function settings() {
  loadEnv();
  const e = process.env;
  return {
    vbee: {
      appId: e.VBEE_APP_ID || "",
      token: e.VBEE_TOKEN || "",
      api: (e.VBEE_API_BASE || "https://api.vbee.vn").replace(/\/+$/, ""),
      voice: e.VBEE_VOICE_CODE || "hn_female_ngochuyen_full_48k-fhg",
      // Batch TTS requires a webhook URL even when the result is polled.
      webhook: e.VBEE_WEBHOOK_URL || "https://example.com/vbee-webhook",
    },
    elevenlabs: {
      apiKey: e.ELEVENLABS_API_KEY || "",
      api: (e.ELEVENLABS_API_BASE || "https://api.elevenlabs.io").replace(/\/+$/, ""),
      // Vietnamese needs a v2.5/v3 model; eleven_multilingual_v2 does not list it.
      model: e.ELEVENLABS_MODEL || "eleven_turbo_v2_5",
      voice: e.ELEVENLABS_VOICE_ID || "",
    },
    // Cost guard: one call may not read more characters than this without an explicit override.
    maxChars: Number(e.LUAN_TTS_MAX_CHARS || 3000),
  };
}
