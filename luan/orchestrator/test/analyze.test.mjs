// End-to-end test of stages 1–3 on synthetic media with known events:
// 0–2 s test pattern, 2–3 s black, 3–6 s colour bars; a 440 Hz tone for 1.5 s, then silence.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyze, status } from "../cli.mjs";
import { requireTool, run } from "../lib/proc.mjs";

const root = mkdtempSync(join(tmpdir(), "luan-orch-"));
const sources = join(root, "sources");
const project = join(root, "project");
mkdirSync(sources);

async function makeMedia() {
  const ff = requireTool("ffmpeg");
  const clip = await run(ff, [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:duration=2",
    "-f",
    "lavfi",
    "-i",
    "color=black:size=640x360:rate=30:duration=1",
    "-f",
    "lavfi",
    "-i",
    "smptebars=size=640x360:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.5",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]apad=whole_dur=6[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    join(sources, "Cảnh quay 01.mp4"),
  ]);
  assert.equal(clip.code, 0, clip.stderr);
  const img = await run(ff, [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "smptebars=size=1080x1920",
    "-frames:v",
    "1",
    join(sources, "phoi-canh.png"),
  ]);
  assert.equal(img.code, 0, img.stderr);
  writeFileSync(join(sources, "ghi-chu.xyz"), "not media");
}

test("analyze: ingest, measure, report, resume", async () => {
  await makeMedia();
  const logs = [];
  const r1 = await analyze({ project, sources: [sources], log: (m) => logs.push(m) });

  const video = r1.analyses.find((a) => a.kind === "video");
  const image = r1.analyses.find((a) => a.kind === "image");
  assert.ok(video && image, "one video and one image");
  assert.match(video.id, /^canh-quay-01-[0-9a-f]{6}$/, "Vietnamese name is slugged");

  // Metadata
  assert.equal(video.video.width, 640);
  assert.equal(video.video.height, 360);
  assert.equal(video.video.orientation, "landscape");
  assert.ok(Math.abs(video.duration - 6) < 0.2, `duration ${video.duration}`);
  assert.equal(image.video.orientation, "portrait");

  // Black 2–3 s
  assert.ok(
    video.black.some((b) => Math.abs(b.start - 2) < 0.2 && Math.abs(b.end - 3) < 0.2),
    JSON.stringify(video.black),
  );
  // Shots split near 2 s and 3 s; the black shot is marked unusable
  const starts = video.shots.map((s) => s.start);
  assert.ok(
    starts.some((s) => Math.abs(s - 2) < 0.2) && starts.some((s) => Math.abs(s - 3) < 0.2),
    JSON.stringify(video.shots),
  );
  const blackShot = video.shots.find((s) => Math.abs(s.start - 2) < 0.2);
  assert.equal(blackShot.usable, false);
  // Silence after the tone (1.5 s → 6 s)
  assert.ok(
    video.silence.some((s) => Math.abs(s.start - 1.5) < 0.3 && s.end >= 5.5),
    JSON.stringify(video.silence),
  );
  assert.ok(video.speechRatio < 0.4, `speechRatio ${video.speechRatio}`);
  assert.equal(video.role, "b-roll");
  assert.ok(Number.isFinite(video.integratedLufs), "loudness measured");
  assert.ok(existsSync(video.contactSheet), "contact sheet written");

  // Report + skipped file
  const report = readFileSync(join(project, "analysis", "footage-report.md"), "utf8");
  assert.match(report, /Footage Analysis Report/);
  assert.match(report, /ghi-chu\.xyz/);

  // Resume: unchanged sources are not analysed again
  const logs2 = [];
  await analyze({ project, sources: [sources], log: (m) => logs2.push(m) });
  assert.ok(
    logs2.some((l) => l.startsWith("Đã có")),
    logs2.join("\n"),
  );
  const st = status(project).stages;
  assert.equal(st[`analyze:${video.id}`].status, "done");
  assert.equal(st[`analyze:${video.id}`].attempts, 1);
});
