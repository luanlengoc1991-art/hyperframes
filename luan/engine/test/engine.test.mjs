// Engine API in-process, on scratch folders: a temporary studio root and secrets file,
// so nothing touches the real projects or luan/.env.local. No Claude, no paid API.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "luan-engine-"));
const sources = join(root, "sources");
mkdirSync(sources);
writeFileSync(join(sources, "note.txt"), "tư liệu");
const envFile = join(root, "test.env");
writeFileSync(envFile, "ELEVENLABS_MODEL=eleven_turbo_v2_5\n");
process.env.LUAN_STUDIO_ROOT = join(root, "studio");
process.env.LUAN_ENV_FILE = envFile;

let base;
let server;
before(async () => {
  ({ server } = await import("../server.mjs"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = async (path, init) => {
  const r = await fetch(base + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const put = (path, body) =>
  api(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("health reports tools and voice status", async () => {
  const r = await api("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok("ffmpeg" in r.body.tools && "whisper" in r.body.tools);
  assert.equal(r.body.voice.elevenlabs.model, "eleven_turbo_v2_5");
});

test("create project: Vietnamese name slugged, missing sources rejected", async () => {
  const bad = await post("/api/projects", { name: "X", sources: [join(root, "khong-co")] });
  assert.equal(bad.status, 400);
  const r = await post("/api/projects", { name: "Dự án Cần Giờ", sources: [sources] });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, "du-an-can-gio");
  const list = await api("/api/projects");
  assert.equal(list.body.length, 1);
  const again = await post("/api/projects", { name: "Dự án Cần Giờ", sources: [sources] });
  assert.equal(again.body.id, "du-an-can-gio-2");
});

test("brief is saved; EDL edits need an EDL first", async () => {
  const b = await put("/api/projects/du-an-can-gio/brief", { title: "Cần Giờ", cta: "Liên hệ" });
  assert.equal(b.body.brief.title, "Cần Giờ");
  const e = await put("/api/projects/du-an-can-gio/edl", { keep: {} });
  assert.equal(e.status, 400);
});

test("files are confined to the project folder", async () => {
  const r = await fetch(`${base}/files/du-an-can-gio/..%2F..%2F..%2Fsecret.txt`);
  assert.equal(r.status, 404);
  const ok = await fetch(`${base}/files/du-an-can-gio/project.json`);
  assert.equal(ok.status, 200);
});

test("voice settings write only allowed keys to the configured file, newlines stripped", async () => {
  const r = await put("/api/settings/voice", { VBEE_APP_ID: "app\nINJECT=1", NOT_ALLOWED: "x" });
  assert.equal(r.status, 200);
  const text = readFileSync(envFile, "utf8");
  assert.match(text, /^VBEE_APP_ID=appINJECT=1$/m);
  assert.doesNotMatch(text, /NOT_ALLOWED/);
  assert.doesNotMatch(text, /^INJECT=1$/m);
});

test("unknown project and bad ids are 404", async () => {
  assert.equal((await api("/api/projects/khong-ton-tai")).status, 404);
  assert.equal((await api("/api/projects/..%2F..")).status, 404);
});
