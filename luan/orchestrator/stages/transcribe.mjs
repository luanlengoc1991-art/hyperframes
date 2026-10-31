// Stage 3 — Speech transcription, reusing `hyperframes transcribe` (whisper, word timestamps).
// Parakeet does not cover Vietnamese, so whisper's multilingual model is forced with --language.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BlockedError } from "../lib/pipeline.mjs";
import { findTool, hyperframes } from "../lib/proc.mjs";

export function whisperAvailable() {
  return findTool("whisper-cli") !== null;
}

/** Transcribe one clip into <analysisDir>/<id>/transcript.json; returns a summary. */
export async function transcribeItem(item, analysisDir, { language = "vi", model = "small" } = {}) {
  if (!whisperAvailable()) {
    throw new BlockedError(
      "Chưa có whisper-cli: cài bản build sẵn của whisper.cpp cho Windows và thêm vào PATH, rồi chạy lại. Parakeet không hỗ trợ tiếng Việt.",
    );
  }
  const dir = join(analysisDir, item.id);
  const r = await hyperframes(
    [
      "transcribe",
      item.path,
      "--language",
      language,
      "--model",
      model,
      "--dir",
      dir,
      "--json",
      "--no-runtime-install",
    ],
    { cwd: dir },
  );
  const out = join(dir, "transcript.json");
  if (r.code !== 0 || !existsSync(out))
    throw new Error(`transcribe lỗi: ${(r.stderr || r.stdout).slice(-400)}`);
  const words = JSON.parse(readFileSync(out, "utf8"));
  const list = Array.isArray(words) ? words : words.words || [];
  return {
    transcript: out,
    words: list.length,
    text: list
      .map((w) => w.text ?? w.word)
      .join(" ")
      .slice(0, 400),
  };
}
