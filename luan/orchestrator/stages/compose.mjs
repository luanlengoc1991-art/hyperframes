// Stages 4–10 for talking-head footage: sentence-level Edit Decision List, non-destructive
// smart cut and a HyperFrames composition (footage clips trimmed with data-media-start,
// word-level captions, title and end card). Every cut stays editable: toggle `keep` in
// edl.json and compose again, or edit the composition in HyperFrames Studio.
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

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

/** Caption groups of up to 4 words in timeline time. */
export function captionGroups(clips) {
  const groups = [];
  for (const c of clips) {
    const words = c.rows
      .flatMap((r) => r.words)
      .filter((w) => w.start >= c.sourceIn - 0.01 && w.end <= c.sourceOut + 0.01)
      .map((w) => ({
        text: w.text,
        start: round(c.start + (w.start - c.sourceIn)),
        end: round(c.start + (w.end - c.sourceIn)),
      }));
    let g = [];
    for (const w of words) {
      g.push(w);
      if (g.length >= 4 || /[.,?!…]$/.test(w.text)) {
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
  try {
    linkSync(src, dest);
    return "hardlink";
  } catch {
    copyFileSync(src, dest);
    return "copy";
  }
}

function indexHtml({ width, height, duration, clips, footage }) {
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
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; background: #000; }
      .footage { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; object-fit: cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
${videos}
      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${duration}" data-track-index="2" data-track-kind="captions" data-width="${width}" data-height="${height}"></div>
      <div id="overlay" data-composition-id="overlay" data-composition-src="compositions/overlay.html" data-start="0" data-duration="${duration}" data-track-index="3" data-track-kind="graphics" data-width="${width}" data-height="${height}"></div>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

function captionsHtml({ width, height, groups, enabled }) {
  const items = enabled
    ? groups
        .map(
          (g, i) =>
            `      <div id="cap-${i + 1}" class="clip cap" data-start="${g.start}" data-duration="${round(g.end - g.start)}"><span class="box">${g.words
              .map((w, j) => `<span id="cap-${i + 1}-${j + 1}" class="w">${esc(w.text)}</span>`)
              .join(" ")}</span></div>`,
        )
        .join("\n")
    : "";
  // [selector, start, end] per word: the active word turns gold while it is spoken.
  const timings = enabled
    ? groups.flatMap((g, i) => g.words.map((w, j) => [`#cap-${i + 1}-${j + 1}`, w.start, w.end]))
    : [];
  const sets = `    const WORDS = ${JSON.stringify(timings)};
    for (const [sel, start, end] of WORDS) {
      tl.set(sel, { color: "#FFD45C" }, start);
      tl.set(sel, { color: "#FFFFFF" }, end);
    }`;
  return `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; }
    .cap {
      position: absolute; left: ${Math.round(width * 0.08)}px; right: ${Math.round(width * 0.08)}px; top: ${Math.round(height * 0.68)}px;
      text-align: center; font-family: "Montserrat", sans-serif; font-weight: 800; font-size: ${Math.round(width * 0.062)}px;
      line-height: 1.35; color: #fff;
    }
    /* A dark plate keeps the words readable on bright sky or water (WCAG AA on any footage). */
    .cap .box {
      display: inline; padding: 6px 18px; border-radius: 14px; background: rgba(0, 0, 0, 0.62);
      box-decoration-break: clone; -webkit-box-decoration-break: clone;
    }
  </style>
  <div id="root" data-composition-id="captions" data-width="${width}" data-height="${height}">
${items}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${sets}
    window.__timelines["captions"] = tl;
  </script>
</template>
`;
}

function overlayHtml({ width, height, duration, brief }) {
  const hasTitle = Boolean(brief.title);
  const endStart = round(Math.max(0, duration - 3.2));
  return `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; font-family: "Montserrat", sans-serif; }
    #ov-title { position: absolute; left: ${Math.round(width * 0.07)}px; right: ${Math.round(width * 0.07)}px; top: ${Math.round(height * 0.08)}px; }
    #ov-kicker { display: inline-block; padding: 10px 22px; background: #FFD45C; color: #111; font-weight: 800; letter-spacing: .14em; font-size: ${Math.round(width * 0.03)}px; text-transform: uppercase; }
    #ov-name { margin-top: 18px; color: #fff; font-weight: 800; font-size: ${Math.round(width * 0.078)}px; line-height: 1.15; text-shadow: 0 6px 22px rgba(0,0,0,.6); }
    #ov-sub { margin-top: 10px; color: #f1f1f1; font-weight: 600; font-size: ${Math.round(width * 0.036)}px; text-shadow: 0 4px 14px rgba(0,0,0,.6); }
    #ov-end { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,.82) 100%); }
    #ov-cta { position: absolute; left: 0; right: 0; bottom: ${Math.round(height * 0.12)}px; text-align: center; }
    #ov-cta-btn { display: inline-block; padding: 26px 56px; border-radius: 999px; background: #FFD45C; color: #111; font-weight: 800; font-size: ${Math.round(width * 0.05)}px; }
    #ov-hotline { margin-top: 22px; color: #fff; font-weight: 700; font-size: ${Math.round(width * 0.045)}px; letter-spacing: .04em; }
  </style>
  <div id="root" data-composition-id="overlay" data-width="${width}" data-height="${height}">
${
  hasTitle
    ? `    <div id="ov-title" class="clip" data-start="0.3" data-duration="3.2">
      <div id="ov-kicker">Dự án</div>
      <h1 id="ov-name">${esc(brief.title)}</h1>
      ${brief.subtitle ? `<p id="ov-sub">${esc(brief.subtitle)}</p>` : ""}
    </div>`
    : ""
}
    <div id="ov-end" class="clip" data-start="${endStart}" data-duration="${round(duration - endStart)}">
      <div id="ov-cta">
        <div id="ov-cta-btn">${esc(brief.cta || DEFAULT_BRIEF.cta)}</div>
        ${brief.hotline ? `<div id="ov-hotline">${esc(brief.hotline)}</div>` : ""}
      </div>
    </div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${
  hasTitle
    ? `    tl.fromTo("#ov-kicker", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.45, ease: "power3.out" }, 0.3);
    tl.fromTo("#ov-name", { opacity: 0, filter: "blur(10px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "power3.out" }, 0.45);
    tl.to(["#ov-kicker", "#ov-name"${brief.subtitle ? ', "#ov-sub"' : ""}], { opacity: 0, duration: 0.35, ease: "power2.in" }, 3.1);`
    : ""
}
    tl.fromTo("#ov-cta", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }, ${round(endStart + 0.2)});
    window.__timelines["overlay"] = tl;
  </script>
</template>
`;
}

/**
 * Compose <project>/composition from analysis/footage-report.json, transcripts and brief.json.
 * Keeps an existing edl.json (the editable cut) unless `rebuildEdl` is set.
 */
export function compose(projectDir, { rebuildEdl = false } = {}) {
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
  const { clips, duration } = clipsOf(edl);
  if (!clips.length) throw new Error("EDL không còn câu nào được giữ");

  const comp = join(projectDir, "composition");
  mkdirSync(join(comp, "assets", "footage"), { recursive: true });
  mkdirSync(join(comp, "compositions"), { recursive: true });
  const footage = {};
  const linked = {};
  for (const id of new Set(clips.map((c) => c.source))) {
    const item = report.items.find((a) => a.id === id);
    const rel = `assets/footage/${id}${extname(item.path).toLowerCase()}`;
    linked[id] = linkOrCopy(item.path, join(comp, rel));
    footage[id] = rel;
  }
  const first = report.items.find((a) => a.id === clips[0].source);
  const width = first.video?.width || 1080;
  const height = first.video?.height || 1920;
  const groups = captionGroups(clips);

  writeFileSync(join(comp, "index.html"), indexHtml({ width, height, duration, clips, footage }));
  writeFileSync(
    join(comp, "compositions", "captions.html"),
    captionsHtml({ width, height, groups, enabled: brief.captions }),
  );
  writeFileSync(
    join(comp, "compositions", "overlay.html"),
    overlayHtml({ width, height, duration, brief }),
  );
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
    duration,
    rows: edl,
    clips: clips.map(({ rows, ...c }) => ({ ...c, sentences: rows.length })),
  };
  writeFileSync(edlPath, JSON.stringify(edlOut, null, 2));
  return {
    composition: comp,
    duration,
    clips: clips.length,
    captions: groups.length,
    sentences: edl.length,
    kept: edl.filter((r) => r.keep).length,
    width,
    height,
    linked,
  };
}
