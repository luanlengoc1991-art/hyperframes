// Voice adapters against a fake fetch: no network, no credits spent.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { wordsFromAlignment } from "../elevenlabs.mjs";
import * as voice from "../index.mjs";

const dir = mkdtempSync(join(tmpdir(), "luan-voice-"));
const KEYS = [
  "VBEE_APP_ID",
  "VBEE_TOKEN",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_MODEL",
  "LUAN_TTS_MAX_CHARS",
];
const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  for (const k of KEYS) process.env[k] = "";
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeFetch(routes) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => r.match(String(url), init));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route.respond(String(url), init);
  };
}
const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

test("alignment characters become words with times", () => {
  const al = {
    characters: [..."Xin chào"],
    character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6],
    character_end_times_seconds: [0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7],
  };
  assert.deepEqual(wordsFromAlignment(al), [
    { text: "Xin", start: 0, end: 0.3 },
    { text: "chào", start: 0.35, end: 0.7 },
  ]);
});

test("no keys: blocked, nothing sent", async () => {
  fakeFetch([]);
  await assert.rejects(voice.synthesize({ text: "Xin chào", out: join(dir, "a.mp3") }), {
    name: "BlockedError",
  });
  assert.equal(calls.length, 0);
});

test("dry run reports the plan and calls nothing", async () => {
  process.env.ELEVENLABS_API_KEY = "k";
  fakeFetch([]);
  const r = await voice.synthesize({
    text: "Xin chào anh chị",
    out: join(dir, "b.mp3"),
    dryRun: true,
  });
  assert.equal(r.provider, "elevenlabs");
  assert.equal(r.chars, 16);
  assert.equal(calls.length, 0);
});

test("character budget blocks long text before any call", async () => {
  process.env.VBEE_APP_ID = "app";
  process.env.VBEE_TOKEN = "tok";
  process.env.LUAN_TTS_MAX_CHARS = "10";
  fakeFetch([]);
  await assert.rejects(
    voice.synthesize({ text: "x".repeat(11), out: join(dir, "c.mp3") }),
    /vượt giới hạn/,
  );
  assert.equal(calls.length, 0);
});

test("vbee: create, poll until done, download", async () => {
  process.env.VBEE_APP_ID = "app-1";
  process.env.VBEE_TOKEN = "tok-1";
  let polls = 0;
  fakeFetch([
    {
      match: (u, i) => u.endsWith("/v1/tts") && i.method === "POST",
      respond: () => jsonRes({ requestId: "r42" }),
    },
    {
      match: (u) => u.includes("/v1/tts/requests/r42"),
      respond: () =>
        jsonRes(
          ++polls < 2
            ? { status: "IN_PROGRESS" }
            : { status: "COMPLETED", audioLink: "https://cdn.test/a.mp3" },
        ),
    },
    {
      match: (u) => u === "https://cdn.test/a.mp3",
      respond: () => new Response(new Uint8Array([1, 2, 3])),
    },
  ]);
  const out = join(dir, "vbee.mp3");
  const vbee = await import("../vbee.mjs");
  const r = await vbee.synthesize({ text: "Xin chào", out, pollMs: 1 });
  assert.equal(r.provider, "vbee");
  assert.equal(r.requestId, "r42");
  assert.deepEqual([...readFileSync(out)], [1, 2, 3]);
  const create = calls[0];
  assert.equal(create.init.headers["App-Id"], "app-1");
  assert.equal(create.init.headers.Authorization, "Bearer tok-1");
  const body = JSON.parse(create.init.body);
  assert.equal(body.voiceCode, "hn_female_ngochuyen_full_48k-fhg");
  assert.equal(body.mode, "async");
  assert.ok(polls >= 2);
});

test("vbee: voice list is authenticated and filtered to Vietnamese stock voices", async () => {
  process.env.VBEE_APP_ID = "app-2";
  process.env.VBEE_TOKEN = "tok-2";
  fakeFetch([
    {
      match: (u) => u.startsWith("https://vbee.vn/api/public/v1/voices?"),
      respond: () =>
        jsonRes({
          result: {
            voices: [
              { code: "hn_female_x", name: "Ngọc Huyền", gender: "female", languageCode: "vi-VN" },
            ],
          },
        }),
    },
  ]);
  const vbee = await import("../vbee.mjs");
  const list = await vbee.listVoices();
  assert.deepEqual(list, [
    { id: "hn_female_x", name: "Ngọc Huyền", gender: "female", language: "vi-VN" },
  ]);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("languageCode"), "vi-VN");
  assert.equal(url.searchParams.get("voiceOwnership"), "VBEE");
  assert.equal(calls[0].init.headers["App-Id"], "app-2");
});

test("vbee: voice list without keys is blocked before any call", async () => {
  fakeFetch([]);
  const vbee = await import("../vbee.mjs");
  await assert.rejects(vbee.listVoices(), { name: "BlockedError" });
  assert.equal(calls.length, 0);
});

test("elevenlabs: with-timestamps, Vietnamese model, words returned", async () => {
  process.env.ELEVENLABS_API_KEY = "xi-key";
  process.env.ELEVENLABS_VOICE_ID = "voice-9";
  fakeFetch([
    {
      match: (u, i) =>
        u.includes("/v1/text-to-speech/voice-9/with-timestamps") && i.method === "POST",
      respond: () =>
        jsonRes({
          audio_base64: Buffer.from([9, 8, 7]).toString("base64"),
          alignment: {
            characters: [..."Chào"],
            character_start_times_seconds: [0, 0.1, 0.2, 0.3],
            character_end_times_seconds: [0.1, 0.2, 0.3, 0.4],
          },
        }),
    },
  ]);
  const out = join(dir, "el.mp3");
  const r = await voice.synthesize({ text: "Chào", out, provider: "elevenlabs" });
  assert.ok(existsSync(out));
  assert.deepEqual([...readFileSync(out)], [9, 8, 7]);
  assert.deepEqual(r.words, [{ text: "Chào", start: 0, end: 0.4 }]);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model_id, "eleven_turbo_v2_5");
  assert.equal(body.language_code, "vi");
  assert.equal(calls[0].init.headers["xi-api-key"], "xi-key");
});
