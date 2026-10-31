// Stage 1 — Media Ingestion. Lists the user's source files by kind and fingerprints them.
// Sources are referenced by absolute path and never copied, moved or modified.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const KINDS = {
  video: [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts"],
  image: [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"],
  document: [".pdf", ".docx", ".txt", ".md"],
};

export function kindOf(file) {
  const ext = extname(file).toLowerCase();
  for (const [kind, exts] of Object.entries(KINDS)) if (exts.includes(ext)) return kind;
  return null;
}

function walk(path, out) {
  const st = statSync(path);
  if (st.isFile()) {
    out.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    walk(resolve(path, entry.name), out);
  }
}

// Size + mtime + the first 64 KiB: stable across runs, cheap on multi-GB footage.
function fingerprint(file, st) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(65536, st.size));
    readSync(fd, buf, 0, buf.length, 0);
    return createHash("sha1")
      .update(`${st.size}:${st.mtimeMs}:`)
      .update(buf)
      .digest("hex")
      .slice(0, 12);
  } finally {
    closeSync(fd);
  }
}

function slug(name) {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return s.slice(0, 40) || "file";
}

/** @param {string[]} sources files or folders */
export function ingest(sources) {
  const files = [];
  for (const src of sources) {
    const abs = resolve(src);
    if (!existsSync(abs)) throw new Error(`Không tìm thấy: ${abs}`);
    walk(abs, files);
  }
  const items = [];
  const skipped = [];
  for (const file of files.sort()) {
    const kind = kindOf(file);
    if (!kind) {
      skipped.push(file);
      continue;
    }
    const st = statSync(file);
    const fp = fingerprint(file, st);
    const name = basename(file, extname(file));
    items.push({
      id: `${slug(name)}-${fp.slice(0, 6)}`,
      path: file,
      kind,
      size: st.size,
      fingerprint: fp,
    });
  }
  return { items, skipped };
}
