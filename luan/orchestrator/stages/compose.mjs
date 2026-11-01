// Stages 4–10 for talking-head footage: sentence-level Edit Decision List, non-destructive
// smart cut and a HyperFrames composition: footage clips trimmed with data-media-start, the
// motion layer from story.json (hook, cards, full screens, stats, badges, end card, chapter
// bar), keyword captions, music and sound effects. Every cut stays editable: toggle `keep` in
// edl.json, move beats in story.json, then compose again.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { BlockedError } from "../lib/pipeline.mjs";
import { findTool } from "../lib/proc.mjs";
import { libraryAvailable, listSounds, pickSound, soundPath } from "../lib/sounds.mjs";
import {
  captionsHtml,
  chaptersOf,
  correctText,
  introLength,
  motionHtml,
  musicAutomation,
  outroLength,
  planBeats,
  resolveBeats,
  retimeWords,
  rowTimes,
  sanitizeStory,
  soundCues,
} from "./motion.mjs";

const sha = (s) => createHash("sha1").update(s).digest("hex");
const round = (n) => Math.round(n * 1000) / 1000;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const FILLERS = new Set(["à", "ờ", "ừ", "ừm", "ơ", "uhm", "um", "uh"]);
const PAD_IN = 0.12;
const PAD_OUT = 0.25;

export const DEFAULT_BRIEF = {
  title: "",
  subtitle: "",
  cta: "Liên hệ tư vấn",
  hotline: "",
  targetDuration: null,
  captions: true,
  corrections: [],
  quality: "standard",
};

const MAX_WORDS = 24;
const MAX_SECONDS = 9;
const PAUSE_SPLIT = 0.45;

/**
 * Split a word transcript into editable sentences: at . ? !, at a pause longer than
 * PAUSE_SPLIT, and never longer than MAX_WORDS / MAX_SECONDS (ASR often skips punctuation).
 * Filler words and ASR hallucinations (one letter repeated 5+ times) are dropped.
 */
export function sentencesOf(words) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (const w of words) {
    const bare = w.text
      .toLowerCase()
      .replace(/[.,!?…]/g, "")
      .trim();
    if (!bare || FILLERS.has(bare) || /(.)\1{4,}/u.test(bare)) continue;
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > PAUSE_SPLIT) flush();
    cur.push(w);
    const long = cur.length >= MAX_WORDS || w.end - cur[0].start >= MAX_SECONDS;
    if (/[.?!…]$/.test(w.text) || long) flush();
  }
  flush();
  return out;
}

/** Edit Decision List: one row per sentence of every A-roll clip, in source order. */
export function buildEdl(items, transcripts, brief = DEFAULT_BRIEF) {
  const rows = [];
  for (const item of items) {
    const words = transcripts[item.id];
    if (!words?.length) continue;
    const sentences = sentencesOf(words);
    sentences.forEach((s, i) => {
      const next = sentences[i + 1];
      const sourceIn = Math.max(0, s[0].start - PAD_IN);
      let sourceOut = Math.min(item.duration, s[s.length - 1].end + PAD_OUT);
      if (next) sourceOut = Math.min(sourceOut, next[0].start - 0.02);
      rows.push({
        id: `${item.id}#${i + 1}`,
        source: item.id,
        sourceIn: round(sourceIn),
        sourceOut: round(Math.max(sourceOut, sourceIn + 0.2)),
        text: s.map((w) => w.text).join(" "),
        words: s.map((w) => ({ text: w.text, start: w.start, end: w.end })),
        keep: true,
        reason: "câu nói trọn vẹn; đã bỏ khoảng lặng trước/sau và từ đệm",
      });
    });
  }
  // Over the target length: keep sentences in order until the budget is used (Claude refines).
  if (brief.targetDuration) {
    let used = 0;
    for (const r of rows) {
      const d = r.sourceOut - r.sourceIn;
      if (used + d > brief.targetDuration + 0.5) {
        r.keep = false;
        r.reason = `vượt thời lượng mục tiêu ${brief.targetDuration}s`;
      } else used += d;
    }
  }
  return rows;
}

/** Kept rows → timeline clips; consecutive rows of one source that touch become one clip. */
export function clipsOf(edl) {
  const clips = [];
  let t = 0;
  for (const r of edl.filter((x) => x.keep)) {
    const last = clips[clips.length - 1];
    if (last && last.source === r.source && r.sourceIn - last.sourceOut < 0.08) {
      last.sourceOut = r.sourceOut;
      last.rows.push(r);
    } else {
      clips.push({ source: r.source, sourceIn: r.sourceIn, sourceOut: r.sourceOut, rows: [r] });
    }
  }
  for (const c of clips) {
    c.start = round(t);
    c.duration = round(c.sourceOut - c.sourceIn);
    t += c.duration;
  }
  return { clips, duration: round(t) };
}

/**
 * Caption groups of up to 6 words in timeline time. A row whose text was edited
 * (`captionText`) or matches a brief correction gets its words re-timed over the spoken span.
 */
export function captionGroups(clips, { corrections = [], offset = 0 } = {}) {
  const groups = [];
  for (const c of clips) {
    const words = c.rows
      .flatMap((r) => {
        const fixed = r.captionText || correctText(r.text, corrections);
        return fixed ? retimeWords(fixed, r.words) : r.words;
      })
      .filter((w) => w.start >= c.sourceIn - 0.01 && w.end <= c.sourceOut + 0.01)
      .map((w) => ({
        text: w.text,
        start: round(offset + c.start + (w.start - c.sourceIn)),
        end: round(offset + c.start + (w.end - c.sourceIn)),
      }));
    let g = [];
    for (const w of words) {
      g.push(w);
      if (g.length >= 6 || /[.,?!…]$/.test(w.text)) {
        groups.push(g);
        g = [];
      }
    }
    if (g.length) groups.push(g);
  }
  // Hold each group until the next one starts (short gaps), never past the clip.
  return groups.map((g, i) => {
    const next = groups[i + 1];
    const end =
      next && next[0].start - g[g.length - 1].end < 0.6 ? next[0].start : g[g.length - 1].end + 0.3;
    return { words: g, start: g[0].start, end: round(end) };
  });
}

function linkOrCopy(src, dest) {
  if (existsSync(dest)) return "existing";
  mkdirSync(dirname(dest), { recursive: true });
  try {
    linkSync(src, dest);
    return "hardlink";
  } catch {
    copyFileSync(src, dest);
    return "copy";
  }
}

const durations = new Map();
function mediaDuration(file) {
  if (durations.has(file)) return durations.get(file);
  let d = null;
  const ffprobe = findTool("ffprobe");
  if (ffprobe) {
    try {
      const out = execFileSync(
        ffprobe,
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
        { encoding: "utf8", windowsHide: true },
      );
      d = Number.parseFloat(out) || null;
    } catch {
      d = null;
    }
  }
  durations.set(file, d);
  return d;
}

/** No bed chosen: the first track (in a stable order) long enough for the whole film. */
function chooseMusic(total) {
  const first = pickSound("music", "default");
  if (!first) return null;
  const pool = listSounds().filter((s) => s.role === "music");
  const i0 = pool.findIndex((s) => s.rel === first.rel);
  for (let k = 0; k < Math.min(pool.length, 24); k++) {
    const s = pool[(i0 + k) % pool.length];
    const d = mediaDuration(soundPath(s.rel));
    if (d && d >= total + 1) return s.rel;
  }
  return first.rel;
}

/** The part of a volume envelope that falls inside one clip, in that clip's own time. */
export function sliceAutomation(auto, start, dur) {
  const pts = auto.lanes[0].points;
  const at = (t) => {
    if (t <= pts[0].t) return pts[0].v;
    for (let i = 1; i < pts.length; i++)
      if (t <= pts[i].t) {
        const a = pts[i - 1];
        const b = pts[i];
        return round(a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t || 1));
      }
    return pts[pts.length - 1].v;
  };
  const inner = pts
    .filter((p) => p.t > start && p.t < start + dur)
    .map((p) => ({ t: round(p.t - start), v: p.v }));
  return {
    version: 1,
    lanes: [
      {
        target: "volume",
        points: [{ t: 0, v: at(start) }, ...inner, { t: round(dur), v: at(start + dur) }],
      },
    ],
  };
}

/** A still from the footage, used behind the hook when the project has no images. */
function posterFrame(src, at, out) {
  if (existsSync(out)) return true;
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) return false;
  mkdirSync(dirname(out), { recursive: true });
  try {
    execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-ss",
        String(at),
        "-i",
        src,
        "-frames:v",
        "1",
        "-vf",
        "scale=1080:-2",
        "-q:v",
        "3",
        out,
      ],
      { windowsHide: true },
    );
    return existsSync(out);
  } catch {
    return false;
  }
}

const assetName = (rel) =>
  `${slug(
    rel
      .split("/")
      .pop()
      .replace(/\.\w+$/, ""),
  ).slice(0, 40)}-${sha(rel).slice(0, 6)}`;
const slug = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60);

function indexHtml({ width, height, duration, clips, footage, audio }) {
  const videos = clips
    .map(
      (c, i) => `      <video
        id="clip-${i + 1}"
        class="clip footage"
        src="${esc(footage[c.source])}"
        data-start="${c.start}"
        data-duration="${c.duration}"
        data-media-start="${c.sourceIn}"
        data-track-index="0"
        data-has-audio="true"
        playsinline
      ></video>`,
    )
    .join("\n");
  const audios = audio
    .map(
      (a) =>
        `      <audio id="${a.id}" class="clip" src="${esc(a.src)}" data-start="${a.start}" data-duration="${a.duration}" data-track-index="${a.track}"${a.automation ? ` data-automation="${esc(JSON.stringify(a.automation))}"` : ` data-volume="${a.volume}"`} data-fade-in="${a.fadeIn ?? 0.02}" data-fade-out="${a.fadeOut ?? 0.3}"></audio>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #0c0e11; }
      #root { position: relative; width: 100%; height: 100%; background: #0c0e11; }
      .footage { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; object-fit: cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
${videos}
      <div id="motion" data-composition-id="motion" data-composition-src="compositions/motion.html" data-start="0" data-duration="${duration}" data-track-index="2" data-track-kind="graphics" data-width="${width}" data-height="${height}"></div>
      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${duration}" data-track-index="3" data-track-kind="captions" data-width="${width}" data-height="${height}"></div>
${audios}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

// Files compose writes are recorded by hash; one changed since (in Studio or by hand) is not
// overwritten unless the caller forces it, so manual work is never lost silently.
const GENERATED = ".luan-generated.json";

function guardedWriter(comp, force) {
  const recordFile = join(comp, GENERATED);
  const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf8")) : {};
  const pending = [];
  return {
    add(rel, content) {
      pending.push([rel, content]);
    },
    commit() {
      const edited = pending
        .map(([rel]) => rel)
        .filter((rel) => {
          const f = join(comp, rel);
          return existsSync(f) && record[rel] && sha(readFileSync(f, "utf8")) !== record[rel];
        });
      if (edited.length && !force)
        throw new BlockedError(
          `Composition đã được sửa tay (${edited.join(", ")}). Dựng lại sẽ ghi đè các sửa đổi đó — chọn "Ghi đè" nếu muốn.`,
        );
      for (const [rel, content] of pending) {
        mkdirSync(dirname(join(comp, rel)), { recursive: true });
        writeFileSync(join(comp, rel), content);
        record[rel] = sha(content);
      }
      writeFileSync(recordFile, JSON.stringify(record, null, 2));
      return edited;
    },
  };
}

export function readStory(projectDir) {
  const f = join(projectDir, "story.json");
  return existsSync(f) ? sanitizeStory(JSON.parse(readFileSync(f, "utf8"))) : null;
}

/**
 * Compose <project>/composition from analysis/footage-report.json, transcripts, brief.json and
 * story.json (a rule-based first storyboard is written when there is none). Keeps an existing
 * edl.json (the editable cut) unless `rebuildEdl` is set.
 */
export function compose(
  projectDir,
  { rebuildEdl = false, replanStory = false, force = false } = {},
) {
  const report = JSON.parse(
    readFileSync(join(projectDir, "analysis", "footage-report.json"), "utf8"),
  );
  const briefPath = join(projectDir, "brief.json");
  const brief = {
    ...DEFAULT_BRIEF,
    ...(existsSync(briefPath) ? JSON.parse(readFileSync(briefPath, "utf8")) : {}),
  };
  if (!existsSync(briefPath)) writeFileSync(briefPath, JSON.stringify(brief, null, 2));

  const aroll = report.items.filter((a) => a.kind === "video" && a.role === "a-roll-candidate");
  const transcripts = {};
  for (const a of aroll) {
    const f = join(projectDir, "analysis", a.id, "transcript.json");
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, "utf8"));
      transcripts[a.id] = Array.isArray(j) ? j : j.words;
    }
  }
  if (!Object.keys(transcripts).length)
    throw new Error("Chưa có transcript nào: chạy analyze trước");

  const edlPath = join(projectDir, "edl.json");
  const edl =
    !rebuildEdl && existsSync(edlPath)
      ? JSON.parse(readFileSync(edlPath, "utf8")).rows
      : buildEdl(aroll, transcripts, brief);
  const { clips, duration: footage } = clipsOf(edl);
  if (!clips.length) throw new Error("EDL không còn câu nào được giữ");

  // Storyboard: the saved one, or a rule-based first draft placed on the sentences.
  let story = replanStory ? null : readStory(projectDir);
  if (!story) {
    const starts = rowTimes(clips, 0);
    const kept = edl.filter((r) => r.keep);
    story = planBeats({
      rows: kept,
      rowStart: Object.fromEntries(Object.entries(starts).map(([k, v]) => [k, v.start])),
      brief,
    });
    writeFileSync(join(projectDir, "story.json"), JSON.stringify(story, null, 2));
  }
  const intro = introLength(story);
  const outro = outroLength(story);
  const total = round(intro + footage + outro);

  const comp = join(projectDir, "composition");
  mkdirSync(join(comp, "assets", "footage"), { recursive: true });
  const footageRel = {};
  const linked = {};
  for (const id of new Set(clips.map((c) => c.source))) {
    const item = report.items.find((a) => a.id === id);
    const rel = `assets/footage/${id}${extname(item.path).toLowerCase()}`;
    linked[id] = linkOrCopy(item.path, join(comp, rel));
    footageRel[id] = rel;
  }
  // Project images (renders, maps, logos) are available to beats by their media id.
  const images = {};
  for (const img of report.items.filter((a) => a.kind === "image")) {
    const rel = `assets/images/${img.id}${extname(img.path).toLowerCase()}`;
    linkOrCopy(img.path, join(comp, rel));
    images[img.id] = rel;
  }
  const firstItem = report.items.find((a) => a.id === clips[0].source);
  // Stills from different moments of the footage, one per hook / full screen without an image.
  const needPosters = Math.min(
    8,
    story.beats.filter(
      (b) => (b.type === "hook" || b.type === "full") && !(b.image && images[b.image]),
    ).length,
  );
  const posters = [];
  for (let i = 0; i < needPosters; i++) {
    const f = (i + 0.5) / needPosters;
    let t = f * footage;
    const c = clips.find((x) => t < x.start + x.duration) || clips[clips.length - 1];
    t = Math.min(c.duration - 0.1, Math.max(0, t - c.start));
    const item = report.items.find((a) => a.id === c.source);
    const at = round(c.sourceIn + t);
    const rel = `assets/images/poster-${c.source.slice(-6)}-${Math.round(at * 10)}.jpg`;
    if (posterFrame(item.path, at, join(comp, rel))) posters.push(rel);
  }

  const width = firstItem.video?.width || 1080;
  const height = firstItem.video?.height || 1920;
  const timelineClips = clips.map((c) => ({ ...c, start: round(c.start + intro) }));
  const groups = captionGroups(clips, { corrections: brief.corrections || [], offset: intro });
  const beats = resolveBeats(story, rowTimes(clips, intro), { intro, footage });
  let posterIndex = 0;
  for (const b of beats)
    if ((b.type === "hook" || b.type === "full") && !(b.image && images[b.image]) && posters.length)
      b.poster = posters[posterIndex++ % posters.length];
  const chapters = chaptersOf(beats, intro, footage);
  const keywords = [
    ...story.keywords,
    ...beats.flatMap((b) => [b.title, b.accent].filter(Boolean)),
  ];

  // Sound: music bed ducked under speech, one effect per beat, from the local library.
  const audio = [];
  const sounds = { music: null, sfx: 0 };
  if (libraryAvailable()) {
    if (story.music.enabled) {
      const rel = story.music.rel || chooseMusic(total);
      const src = rel && soundPath(rel);
      if (src && existsSync(src)) {
        const dest = `assets/music/${assetName(rel)}${extname(src).toLowerCase()}`;
        linkOrCopy(src, join(comp, dest));
        const len = mediaDuration(src) || total;
        const auto = musicAutomation({ intro, footage, total, volume: story.music.volume });
        // A bed shorter than the film repeats, each pass crossfading 1 s into the next.
        const XF = 1;
        for (let k = 0, at = 0; at < total - 0.05 && k < 20; k++, at += len - XF) {
          const dur = round(Math.min(len, total - at));
          audio.push({
            id: k ? `music-${k + 1}` : "music",
            src: dest,
            start: round(at),
            duration: dur,
            track: 5 + (k % 2 ? -1 : 0),
            automation: sliceAutomation(auto, at, dur),
            fadeIn: k ? XF : 0.4,
            fadeOut: at + len >= total - 0.05 ? 1.5 : XF,
          });
        }
        sounds.music = rel;
      }
    }
    if (story.sfx.enabled) {
      soundCues(beats, { total }).forEach((c, i) => {
        const pick = pickSound(c.role, c.seed);
        const src = pick && soundPath(pick.rel);
        if (!src || !existsSync(src)) return;
        const dest = `assets/sfx/${assetName(pick.rel)}${extname(src).toLowerCase()}`;
        linkOrCopy(src, join(comp, dest));
        const len = mediaDuration(src) || c.duration;
        audio.push({
          id: `sfx-${i + 1}`,
          src: dest,
          start: c.start,
          duration: round(Math.max(0.2, Math.min(c.duration, len))),
          track: 6 + (i % 3),
          volume: round(Math.min(1, c.volume * (story.sfx.volume / 0.5))),
          fadeOut: 0.25,
        });
        sounds.sfx++;
      });
    }
  }

  const out = guardedWriter(comp, force);
  out.add(
    "index.html",
    indexHtml({ width, height, duration: total, clips: timelineClips, footage: footageRel, audio }),
  );
  out.add(
    "compositions/captions.html",
    captionsHtml({
      width,
      height,
      groups,
      enabled: brief.captions,
      keywords,
      accent: story.theme.accent,
    }),
  );
  out.add(
    "compositions/motion.html",
    motionHtml({
      width,
      height,
      duration: total,
      intro,
      footage,
      beats,
      chapters,
      theme: story.theme,
      images,
    }),
  );
  const overwritten = out.commit();
  const legacy = join(comp, "compositions", "overlay.html");
  if (existsSync(legacy)) unlinkSync(legacy);
  if (!existsSync(join(comp, "hyperframes.json"))) {
    const config = {
      $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
      registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
      paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
      media: { autoProxy: true },
    };
    writeFileSync(join(comp, "hyperframes.json"), JSON.stringify(config, null, 2));
  }

  const edlOut = {
    generatedAt: new Date().toISOString(),
    duration: footage,
    total,
    intro,
    rows: edl,
    clips: clips.map(({ rows, ...c }) => ({ ...c, sentences: rows.length })),
  };
  writeFileSync(edlPath, JSON.stringify(edlOut, null, 2));
  writeFileSync(
    join(projectDir, "timeline.json"),
    JSON.stringify(
      {
        total,
        intro,
        footage,
        outro,
        clips: timelineClips.map(({ rows, ...c }) => ({ ...c, rows: rows.map((r) => r.id) })),
        rows: rowTimes(clips, intro),
        beats,
        chapters,
        captions: groups.map((g) => ({
          start: g.start,
          end: g.end,
          text: g.words.map((w) => w.text).join(" "),
        })),
        audio: audio.map((a) => ({ id: a.id, src: a.src, start: a.start, duration: a.duration })),
      },
      null,
      2,
    ),
  );
  return {
    composition: comp,
    duration: total,
    footage,
    clips: clips.length,
    captions: groups.length,
    beats: beats.filter((b) => !b.hidden).length,
    sentences: edl.length,
    kept: edl.filter((r) => r.keep).length,
    music: sounds.music,
    sfx: sounds.sfx,
    overwritten,
    width,
    height,
    linked,
  };
}
