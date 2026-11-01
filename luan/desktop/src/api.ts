// Client for the local engine (luan/engine/server.mjs).
// Served by the engine itself in the app (same origin); the Vite dev server (port 1420) calls it.
export const ENGINE = location.port === "1420" ? "http://127.0.0.1:4500" : location.origin;

export interface MediaItem {
  id: string;
  kind: string;
  role: string;
  duration: number | null;
  video?: { width: number; height: number; fps: number; orientation: string; codec: string } | null;
  flags?: string[];
  contactSheet: string | null;
  integratedLufs?: number | null;
  truePeakDbtp?: number | null;
}

export interface EdlRow {
  id: string;
  source: string;
  sourceIn: number;
  sourceOut: number;
  text: string;
  captionText?: string;
  keep: boolean;
  reason: string;
}

export interface Correction {
  from: string;
  to: string;
}

export interface Brief {
  title: string;
  subtitle: string;
  cta: string;
  hotline: string;
  targetDuration: number | null;
  captions: boolean;
  corrections?: Correction[];
  quality?: "draft" | "standard" | "high";
  notes?: string;
}

export interface RenderInfo {
  file: string;
  duration?: number;
  sizeMB?: number;
  quality?: string;
  video?: { width: number; height: number } | null;
  renderedAt?: string;
  mtime: number;
}

export interface Project {
  id: string;
  name: string;
  sources: string[];
  createdAt: string;
  brief: Brief | null;
  stages: Record<string, { status: string; error: string | null; finishedAt: string | null }>;
  report: {
    items: MediaItem[];
    transcripts: Record<
      string,
      { status: string; output?: { words: number; text: string } | null; error?: string }
    >;
  } | null;
  edl: { duration: number; total?: number; rows: EdlRow[] } | null;
  story: { beats: number; aiPlanned: boolean } | null;
  total: number | null;
  hasComposition: boolean;
  renders: RenderInfo[];
  updatedAt: number;
  error?: string;
}

export type BeatType = "hook" | "card" | "full" | "stats" | "badge" | "outro";

export interface Beat {
  id: string;
  type: BeatType;
  row?: string;
  at?: number;
  offset?: number;
  duration: number;
  chapter?: string;
  index?: string;
  kicker?: string;
  title?: string;
  accent?: string;
  note?: string;
  sub?: string;
  label?: string;
  image?: string;
  stat?: { value: string; unit: string; label: string };
  dates?: { label: string; value: string }[];
  bullets?: string[];
  rows?: { value: string; unit: string; label: string }[];
}

export interface Story {
  version: number;
  theme: { accent: string; brand: string };
  keywords: string[];
  music: { enabled: boolean; rel: string | null; volume: number };
  sfx: { enabled: boolean; volume: number };
  beats: Beat[];
}

export interface PlacedBeat extends Beat {
  start: number | null;
  hidden?: boolean;
}

export interface Timeline {
  total: number;
  intro: number;
  footage: number;
  outro: number;
  clips: {
    source: string;
    sourceIn: number;
    sourceOut: number;
    start: number;
    duration: number;
    rows: string[];
  }[];
  rows: Record<string, { start: number; end: number }>;
  beats: PlacedBeat[];
  chapters: { label: string; start: number; end: number }[];
  captions: { start: number; end: number; text: string }[];
  audio: { id: string; src: string; start: number; duration: number }[];
}

export interface EditorState {
  timeline: Timeline | null;
  story: Story | null;
  brief: Brief | null;
  rows: EdlRow[];
  images: { id: string; name: string }[];
  proxies: { ready: number; total: number };
}

export interface Health {
  ok: boolean;
  studioRoot: string;
  soundLibrary: string;
  tools: {
    ffmpeg: boolean;
    whisper: boolean;
    claude: boolean;
    claudeApi: boolean;
    sounds: boolean;
  };
  voice: VoiceStatus;
}

export interface VoiceStatus {
  vbee: { configured: boolean; voice: string };
  elevenlabs: { configured: boolean; model: string; voice: string | null };
  maxChars: number;
}

export interface JobEvent {
  type: "log" | "ai" | "tool" | "thinking" | "done" | "error";
  text: string;
  at: number;
}

export interface ChatMsg {
  role: "user" | "ai";
  text: string;
  tools?: string[];
  at: number;
}

export interface Sound {
  rel: string;
  role: string;
  name: string;
}

export class EngineError extends Error {
  status: number;
  blocked: boolean;
  constructor(message: string, status: number, blocked: boolean) {
    super(message);
    this.status = status;
    this.blocked = blocked;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(ENGINE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; blocked?: boolean };
    throw new EngineError(b.error || res.statusText, res.status, Boolean(b.blocked));
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const api = {
  health: () => call<Health>("/api/health"),
  projects: () => call<Project[]>("/api/projects"),
  project: (id: string) => call<Project>(`/api/projects/${id}`),
  createProject: (name: string, sources: string[]) =>
    call<Project>("/api/projects", json("POST", { name, sources })),
  deleteProject: (id: string) => call<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  renameProject: (id: string, name: string) =>
    call<Project>(`/api/projects/${id}/meta`, json("PUT", { name })),
  saveBrief: (id: string, brief: Brief) =>
    call<Project>(`/api/projects/${id}/brief`, json("PUT", brief)),
  saveSources: (id: string, sources: string[]) =>
    call<Project>(`/api/projects/${id}/sources`, json("PUT", { sources })),
  saveEdl: (id: string, keep: Record<string, boolean>, captionText: Record<string, string> = {}) =>
    call<Project>(`/api/projects/${id}/edl`, json("PUT", { keep, captionText })),
  run: (id: string, steps: string[], force = false) =>
    call<{ job: string }>(`/api/projects/${id}/run`, json("POST", { steps, force })),
  editor: (id: string) => call<EditorState>(`/api/projects/${id}/editor`),
  saveStory: (id: string, story: Story, force = false) =>
    call<EditorState>(`/api/projects/${id}/story`, json("PUT", { story, force })),
  recompose: (id: string, force = false) =>
    call<EditorState>(`/api/projects/${id}/recompose`, json("POST", { force })),
  chatHistory: (id: string) => call<ChatMsg[]>(`/api/projects/${id}/chat`),
  chat: (id: string, message: string, context: { time?: number; beat?: string } = {}) =>
    call<{ job: string }>(`/api/projects/${id}/chat`, json("POST", { message, context })),
  chatReset: (id: string) =>
    call<{ ok: boolean }>(`/api/projects/${id}/chat`, json("POST", { reset: true })),
  studio: (id: string) => call<{ url: string }>(`/api/projects/${id}/studio`, json("POST", {})),
  openFolder: (id: string) =>
    call<{ ok: boolean }>(`/api/projects/${id}/open-folder`, json("POST", {})),
  sounds: (role?: string) => call<Sound[]>(`/api/library/sounds${role ? `?role=${role}` : ""}`),
  soundUrl: (rel: string) =>
    `${ENGINE}/library/sound/${rel.split("/").map(encodeURIComponent).join("/")}`,
  voiceSettings: (values: Record<string, string>) =>
    call<VoiceStatus>("/api/settings/voice", json("PUT", values)),
  voices: (provider: string) =>
    call<{ id: string; name: string; gender?: string }[]>(`/api/voices/${provider}`),
  fileUrl: (id: string, rel: string) =>
    `${ENGINE}/files/${id}/${rel.split("/").map(encodeURIComponent).join("/")}`,
  previewUrl: (id: string, v: number) => `${ENGINE}/preview/${id}/index.html?v=${v}`,
};

/** Follow a job's events until it ends. Returns a function that stops listening. */
export function followJob(jobId: string, onEvent: (e: JobEvent) => void): () => void {
  const es = new EventSource(`${ENGINE}/api/jobs/${jobId}/events`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data) as JobEvent;
    onEvent(e);
    if (e.type === "done" || e.type === "error") es.close();
  };
  es.onerror = () => es.close();
  return () => es.close();
}

let playerLoaded: Promise<void> | null = null;
/** Load the HyperFrames player web component once (served by the engine from this checkout). */
export function loadPlayer(): Promise<void> {
  if (customElements.get("hyperframes-player")) return Promise.resolve();
  playerLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${ENGINE}/hf/player.js`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Không tải được HyperFrames player"));
    document.head.appendChild(s);
  });
  return playerLoaded;
}
