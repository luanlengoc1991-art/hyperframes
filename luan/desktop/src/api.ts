// Client for the local engine (luan/engine/server.mjs).
export const ENGINE = "http://127.0.0.1:4500";

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
  keep: boolean;
  reason: string;
}

export interface Brief {
  title: string;
  subtitle: string;
  cta: string;
  hotline: string;
  targetDuration: number | null;
  captions: boolean;
}

export interface RenderInfo {
  file: string;
  duration?: number;
  sizeMB?: number;
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
  edl: { duration: number; rows: EdlRow[] } | null;
  hasComposition: boolean;
  renders: RenderInfo[];
  updatedAt: number;
}

export interface Health {
  ok: boolean;
  studioRoot: string;
  tools: { ffmpeg: boolean; whisper: boolean; claude: boolean; claudeApi: boolean };
  voice: VoiceStatus;
}

export interface VoiceStatus {
  vbee: { configured: boolean; voice: string };
  elevenlabs: { configured: boolean; model: string; voice: string | null };
  maxChars: number;
}

export interface JobEvent {
  type: "log" | "done" | "error";
  text: string;
  at: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(ENGINE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
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
  saveBrief: (id: string, brief: Brief) =>
    call<Project>(`/api/projects/${id}/brief`, json("PUT", brief)),
  saveSources: (id: string, sources: string[]) =>
    call<Project>(`/api/projects/${id}/sources`, json("PUT", { sources })),
  saveEdl: (id: string, keep: Record<string, boolean>) =>
    call<Project>(`/api/projects/${id}/edl`, json("PUT", { keep })),
  run: (id: string, steps: string[]) =>
    call<{ job: string }>(`/api/projects/${id}/run`, json("POST", { steps })),
  chat: (id: string, message: string) =>
    call<{ job: string }>(`/api/projects/${id}/chat`, json("POST", { message })),
  studio: (id: string) => call<{ url: string }>(`/api/projects/${id}/studio`, json("POST", {})),
  openFolder: (id: string) =>
    call<{ ok: boolean }>(`/api/projects/${id}/open-folder`, json("POST", {})),
  voiceSettings: (values: Record<string, string>) =>
    call<VoiceStatus>("/api/settings/voice", json("PUT", values)),
  voices: (provider: string) =>
    call<{ id: string; name: string; gender?: string }[]>(`/api/voices/${provider}`),
  fileUrl: (id: string, rel: string) =>
    `${ENGINE}/files/${id}/${rel.split("/").map(encodeURIComponent).join("/")}`,
};

/** Follow a job's events until it ends. Returns a function that stops listening. */
export function followJob(jobId: string, onEvent: (e: JobEvent) => void): () => void {
  const es = new EventSource(`${ENGINE}/api/jobs/${jobId}/events`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data) as JobEvent;
    onEvent(e);
    if (e.type !== "log") es.close();
  };
  es.onerror = () => es.close();
  return () => es.close();
}
