// Edit decisions and caption timing: pure functions, no media needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEdl, captionGroups, clipsOf, sentencesOf } from "../stages/compose.mjs";

const w = (text, start, end) => ({ text, start, end });
const words = [
  w("Xin", 0.5, 0.8),
  w("chào", 0.8, 1.2),
  w("ờ", 1.2, 1.4),
  w("anh", 1.5, 1.8),
  w("chị.", 1.8, 2.2),
  w("Dự", 3.0, 3.3),
  w("án", 3.3, 3.6),
  w("đẹp.", 3.6, 4.0),
  w("Liên", 6.0, 6.3),
  w("hệ.", 6.3, 6.8),
];
const item = { id: "clip-a", duration: 8 };

test("sentences split at punctuation and drop fillers", () => {
  const s = sentencesOf(words);
  assert.equal(s.length, 3);
  assert.deepEqual(
    s[0].map((x) => x.text),
    ["Xin", "chào", "anh", "chị."],
  );
});

test("long unpunctuated speech splits at pauses and length; hallucinations dropped", () => {
  const run = [];
  for (let i = 0; i < 30; i++) run.push(w(`từ${i}`, i * 0.3, i * 0.3 + 0.25)); // 30 words, no punctuation
  run.push(w("tiếp", 10.0, 10.3)); // after a 0.95 s pause
  run.push(w("Yayyyyyyy", 10.4, 12.0));
  const s = sentencesOf(run);
  assert.ok(
    s.every((x) => x.length <= 24),
    "no sentence over 24 words",
  );
  assert.equal(s[s.length - 1][0].text, "tiếp", "a long pause starts a new sentence");
  assert.ok(!s.flat().some((x) => /yyyyy/.test(x.text)), "hallucinated word removed");
});

test("EDL rows are padded, never overlap the next sentence, all kept by default", () => {
  const edl = buildEdl([item], { "clip-a": words });
  assert.equal(edl.length, 3);
  assert.ok(edl.every((r) => r.keep));
  assert.equal(edl[0].sourceIn, 0.38);
  assert.ok(edl[0].sourceOut <= edl[1].sourceIn);
  assert.equal(edl[2].sourceOut, 7.05);
});

test("a target duration drops later sentences instead of cutting mid-sentence", () => {
  const edl = buildEdl([item], { "clip-a": words }, { targetDuration: 3 });
  assert.deepEqual(
    edl.map((r) => r.keep),
    [true, true, false],
  );
  assert.match(edl[2].reason, /mục tiêu/);
});

test("pauses between sentences are cut; touching rows merge; dropped rows split the timeline", () => {
  const edl = buildEdl([item], { "clip-a": words });
  // 0.8 s and 2 s pauses between the sentences are removed, so each sentence is its own clip.
  assert.equal(clipsOf(edl).clips.length, 3);
  const touching = edl.map((r) => ({ ...r }));
  touching[1].sourceIn = touching[0].sourceOut;
  assert.equal(clipsOf(touching).clips.length, 2, "rows that touch in the source merge");
  edl[1].keep = false;
  const { clips, duration } = clipsOf(edl);
  assert.equal(clips.length, 2);
  assert.equal(clips[0].start, 0);
  assert.equal(clips[1].start, clips[0].duration);
  assert.equal(duration, Math.round((clips[0].duration + clips[1].duration) * 1000) / 1000);
});

test("caption words map from source time to timeline time", () => {
  const edl = buildEdl([item], { "clip-a": words });
  edl[1].keep = false;
  const { clips } = clipsOf(edl);
  const groups = captionGroups(clips);
  const first = groups[0].words[0];
  assert.equal(first.text, "Xin");
  assert.equal(first.start, Math.round((0.5 - clips[0].sourceIn) * 1000) / 1000);
  const lien = groups.flatMap((g) => g.words).find((x) => x.text === "Liên");
  assert.equal(lien.start, Math.round((clips[1].start + (6.0 - clips[1].sourceIn)) * 1000) / 1000);
  assert.ok(
    !groups.flatMap((g) => g.words).some((x) => x.text === "Dự"),
    "dropped sentence has no captions",
  );
});
