import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Brief,
  type Correction,
  type Health,
  type JobEvent,
  type Project,
  type Sound,
  followJob,
} from "./api";
import { Editor } from "./Editor";

type View =
  | { kind: "home" }
  | { kind: "project"; id: string }
  | { kind: "library" }
  | { kind: "settings" };
type Tab = "flow" | "editor" | "script" | "media" | "brief" | "video";

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
const fmtDate = (ms: number) =>
  ms ? new Date(ms).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "–";

/** One status word for a project: where it is in the workflow. */
function phase(p: Project): { label: string; cls: string } {
  if (p.error) return { label: "Lỗi dữ liệu", cls: "bad" };
  if (p.renders.length) return { label: `Đã xuất ${p.renders.length} video`, cls: "ok" };
  if (p.story?.aiPlanned) return { label: "Có storyboard AI", cls: "run" };
  if (p.hasComposition) return { label: "Đã dựng", cls: "run" };
  if (p.report) return { label: "Đã phân tích", cls: "run" };
  return { label: "Mới", cls: "" };
}

// ---------- jobs ----------

function useJob(onFinish?: () => void) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const stop = useRef<() => void>(() => {});
  const start = useCallback(
    async (kind: string, begin: () => Promise<{ job: string }>) => {
      setEvents([]);
      setRunning(kind);
      try {
        const { job } = await begin();
        stop.current = followJob(job, (e) => {
          setEvents((prev) => [...prev, e]);
          if (e.type === "done" || e.type === "error") {
            setRunning(null);
            onFinish?.();
          }
        });
      } catch (err) {
        setEvents([{ type: "error", text: String((err as Error).message), at: Date.now() }]);
        setRunning(null);
      }
    },
    [onFinish],
  );
  useEffect(() => () => stop.current(), []);
  return { events, running, start, clear: () => setEvents([]) };
}

function JobLog({
  events,
  running,
  onClose,
}: {
  events: JobEvent[];
  running: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [events, open]);
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
        <span className="small grow ellipsis">{last?.text}</span>
        <button className="btn small ghost" onClick={() => setOpen(!open)}>
          {open ? "Thu gọn" : "Xem log"}
        </button>
        {!running && (
          <button className="btn small ghost" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {open && (
        <div className="joblog-body" ref={ref}>
          {events.map((e, i) => (
            <div key={i} className={`line ${e.type}`}>
              {e.type === "tool" ? "⚙ " : ""}
              {e.text}
            </div>
          ))}
        </div>
      )}
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
  const [q, setQ] = useState("");

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
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  const project = view.kind === "project";
  return (
    <div className={`app ${project ? "wide-main" : ""}`}>
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
        <button
          className={`navitem ${view.kind === "home" ? "active" : ""}`}
          onClick={() => setView({ kind: "home" })}
        >
          ▦ Bảng điều khiển
        </button>
        <button
          className={`navitem ${view.kind === "library" ? "active" : ""}`}
          onClick={() => setView({ kind: "library" })}
        >
          ♪ Thư viện
        </button>
        <div className="side-label">Dự án ({projects.length})</div>
        <input
          className="search"
          placeholder="Tìm dự án…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <nav className="plist">
          {shown.map((p) => (
            <button
              key={p.id}
              className={`pitem ${view.kind === "project" && view.id === p.id ? "active" : ""}`}
              onClick={() => setView({ kind: "project", id: p.id })}
            >
              <span className="pname">{p.name}</span>
              <span className={`psub ${phase(p).cls}`}>{phase(p).label}</span>
            </button>
          ))}
          {!shown.length && <div className="muted small pad">Chưa có dự án</div>}
        </nav>
        <button
          className={`navitem ${view.kind === "settings" ? "active" : ""}`}
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
              <span className={health.tools.sounds ? "good" : "warn"}>● Nhạc/SFX</span>
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
            onChanged={refresh}
          />
        )}
        {view.kind === "project" && <ProjectView key={view.id} id={view.id} onChanged={refresh} />}
        {view.kind === "library" && (
          <Library projects={projects} onOpen={(id) => setView({ kind: "project", id })} />
        )}
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
  onChanged,
}: {
  projects: Project[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onChanged: () => void;
}) {
  const videos = projects
    .flatMap((p) => p.renders.map((r) => ({ p, r })))
    .sort((a, b) => b.r.mtime - a.r.mtime)
    .slice(0, 4);
  const rename = async (p: Project) => {
    const name = window.prompt("Tên mới cho dự án", p.name);
    if (name?.trim())
      await api
        .renameProject(p.id, name.trim())
        .then(onChanged)
        .catch((e) => alert(e.message));
  };
  const remove = async (p: Project) => {
    if (
      window.confirm(`Chuyển dự án “${p.name}” vào thùng rác (_trash)? Footage gốc không bị xoá.`)
    )
      await api
        .deleteProject(p.id)
        .then(onChanged)
        .catch((e) => alert(e.message));
  };
  return (
    <div className="page">
      <h1>Bảng điều khiển</h1>
      <p className="muted">
        Quy trình: Tư liệu → Phân tích → AI storyboard → Dựng & chỉnh → Kiểm tra → Xuất MP4.
      </p>
      <div className="cards">
        <div className="card stat">
          <b>{projects.length}</b>
          <span>dự án</span>
        </div>
        <div className="card stat">
          <b>{projects.filter((p) => p.hasComposition && !p.renders.length).length}</b>
          <span>đang dựng</span>
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
      <h2>Quản lý dự án</h2>
      <table className="ptable">
        <thead>
          <tr>
            <th>Dự án</th>
            <th>Trạng thái</th>
            <th>Thời lượng</th>
            <th>Hiệu ứng</th>
            <th>Video</th>
            <th>Cập nhật</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td>
                <button className="link strong" onClick={() => onOpen(p.id)}>
                  {p.name}
                </button>
                <div className="small muted ellipsis">{p.sources.join(" · ")}</div>
              </td>
              <td>
                <span className={`pill ${phase(p).cls}`}>{phase(p).label}</span>
              </td>
              <td>{fmtSec(p.total ?? p.edl?.duration)}</td>
              <td>{p.story ? `${p.story.beats}${p.story.aiPlanned ? " · AI" : ""}` : "–"}</td>
              <td>{p.renders.length}</td>
              <td className="small">{fmtDate(p.updatedAt)}</td>
              <td className="actions">
                <button className="btn small" onClick={() => onOpen(p.id)}>
                  Mở
                </button>
                <button className="btn small ghost" onClick={() => rename(p)}>
                  Đổi tên
                </button>
                <button className="btn small ghost" onClick={() => api.openFolder(p.id)}>
                  Thư mục
                </button>
                <button className="btn small danger" onClick={() => remove(p)}>
                  Xoá
                </button>
              </td>
            </tr>
          ))}
          {!projects.length && (
            <tr>
              <td colSpan={7} className="muted">
                Chưa có dự án. Bấm “+ Dự án mới” và chọn thư mục footage.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {videos.length > 0 && (
        <>
          <h2>Video gần đây</h2>
          <div className="grid">
            {videos.map(({ p, r }) => (
              <button key={p.id + r.file} className="vcard" onClick={() => onOpen(p.id)}>
                <video src={`${api.fileUrl(p.id, r.file)}#t=2`} preload="metadata" muted />
                <span className="vname">{p.name}</span>
                <span className="muted small">
                  {fmtSec(r.duration)} · {r.sizeMB ?? "?"} MB · {fmtDate(r.mtime)}
                </span>
              </button>
            ))}
          </div>
        </>
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
        <div className="label">Tư liệu (video thô, ảnh phối cảnh, logo, tài liệu)</div>
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
  const [tab, setTab] = useState<Tab>("flow");
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

  const run = (steps: string[], force = false) =>
    job.start(steps.join("+"), () => api.run(id, steps, force));
  const tabs: [Tab, string][] = [
    ["flow", "Quy trình"],
    ["editor", "Dựng phim"],
    ["script", "Kịch bản"],
    ["media", "Tư liệu"],
    ["brief", "Brief"],
    ["video", `Video xuất${p.renders.length ? ` (${p.renders.length})` : ""}`],
  ];

  return (
    <div className={`page project ${tab === "editor" ? "editor-page" : ""}`}>
      <header className="phead">
        <div className="grow">
          <h1>{p.name}</h1>
          <div className="muted small ellipsis">{p.sources.join(" · ")}</div>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => api.openFolder(id)}>
            Mở thư mục
          </button>
          <button
            className="btn"
            disabled={Boolean(job.running) || !p.hasComposition}
            onClick={() => run(["validate", "render"])}
          >
            ⬇ Xuất MP4
          </button>
          <button
            className="btn primary"
            disabled={Boolean(job.running)}
            onClick={() =>
              run(
                p.report
                  ? ["plan", "compose", "validate"]
                  : ["analyze", "plan", "compose", "validate"],
              )
            }
            title="Phân tích (nếu chưa), Claude lên storyboard, dựng và kiểm tra"
          >
            ▶ AI làm tự động
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
        {tab === "flow" && (
          <Flow p={p} running={job.running} run={run} openEditor={() => setTab("editor")} />
        )}
        {tab === "editor" && (
          <Editor
            p={p}
            onProjectChanged={finished}
            runPlan={() => run(["plan", "compose"])}
            planRunning={Boolean(job.running)}
          />
        )}
        {tab === "script" && <Script p={p} onSaved={(np) => (setP(np), run(["compose"]))} />}
        {tab === "media" && <Media p={p} />}
        {tab === "brief" && <BriefForm p={p} onSaved={(np) => (setP(np), run(["compose"]))} />}
        {tab === "video" && <Videos p={p} />}
      </div>
      <JobLog events={job.events} running={job.running} onClose={job.clear} />
    </div>
  );
}

const FLOW = [
  {
    step: "analyze",
    title: "Phân tích tư liệu",
    desc: "Đo hình, tiếng, cảnh hỏng; nhận giọng tiếng Việt từng từ.",
  },
  {
    step: "plan",
    title: "AI lên storyboard",
    desc: "Claude chọn chương, thẻ thông tin, số liệu, mở đầu & kết; sửa chữ phụ đề nghe sai.",
  },
  {
    step: "compose",
    title: "Dựng video",
    desc: "Cắt bỏ khoảng lặng, ghép hiệu ứng, phụ đề tô từ khoá, nhạc & SFX.",
  },
  {
    step: "edit",
    title: "Chỉnh trên trình dựng",
    desc: "Xem trực tiếp, kéo thả timeline, sửa chữ, nhờ Claude sửa.",
  },
  {
    step: "validate",
    title: "Kiểm tra chất lượng",
    desc: "HyperFrames lint + check: bố cục, tương phản, chữ đủ to, lỗi runtime.",
  },
  { step: "render", title: "Xuất MP4", desc: "Render 1080×1920 chất lượng theo Brief." },
];

function Flow({
  p,
  running,
  run,
  openEditor,
}: {
  p: Project;
  running: string | null;
  run: (s: string[], force?: boolean) => void;
  openEditor: () => void;
}) {
  const status = (step: string): [string, string] => {
    if (step === "analyze") {
      const keys = Object.keys(p.stages).filter(
        (k) => k.startsWith("analyze:") || k.startsWith("transcribe:"),
      );
      if (!keys.length) return ["chưa chạy", ""];
      if (keys.some((k) => p.stages[k].status === "failed")) return ["lỗi", "bad"];
      if (keys.some((k) => p.stages[k].status === "blocked")) return ["bị chặn", "warn"];
      return ["xong", "ok"];
    }
    if (step === "plan")
      return p.story?.aiPlanned
        ? ["xong", "ok"]
        : p.story
          ? ["bản nháp tự động", "warn"]
          : ["chưa chạy", ""];
    if (step === "edit") return p.hasComposition ? ["sẵn sàng", "ok"] : ["chờ dựng", ""];
    if (step === "validate")
      return p.stages.render?.status === "done" ? ["xong", "ok"] : ["chạy trước khi xuất", ""];
    const s = p.stages[step];
    if (s?.status === "blocked") return ["bị chặn", "warn"];
    return s?.status === "done"
      ? ["xong", "ok"]
      : s?.status === "failed"
        ? ["lỗi", "bad"]
        : ["chưa chạy", ""];
  };
  const composeErr = p.stages.compose?.status === "blocked" ? p.stages.compose.error : null;
  return (
    <div>
      <div className="flow">
        {FLOW.map((f, i) => {
          const [label, cls] = status(f.step);
          return (
            <div key={f.step} className={`fstep ${cls}`}>
              <span className="num">{i + 1}</span>
              <div className="grow">
                <b>{f.title}</b>
                <div className="small muted">{f.desc}</div>
                <div className={`small st ${cls}`}>{label}</div>
              </div>
              {f.step === "edit" ? (
                <button className="btn" disabled={!p.hasComposition} onClick={openEditor}>
                  Mở trình dựng
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={Boolean(running) || (f.step !== "analyze" && !p.report)}
                  onClick={() =>
                    run(
                      f.step === "plan"
                        ? ["plan", "compose"]
                        : f.step === "render"
                          ? ["validate", "render"]
                          : [f.step],
                    )
                  }
                >
                  {running && running.includes(f.step) ? "Đang chạy…" : "Chạy"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {composeErr && (
        <div className="banner warn">
          {composeErr}
          <button className="btn small" onClick={() => run(["compose"], true)}>
            Ghi đè và dựng lại
          </button>
        </div>
      )}
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
          <b>{p.story?.beats ?? "–"}</b>
          <span>hiệu ứng</span>
        </div>
        <div className="card stat">
          <b>{fmtSec(p.total ?? p.edl?.duration)}</b>
          <span>thời lượng</span>
        </div>
      </div>
    </div>
  );
}

function Media({ p }: { p: Project }) {
  if (!p.report) return <p className="muted">Chưa phân tích. Chạy bước 1 ở tab Quy trình.</p>;
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
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries((p.edl?.rows || []).map((r) => [r.id, r.captionText || r.text])),
  );
  const [fixes, setFixes] = useState<Correction[]>(() => p.brief?.corrections || []);
  const [saving, setSaving] = useState(false);
  if (!p.edl) return <p className="muted">Chưa có kịch bản dựng. Chạy Phân tích rồi Dựng video.</p>;
  const kept = p.edl.rows.filter((r) => keep[r.id]);
  const total = kept.reduce((s, r) => s + (r.sourceOut - r.sourceIn), 0);
  const save = async () => {
    setSaving(true);
    try {
      await api.saveBrief(p.id, {
        ...(p.brief as Brief),
        corrections: fixes.filter((f) => f.from.trim() && f.to.trim()),
      });
      onSaved(await api.saveEdl(p.id, keep, text));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div>
      <div className="row between">
        <div className="muted">
          Giữ {kept.length}/{p.edl.rows.length} câu · khoảng {fmtSec(total)} lời nói. Bỏ chọn để cắt
          câu (footage gốc không bị xoá); sửa chữ để đổi phụ đề.
        </div>
        <button className="btn primary" disabled={saving} onClick={save}>
          Lưu & dựng lại
        </button>
      </div>
      <h3>Sửa lỗi phụ đề (áp dụng cho cả video)</h3>
      <div className="fixes">
        {fixes.map((f, i) => (
          <div key={i} className="row">
            <input
              value={f.from}
              placeholder="Nghe sai"
              onChange={(e) =>
                setFixes(fixes.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))
              }
            />
            <span>→</span>
            <input
              value={f.to}
              placeholder="Đúng"
              onChange={(e) =>
                setFixes(fixes.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))
              }
            />
            <button
              className="btn small ghost"
              onClick={() => setFixes(fixes.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <button className="btn small" onClick={() => setFixes([...fixes, { from: "", to: "" }])}>
          + Thêm
        </button>
      </div>
      <table className="edl">
        <thead>
          <tr>
            <th>Giữ</th>
            <th>Vào – Ra</th>
            <th>Lời thoại / phụ đề (sửa trực tiếp)</th>
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
              <td className="small mono">
                {r.source.slice(0, 8)}
                <br />
                {r.sourceIn.toFixed(1)}–{r.sourceOut.toFixed(1)}s
              </td>
              <td>
                <textarea
                  className="rowtext"
                  rows={2}
                  value={text[r.id] ?? ""}
                  onChange={(e) => setText({ ...text, [r.id]: e.target.value })}
                />
              </td>
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
  corrections: [],
  quality: "standard",
  notes: "",
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
        Chỉ nhập thông tin đã xác minh. AI chỉ dùng số liệu có trong lời nói hoặc brief.
      </p>
      {field("title", "Tên dự án", "VD: Vinhomes Green Paradise Cần Giờ")}
      {field("subtitle", "Phân khu / dòng phụ", "VD: Phân khu Vịnh Tiên")}
      {field("cta", "Lời kêu gọi (CTA)", "Liên hệ tư vấn")}
      {field("hotline", "Hotline", "VD: 09xx xxx xxx")}
      <label>
        Thông tin đã xác minh cho AI (tiện ích, quy mô, mốc tiến độ…)
        <textarea
          rows={4}
          value={b.notes || ""}
          onChange={(e) => setB({ ...b, notes: e.target.value })}
        />
      </label>
      <label>
        Thời lượng mục tiêu (giây, để trống = giữ hết lời nói)
        <input
          type="number"
          value={b.targetDuration ?? ""}
          onChange={(e) =>
            setB({ ...b, targetDuration: e.target.value ? Number(e.target.value) : null })
          }
        />
      </label>
      <label>
        Chất lượng xuất
        <select
          value={b.quality || "standard"}
          onChange={(e) => setB({ ...b, quality: e.target.value as Brief["quality"] })}
        >
          <option value="draft">Nháp — xuất nhanh để duyệt</option>
          <option value="standard">Chuẩn — mạng xã hội (~10 Mb/s)</option>
          <option value="high">Cao — bàn giao (file lớn)</option>
        </select>
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

function Videos({ p }: { p: Project }) {
  const [current, setCurrent] = useState(p.renders[0]?.file || null);
  if (!p.renders.length) return <p className="muted">Chưa xuất video. Bấm “⬇ Xuất MP4” ở trên.</p>;
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
              {r.sizeMB ?? "?"} MB
              {r.quality ? ` · ${r.quality}` : ""} · {fmtDate(r.mtime)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- library ----------

const SOUND_ROLES: [string, string][] = [
  ["music", "Nhạc nền"],
  ["whoosh", "Whoosh"],
  ["hit", "Hit"],
  ["boom", "Boom"],
  ["riser", "Riser"],
  ["sfx", "SFX khác"],
  ["loop", "Loop"],
];

function Library({ projects, onOpen }: { projects: Project[]; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<"videos" | "sounds">("videos");
  const [role, setRole] = useState("music");
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [q, setQ] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (tab === "sounds")
      api
        .sounds(role)
        .then(setSounds)
        .catch(() => setSounds([]));
  }, [tab, role]);
  useEffect(() => () => audio.current?.pause(), []);
  const play = (rel: string) => {
    audio.current?.pause();
    if (playing === rel) return setPlaying(null);
    audio.current = new Audio(api.soundUrl(rel));
    audio.current.play();
    setPlaying(rel);
  };
  const videos = projects
    .flatMap((p) => p.renders.map((r) => ({ p, r })))
    .sort((a, b) => b.r.mtime - a.r.mtime);
  return (
    <div className="page">
      <h1>Thư viện</h1>
      <nav className="tabs">
        <button
          className={`tab ${tab === "videos" ? "active" : ""}`}
          onClick={() => setTab("videos")}
        >
          Video đã xuất ({videos.length})
        </button>
        <button
          className={`tab ${tab === "sounds" ? "active" : ""}`}
          onClick={() => setTab("sounds")}
        >
          Âm thanh
        </button>
      </nav>
      {tab === "videos" && (
        <div className="grid">
          {videos.map(({ p, r }) => (
            <div key={p.id + r.file} className="vcard">
              <video src={api.fileUrl(p.id, r.file)} preload="metadata" controls />
              <button className="link vname" onClick={() => onOpen(p.id)}>
                {p.name}
              </button>
              <span className="muted small">
                {fmtSec(r.duration)} · {r.sizeMB ?? "?"} MB · {fmtDate(r.mtime)}
              </span>
            </div>
          ))}
          {!videos.length && <p className="muted">Chưa có video nào.</p>}
        </div>
      )}
      {tab === "sounds" && (
        <div>
          <div className="row">
            {SOUND_ROLES.map(([k, l]) => (
              <button
                key={k}
                className={`chip ${role === k ? "on" : ""}`}
                onClick={() => setRole(k)}
              >
                {l}
              </button>
            ))}
            <input
              className="search"
              placeholder="Tìm…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="soundlist big">
            {sounds
              .filter((s) => !q || s.rel.toLowerCase().includes(q.toLowerCase()))
              .slice(0, 300)
              .map((s) => (
                <div key={s.rel} className={`sound ${playing === s.rel ? "on" : ""}`}>
                  <button className="btn small" onClick={() => play(s.rel)}>
                    {playing === s.rel ? "■" : "▶"}
                  </button>
                  <span className="grow">{s.name}</span>
                  <span className="small muted ellipsis">
                    {s.rel.split("/").slice(0, -1).join(" / ")}
                  </span>
                </div>
              ))}
            {!sounds.length && <p className="muted">Không có âm thanh loại này.</p>}
          </div>
          <p className="small muted">
            Nhạc & SFX lấy từ thư viện trên máy. Kiểm tra giấy phép thương mại của từng gói trước
            khi đăng quảng cáo.
          </p>
        </div>
      )}
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

      <h2>Engine & thư mục</h2>
      {health && (
        <div className="small">
          <div>Dữ liệu dự án: {health.studioRoot}</div>
          <div>
            Thư viện nhạc/SFX: {health.soundLibrary} {health.tools.sounds ? "" : "(không tìm thấy)"}
          </div>
          <div>
            Claude:{" "}
            {health.tools.claudeApi
              ? "Claude API"
              : health.tools.claude
                ? "Claude Code trên máy (tính theo gói tài khoản)"
                : "chưa có"}
          </div>
        </div>
      )}
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
    </div>
  );
}
