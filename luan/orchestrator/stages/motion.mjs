// Motion design layer: the storyboard (story.json) of "beats" that sit on top of the footage —
// opening hook stats, info cards, full-screen interstitials, stat tables, corner badges and the
// end card — plus the chapter bar, keyword captions and the sound design that goes with them.
// Beats anchor to an EDL sentence (`row` + `offset`), so they follow the speech when the cut changes.

export const DEFAULT_THEME = { accent: "#D2FF3C", brand: "" };
export const BEAT_TYPES = ["hook", "card", "full", "stats", "badge", "outro"];
export const DEFAULT_DURATION = {
  hook: 2.6,
  card: 3.6,
  full: 3.2,
  stats: 4.2,
  badge: 4,
  outro: 3.6,
};

const round = (n) => Math.round(n * 1000) / 1000;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const str = (v, max = 80) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, max));

// ---------- story ----------

export function emptyStory() {
  return {
    version: 1,
    theme: { ...DEFAULT_THEME },
    keywords: [],
    music: { enabled: true, rel: null, volume: 0.5 },
    sfx: { enabled: true, volume: 0.5 },
    beats: [],
  };
}

/** Clean a story from the editor or from Claude: known types, bounded text, real rows only. */
export function sanitizeStory(input, { rowIds = null } = {}) {
  const base = emptyStory();
  const s = input && typeof input === "object" ? input : {};
  const theme = { ...base.theme, ...(s.theme || {}) };
  if (!/^#[0-9a-f]{6}$/i.test(theme.accent)) theme.accent = DEFAULT_THEME.accent;
  theme.brand = str(theme.brand, 40);
  const beats = [];
  let n = 0;
  for (const b of Array.isArray(s.beats) ? s.beats : []) {
    if (!b || !BEAT_TYPES.includes(b.type)) continue;
    const out = {
      id: /^[a-z0-9-]{1,24}$/i.test(b.id || "") ? b.id : `b${Date.now().toString(36)}${n}`,
      type: b.type,
    };
    n++;
    if (b.type !== "hook" && b.type !== "outro") {
      if (b.row && (!rowIds || rowIds.has(b.row))) out.row = String(b.row);
      else if (Number.isFinite(b.at)) out.at = Math.max(0, round(b.at));
      else continue;
      out.offset = round(Number.isFinite(b.offset) ? b.offset : 0);
    }
    out.duration = round(
      Math.min(30, Math.max(0.8, Number(b.duration) || DEFAULT_DURATION[b.type])),
    );
    for (const k of [
      "chapter",
      "index",
      "kicker",
      "title",
      "accent",
      "note",
      "label",
      "sub",
      "image",
    ])
      if (b[k]) out[k] = str(b[k], k === "sub" || k === "label" ? 120 : 60);
    if (b.stat && (b.stat.value || b.stat.value === 0))
      out.stat = {
        value: str(b.stat.value, 16),
        unit: str(b.stat.unit, 10),
        label: str(b.stat.label, 60),
      };
    if (Array.isArray(b.dates))
      out.dates = b.dates
        .slice(0, 3)
        .filter((d) => d?.value)
        .map((d) => ({ label: str(d.label, 40), value: str(d.value, 20) }));
    if (Array.isArray(b.bullets))
      out.bullets = b.bullets
        .slice(0, 5)
        .map((x) => str(x, 40))
        .filter(Boolean);
    if (Array.isArray(b.rows))
      out.rows = b.rows
        .slice(0, 4)
        .filter((r) => r?.value)
        .map((r) => ({ value: str(r.value, 12), unit: str(r.unit, 10), label: str(r.label, 50) }));
    beats.push(out);
  }
  return {
    version: 1,
    theme,
    keywords: (Array.isArray(s.keywords) ? s.keywords : [])
      .map((k) => str(k, 40))
      .filter(Boolean)
      .slice(0, 40),
    music: {
      enabled: s.music?.enabled !== false,
      rel: s.music?.rel ? String(s.music.rel) : null,
      volume: Math.min(1, Math.max(0, Number(s.music?.volume ?? 0.5))),
    },
    sfx: {
      enabled: s.sfx?.enabled !== false,
      volume: Math.min(1, Math.max(0, Number(s.sfx?.volume ?? 0.5))),
    },
    beats,
  };
}

export const introLength = (story) =>
  round(story.beats.filter((b) => b.type === "hook").reduce((t, b) => t + b.duration, 0));
export const outroLength = (story) => {
  const o = story.beats.find((b) => b.type === "outro");
  return o ? o.duration : 0;
};

/** Timeline start/end of every kept EDL row (timeline already offset by the intro). */
export function rowTimes(clips, intro = 0) {
  const map = {};
  for (const c of clips)
    for (const r of c.rows)
      map[r.id] = {
        start: round(intro + c.start + (r.sourceIn - c.sourceIn)),
        end: round(intro + c.start + (r.sourceOut - c.sourceIn)),
      };
  return map;
}

/**
 * Place every beat on the timeline. Hooks play back to back before the footage, the outro after
 * it; the rest sit at their sentence + offset, clamped inside the footage. A beat whose sentence
 * was cut is returned with `hidden: true` so the editor can show it greyed out.
 */
export function resolveBeats(story, rows, { intro, footage }) {
  const out = [];
  let t = 0;
  for (const b of story.beats.filter((x) => x.type === "hook")) {
    out.push({ ...b, start: round(t), duration: b.duration });
    t += b.duration;
  }
  const end = intro + footage;
  for (const b of story.beats.filter((x) => x.type !== "hook" && x.type !== "outro")) {
    let start = null;
    if (b.row) start = rows[b.row] ? rows[b.row].start + (b.offset || 0) : null;
    else if (Number.isFinite(b.at)) start = intro + b.at;
    if (start == null) {
      out.push({ ...b, start: null, hidden: true });
      continue;
    }
    start = Math.min(Math.max(intro, start), Math.max(intro, end - 0.8));
    out.push({ ...b, start: round(start), duration: round(Math.min(b.duration, end - start)) });
  }
  const o = story.beats.find((x) => x.type === "outro");
  if (o) out.push({ ...o, start: round(end), duration: o.duration });
  out.sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9));
  // Two beats in one screen slot never overlap: the earlier one leaves as the next arrives.
  const slot = (b) => (b.type === "card" ? "top" : b.type === "badge" ? "corner" : "full");
  const last = {};
  for (const b of out) {
    if (b.hidden || b.start == null) continue;
    const prev = last[slot(b)];
    if (prev && prev.start + prev.duration > b.start - 0.05)
      prev.duration = round(Math.max(0.6, b.start - 0.05 - prev.start));
    last[slot(b)] = b;
  }
  return out;
}

/** Chapter spans for the top bar: a beat with `chapter` opens one, it runs to the next. */
export function chaptersOf(beats, intro, footage) {
  const marks = beats.filter(
    (b) => !b.hidden && b.chapter && b.type !== "hook" && b.type !== "outro",
  );
  const out = [];
  for (const b of marks) {
    const last = out[out.length - 1];
    if (last && last.label === b.chapter) continue;
    if (last) last.end = b.start;
    out.push({ label: b.chapter, start: b.start, end: intro + footage });
  }
  if (out.length && out[0].start > intro + 0.5)
    out.unshift({ label: "", start: intro, end: out[0].start });
  else if (out.length) out[0].start = intro;
  return out.map((c) => ({ ...c, start: round(c.start), end: round(c.end) }));
}

// ---------- automatic first draft (no AI needed) ----------

const UNIT =
  "%|phần trăm|ha|héc ta|hecta|m2|m²|mét vuông|mét|m|km|căn|năm|tầng|lầu|tỷ|triệu|phút|ngàn|nghìn";
const STAT_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNIT})(?![\\p{L}])`, "iu");
const DATE_RE = /(?:ngày\s*)?(\d{1,2})\s*tháng\s*(\d{1,2})(?:\s*năm\s*|[\s/.-]+)(20\d{2})/iu;
const MONTH_RE = /tháng\s*(\d{1,2})\s*(?:năm\s*)?(20\d{2})/iu;
const UNIT_SHORT = {
  "phần trăm": "%",
  "héc ta": "ha",
  hecta: "ha",
  "mét vuông": "m²",
  m2: "m²",
  mét: "m",
};

const pad2 = (n) => String(n).padStart(2, "0");
const clean = (t) => t.replace(/[.,!?…]+$/g, "");

/**
 * A rule-based first storyboard from the kept sentences: numbers with units become stat cards,
 * dates become date cards, the brief title opens the film and the end card closes it. Only
 * facts that are spoken in the footage or typed in the brief are used.
 */
export function planBeats({ rows, rowStart, brief = {}, keywords = [] }) {
  const story = emptyStory();
  story.theme.brand = str(brief.subtitle || brief.title, 40);
  story.keywords = [
    ...new Set([
      ...(keywords || []),
      ...splitKeywords(brief.title),
      ...splitKeywords(brief.subtitle),
    ]),
  ];
  const beats = [];
  const hooks = [];
  let lastAt = -1e9;
  let idx = 1;
  const first = rows[0];
  if (first && brief.title) {
    beats.push({
      id: "intro-card",
      type: "card",
      row: first.id,
      offset: 0.3,
      duration: 3.6,
      index: pad2(idx++),
      kicker: "Dự án",
      title: str(brief.title, 40),
      accent: str(brief.subtitle, 40),
      chapter: "Giới thiệu",
    });
    lastAt = rowStart[first.id] ?? 0;
  }
  for (const r of rows) {
    const at = rowStart[r.id];
    if (at == null || at - lastAt < 4) continue;
    const text = r.captionText || r.text;
    const date = DATE_RE.exec(text);
    const month = date ? null : MONTH_RE.exec(text);
    const stat = date || month ? null : STAT_RE.exec(text);
    if (!date && !month && !stat) continue;
    const words = text.split(/\s+/);
    const hitIndex = (m) => text.slice(0, m.index).split(/\s+/).filter(Boolean).length;
    const m = date || month || stat;
    const lead = words
      .slice(Math.max(0, hitIndex(m) - 4), hitIndex(m))
      .map(clean)
      .join(" ");
    const offsetWord = r.words?.[Math.min(hitIndex(m), (r.words?.length || 1) - 1)];
    const offset =
      offsetWord && r.words?.[0]
        ? Math.max(0, round(offsetWord.start - r.words[0].start - 0.4))
        : 0.2;
    const id = `auto-${idx}`;
    if (date || month) {
      const value = date
        ? `${pad2(date[1])}.${pad2(date[2])}.${date[3]}`
        : `${pad2(month[1])}.${month[2]}`;
      beats.push({
        id,
        type: "card",
        row: r.id,
        offset,
        duration: 3.8,
        index: pad2(idx++),
        kicker: "Mốc thời gian",
        title: lead || "Mốc quan trọng",
        dates: [{ label: "Thời gian", value }],
      });
    } else {
      const unit = UNIT_SHORT[stat[2].toLowerCase()] || stat[2];
      const label = lead || "";
      beats.push({
        id,
        type: "card",
        row: r.id,
        offset,
        duration: 3.6,
        index: pad2(idx++),
        kicker: "Thông tin",
        title: label || "Điểm nổi bật",
        stat: { value: stat[1], unit, label: "" },
      });
      if (hooks.length < 3) hooks.push({ value: stat[1], unit, label });
    }
    lastAt = at;
  }
  if (hooks.length >= 2)
    story.beats.push(
      ...hooks.map((h, i) => ({
        id: `hook-${i + 1}`,
        type: "hook",
        duration: 2.6,
        kicker: story.theme.brand,
        title: h.label,
        stat: { value: h.value, unit: h.unit, label: "" },
      })),
    );
  story.beats.push(...beats);
  story.beats.push({
    id: "outro",
    type: "outro",
    duration: 3.6,
    kicker: str(brief.title, 40),
    title: str(brief.subtitle || brief.title || "Liên hệ", 24),
    sub: str(brief.cta || "Liên hệ tư vấn", 80),
    label: str(brief.hotline, 30),
  });
  return sanitizeStory(story);
}

function splitKeywords(s) {
  return String(s || "")
    .split(/[—–\-·|,]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 2);
}

// ---------- HTML ----------

// Plain amounts count up (122, 6, 3,5); dates and codes like 01.07 or 2027 stay as written.
const COUNTABLE = /^(0|[1-9]\d{0,3})(,\d{1,2})?$/;

function num(value, cls = "num") {
  const v = String(value);
  return COUNTABLE.test(v)
    ? `<b class="${cls}" data-to="${esc(v.replace(",", "."))}" data-dec="${(v.split(/[.,]/)[1] || "").length}" data-comma="${v.includes(",") ? 1 : 0}">${esc(v)}</b>`
    : `<b class="${cls}">${esc(v)}</b>`;
}

function titleLines(b, cls = "ttl") {
  const lines = [];
  if (b.title) lines.push(`<span class="ln"><span class="in">${esc(b.title)}</span></span>`);
  if (b.accent) lines.push(`<span class="ln acc"><span class="in">${esc(b.accent)}</span></span>`);
  return lines.length ? `<div class="${cls}">${lines.join("")}</div>` : "";
}

function kicker(b) {
  if (!b.kicker && !b.index) return "";
  return `<div class="kick x"><span class="dot"></span>${b.index ? `<span class="idx">${esc(b.index)}</span>` : ""}${b.kicker ? `<span>${esc(b.kicker)}</span>` : ""}</div>`;
}

function beatHtml(b, images) {
  const id = `b-${b.id}`;
  const attrs = `id="${id}" class="clip beat ${b.type}" data-start="${b.start}" data-duration="${b.duration}"`;
  const img = b.image && images[b.image];
  if (b.type === "card") {
    const extra = [
      b.note ? `<div class="note x">${esc(b.note)}</div>` : "",
      b.stat
        ? `<div class="stat x">${num(b.stat.value)}${b.stat.unit ? `<i>${esc(b.stat.unit)}</i>` : ""}${b.stat.label ? `<span>${esc(b.stat.label)}</span>` : ""}</div>`
        : "",
      b.dates?.length
        ? `<div class="dates">${b.dates.map((d) => `<div class="date x"><small data-layout-ignore>${esc(d.label)}</small><b>${esc(d.value)}</b></div>`).join("")}</div>`
        : "",
      b.bullets?.length
        ? `<ul class="bul">${b.bullets.map((x) => `<li class="x">${esc(x)}</li>`).join("")}</ul>`
        : "",
      img ? `<img class="pic x" src="${esc(img)}" alt="" />` : "",
      b.sub ? `<div class="sub x">${esc(b.sub)}</div>` : "",
    ].join("");
    return `      <div ${attrs}><div class="panel">${kicker(b)}${titleLines(b)}${extra}</div></div>`;
  }
  if (b.type === "full" || b.type === "hook") {
    const bg = img || b.poster;
    return `      <div ${attrs}>${bg ? `<img class="bg" src="${esc(bg)}" alt="" />` : ""}<div class="shade"></div><div class="center">${kicker(b)}${b.type === "hook" ? "" : titleLines(b, "ttl big")}${b.stat ? `<div class="hero x">${num(b.stat.value, "num hv")}${b.stat.unit ? `<i>${esc(b.stat.unit)}</i>` : ""}</div>` : ""}${b.type === "hook" ? titleLines(b, "ttl mid") : ""}${b.sub ? `<div class="sub x">${esc(b.sub)}</div>` : ""}</div></div>`;
  }
  if (b.type === "stats") {
    const rows = (b.rows || [])
      .map(
        (r) =>
          `<div class="srow x"><span class="nv">${num(r.value)}${r.unit ? `<i>${esc(r.unit)}</i>` : ""}</span><span class="lb">${esc(r.label)}</span></div>`,
      )
      .join("");
    return `      <div ${attrs}><div class="shade solid"></div><div class="stack">${kicker(b)}${titleLines(b)}${rows}</div></div>`;
  }
  if (b.type === "badge") {
    return `      <div ${attrs}><div class="bbox">${b.kicker ? `<small class="x" data-layout-ignore><span class="dot"></span>${esc(b.kicker)}</small>` : ""}<b class="x">${esc(b.title)}</b>${b.sub ? `<span class="x">${esc(b.sub)}</span>` : ""}</div></div>`;
  }
  if (b.type === "outro") {
    return `      <div ${attrs}><div class="shade solid"></div><div class="center">${b.kicker ? `<div class="kick x"><span>${esc(b.kicker)}</span></div>` : ""}<div class="otitle"><span class="in">${esc(b.title)}<em>.</em></span></div><div class="rule"></div>${b.sub ? `<div class="sub x">${esc(b.sub)}</div>` : ""}${b.label ? `<div class="hot x">${esc(b.label)}</div>` : ""}</div></div>`;
  }
  return "";
}

/** The motion sub-composition: chapter bar, scrims and every visible beat. */
export function motionHtml({
  width,
  height,
  duration,
  intro,
  footage,
  beats,
  chapters,
  theme,
  images,
}) {
  const u = width / 1080;
  const px = (n) => `${Math.round(n * u)}px`;
  const visible = beats.filter((b) => !b.hidden && b.start != null);
  const A = theme.accent;
  const brand = theme.brand;
  const barEnd = round(intro + footage);
  const chapterTags = chapters
    .map((c, i) => (c.label ? `<span id="ch-${i}" class="chtag">${esc(c.label)}</span>` : ""))
    .join("");
  const segs = chapters
    .map((_, i) => `<span class="seg"><span id="seg-${i}" class="fill"></span></span>`)
    .join("");
  const data = visible.map((b) => [`#b-${b.id}`, b.type, b.start, b.duration]);
  const chData = chapters.map((c, i) => [i, c.start, c.end, Boolean(c.label)]);
  return `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; font-family: "Montserrat", sans-serif; color: #fff; --a: ${A}; }
    .mono { font-family: "JetBrains Mono", monospace; }
    #scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 52%, rgba(0,0,0,.58) 70%, rgba(0,0,0,.8) 100%); }
    #bar { position: absolute; left: ${px(36)}; right: ${px(36)}; top: ${px(34)}; }
    #bar .row { display: flex; justify-content: space-between; align-items: center; height: ${px(52)}; }
    #bar .brand { display: flex; align-items: center; gap: ${px(12)}; padding: ${px(8)} ${px(18)} ${px(8)} ${px(10)}; background: rgba(12,14,17,.78); border-radius: ${px(12)}; font-weight: 800; font-size: ${px(28)}; }
    #bar .brand i { width: ${px(26)}; height: ${px(26)}; border-radius: ${px(7)}; background: var(--a); display: inline-block; }
    #bar .tags { position: relative; height: ${px(52)}; width: ${px(520)}; }
    .chtag { position: absolute; right: 0; top: 0; opacity: 0; white-space: nowrap; padding: ${px(8)} ${px(22)}; border-radius: 999px; background: #f4f4f2; color: #101215; font-weight: 800; font-size: ${px(28)}; }
    #bar .segs { display: flex; gap: ${px(8)}; margin-top: ${px(12)}; }
    .seg { flex: 1; height: ${px(5)}; border-radius: 9px; background: rgba(255,255,255,.28); overflow: hidden; }
    .fill { display: block; height: 100%; width: 100%; background: var(--a); transform-origin: left center; transform: scaleX(0); }
    .beat { position: absolute; inset: 0; }
    .dot { display: inline-block; width: ${px(12)}; height: ${px(12)}; border-radius: 50%; background: var(--a); margin-right: ${px(12)}; vertical-align: middle; }
    .kick { font-family: "JetBrains Mono", monospace; font-size: ${px(28)}; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.78); }
    .kick .idx { color: var(--a); font-weight: 700; margin-right: ${px(14)}; }
    .ttl { margin-top: ${px(14)}; font-weight: 900; text-transform: uppercase; line-height: 1.08; font-size: ${px(64)}; }
    /* Room under each line for Vietnamese marks below the baseline (dấu nặng) inside the reveal mask. */
    .ttl .ln { display: block; overflow: hidden; padding: ${px(4)} 0 ${px(16)}; margin-bottom: -${px(14)}; }
    .ttl .in, .otitle .in { display: inline-block; }
    .acc { color: var(--a); }
    .panel { position: absolute; left: ${px(36)}; right: ${px(36)}; top: ${px(150)}; padding: ${px(36)} ${px(40)} ${px(40)}; border-radius: ${px(34)}; background: rgba(16,18,22,.9); border: ${px(2)} solid rgba(255,255,255,.07); box-shadow: 0 ${px(30)} ${px(80)} rgba(0,0,0,.45); transform-origin: top center; }
    .note { margin-top: ${px(10)}; font-size: ${px(44)}; font-style: italic; font-weight: 600; color: var(--a); }
    .stat { margin-top: ${px(22)}; display: flex; align-items: baseline; gap: ${px(12)}; }
    .stat .num { font-size: ${px(120)}; font-weight: 900; color: var(--a); line-height: 1; }
    .stat i { font-style: normal; font-weight: 900; font-size: ${px(48)}; }
    .stat span { font-size: ${px(28)}; color: rgba(255,255,255,.8); margin-left: ${px(10)}; }
    .dates { margin-top: ${px(22)}; display: flex; flex-direction: column; gap: ${px(14)}; }
    .date { padding: ${px(14)} ${px(22)}; border-radius: ${px(18)}; background: rgba(255,255,255,.06); border-left: ${px(6)} solid var(--a); }
    .date small { display: block; font-family: "JetBrains Mono", monospace; font-size: ${px(26)}; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.7); }
    .date b { font-size: ${px(60)}; font-weight: 900; color: var(--a); }
    .bul { margin-top: ${px(18)}; list-style: none; }
    .bul li { font-size: ${px(32)}; font-weight: 700; padding: ${px(6)} 0; }
    .bul li::before { content: ""; display: inline-block; width: ${px(12)}; height: ${px(12)}; border-radius: 50%; background: var(--a); margin-right: ${px(16)}; vertical-align: middle; }
    .pic { display: block; margin-top: ${px(22)}; width: 100%; height: ${px(360)}; object-fit: cover; border-radius: ${px(20)}; }
    .sub { margin-top: ${px(18)}; font-size: ${px(30)}; font-weight: 600; color: rgba(255,255,255,.85); }
    .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(10,12,15,.55), rgba(10,12,15,.82) 55%, rgba(10,12,15,.96)); }
    .shade.solid { background: radial-gradient(120% 60% at 50% 40%, #1a1f24 0%, #0c0e11 70%); }
    .center { position: absolute; left: ${px(60)}; right: ${px(60)}; top: 50%; transform: translateY(-50%); text-align: center; }
    .ttl.big { font-size: ${px(78)}; }
    .ttl.mid { font-size: ${px(56)}; }
    .hero { margin-top: ${px(10)}; display: flex; justify-content: center; align-items: baseline; gap: ${px(14)}; }
    .hero .hv { font-size: ${px(230)}; font-weight: 900; color: var(--a); line-height: .95; }
    .hero i { font-style: normal; font-size: ${px(84)}; font-weight: 900; }
    .stack { position: absolute; left: ${px(60)}; right: ${px(60)}; top: ${px(190)}; }
    .srow { display: flex; align-items: baseline; gap: ${px(14)}; margin-top: ${px(26)}; padding: ${px(20)} ${px(28)}; border-radius: ${px(22)}; background: rgba(255,255,255,.05); }
    .srow .nv { display: flex; align-items: baseline; gap: ${px(10)}; min-width: ${px(250)}; }
    .srow .num { font-size: ${px(110)}; font-weight: 900; color: var(--a); line-height: 1; }
    .srow i { font-style: normal; font-size: ${px(40)}; font-weight: 900; }
    .srow .lb { margin-left: auto; max-width: 48%; text-align: right; font-size: ${px(28)}; font-weight: 600; color: rgba(255,255,255,.82); }
    .badge .bbox { position: absolute; right: ${px(36)}; top: ${px(1180)}; padding: ${px(18)} ${px(26)}; border-radius: ${px(22)}; background: rgba(16,18,22,.9); min-width: ${px(170)}; }
    .bbox small { display: block; font-family: "JetBrains Mono", monospace; font-size: ${px(24)}; letter-spacing: .06em; text-transform: uppercase; color: rgba(255,255,255,.75); }
    .bbox b { display: block; font-size: ${px(64)}; font-weight: 900; line-height: 1.05; }
    .bbox span { font-size: ${px(28)}; color: rgba(255,255,255,.8); }
    .otitle { font-size: ${px(120)}; font-weight: 900; text-transform: uppercase; overflow: hidden; line-height: 1.1; padding-bottom: ${px(18)}; }
    .otitle em { font-style: normal; color: var(--a); }
    .rule { height: ${px(4)}; width: 62%; margin: ${px(18)} auto; background: var(--a); transform-origin: center; }
    .hot { margin-top: ${px(18)}; font-size: ${px(46)}; font-weight: 900; color: var(--a); letter-spacing: .03em; }
  </style>
  <div id="root" data-composition-id="motion" data-width="${width}" data-height="${height}">
    <div id="scrim" class="clip" data-start="${round(intro)}" data-duration="${round(footage)}"></div>
    <div id="bar" class="clip" data-start="${round(intro)}" data-duration="${round(barEnd - intro)}">
      <div class="row"><div class="brand"><i></i>${esc(brand || "LUAN")}</div><div class="tags">${chapterTags}</div></div>
      ${chapters.length > 1 ? `<div class="segs">${segs}</div>` : ""}
    </div>
${visible.map((b) => beatHtml(b, images)).join("\n")}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    const BEATS = ${JSON.stringify(data)};
    const CHAPTERS = ${JSON.stringify(chData)};
    const q = (s) => Array.from(document.querySelectorAll(s));
    const count = (el, at) => {
      const to = parseFloat(el.dataset.to), dec = Number(el.dataset.dec), comma = el.dataset.comma === "1";
      const o = { v: 0 };
      tl.to(o, { v: to, duration: 0.9, ease: "power2.out", onUpdate: () => { const s = o.v.toFixed(dec); el.textContent = comma ? s.replace(".", ",") : s; } }, at);
    };
    // Tween only what exists in this beat, so no GSAP "target not found" warnings.
    const ft = (t, from, to, at) => { const els = typeof t === "string" ? q(t) : t; if (els.length) tl.fromTo(els, from, to, at); };
    const to = (t, vars, at) => { const els = q(t); if (els.length) tl.to(els, vars, at); };
    for (const [sel, type, s, d] of BEATS) {
      const out = s + d;
      // The film's first frame is its thumbnail: a beat at 0 s is already on screen there.
      const first = s < 0.05;
      const lines = q(sel + " .in"), extras = q(sel + " .x");
      if (type === "card") {
        ft(sel + " .panel", { opacity: 0, y: -40, scaleY: 0.7 }, { opacity: 1, y: 0, scaleY: 1, duration: 0.5, ease: "power3.out" }, s);
        ft(lines, { yPercent: 110 }, { yPercent: 0, duration: 0.55, stagger: 0.09, ease: "power4.out" }, s + 0.18);
        ft(extras, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.08, ease: "power3.out" }, s + 0.32);
        to(sel + " .panel", { opacity: 0, y: -24, duration: 0.3, ease: "power2.in" }, out - 0.3);
      } else if (type === "badge") {
        ft(sel + " .bbox", { opacity: 0, x: 60 }, { opacity: 1, x: 0, duration: 0.45, ease: "power3.out" }, s);
        ft(extras, { opacity: 0 }, { opacity: 1, duration: 0.3, stagger: 0.06 }, s + 0.15);
        to(sel + " .bbox", { opacity: 0, x: 40, duration: 0.3, ease: "power2.in" }, out - 0.3);
      } else {
        if (!first) ft(sel, { opacity: 0 }, { opacity: 1, duration: 0.28, ease: "power2.out" }, s);
        ft(sel + " .bg", { scale: 1.12 }, { scale: 1, duration: d, ease: "none" }, s);
        if (first) ft(extras.concat(lines), { scale: 1.12 }, { scale: 1, duration: 0.9, ease: "power3.out" }, s);
        else {
          ft(lines, { yPercent: 110 }, { yPercent: 0, duration: 0.6, stagger: 0.1, ease: "power4.out" }, s + 0.12);
          ft(extras, { opacity: 0, y: 30, scale: type === "hook" ? 1.25 : 1 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.12, ease: "power3.out" }, s + 0.2);
        }
        ft(sel + " .rule", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.inOut" }, s + 0.35);
        if (type !== "outro") to(sel, { opacity: 0, duration: 0.25, ease: "power2.in" }, out - 0.25);
      }
      if (!first) q(sel + " .num[data-to]").forEach((el, i) => count(el, s + 0.3 + i * 0.12));
    }
    for (const [i, s, e, labelled] of CHAPTERS) {
      if (labelled) {
        tl.fromTo("#ch-" + i, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, s);
        tl.set("#ch-" + i, { opacity: 0 }, e);
      }
      if (document.querySelector("#seg-" + i)) tl.fromTo("#seg-" + i, { scaleX: 0 }, { scaleX: 1, duration: Math.max(0.1, e - s), ease: "none" }, s);
    }
    tl.set({}, {}, ${round(duration)});
    window.__timelines = window.__timelines || {};
    window.__timelines["motion"] = tl;
  </script>
</template>
`;
}

// ---------- captions ----------

/** Words of a caption-edited row, spread over the row's spoken span by length. */
export function retimeWords(text, words) {
  const parts = String(text).split(/\s+/).filter(Boolean);
  if (!parts.length || !words?.length) return [];
  const t0 = words[0].start;
  const t1 = words[words.length - 1].end;
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  let t = t0;
  return parts.map((p) => {
    const d = ((t1 - t0) * (p.length + 1)) / total;
    const w = { text: p, start: round(t), end: round(t + d) };
    t += d;
    return w;
  });
}

/** Apply brief corrections ("Vinh Hom" → "Vinhomes") to a sentence; returns null when unchanged. */
export function correctText(text, corrections = []) {
  let out = text;
  for (const c of corrections) {
    if (!c?.from || !c?.to) continue;
    const re = new RegExp(c.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    out = out.replace(re, c.to);
  }
  return out === text ? null : out;
}

const isKeyword = (w, keys) => {
  const bare = w.replace(/[.,!?…:;"“”]/g, "").toLowerCase();
  if (!bare) return false;
  if (/\d/.test(bare)) return true;
  return keys.some((k) => k.split(/\s+/).some((p) => p.length > 2 && p.toLowerCase() === bare));
};

export function captionsHtml({ width, height, groups, enabled, keywords = [], accent }) {
  const u = width / 1080;
  const px = (n) => `${Math.round(n * u)}px`;
  const items = enabled
    ? groups
        .map(
          (g, i) =>
            `    <div id="cap-${i + 1}" class="clip cap" data-start="${g.start}" data-duration="${round(g.end - g.start)}">${g.words
              .map(
                (w, j) =>
                  `<span id="cap-${i + 1}-${j + 1}" class="w${isKeyword(w.text, keywords) ? " k" : ""}">${esc(w.text)}</span>`,
              )
              .join(" ")}</div>`,
        )
        .join("\n")
    : "";
  const caps = enabled ? groups.map((g, i) => [i + 1, g.start]) : [];
  const words = enabled
    ? groups.flatMap((g, i) => g.words.map((w, j) => [`#cap-${i + 1}-${j + 1}`, w.start, w.end]))
    : [];
  return `<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; }
    .cap {
      position: absolute; left: ${px(70)}; right: ${px(70)}; top: ${Math.round(height * 0.735)}px;
      text-align: center; font-family: "Montserrat", sans-serif; font-weight: 800; font-size: ${px(46)};
      line-height: 1.3; color: #fff;
      text-shadow: 0 ${px(3)} ${px(4)} rgba(0,0,0,.9), 0 0 ${px(18)} rgba(0,0,0,.75);
    }
    .w { display: inline-block; }
    .k { color: ${accent}; }
  </style>
  <div id="root" data-composition-id="captions" data-width="${width}" data-height="${height}">
${items}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    const CAPS = ${JSON.stringify(caps)};
    const WORDS = ${JSON.stringify(words)};
    for (const [i, s] of CAPS) tl.fromTo("#cap-" + i, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" }, s);
    for (const [sel, s, e] of WORDS) tl.fromTo(sel, { scale: 1 }, { scale: 1.08, duration: 0.08, yoyo: true, repeat: 1, ease: "power1.out" }, s);
    window.__timelines = window.__timelines || {};
    window.__timelines["captions"] = tl;
  </script>
</template>
`;
}

// ---------- sound design ----------

/** Which sound plays where: whoosh into cards, hit under full screens, boom under hooks, riser into the end card. */
export function soundCues(beats, { total }) {
  const cues = [];
  for (const b of beats) {
    if (b.hidden || b.start == null) continue;
    if (b.type === "hook")
      cues.push({ role: "boom", seed: b.id, start: b.start, duration: 2, volume: 0.55 });
    else if (b.type === "card" || b.type === "badge")
      cues.push({
        role: "whoosh",
        seed: b.id,
        start: Math.max(0, b.start - 0.08),
        duration: 1.6,
        volume: 0.45,
      });
    else if (b.type === "full" || b.type === "stats")
      cues.push({ role: "hit", seed: b.id, start: b.start, duration: 2, volume: 0.45 });
    else if (b.type === "outro")
      cues.push({
        role: "riser",
        seed: b.id,
        start: Math.max(0, b.start - 1.6),
        duration: 2,
        volume: 0.4,
      });
  }
  return cues
    .filter((c) => c.start < total)
    .map((c) => ({
      ...c,
      start: round(c.start),
      duration: round(Math.min(c.duration, total - c.start)),
    }));
}

/** Music level: up in the intro and the end card, ducked under speech. Points in clip time. */
export function musicAutomation({ intro, footage, total, volume }) {
  const hi = round(Math.min(1, volume * 1.1));
  const lo = round(Math.min(1, volume * 0.28));
  const pts = [{ t: 0, v: hi }];
  if (intro > 0) pts.push({ t: round(Math.max(0, intro - 0.3)), v: hi });
  pts.push({ t: round(intro + 0.4), v: lo });
  const end = intro + footage;
  if (total > end + 0.3) {
    pts.push({ t: round(end - 0.2), v: lo }, { t: round(end + 0.5), v: hi });
  }
  return { version: 1, lanes: [{ target: "volume", points: pts }] };
}
