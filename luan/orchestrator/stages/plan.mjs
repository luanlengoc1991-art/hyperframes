// AI storyboard: Claude reads the kept sentences (with their timeline times) and the brief, and
// writes story.json — chapters, info cards, hooks, full screens, stats, badges, end card — plus
// caption corrections for words the speech recognizer misheard. Every number Claude puts on
// screen must be spoken in the footage or typed in the brief; beats that fail that are dropped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaude } from "../lib/claude.mjs";
import { firstJsonObject } from "../lib/proc.mjs";
import { clipsOf, DEFAULT_BRIEF } from "./compose.mjs";
import { DEFAULT_DURATION, emptyStory, rowTimes, sanitizeStory } from "./motion.mjs";

const SCHEMA = `{
  "theme": { "accent": "#D2FF3C", "brand": "tên ngắn hiện ở góc trên (VD: Vịnh Tiên)" },
  "keywords": ["từ khoá tô màu trong phụ đề: tên dự án, tiện ích, con số"],
  "corrections": [{ "from": "cụm từ nhận giọng sai", "to": "cụm từ đúng" }],
  "beats": [
    { "id": "hook-1", "type": "hook", "duration": 2.6, "kicker": "dòng nhỏ", "title": "nhãn ngắn", "stat": { "value": "89", "unit": "căn" } },
    { "id": "c1", "type": "card", "row": "<id câu>", "offset": 0.4, "duration": 4, "chapter": "Vị trí", "index": "01", "kicker": "dòng nhỏ", "title": "dòng trắng", "accent": "dòng màu nhấn", "note": "dòng chữ nghiêng (tuỳ chọn)",
      "stat": { "value": "122", "unit": "ha", "label": "" }, "dates": [{ "label": "Dự kiến", "value": "30.09.2026" }], "bullets": ["1 trệt", "2 lầu"] },
    { "id": "f1", "type": "full", "row": "<id câu>", "offset": 0, "duration": 3.2, "chapter": "Tiện ích", "title": "dòng trắng", "accent": "dòng màu nhấn", "stat": { "value": "122", "unit": "ha" } },
    { "id": "s1", "type": "stats", "row": "<id câu>", "offset": 0, "duration": 4.5, "chapter": "Shophouse", "title": "Cam kết thuê", "accent": "6% mỗi năm", "rows": [{ "value": "89", "unit": "căn", "label": "Shophouse được cam kết thuê" }] },
    { "id": "g1", "type": "badge", "row": "<id câu>", "offset": 0, "duration": 4, "kicker": "Cập nhật", "title": "T10", "sub": "Năm 2026" },
    { "id": "outro", "type": "outro", "duration": 3.6, "kicker": "dòng nhỏ", "title": "tên dự án ngắn", "sub": "lời kêu gọi", "label": "hotline" }
  ]
}`;

const RULES = `Bạn là motion designer cho video bất động sản dọc 9:16 (phong cách: thẻ thông tin tối bo góc ở trên, tiêu đề chữ IN HOA hai dòng trắng + màu nhấn, số liệu lớn, phụ đề có từ khoá tô màu, thanh chương ở trên cùng).
Dữ liệu vào (stdin): brief và danh sách câu đã giữ, mỗi câu có id, thời điểm bắt đầu/kết thúc trên timeline (giây) và lời nói (do máy nhận giọng, có thể nghe sai tên riêng).
Nhiệm vụ: trả về DUY NHẤT một object JSON theo đúng mẫu dưới đây, không kèm giải thích.
Quy tắc:
- Chỉ dùng thông tin có trong lời nói hoặc brief. Mọi con số/ngày tháng phải có trong lời nói hoặc brief; không bịa giá, pháp lý, quy mô.
- Sửa tên riêng nghe sai dựa vào brief và ngữ cảnh (VD "Vinh Hom" → "Vinhomes", "chục đường" → "trục đường") — ghi vào "corrections" (chỉ sửa chữ, không đổi con số), và dùng tên đúng trên thẻ.
- Mỗi beat (trừ hook, outro) gắn vào một câu bằng "row" (id câu) và "offset" (giây tính từ đầu câu, nhỏ hơn độ dài câu) — đặt đúng lúc người nói nhắc tới nội dung đó.
- Nhịp: 1 thẻ "card" mỗi 6–10 giây lời nói; 1–3 "full" cho khoảnh khắc lớn; tối đa 1 "stats" khi có ≥2 con số liên quan; "badge" cho mốc/cập nhật ngắn. Không để hai beat cùng loại chồng nhau.
- "chapter": 4–7 chương, nhãn 1–2 từ (VD: Vị trí, Tiện ích, Mốc 2027, Trục đường, Shophouse, Liên hệ). Beat đầu của mỗi chương mang "chapter".
- 2–3 "hook" mở đầu bằng con số mạnh nhất (hook không có row). 1 "outro" cuối (không có row) với tên dự án, lời kêu gọi từ brief, hotline nếu có.
- "index" đánh số thẻ 01, 02, … theo thứ tự. title ≤ 26 ký tự, accent ≤ 24 ký tự, kicker ≤ 32 ký tự.
- Không dùng "image" trừ khi brief liệt kê ảnh.
Mẫu JSON:
${SCHEMA}`;

/** Integers in a text: "01.07.2027" and "1 tháng 7 năm 2027" both give 1, 7, 2027. */
const numbersIn = (s) => (String(s).match(/\d+/g) || []).map((n) => Number.parseInt(n, 10));

function beatNumbers(b) {
  const parts = [
    b.title,
    b.accent,
    b.kicker,
    b.note,
    b.sub,
    b.index && null,
    b.stat?.value,
    b.stat?.label,
    ...(b.dates || []).map((d) => `${d.label} ${d.value}`),
    ...(b.bullets || []),
    ...(b.rows || []).map((r) => `${r.value} ${r.label}`),
  ];
  return parts.filter(Boolean).flatMap(numbersIn);
}

/** Drop beats that show a number nobody said; corrections must keep every digit. */
export function verifyStory(story, corrections, sourceText) {
  const allowed = new Set(numbersIn(sourceText));
  const dropped = [];
  const beats = story.beats.filter((b) => {
    if (b.type === "outro") return true;
    const bad = beatNumbers(b).filter((n) => !allowed.has(n));
    if (bad.length) dropped.push({ id: b.id, numbers: bad });
    return !bad.length;
  });
  const fixes = (corrections || []).filter(
    (c) =>
      c?.from &&
      c?.to &&
      numbersIn(c.from).join(",") === numbersIn(c.to).join(",") &&
      c.from.length <= 60 &&
      c.to.length <= 60,
  );
  return { story: { ...story, beats }, corrections: fixes, dropped };
}

export async function planStory(projectDir, { onEvent = () => {} } = {}) {
  const edl = JSON.parse(readFileSync(join(projectDir, "edl.json"), "utf8"));
  const briefPath = join(projectDir, "brief.json");
  const brief = {
    ...DEFAULT_BRIEF,
    ...(existsSync(briefPath) ? JSON.parse(readFileSync(briefPath, "utf8")) : {}),
  };
  const { clips } = clipsOf(edl.rows);
  const times = rowTimes(clips, 0);
  const kept = edl.rows.filter((r) => r.keep && times[r.id]);
  const lines = kept.map((r) => ({
    id: r.id,
    start: times[r.id].start,
    end: times[r.id].end,
    text: r.captionText || r.text,
  }));
  const input = JSON.stringify(
    {
      brief: {
        title: brief.title,
        subtitle: brief.subtitle,
        cta: brief.cta,
        hotline: brief.hotline,
        notes: brief.notes || "",
      },
      sentences: lines,
    },
    null,
    1,
  );
  onEvent({ kind: "text", text: `Claude đang đọc ${lines.length} câu và lên storyboard…` });
  const r = await runClaude(RULES, { cwd: projectDir, input, onEvent, timeoutMs: 10 * 60_000 });
  const raw = firstJsonObject(r.text);
  if (!raw?.beats)
    throw new Error(`Claude không trả về storyboard hợp lệ: ${r.text.slice(0, 300)}`);
  const prev = existsSync(join(projectDir, "story.json"))
    ? JSON.parse(readFileSync(join(projectDir, "story.json"), "utf8"))
    : emptyStory();
  const clean = sanitizeStory(
    { ...raw, music: prev.music, sfx: prev.sfx },
    { rowIds: new Set(kept.map((x) => x.id)) },
  );
  for (const b of clean.beats) if (!b.duration) b.duration = DEFAULT_DURATION[b.type];
  const sourceText = [
    brief.title,
    brief.subtitle,
    brief.cta,
    brief.hotline,
    brief.notes,
    ...lines.map((l) => l.text),
  ].join(" ");
  const v = verifyStory(clean, raw.corrections, sourceText);
  writeFileSync(
    join(projectDir, "story.json"),
    JSON.stringify({ ...v.story, aiPlanned: true }, null, 2),
  );
  if (v.corrections.length) {
    const merged = [...(brief.corrections || [])];
    for (const c of v.corrections)
      if (!merged.some((m) => m.from === c.from)) merged.push({ from: c.from, to: c.to });
    writeFileSync(briefPath, JSON.stringify({ ...brief, corrections: merged }, null, 2));
  }
  return {
    beats: v.story.beats.length,
    chapters: [...new Set(v.story.beats.map((b) => b.chapter).filter(Boolean))],
    corrections: v.corrections.length,
    dropped: v.dropped,
    cost: r.cost,
  };
}
