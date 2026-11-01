import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, followJob, type Brief, type Health, type JobEvent, type Project } from "./api";

type View = { kind: "home" } | { kind: "project"; id: string } | { kind: "settings" };
type Tab = "overview" | "media" | "script" | "brief" | "editor" | "video" | "chat";

const STEP_LABEL: Record<string, string> = {
  analyze: "Phân tích tư liệu",
  compose: "Dựng video",
  validate: "Kiểm tra",
  render: "Xuất MP4",
};
const ROLE_LABEL: Record<string, string> = {
  "a-roll-candidate": "A-roll (lời nói)",
  "b-roll": "B-roll",
  image: "Ảnh",
  music: "Nhạc",
  sfx: "SFX",
  document: "Tài liệu",
};
const fmtSec = (s?: number | null) =>
  s == null ? "–" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// ---------- jobs ----------

function useJob(onFinish?: () => void) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef<() => void>(() => {});
  const start = useCallback(
    async (begin: () => Promise<{ job: string }>) => {
      setEvents([]);
      setRunning(true);
      try {
        const { job } = await begin();
        stop.current = followJob(job, (e) => {
          setEvents((prev) => [...prev, e]);
          if (e.type !== "log") {
            setRunning(false);
            onFinish?.();
          }
        });
      } catch (err) {
        setEvents([{ type: "error", text: String((err as Error).message), at: Date.now() }]);
        setRunning(false);
      }
    },
    [onFinish],
  );
  useEffect(() => () => stop.current(), []);
  return { events, running, start };
}

function JobLog({ events, running }: { events: JobEvent[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [events]);
  if (!events.length && !running) return null;
  const last = events[events.length - 1];
  return (
    <div className="joblog">
      <div className="joblog-head">
        {running ? (
          <span className="pill run">Đang chạy…</span>
        ) : last?.type === "done" ? (
          <span className="pill ok">Xong</span>
        ) : (
          <span className="pill err">Dừng</span>
        )}
      </div>
      <div className="joblog-body" ref={ref}>
        {events.map((e, i) => (
          <div key={i} className={`line ${e.type}`}>
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- app ----------

export function App() {
  const [view, setView] = useState<View>({ kind: "home" });
  const [health, setHealth] = useState<Health | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [h, list] = await Promise.all([api.health(), api.projects()]);
      setHealth(h);
      setProjects(list);
      setEngineError(null);
    } catch {
      setEngineError("Chưa kết nối được engine (đang khởi động hoặc thiếu Node.js)");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">L</span>
          <div>
            <b>LUAN AI</b>
            <small>VIDEO STUDIO</small>
          </div>
        </div>
        <button className="btn primary wide" onClick={() => setCreating(true)}>
          + Dự án mới
        </button>
        <div className="side-label">Dự án</div>
        <nav className="plist">
          {projects.map((p) => (
            <button
              key={p.id}
              className={`pitem ${view.kind === "project" && view.id === p.id ? "active" : ""}`}
              onClick={() => setView({ kind: "project", id: p.id })}
            >
              <span className="pname">{p.name}</span>
              <span className="psub">
                {p.renders.length
                  ? `${p.renders.length} video`
                  : p.hasComposition
                    ? "Đã dựng"
                    : Object.keys(p.stages).length
                      ? "Đã phân tích"
                      : "Mới"}
              </span>
            </button>
          ))}
          {!projects.length && <div className="muted small pad">Chưa có dự án</div>}
        </nav>
        <button
          className={`btn ghost wide ${view.kind === "settings" ? "active" : ""}`}
          onClick={() => setView({ kind: "settings" })}
        >
          ⚙ Cài đặt
        </button>
        <div className="status">
          {engineError ? (
            <span className="bad">● {engineError}</span>
          ) : health ? (
            <>
              <span className="good">● Engine</span>
              <span className={health.tools.ffmpeg ? "good" : "bad"}>● FFmpeg</span>
              <span className={health.tools.whisper ? "good" : "bad"}>● Nhận giọng</span>
              <span className={health.tools.claude || health.tools.claudeApi ? "good" : "bad"}>
                ● Claude
              </span>
              <span
                className={
                  health.voice.vbee.configured || health.voice.elevenlabs.configured
                    ? "good"
                    : "warn"
                }
              >
                ● Giọng AI
              </span>
            </>
          ) : (
            <span className="muted">Đang kết nối…</span>
          )}
        </div>
      </aside>

      <main className="main">
        {view.kind === "home" && (
          <Home
            projects={projects}
            onOpen={(id) => setView({ kind: "project", id })}
            onNew={() => setCreating(true)}
          />
        )}
        {view.kind === "project" && <ProjectView key={view.id} id={view.id} onChanged={refresh} />}
        {view.kind === "settings" && <Settings health={health} onSaved={refresh} />}
      </main>

      {creating && (
        <NewProject
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            refresh();
            setView({ kind: "project", id: p.id });
          }}
        />
      )}
    </div>
  );
}

function Home({
  projects,
  onOpen,
  onNew,
}: {
  projects: Project[];
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const videos = projects
    .flatMap((p) => p.renders.map((r) => ({ p, r })))
    .sort((a, b) => b.r.mtime - a.r.mtime)
    .slice(0, 6);
  return (
    <div className="page">
      <h1>Bảng điều khiển</h1>
      <p className="muted">Chọn thư mục tư liệu, AI tự phân tích, dựng, kiểm tra và xuất TVC.</p>
      <div className="cards">
        <div className="card stat">
          <b>{projects.length}</b>
          <span>dự án</span>
        </div>
        <div className="card stat">
          <b>{projects.reduce((n, p) => n + p.renders.length, 0)}</b>
          <span>video đã xuất</span>
        </div>
        <button className="card stat action" onClick={onNew}>
          <b>+</b>
          <span>Tạo dự án mới</span>
        </button>
      </div>
      <h2>Video gần đây</h2>
      {videos.length ? (
        <div className="grid">
          {videos.map(({ p, r }) => (
            <button key={p.id + r.file} className="vcard" onClick={() => onOpen(p.id)}>
              <video src={`${api.fileUrl(p.id, r.file)}#t=2`} preload="metadata" muted />
              <span className="vname">{p.name}</span>
              <span className="muted small">
                {fmtSec(r.duration)} · {r.video ? `${r.video.width}×${r.video.height}` : ""} ·{" "}
                {r.sizeMB ?? "?"} MB
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">Chưa có video nào.</p>
      )}
    </div>
  );
}

function NewProject({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [name, setName] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (directory: boolean) => {
    try {
      const r = await open({
        directory,
        multiple: true,
        title: directory ? "Chọn thư mục tư liệu" : "Chọn file tư liệu",
      });
      const list = Array.isArray(r) ? r : r ? [r] : [];
      setSources((prev) => [...new Set([...prev, ...list])]);
    } catch (e) {
      setError(`Không mở được hộp chọn thư mục: ${(e as Error).message}`);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createProject(name, sources));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Dự án mới</h2>
        <label>
          Tên dự án
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="VD: Vinhomes Cần Giờ — Phân khu Vịnh Tiên"
            autoFocus
          />
        </label>
        <div className="label">Tư liệu (video thô, ảnh, logo, nhạc, tài liệu)</div>
        <div className="row">
          <button className="btn" onClick={() => pick(true)}>
            + Thêm thư mục
          </button>
          <button className="btn" onClick={() => pick(false)}>
            + Thêm file
          </button>
        </div>
        <ul className="srclist">
          {sources.map((s) => (
            <li key={s}>
              <span>{s}</span>
              <button className="x" onClick={() => setSources(sources.filter((x) => x !== s))}>
                ×
              </button>
            </li>
          ))}
          {!sources.length && <li className="muted">Chưa chọn tư liệu</li>}
        </ul>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn primary"
            disabled={!name.trim() || !sources.length || busy}
            onClick={create}
          >
            Tạo dự án
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- project ----------

function ProjectView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [p, setP] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setP(await api.project(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  const finished = useCallback(() => {
    load();
    onChanged();
  }, [load, onChanged]);
  const job = useJob(finished);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="page error">{error}</div>;
  if (!p) return <div className="page muted">Đang tải…</div>;

  const run = (steps: string[]) => job.start(() => api.run(id, steps));
  const tabs: [Tab, string][] = [
    ["overview", "Tổng quan"],
    ["media", "Tư liệu"],
    ["script", "Kịch bản"],
    ["brief", "Brief"],
    ["editor", "Chỉnh sửa"],
    ["video", `Video${p.renders.length ? ` (${p.renders.length})` : ""}`],
    ["chat", "Chat AI"],
  ];

  return (
    <div className="page project">
      <header className="phead">
        <div>
          <h1>{p.name}</h1>
          <div className="muted small">{p.sources.join(" · ")}</div>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => api.openFolder(id)}>
            Mở thư mục
          </button>
          <button
            className="btn primary"
            disabled={job.running}
            onClick={() => run(["analyze", "compose", "validate", "render"])}
          >
            ▶ Làm tất cả
          </button>
        </div>
      </header>
      <nav className="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="tabbody">
        {tab === "overview" && <Overview p={p} running={job.running} run={run} />}
        {tab === "media" && <Media p={p} />}
        {tab === "script" && (
          <Script p={p} onSaved={(np) => (setP(np), run(["compose", "validate"]))} />
        )}
        {tab === "brief" && (
          <BriefForm p={p} onSaved={(np) => (setP(np), run(["compose", "validate"]))} />
        )}
        {tab === "editor" && <Editor p={p} />}
        {tab === "video" && <Videos p={p} />}
        {tab === "chat" && <Chat p={p} onDone={finished} />}
      </div>
      {tab !== "chat" && <JobLog events={job.events} running={job.running} />}
    </div>
  );
}

function Overview({
  p,
  running,
  run,
}: {
  p: Project;
  running: boolean;
  run: (s: string[]) => void;
}) {
  const stageStatus = (step: string) => {
    if (step === "analyze") {
      const keys = Object.keys(p.stages).filter(
        (k) => k.startsWith("analyze:") || k.startsWith("transcribe:"),
      );
      if (!keys.length) return "chưa chạy";
      if (keys.some((k) => p.stages[k].status === "failed")) return "lỗi";
      if (keys.some((k) => p.stages[k].status === "blocked")) return "bị chặn";
      return "xong";
    }
    if (step === "validate") return p.hasComposition ? "chạy khi dựng" : "chưa chạy";
    const s = p.stages[step]?.status;
    return s === "done"
      ? "xong"
      : s === "failed"
        ? "lỗi"
        : s === "blocked"
          ? "bị chặn"
          : "chưa chạy";
  };
  return (
    <div>
      <div className="steps">
        {["analyze", "compose", "validate", "render"].map((s, i) => (
          <div key={s} className="step">
            <span className="num">{i + 1}</span>
            <div className="grow">
              <b>{STEP_LABEL[s]}</b>
              <div className={`small st-${stageStatus(s).replace(/\s/g, "-")}`}>
                {stageStatus(s)}
              </div>
            </div>
            <button className="btn" disabled={running} onClick={() => run([s])}>
              Chạy
            </button>
          </div>
        ))}
      </div>
      <div className="cards">
        <div className="card stat">
          <b>{p.report?.items.length ?? 0}</b>
          <span>tư liệu</span>
        </div>
        <div className="card stat">
          <b>{p.edl ? `${p.edl.rows.filter((r) => r.keep).length}/${p.edl.rows.length}` : "–"}</b>
          <span>câu được giữ</span>
        </div>
        <div className="card stat">
          <b>{p.edl ? fmtSec(p.edl.duration) : "–"}</b>
          <span>thời lượng dựng</span>
        </div>
      </div>
    </div>
  );
}

function Media({ p }: { p: Project }) {
  if (!p.report)
    return <p className="muted">Chưa phân tích. Bấm “Chạy” ở bước Phân tích tư liệu.</p>;
  return (
    <div className="media">
      {p.report.items.map((m) => {
        const t = p.report?.transcripts[m.id];
        return (
          <div key={m.id} className="mitem">
            {m.contactSheet ? (
              <img src={api.fileUrl(p.id, m.contactSheet)} alt="" />
            ) : (
              <div className="noimg">{ROLE_LABEL[m.role] || m.role}</div>
            )}
            <div className="minfo">
              <b>{m.id}</b>
              <span className="tag">{ROLE_LABEL[m.role] || m.role}</span>
              <div className="small muted">
                {fmtSec(m.duration)} ·{" "}
                {m.video
                  ? `${m.video.width}×${m.video.height} ${m.video.fps}fps ${m.video.codec}`
                  : ""}
                {m.integratedLufs != null
                  ? ` · ${m.integratedLufs} LUFS, đỉnh ${m.truePeakDbtp} dBTP`
                  : ""}
              </div>
              {m.flags?.length ? <div className="small warn">⚠ {m.flags.join("; ")}</div> : null}
              {t && (
                <div className="small transcript">
                  {t.status === "done"
                    ? `“${t.output?.text}…”`
                    : `Transcript: ${t.status} — ${t.error}`}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Script({ p, onSaved }: { p: Project; onSaved: (p: Project) => void }) {
  const [keep, setKeep] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((p.edl?.rows || []).map((r) => [r.id, r.keep])),
  );
  const [saving, setSaving] = useState(false);
  if (!p.edl) return <p className="muted">Chưa có kịch bản dựng. Chạy Phân tích rồi Dựng video.</p>;
  const kept = p.edl.rows.filter((r) => keep[r.id]);
  const total = kept.reduce((s, r) => s + (r.sourceOut - r.sourceIn), 0);
  const changed = p.edl.rows.some((r) => keep[r.id] !== r.keep);
  return (
    <div>
      <div className="row between">
        <div className="muted">
          Giữ {kept.length}/{p.edl.rows.length} câu · khoảng {fmtSec(total)}. Bỏ chọn câu để cắt
          khỏi video (không xoá footage gốc).
        </div>
        <button
          className="btn primary"
          disabled={!changed || saving}
          onClick={async () => {
            setSaving(true);
            try {
              onSaved(await api.saveEdl(p.id, keep));
            } finally {
              setSaving(false);
            }
          }}
        >
          Lưu & dựng lại
        </button>
      </div>
      <table className="edl">
        <thead>
          <tr>
            <th>Giữ</th>
            <th>Clip</th>
            <th>Vào – Ra</th>
            <th>Lời thoại</th>
          </tr>
        </thead>
        <tbody>
          {p.edl.rows.map((r) => (
            <tr key={r.id} className={keep[r.id] ? "" : "dropped"}>
              <td>
                <input
                  type="checkbox"
                  checked={Boolean(keep[r.id])}
                  onChange={(e) => setKeep({ ...keep, [r.id]: e.target.checked })}
                />
              </td>
              <td className="small">{r.source}</td>
              <td className="small mono">
                {r.sourceIn.toFixed(1)}s – {r.sourceOut.toFixed(1)}s
              </td>
              <td>{r.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EMPTY_BRIEF: Brief = {
  title: "",
  subtitle: "",
  cta: "Liên hệ tư vấn",
  hotline: "",
  targetDuration: null,
  captions: true,
};

function BriefForm({ p, onSaved }: { p: Project; onSaved: (p: Project) => void }) {
  const [b, setB] = useState<Brief>({ ...EMPTY_BRIEF, ...(p.brief || {}) });
  const [saving, setSaving] = useState(false);
  const field = (k: keyof Brief, label: string, ph = "") => (
    <label>
      {label}
      <input
        value={String(b[k] ?? "")}
        placeholder={ph}
        onChange={(e) => setB({ ...b, [k]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="form">
      <p className="muted">
        Chỉ nhập thông tin đã xác minh. AI không tự thêm giá, pháp lý hay ngày tháng.
      </p>
      {field("title", "Tiêu đề mở đầu", "VD: Vinhomes Green Paradise Cần Giờ")}
      {field("subtitle", "Dòng phụ", "VD: Phân khu Vịnh Tiên")}
      {field("cta", "Lời kêu gọi (CTA)", "Liên hệ tư vấn")}
      {field("hotline", "Hotline", "VD: 09xx xxx xxx")}
      <label>
        Thời lượng mục tiêu (giây, để trống = giữ hết)
        <input
          type="number"
          value={b.targetDuration ?? ""}
          onChange={(e) =>
            setB({ ...b, targetDuration: e.target.value ? Number(e.target.value) : null })
          }
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={b.captions}
          onChange={(e) => setB({ ...b, captions: e.target.checked })}
        />{" "}
        Phụ đề theo từng từ
      </label>
      <button
        className="btn primary"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            onSaved(await api.saveBrief(p.id, b));
          } finally {
            setSaving(false);
          }
        }}
      >
        Lưu & dựng lại
      </button>
    </div>
  );
}

function Editor({ p }: { p: Project }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!p.hasComposition)
    return <p className="muted">Chưa dựng video. Chạy bước Dựng video trước.</p>;
  const openStudio = async () => {
    setBusy(true);
    setError(null);
    try {
      setUrl((await api.studio(p.id)).url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="editor">
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={openStudio}>
          {busy ? "Đang mở…" : url ? "Tải lại Studio" : "Mở HyperFrames Studio"}
        </button>
        {url && (
          <button className="btn ghost" onClick={() => openUrl(url)}>
            Mở cửa sổ riêng
          </button>
        )}
        <span className="muted small">
          Sửa timeline, chữ, hiệu ứng, âm thanh. Thay đổi được lưu vào project.
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      {url && <iframe className="studio" src={url} title="HyperFrames Studio" />}
    </div>
  );
}

function Videos({ p }: { p: Project }) {
  const [current, setCurrent] = useState(p.renders[0]?.file || null);
  if (!p.renders.length)
    return <p className="muted">Chưa xuất video. Bấm “Chạy” ở bước Xuất MP4.</p>;
  return (
    <div className="videos">
      {current && <video className="player" src={api.fileUrl(p.id, current)} controls />}
      <div className="vlist">
        {p.renders.map((r) => (
          <button
            key={r.file}
            className={`vrow ${r.file === current ? "active" : ""}`}
            onClick={() => setCurrent(r.file)}
          >
            <b>{r.file.replace("renders/", "")}</b>
            <span className="small muted">
              {fmtSec(r.duration)} · {r.video ? `${r.video.width}×${r.video.height}` : ""} ·{" "}
              {r.sizeMB ?? "?"} MB · {new Date(r.mtime).toLocaleString("vi-VN")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface ChatMsg {
  role: "user" | "ai";
  text: string;
}

function Chat({ p, onDone }: { p: Project; onDone: () => void }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const job = useJob(onDone);
  const live = useMemo(() => job.events.map((e) => e.text).join("\n"), [job.events]);
  const send = () => {
    const text = input.trim();
    if (!text) return;
    if (live) setMsgs((m) => [...m, { role: "ai", text: live }]);
    setMsgs((m) => [...m, { role: "user", text }]);
    setInput("");
    job.start(() => api.chat(p.id, text));
  };
  return (
    <div className="chat">
      <div className="msgs">
        {!msgs.length && !live && (
          <div className="muted">
            Ra lệnh bằng tiếng Việt, ví dụ: “Rút xuống 45 giây, giữ đoạn giới thiệu VinWonders”,
            “Đổi tiêu đề thành …”, “Xuất lại video”.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {live && <div className={`msg ai ${job.running ? "typing" : ""}`}>{live}</div>}
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Nhập yêu cầu cho Claude…"
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
        />
        <button className="btn primary" disabled={job.running || !input.trim()} onClick={send}>
          Gửi
        </button>
      </div>
    </div>
  );
}

// ---------- settings ----------

interface EngineInfo {
  script: string;
  script_exists: boolean;
  node: string | null;
  running: boolean;
  started_by_app: boolean;
}

function Settings({ health, onSaved }: { health: Health | null; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  useEffect(() => {
    invoke<EngineInfo>("engine_info")
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  const field = (k: string, label: string, secret = false) => (
    <label>
      {label}
      <input
        type={secret ? "password" : "text"}
        value={values[k] ?? ""}
        placeholder={secret ? "(giữ nguyên nếu để trống)" : ""}
        onChange={(e) => setValues({ ...values, [k]: e.target.value })}
      />
    </label>
  );
  const save = async () => {
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""));
    try {
      await api.voiceSettings(filled);
      setValues({});
      setMsg("Đã lưu (chỉ trên máy này).");
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="page form">
      <h1>Cài đặt</h1>
      <h2>Giọng AI</h2>
      <p className="muted small">
        Vbee: {health?.voice.vbee.configured ? "đã cấu hình" : "chưa có key"} · ElevenLabs:{" "}
        {health?.voice.elevenlabs.configured ? "đã cấu hình" : "chưa có key"} · Giới hạn{" "}
        {health?.voice.maxChars} ký tự/lần. Key lưu trong luan/.env.local, không lên GitHub.
      </p>
      {field("VBEE_APP_ID", "Vbee App ID")}
      {field("VBEE_TOKEN", "Vbee Token", true)}
      {field("VBEE_VOICE_CODE", "Vbee giọng (mã)")}
      {field("ELEVENLABS_API_KEY", "ElevenLabs API Key", true)}
      {field("ELEVENLABS_VOICE_ID", "ElevenLabs Voice ID")}
      {field("LUAN_TTS_MAX_CHARS", "Giới hạn ký tự mỗi lần")}
      <button className="btn primary" onClick={save}>
        Lưu
      </button>
      {msg && <p className="muted">{msg}</p>}

      <h2>Engine</h2>
      {info ? (
        <div className="small">
          <div>
            Engine: {info.script} {info.script_exists ? "" : "(không tìm thấy)"}
          </div>
          <div>Node: {info.node ?? "chưa cài"}</div>
          <div>Trạng thái: {info.running ? "đang chạy" : "đã dừng"}</div>
          <button
            className="btn"
            onClick={() =>
              invoke("restart_engine").then(() => invoke<EngineInfo>("engine_info").then(setInfo))
            }
          >
            Khởi động lại engine
          </button>
        </div>
      ) : (
        <p className="muted small">Thông tin engine chỉ có khi chạy trong app.</p>
      )}
      {health && (
        <div className="small muted">
          Thư mục dữ liệu: {health.studioRoot} · Claude:{" "}
          {health.tools.claudeApi
            ? "Claude API"
            : health.tools.claude
              ? "Claude Code trên máy"
              : "chưa có"}
        </div>
      )}
    </div>
  );
}
