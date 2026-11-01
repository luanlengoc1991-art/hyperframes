// The local sound library (music beds and sound effects the user already owns). Files are only
// read and hard-linked into a composition; nothing is uploaded. Set LUAN_SOUND_LIBRARY to move it.
import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export const SOUND_LIBRARY = resolve(
  process.env.LUAN_SOUND_LIBRARY ||
    "D:/CLAUDE CURSO WEBSITE LUAN/LUAN AI VIDEO STUDIO/NGÔ BĂNG AI SKILL/SOUND/SOUND",
);
const AUDIO = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]);

// Role → which files serve it. Soft whooshes for cards, hits for big numbers, a riser into the
// end card, a boom under the opening hook, music beds from the music collections.
const ROLES = {
  whoosh: /Simple Whoosh \d+ - Single|HAY DUNG[\\/]HIT[\\/]whoosh_hit/i,
  hit: /HAY DUNG[\\/]HIT[\\/]whoosh_hit|HITS ORGANIC/i,
  boom: /HAY DUNG[\\/]HIT[\\/]boom_|HAY DUNG[\\/]BASS DROP/i,
  riser: /HAY DUNG[\\/]RISE[\\/]approach_|RISER STRING - (Mini|Build)/i,
  music: /MUCSIC|NHAC HOI HOP|[\\/]music[\\/]/i,
};

let cache = null;

/** Every audio file under the library, with a role guess. Cached for the process. */
export function listSounds(root = SOUND_LIBRARY) {
  if (cache?.root === root) return cache.items;
  const items = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory() && depth < 8) walk(full, depth + 1);
      else if (e.isFile() && AUDIO.has(extname(e.name).toLowerCase())) {
        const rel = relative(root, full).split(sep).join("/");
        const role =
          Object.entries(ROLES).find(([, re]) => re.test(rel))?.[0] ||
          (/LOOPS/i.test(rel) ? "loop" : "sfx");
        items.push({ rel, role, name: e.name.replace(/-GFXVIET\.NET/i, "").replace(/\.\w+$/, "") });
      }
    }
  };
  walk(root, 0);
  items.sort((a, b) => a.rel.localeCompare(b.rel));
  cache = { root, items };
  return items;
}

export function soundPath(rel, root = SOUND_LIBRARY) {
  const full = resolve(root, rel);
  return full.startsWith(resolve(root) + sep) ? full : null;
}

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A stable pick for a role: the same beat always gets the same sound. */
export function pickSound(role, seed, root = SOUND_LIBRARY) {
  const pool = listSounds(root).filter((s) => s.role === role);
  if (!pool.length) return null;
  return pool[hash(`${role}:${seed}`) % pool.length];
}

export function libraryAvailable(root = SOUND_LIBRARY) {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
}
