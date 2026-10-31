// Footage Analysis Report: one JSON for the next stages and one Markdown page for people.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fmt = (s) => (s === null || s === undefined ? "–" : `${Number(s).toFixed(1)}s`);
const ROLE = {
  "a-roll-candidate": "A-roll (có lời nói, chờ transcript xác nhận)",
  "b-roll": "B-roll",
  image: "Ảnh",
  music: "Nhạc",
  sfx: "SFX",
  document: "Tài liệu",
};

export function writeReport(projectDir, analyses, transcripts, skipped) {
  const json = { generatedAt: new Date().toISOString(), items: analyses, transcripts, skipped };
  writeFileSync(join(projectDir, "analysis", "footage-report.json"), JSON.stringify(json, null, 2));

  const videos = analyses.filter((a) => a.kind === "video");
  const usable = videos.flatMap((v) => (v.shots || []).filter((s) => s.usable));
  const lines = [
    "# Footage Analysis Report",
    "",
    `Tạo lúc: ${json.generatedAt}`,
    "",
    `Tổng: ${analyses.length} tư liệu · ${videos.length} video · ${usable.length} shot dùng được · ${usable.reduce((s, x) => s + x.duration, 0).toFixed(1)}s footage dùng được`,
    "",
    "| Tư liệu | Loại | Thời lượng | Khung hình | Âm thanh | Shot dùng được | Cảnh báo |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const a of analyses) {
    const frame = a.video
      ? `${a.video.width}×${a.video.height} ${a.video.fps}fps ${a.video.orientation}`
      : "–";
    const audio = a.audio
      ? `${a.integratedLufs ?? "?"} LUFS, đỉnh ${a.truePeakDbtp ?? "?"} dBTP${a.speechRatio !== undefined ? `, có tiếng ${Math.round((a.speechRatio ?? 0) * 100)}%` : ""}`
      : "–";
    const shots = a.shots ? `${a.shots.filter((s) => s.usable).length}/${a.shots.length}` : "–";
    lines.push(
      `| ${a.id} | ${ROLE[a.role] || a.role} | ${fmt(a.duration)} | ${frame} | ${audio} | ${shots} | ${(a.flags || []).join("; ") || "–"} |`,
    );
  }
  lines.push("", "## Transcript", "");
  const t = Object.entries(transcripts);
  if (!t.length) lines.push("Không có clip nào cần transcript.");
  for (const [id, r] of t) {
    lines.push(
      r.status === "done"
        ? `- **${id}**: ${r.output.words} từ — “${r.output.text}”`
        : `- **${id}**: ${r.status} — ${r.error}`,
    );
  }
  lines.push(
    "",
    "## Chưa đo được",
    "",
    "- Rung lắc: chưa đo (cần vidstab).",
    "- Nội dung hình ảnh: Claude xem contact sheet `analysis/<id>/contact.jpg`.",
    "- Cắt cảnh giữa hai cảnh cùng tông màu, hoặc chuyển cảnh mờ dần, có thể không được phát hiện: đối chiếu với contact sheet.",
  );
  if (skipped.length)
    lines.push("", "## Bỏ qua (không phải media)", "", ...skipped.map((s) => `- ${s}`));
  writeFileSync(join(projectDir, "analysis", "footage-report.md"), lines.join("\n") + "\n");
  return json;
}
