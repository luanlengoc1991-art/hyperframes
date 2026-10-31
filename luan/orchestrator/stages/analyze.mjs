// Stage 2 — Video Analysis. Measures each source with ffprobe and ffmpeg detectors only:
// metadata, shot boundaries, black and frozen spans, blur, silence, loudness and a contact
// sheet for visual review. It reports what was measured; it never guesses what was not.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireTool, run } from "../lib/proc.mjs";

const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

function fps(rate) {
  const [a, b] = String(rate || "0/1")
    .split("/")
    .map(Number);
  return b ? a / b : null;
}

async function probe(file) {
  const r = await run(requireTool("ffprobe"), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe không đọc được ${file}: ${r.stderr.slice(-300)}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = j.streams.find((s) => s.codec_type === "audio");
  const rotation = Number(
    v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0,
  );
  const turned = Math.abs(rotation) % 180 === 90;
  const width = v ? (turned ? v.height : v.width) : null;
  const height = v ? (turned ? v.width : v.height) : null;
  return {
    duration: round(Number(j.format.duration ?? v?.duration ?? a?.duration)),
    container: j.format.format_name,
    bitrateKbps: j.format.bit_rate ? Math.round(Number(j.format.bit_rate) / 1000) : null,
    video: v
      ? {
          codec: v.codec_name,
          width,
          height,
          fps: round(fps(v.avg_frame_rate) || fps(v.r_frame_rate)),
          rotation,
          orientation:
            width && height
              ? width > height
                ? "landscape"
                : width < height
                  ? "portrait"
                  : "square"
              : null,
          pixFmt: v.pix_fmt,
        }
      : null,
    audio: a
      ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels }
      : null,
  };
}

function spans(text, startRe, endRe, duration) {
  const starts = [...text.matchAll(startRe)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(endRe)].map((m) => Number(m[1]));
  return starts.map((s, i) => ({ start: round(s), end: round(ends[i] ?? duration) }));
}

const total = (list) => list.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);

function overlap(shot, list) {
  return list.reduce(
    (sum, s) => sum + Math.max(0, Math.min(shot.end, s.end) - Math.max(shot.start, s.start)),
    0,
  );
}

async function videoSignals(file, duration) {
  const vf =
    "scale=480:-2,scdet=threshold=10,blackdetect=d=0.3:pix_th=0.10,freezedetect=n=0.003:d=1,blurdetect";
  const r = await run(requireTool("ffmpeg"), [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-vf",
    vf,
    "-an",
    "-f",
    "null",
    "-",
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg không phân tích được hình: ${r.stderr.slice(-300)}`);
  const t = r.stderr;
  const cuts = [...t.matchAll(/lavfi\.scd\.time: ([\d.]+)/g)].map((m) => Number(m[1]));
  const black = [...t.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({
    start: round(Number(m[1])),
    end: round(Number(m[2])),
  }));
  const frozen = spans(t, /freeze_start: ([\d.]+)/g, /freeze_end: ([\d.]+)/g, duration);
  const blurMatch = /blur mean: ([\d.]+)/.exec(t);
  return { cuts, black, frozen, blurMean: blurMatch ? round(Number(blurMatch[1])) : null };
}

async function audioSignals(file, duration) {
  const af = "silencedetect=n=-40dB:d=0.6,ebur128=peak=true";
  const r = await run(requireTool("ffmpeg"), [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-vn",
    "-af",
    af,
    "-f",
    "null",
    "-",
  ]);
  if (r.code !== 0)
    throw new Error(`ffmpeg không phân tích được âm thanh: ${r.stderr.slice(-300)}`);
  const t = r.stderr;
  const summary = t.slice(t.lastIndexOf("Summary:"));
  const num = (re) => {
    const m = re.exec(summary);
    return m && m[1] !== "-inf" ? round(Number(m[1])) : null;
  };
  return {
    silence: spans(t, /silence_start: (-?[\d.]+)/g, /silence_end: (-?[\d.]+)/g, duration),
    integratedLufs: num(/I:\s+(-?[\d.]+|-inf) LUFS/),
    loudnessRangeLu: num(/LRA:\s+([\d.]+) LU/),
    truePeakDbtp: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/),
  };
}

async function contactSheet(file, duration, out) {
  const tiles = 20;
  const rate = duration > 0 ? tiles / duration : 1;
  const vf = `fps=${rate.toFixed(6)},scale=320:-2,tile=5x4:padding=4:color=black`;
  const r = await run(requireTool("ffmpeg"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    file,
    "-vf",
    vf,
    "-frames:v",
    "1",
    "-q:v",
    "4",
    out,
  ]);
  return r.code === 0 && existsSync(out) ? out : null;
}

function shotsOf(cuts, duration, black, frozen) {
  const bounds = [0];
  for (const c of cuts)
    if (c - bounds[bounds.length - 1] >= 0.25 && duration - c >= 0.25) bounds.push(c);
  bounds.push(duration);
  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const shot = { index: i + 1, start: round(bounds[i]), end: round(bounds[i + 1]) };
    shot.duration = round(shot.end - shot.start);
    const bad = overlap(shot, black) + overlap(shot, frozen);
    shot.usable = shot.duration >= 0.5 && bad / shot.duration < 0.5;
    if (!shot.usable)
      shot.reason = shot.duration < 0.5 ? "quá ngắn" : "chủ yếu là khung đen hoặc đứng hình";
    shots.push(shot);
  }
  return shots;
}

/** Analyse one ingested item; writes <analysisDir>/<id>/analysis.json and returns it. */
export async function analyzeItem(item, analysisDir) {
  const dir = join(analysisDir, item.id);
  mkdirSync(dir, { recursive: true });
  const result = { id: item.id, path: item.path, kind: item.kind };
  if (item.kind === "document") {
    result.role = "document";
  } else {
    Object.assign(result, await probe(item.path));
  }

  if (item.kind === "video" && result.video) {
    const vs = await videoSignals(item.path, result.duration);
    result.shots = shotsOf(vs.cuts, result.duration, vs.black, vs.frozen);
    result.black = vs.black;
    result.frozen = vs.frozen;
    result.blurMean = vs.blurMean;
    result.contactSheet = await contactSheet(item.path, result.duration, join(dir, "contact.jpg"));
  }
  if ((item.kind === "video" || item.kind === "audio") && result.audio) {
    Object.assign(result, await audioSignals(item.path, result.duration));
    result.speechRatio = result.duration
      ? round(1 - total(result.silence) / result.duration)
      : null;
  }

  const flags = [];
  if (result.duration && result.black?.length && total(result.black) / result.duration > 0.2)
    flags.push("nhiều khung đen");
  if (result.duration && result.frozen?.length && total(result.frozen) / result.duration > 0.3)
    flags.push("nhiều đoạn đứng hình");
  if (
    result.truePeakDbtp !== undefined &&
    result.truePeakDbtp !== null &&
    result.truePeakDbtp > -0.5
  )
    flags.push("âm thanh có thể bị vỡ (true peak > -0.5 dBTP)");
  if (
    result.integratedLufs !== undefined &&
    result.integratedLufs !== null &&
    result.integratedLufs < -35
  )
    flags.push("âm lượng rất nhỏ");
  if (item.kind === "video" && !result.audio) flags.push("không có tiếng");
  result.flags = flags;
  result.notMeasured =
    item.kind === "video"
      ? ["rung lắc (cần vidstab)", "nội dung hình (Claude xem contact sheet)"]
      : [];

  if (item.kind === "video") {
    // A candidate only: a transcript confirms speech; music under silent B-roll also clears silencedetect.
    const talky = result.audio && result.speechRatio >= 0.4 && (result.integratedLufs ?? -99) > -40;
    result.role = talky ? "a-roll-candidate" : "b-roll";
  } else if (item.kind === "audio") {
    result.role = result.duration > 20 ? "music" : "sfx";
  } else if (item.kind === "image") {
    result.role = "image";
  }

  writeFileSync(join(dir, "analysis.json"), JSON.stringify(result, null, 2));
  return result;
}
