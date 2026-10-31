#!/usr/bin/env node
// LUAN AI Video Studio — production orchestrator (Phase 2, stages 1–3).
//
//   node luan/orchestrator/cli.mjs analyze --project <dir> --sources <path>[,<path>...] [--model small]
//   node luan/orchestrator/cli.mjs status  --project <dir>
//   node luan/orchestrator/cli.mjs voice-status
//   node luan/orchestrator/cli.mjs voices  --provider vbee|elevenlabs
//   node luan/orchestrator/cli.mjs voice   --text "..." | --text-file <f> --out <file.mp3>
//                                          [--provider auto|vbee|elevenlabs] [--voice <id>] [--dry-run]
//
// State lives in <project>/pipeline.json: a re-run skips finished work and resumes where it stopped.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pipeline } from "./lib/pipeline.mjs";
import { analyzeItem } from "./stages/analyze.mjs";
import { ingest } from "./stages/ingest.mjs";
import { writeReport } from "./stages/report.mjs";
import { transcribeItem } from "./stages/transcribe.mjs";
import * as voice from "../voice/index.mjs";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--"))
      out[argv[i].slice(2)] =
        argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

export async function analyze({ project, sources, model = "small", log = console.log }) {
  const projectDir = resolve(project);
  const analysisDir = join(projectDir, "analysis");
  mkdirSync(analysisDir, { recursive: true });
  const pipe = new Pipeline(projectDir);

  const ing = await pipe.stage("ingest", { sources, at: Date.now() }, async () => ingest(sources));
  const { items, skipped } = ing.output;
  log(`Nhập ${items.length} tư liệu (${skipped.length} file không phải media bị bỏ qua).`);

  const analyses = [];
  for (const item of items) {
    const r = await pipe.stage(`analyze:${item.id}`, { fp: item.fingerprint }, () =>
      analyzeItem(item, analysisDir),
    );
    log(
      `${r.skipped ? "Đã có" : "Phân tích"}: ${item.id} → ${r.output.role}${r.output.flags?.length ? ` (${r.output.flags.join("; ")})` : ""}`,
    );
    analyses.push(r.output);
  }

  const transcripts = {};
  for (const a of analyses.filter((x) => x.role === "a-roll-candidate")) {
    const item = items.find((i) => i.id === a.id);
    const r = await pipe.stage(`transcribe:${a.id}`, { fp: item.fingerprint, model }, () =>
      transcribeItem(item, analysisDir, { model }),
    );
    transcripts[a.id] = {
      status: r.status,
      output: r.output,
      error: pipe.state.stages[`transcribe:${a.id}`]?.error,
    };
    log(
      `Transcript ${a.id}: ${r.status}${r.status === "blocked" ? ` — ${transcripts[a.id].error}` : ""}`,
    );
  }

  writeReport(projectDir, analyses, transcripts, skipped);
  pipe.state.stages.report = {
    status: "done",
    finishedAt: new Date().toISOString(),
    output: { report: join(analysisDir, "footage-report.md") },
  };
  pipe.save();
  log(`Báo cáo: ${join(analysisDir, "footage-report.md")}`);
  return { pipeline: pipe.state, analyses, transcripts };
}

export function status(project) {
  return new Pipeline(resolve(project)).state;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  try {
    if (cmd === "analyze") {
      if (!a.project || !a.sources) throw new Error("Cần --project và --sources");
      await analyze({ project: a.project, sources: String(a.sources).split(","), model: a.model });
    } else if (cmd === "status") {
      if (!a.project) throw new Error("Cần --project");
      for (const [name, s] of Object.entries(status(a.project).stages))
        console.log(`${s.status.padEnd(8)} ${name}${s.error ? ` — ${s.error}` : ""}`);
    } else if (cmd === "voice-status") {
      console.log(JSON.stringify(voice.status(), null, 2));
    } else if (cmd === "voices") {
      if (!a.provider) throw new Error("Cần --provider vbee|elevenlabs");
      for (const v of await voice.listVoices(a.provider))
        console.log(`${v.id}\t${v.name}\t${v.gender ?? ""}\t${v.language ?? ""}`);
    } else if (cmd === "voice") {
      const text = a["text-file"] ? readFileSync(a["text-file"], "utf8") : a.text;
      if (!text || !a.out) throw new Error("Cần --text (hoặc --text-file) và --out");
      const r = await voice.synthesize({
        text: String(text),
        out: resolve(a.out),
        provider: a.provider || "auto",
        voice: a.voice,
        dryRun: Boolean(a["dry-run"]),
      });
      // Word timings (ElevenLabs) sit next to the audio for captions and ducking.
      if (r.words?.length) writeFileSync(`${r.file}.words.json`, JSON.stringify(r.words, null, 2));
      console.log(JSON.stringify({ ...r, words: r.words ? r.words.length : null }, null, 2));
    } else {
      console.log(
        "Lệnh: analyze | status | voice-status | voices --provider <p> | voice --text <t> --out <f> [--dry-run]",
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`${error.name === "BlockedError" ? "Chưa chạy được" : "Lỗi"}: ${error.message}`);
    process.exitCode = 1;
  }
}
