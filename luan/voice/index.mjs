// One entry point for voice-over: picks Vbee or ElevenLabs, enforces the character budget,
// and supports a dry run that costs nothing.
import { BlockedError } from "../orchestrator/lib/pipeline.mjs";
import { settings } from "./config.mjs";
import * as elevenlabs from "./elevenlabs.mjs";
import * as vbee from "./vbee.mjs";

const PROVIDERS = { vbee, elevenlabs };

/** auto: Vbee first for Vietnamese (native voices), then ElevenLabs; null when neither is configured. */
export function pickProvider(requested = "auto") {
  const s = settings();
  const ready = {
    vbee: Boolean(s.vbee.appId && s.vbee.token),
    elevenlabs: Boolean(s.elevenlabs.apiKey),
  };
  if (requested !== "auto") {
    if (!PROVIDERS[requested])
      throw new Error(`Nhà cung cấp không hợp lệ: ${requested} (vbee | elevenlabs | auto)`);
    return { provider: requested, ready: ready[requested] };
  }
  const provider = ready.vbee ? "vbee" : ready.elevenlabs ? "elevenlabs" : null;
  return { provider, ready: Boolean(provider) };
}

export function status() {
  const s = settings();
  return {
    vbee: { configured: Boolean(s.vbee.appId && s.vbee.token), voice: s.vbee.voice },
    elevenlabs: {
      configured: Boolean(s.elevenlabs.apiKey),
      model: s.elevenlabs.model,
      voice: s.elevenlabs.voice || null,
    },
    maxChars: s.maxChars,
  };
}

/**
 * @param {{text:string,out:string,provider?:string,voice?:string,speed?:number,dryRun?:boolean,allowOverBudget?:boolean}} o
 * A dry run returns the plan and calls no paid API.
 */
export async function synthesize(o) {
  const { provider, ready } = pickProvider(o.provider || "auto");
  const chars = o.text.length;
  const { maxChars } = settings();
  const plan = { provider, chars, maxChars, out: o.out };
  if (o.dryRun) return { ...plan, dryRun: true };
  if (!provider || !ready) {
    throw new BlockedError(
      `Chưa cấu hình ${provider || "Vbee hoặc ElevenLabs"}: thêm key vào luan/.env.local (xem luan/.env.example)`,
    );
  }
  if (chars > maxChars && !o.allowOverBudget) {
    throw new BlockedError(
      `Văn bản ${chars} ký tự vượt giới hạn ${maxChars} (LUAN_TTS_MAX_CHARS); cần duyệt trước khi gọi API tính phí`,
    );
  }
  return PROVIDERS[provider].synthesize(o);
}

export function listVoices(provider) {
  return PROVIDERS[provider].listVoices();
}
