// Storyboard placement, fact guard, caption fixes and the music envelope: pure functions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceAutomation } from "../stages/compose.mjs";
import {
  chaptersOf,
  correctText,
  introLength,
  motionHtml,
  musicAutomation,
  planBeats,
  resolveBeats,
  retimeWords,
  sanitizeStory,
} from "../stages/motion.mjs";
import { verifyStory } from "../stages/plan.mjs";

const rows = { "a#1": { start: 5, end: 9 }, "a#2": { start: 9, end: 15 } };

test("beats follow their sentence; hooks open, the outro closes, cut sentences hide the beat", () => {
  const story = sanitizeStory({
    beats: [
      { id: "h1", type: "hook", duration: 2, stat: { value: "122", unit: "ha" } },
      { id: "c1", type: "card", row: "a#2", offset: 1.5, duration: 3, title: "Tiện ích" },
      { id: "c2", type: "card", row: "a#9", offset: 0, duration: 3, title: "Câu đã cắt" },
      { id: "o", type: "outro", duration: 3, title: "Vịnh Tiên" },
    ],
  });
  const intro = introLength(story);
  assert.equal(intro, 2);
  const placed = resolveBeats(story, rows, { intro, footage: 20 });
  const byId = Object.fromEntries(placed.map((b) => [b.id, b]));
  assert.equal(byId.h1.start, 0);
  assert.equal(byId.c1.start, 10.5);
  assert.equal(byId.c2.hidden, true);
  assert.equal(byId.o.start, 22);
});

test("two cards never overlap: the earlier one leaves as the next arrives", () => {
  const story = sanitizeStory({
    beats: [
      { id: "c1", type: "card", row: "a#1", offset: 0, duration: 6 },
      { id: "c2", type: "card", row: "a#2", offset: 0, duration: 3 },
    ],
  });
  const placed = resolveBeats(story, rows, { intro: 0, footage: 20 });
  const c1 = placed.find((b) => b.id === "c1");
  assert.ok(c1.start + c1.duration <= 9 - 0.04);
});

test("chapters run from one labelled beat to the next and cover the footage", () => {
  const beats = [
    { id: "a", type: "card", start: 3, duration: 3, chapter: "Vị trí" },
    { id: "b", type: "card", start: 12, duration: 3, chapter: "Tiện ích" },
  ];
  const ch = chaptersOf(beats, 2, 20);
  assert.deepEqual(
    ch.map((c) => [c.label, c.start, c.end]),
    [
      ["", 2, 3],
      ["Vị trí", 3, 12],
      ["Tiện ích", 12, 22],
    ],
  );
});

test("a beat showing a number nobody said is dropped; corrections may not change digits", () => {
  const story = sanitizeStory({
    beats: [
      {
        id: "ok",
        type: "card",
        row: "a#1",
        title: "VinWonders",
        stat: { value: "122", unit: "ha" },
      },
      { id: "bad", type: "card", row: "a#1", title: "Giá", stat: { value: "45", unit: "tỷ" } },
      {
        id: "date",
        type: "card",
        row: "a#1",
        dates: [{ label: "Khai trương", value: "01.07.2027" }],
      },
    ],
  });
  const v = verifyStory(
    story,
    [
      { from: "Vinh Wunder", to: "VinWonders" },
      { from: "50 m", to: "500 m" },
    ],
    "tổ hợp giải trí Vinh Wunder 122 ha khai trương ngày 1 tháng 7 năm 2027 trục đường 50 m",
  );
  assert.deepEqual(
    v.story.beats.map((b) => b.id),
    ["ok", "date"],
  );
  assert.deepEqual(v.dropped, [{ id: "bad", numbers: [45] }]);
  assert.deepEqual(v.corrections, [{ from: "Vinh Wunder", to: "VinWonders" }]);
});

test("caption corrections re-time the corrected words over the spoken span", () => {
  assert.equal(
    correctText("tổ hợp Vinh Wunder nha", [{ from: "vinh wunder", to: "VinWonders" }]),
    "tổ hợp VinWonders nha",
  );
  assert.equal(correctText("không đổi", [{ from: "x", to: "y" }]), null);
  const words = retimeWords("tổ hợp VinWonders", [
    { text: "tổ", start: 1, end: 1.2 },
    { text: "Wunder", start: 1.8, end: 2.2 },
  ]);
  assert.equal(words.length, 3);
  assert.equal(words[0].start, 1);
  assert.ok(Math.abs(words[2].end - 2.2) < 0.01);
});

test("rule-based draft: spoken numbers become stat cards and hooks, brief closes it", () => {
  const draft = planBeats({
    rows: [
      { id: "a#1", text: "Xin chào anh chị", words: [{ text: "Xin", start: 0, end: 0.3 }] },
      {
        id: "a#2",
        text: "tổ hợp giải trí rộng 122 ha",
        words: [{ text: "tổ", start: 5, end: 5.2 }],
      },
      { id: "a#3", text: "trục đường lớn 50 m", words: [{ text: "trục", start: 12, end: 12.3 }] },
    ],
    rowStart: { "a#1": 0, "a#2": 5, "a#3": 12 },
    brief: { title: "Vinhomes Green Paradise", subtitle: "Vịnh Tiên", cta: "Liên hệ" },
  });
  const types = draft.beats.map((b) => b.type);
  assert.equal(types.filter((t) => t === "hook").length, 2);
  assert.ok(draft.beats.some((b) => b.stat?.value === "122" && b.stat.unit === "ha"));
  assert.equal(types[types.length - 1], "outro");
});

test("music envelope ducks under speech and slices into looped passes", () => {
  const auto = musicAutomation({ intro: 6, footage: 90, total: 100, volume: 0.5 });
  const pts = auto.lanes[0].points;
  assert.ok(pts[0].v > pts[2].v, "ducked once the speech starts");
  const second = sliceAutomation(auto, 60, 40);
  assert.equal(second.lanes[0].points[0].t, 0);
  assert.equal(second.lanes[0].points.at(-1).t, 40);
  assert.ok(
    second.lanes[0].points.at(-1).v > second.lanes[0].points[0].v,
    "back up for the end card",
  );
});

test("motion layer HTML: dates are not counted, amounts are, and the timeline registers", () => {
  const html = motionHtml({
    width: 1080,
    height: 1920,
    duration: 10,
    intro: 0,
    footage: 10,
    beats: [
      {
        id: "c",
        type: "card",
        start: 1,
        duration: 3,
        title: "X",
        stat: { value: "122", unit: "ha" },
        dates: [{ label: "Mở", value: "01.07.2027" }],
      },
    ],
    chapters: [],
    theme: { accent: "#D2FF3C", brand: "Vịnh Tiên" },
    images: {},
  });
  assert.match(html, /data-to="122"/);
  assert.doesNotMatch(html, /data-to="01/);
  assert.match(html, /window\.__timelines\["motion"\] = tl/);
});
