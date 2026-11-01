// The editor: live HyperFrames preview, a multi-track timeline (chapters, motion beats,
// captions, footage, sound), the beat inspector, the Claude panel, sound and style.
// Every change is saved to story.json and the composition is rebuilt within a second.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Beat,
  type BeatType,
  type ChatMsg,
  EngineError,
  type EditorState,
  ENGINE,
  followJob,
  type JobEvent,
  loadPlayer,
  type Project,
  type Sound,
  type Story,
  type Timeline,
} from "./api";

type PlayerEl = HTMLElement & {
  seek(t: number): void;
  play(): void;
  pause(): void;
  currentTime: number;
  paused?: boolean;
};

export const BEAT_LABEL: Record<BeatType, string> = {
  hook: "Mở đầu (hook)",
  card: "Thẻ thông tin",
  full: "Toàn màn hình",
  stats: "Bảng số liệu",
  badge: "Badge góc",
  outro: "Kết (outro)",
};
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const uid = () => `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Where a beat sits right now, computed locally so drags feel instant before the save lands. */
function place(story: Story, tl: Timeline) {
  const out = new Map<string, { start: number; duration: number; hidden: boolean }>();
  let t = 0;
  const intro = story.beats.filter((b) => b.type === "hook").reduce((n, b) => n + b.duration, 0);
  const shift = intro - tl.intro;
  for (const b of story.beats) {
    if (b.type === "hook") {
      out.set(b.id, { start: t, duration: b.duration, hidden: false });
      t += b.duration;
    } else if (b.type === "outro") {
      out.set(b.id, { start: intro + tl.footage, duration: b.duration, hidden: false });
    } else if (b.row) {
      const r = tl.rows[b.row];
      out.set(
        b.id,
        r
          ? { start: r.start + shift + (b.offset || 0), duration: b.duration, hidden: false }
          : { start: 0, duration: b.duration, hidden: true },
      );
    } else out.set(b.id, { start: intro + (b.at || 0), duration: b.duration, hidden: false });
  }
  return out;
}

/** Anchor an absolute time to the sentence playing then (the beat follows it when the cut changes). */
function anchor(t: number, tl: Timeline, story: Story) {
  const intro = story.beats.filter((b) => b.type === "hook").reduce((n, b) => n + b.duration, 0);
  const shift = intro - tl.intro;
  const rows = Object.entries(tl.rows).map(([id, r]) => ({
    id,
    start: r.start + shift,
    end: r.end + shift,
  }));
  rows.sort((a, b) => a.start - b.start);
  let best = rows[0];
  for (const r of rows) if (r.start <= t) best = r;
  if (!best) return { at: Math.max(0, t - intro) };
  return { row: best.id, offset: Math.round(Math.max(0, t - best.start) * 100) / 100 };
}

// ---------- player ----------

function detailOf(e: Event): Record<string, unknown> | undefined {
  return e instanceof CustomEvent && e.detail && typeof e.detail === "object"
    ? e.detail
    : undefined;
}

function Player({
  src,
  onTime,
  playerRef,
  resumeAt,
}: {
  src: string;
  onTime: (t: number) => void;
  playerRef: React.MutableRefObject<PlayerEl | null>;
  resumeAt: React.MutableRefObject<number>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let el: PlayerEl | null = null;
    let cancelled = false;
    loadPlayer()
      .then(() => {
        if (cancelled || !host.current) return;
        el = document.createElement("hyperframes-player") as PlayerEl;
        el.setAttribute("controls", "");
        el.setAttribute("no-load-timeout", "");
        el.setAttribute("runtime-src", `${ENGINE}/hf/runtime.js`);
        el.setAttribute("src", src);
        el.style.width = "100%";
        el.style.height = "100%";
        el.addEventListener("timeupdate", (e) => {
          const t = detailOf(e)?.currentTime;
          if (typeof t === "number") onTime(t);
        });
        el.addEventListener("ready", () => {
          if (resumeAt.current > 0) el?.seek(resumeAt.current);
        });
        el.addEventListener("error", (e) => setError(String(detailOf(e)?.message || "Lỗi player")));
        host.current.replaceChildren(el);
        playerRef.current = el;
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      el?.remove();
    };
  }, [src, onTime, playerRef, resumeAt]);
  return (
    <div className="stage">
      <div className="stage-frame" ref={host} />
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

// ---------- timeline ----------

const TYPE_COLOR: Record<BeatType, string> = {
  hook: "#ff8a3d",
  card: "#d2ff3c",
  full: "#4fc3ff",
  stats: "#b48cff",
  badge: "#ffd45c",
  outro: "#ff5c8a",
};

function TimelineView({
  tl,
  story,
  rows,
  time,
  selected,
  onSeek,
  onSelect,
  onMove,
  onResize,
}: {
  tl: Timeline;
  story: Story;
  rows: Record<string, string>;
  time: number;
  selected: string | null;
  onSeek: (t: number) => void;
  onSelect: (id: string | null) => void;
  onMove: (id: string, t: number) => void;
  onResize: (id: string, d: number) => void;
}) {
  const [zoom, setZoom] = useState(14);
  const scroller = useRef<HTMLDivElement>(null);
  const placed = useMemo(() => place(story, tl), [story, tl]);
  const total = Math.max(tl.total, ...[...placed.values()].map((p) => p.start + p.duration));
  const width = Math.ceil(total * zoom) + 80;
  const xToT = (clientX: number) => {
    const r = scroller.current?.getBoundingClientRect();
    return Math.max(0, (clientX - (r?.left || 0) + (scroller.current?.scrollLeft || 0) - 8) / zoom);
  };
  const drag = (e: React.MouseEvent, b: Beat, mode: "move" | "resize") => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(b.id);
    const p = placed.get(b.id);
    if (!p) return;
    const x0 = e.clientX;
    let last = mode === "move" ? p.start : p.duration;
    const el = e.currentTarget.closest(".blk") as HTMLElement | null;
    const moveEl = (ev: MouseEvent) => {
      const dt = (ev.clientX - x0) / zoom;
      if (mode === "move") {
        last = Math.max(0, Math.round((p.start + dt) * 20) / 20);
        if (el) el.style.left = `${8 + last * zoom}px`;
      } else {
        last = Math.max(0.8, Math.round((p.duration + dt) * 20) / 20);
        if (el) el.style.width = `${last * zoom}px`;
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", moveEl);
      window.removeEventListener("mouseup", up);
      if (mode === "move" && Math.abs(last - p.start) > 0.02) onMove(b.id, last);
      else if (mode === "move") onSeek(p.start + 0.4); // a click without a drag shows the beat
      if (mode === "resize" && Math.abs(last - p.duration) > 0.02) onResize(b.id, last);
    };
    window.addEventListener("mousemove", moveEl);
    window.addEventListener("mouseup", up);
  };
  // Keep the playhead in view while playing.
  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    const x = 8 + time * zoom;
    if (x < s.scrollLeft || x > s.scrollLeft + s.clientWidth - 40)
      s.scrollLeft = Math.max(0, x - 120);
  }, [time, zoom]);
  const ticks = [];
  const step = zoom > 30 ? 1 : zoom > 12 ? 5 : 10;
  for (let t = 0; t <= total; t += step) ticks.push(t);
  const beatLanes = story.beats.filter((b) => b.type !== "badge");
  const badges = story.beats.filter((b) => b.type === "badge");
  const blk = (b: Beat) => {
    const p = placed.get(b.id);
    if (!p) return null;
    return (
      <div
        key={b.id}
        className={`blk beat-blk ${selected === b.id ? "sel" : ""} ${p.hidden ? "hidden-beat" : ""}`}
        style={{
          left: 8 + p.start * zoom,
          width: Math.max(6, p.duration * zoom),
          background: TYPE_COLOR[b.type],
        }}
        title={`${BEAT_LABEL[b.type]} · ${fmt(p.start)} · ${p.duration.toFixed(1)}s${p.hidden ? " · câu đã bị cắt" : ""}`}
        onMouseDown={(e) =>
          b.type === "hook" || b.type === "outro"
            ? (onSelect(b.id), onSeek(p.start + 0.4))
            : drag(e, b, "move")
        }
        onDoubleClick={() => onSeek(p.start + 0.4)}
      >
        <span>{b.title || b.accent || b.kicker || BEAT_LABEL[b.type]}</span>
        <i className="grip" onMouseDown={(e) => drag(e, b, "resize")} />
      </div>
    );
  };
  return (
    <div className="tl">
      <div className="tl-head">
        <span className="mono">
          {fmt(time)} / {fmt(total)}
        </span>
        <span className="muted small">
          Kéo khối để dời · kéo mép phải để đổi độ dài · nháy đúp để xem
        </span>
        <label className="zoom">
          Thu phóng
          <input
            type="range"
            min={4}
            max={60}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="tl-body">
        <div className="tl-labels">
          <div className="lane-label ruler-l" />
          <div className="lane-label">Chương</div>
          <div className="lane-label">Hiệu ứng</div>
          <div className="lane-label">Badge</div>
          <div className="lane-label">Phụ đề</div>
          <div className="lane-label">Footage</div>
          <div className="lane-label">Âm thanh</div>
        </div>
        <div
          className="tl-scroll"
          ref={scroller}
          onMouseDown={(e) =>
            (e.target as HTMLElement).closest(".blk") || (onSelect(null), onSeek(xToT(e.clientX)))
          }
        >
          <div className="tl-canvas" style={{ width }}>
            <div className="lane ruler">
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: 8 + t * zoom }}>
                  {fmt(t).replace(/\.0$/, "")}
                </span>
              ))}
            </div>
            <div className="lane">
              {tl.chapters.map((c, i) => (
                <div
                  key={i}
                  className="blk chap"
                  style={{ left: 8 + c.start * zoom, width: (c.end - c.start) * zoom }}
                >
                  <span>{c.label || "–"}</span>
                </div>
              ))}
            </div>
            <div className="lane">{beatLanes.map(blk)}</div>
            <div className="lane">{badges.map(blk)}</div>
            <div className="lane">
              {tl.captions.map((c, i) => (
                <div
                  key={i}
                  className="blk cap-blk"
                  style={{ left: 8 + c.start * zoom, width: (c.end - c.start) * zoom }}
                  title={c.text}
                >
                  <span>{c.text}</span>
                </div>
              ))}
            </div>
            <div className="lane">
              {tl.clips.map((c, i) => (
                <div
                  key={i}
                  className="blk clip-blk"
                  style={{ left: 8 + c.start * zoom, width: c.duration * zoom }}
                  title={c.rows.map((r) => rows[r]).join(" ")}
                >
                  <span>{c.source}</span>
                </div>
              ))}
            </div>
            <div className="lane">
              {tl.audio.map((a) => (
                <div
                  key={a.id}
                  className={`blk ${a.id === "music" ? "music-blk" : "sfx-blk"}`}
                  style={{ left: 8 + a.start * zoom, width: Math.max(4, a.duration * zoom) }}
                  title={a.src}
                >
                  {a.id === "music" && <span>♪ Nhạc nền</span>}
                </div>
              ))}
            </div>
            <div className="playhead" style={{ left: 8 + time * zoom }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- inspector ----------

function Field({
  label,
  value,
  onChange,
  wide = false,
  ph = "",
}: {
  label: string;
  value?: string;
  onChange: (v: string) => void;
  wide?: boolean;
  ph?: string;
}) {
  return (
    <label className={wide ? "wide" : ""}>
      {label}
      <input value={value ?? ""} placeholder={ph} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Inspector({
  beat,
  start,
  rowText,
  images,
  onChange,
  onDelete,
  onDuplicate,
  onNudge,
}: {
  beat: Beat;
  start: number | null;
  rowText: string;
  images: { id: string; name: string }[];
  onChange: (b: Beat) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onNudge: (dt: number) => void;
}) {
  const set = (patch: Partial<Beat>) => onChange({ ...beat, ...patch });
  const t = beat.type;
  return (
    <div className="inspector">
      <div className="row between">
        <select value={t} onChange={(e) => set({ type: e.target.value as BeatType })}>
          {(Object.keys(BEAT_LABEL) as BeatType[]).map((k) => (
            <option key={k} value={k}>
              {BEAT_LABEL[k]}
            </option>
          ))}
        </select>
        <div className="row">
          <button className="btn small" onClick={onDuplicate} title="Nhân bản">
            ⧉
          </button>
          <button className="btn small danger" onClick={onDelete} title="Xoá (Delete)">
            Xoá
          </button>
        </div>
      </div>
      <div className="small muted">
        {start != null ? `Bắt đầu ${fmt(start)}` : "Câu gắn với hiệu ứng này đã bị cắt"}
        {rowText && ` · gắn với câu: “${rowText.slice(0, 70)}${rowText.length > 70 ? "…" : ""}”`}
      </div>
      <div className="grid2">
        {t !== "hook" && t !== "outro" && (
          <div className="nudge">
            <span className="small">Thời điểm</span>
            <button className="btn small" onClick={() => onNudge(-0.5)}>
              −0.5s
            </button>
            <button className="btn small" onClick={() => onNudge(-0.1)}>
              −0.1
            </button>
            <button className="btn small" onClick={() => onNudge(0.1)}>
              +0.1
            </button>
            <button className="btn small" onClick={() => onNudge(0.5)}>
              +0.5s
            </button>
          </div>
        )}
        <label>
          Độ dài (giây)
          <input
            type="number"
            step={0.1}
            min={0.8}
            value={beat.duration}
            onChange={(e) => set({ duration: Math.max(0.8, Number(e.target.value) || 0.8) })}
          />
        </label>
        {t !== "hook" && t !== "outro" && (
          <Field
            label="Chương (thanh trên)"
            value={beat.chapter}
            onChange={(v) => set({ chapter: v })}
            ph="VD: Tiện ích"
          />
        )}
        {t === "card" && (
          <Field label="Số thứ tự" value={beat.index} onChange={(v) => set({ index: v })} ph="01" />
        )}
        <Field
          label={t === "outro" ? "Dòng nhỏ trên" : "Dòng nhỏ (kicker)"}
          value={beat.kicker}
          onChange={(v) => set({ kicker: v })}
          wide
        />
        <Field
          label={t === "outro" ? "Tên lớn" : "Tiêu đề (trắng)"}
          value={beat.title}
          onChange={(v) => set({ title: v })}
          wide
        />
        {t !== "outro" && t !== "badge" && (
          <Field
            label="Dòng nhấn (màu)"
            value={beat.accent}
            onChange={(v) => set({ accent: v })}
            wide
          />
        )}
        {t === "card" && (
          <Field label="Chữ nghiêng" value={beat.note} onChange={(v) => set({ note: v })} wide />
        )}
        {(t === "card" || t === "full" || t === "badge" || t === "outro") && (
          <Field
            label={t === "outro" ? "Lời kêu gọi" : "Dòng phụ"}
            value={beat.sub}
            onChange={(v) => set({ sub: v })}
            wide
          />
        )}
        {t === "outro" && (
          <Field label="Hotline" value={beat.label} onChange={(v) => set({ label: v })} wide />
        )}
      </div>
      {(t === "card" || t === "full" || t === "hook") && (
        <fieldset>
          <legend>Số liệu lớn</legend>
          <div className="grid3">
            <Field
              label="Giá trị"
              value={beat.stat?.value}
              onChange={(v) =>
                set({
                  stat: v
                    ? { value: v, unit: beat.stat?.unit || "", label: beat.stat?.label || "" }
                    : undefined,
                })
              }
            />
            <Field
              label="Đơn vị"
              value={beat.stat?.unit}
              onChange={(v) => beat.stat && set({ stat: { ...beat.stat, unit: v } })}
            />
            <Field
              label="Chú thích"
              value={beat.stat?.label}
              onChange={(v) => beat.stat && set({ stat: { ...beat.stat, label: v } })}
            />
          </div>
        </fieldset>
      )}
      {t === "card" && (
        <>
          <fieldset>
            <legend>Mốc ngày</legend>
            {(beat.dates || []).map((d, i) => (
              <div key={i} className="grid3">
                <Field
                  label="Nhãn"
                  value={d.label}
                  onChange={(v) =>
                    set({
                      dates: (beat.dates || []).map((x, j) => (j === i ? { ...x, label: v } : x)),
                    })
                  }
                />
                <Field
                  label="Ngày"
                  value={d.value}
                  onChange={(v) =>
                    set({
                      dates: (beat.dates || []).map((x, j) => (j === i ? { ...x, value: v } : x)),
                    })
                  }
                />
                <button
                  className="btn small"
                  onClick={() => set({ dates: (beat.dates || []).filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
            {(beat.dates?.length || 0) < 3 && (
              <button
                className="btn small"
                onClick={() =>
                  set({ dates: [...(beat.dates || []), { label: "Mốc", value: "01.01.2027" }] })
                }
              >
                + Mốc ngày
              </button>
            )}
          </fieldset>
          <label className="wide">
            Gạch đầu dòng (mỗi dòng một ý)
            <textarea
              rows={3}
              value={(beat.bullets || []).join("\n")}
              onChange={(e) =>
                set({
                  bullets: e.target.value
                    .split("\n")
                    .filter((x, i, a) => x.trim() || i < a.length - 1),
                })
              }
            />
          </label>
        </>
      )}
      {t === "stats" && (
        <fieldset>
          <legend>Các dòng số liệu</legend>
          {(beat.rows || []).map((r, i) => (
            <div key={i} className="grid4">
              <Field
                label="Số"
                value={r.value}
                onChange={(v) =>
                  set({ rows: (beat.rows || []).map((x, j) => (j === i ? { ...x, value: v } : x)) })
                }
              />
              <Field
                label="Đơn vị"
                value={r.unit}
                onChange={(v) =>
                  set({ rows: (beat.rows || []).map((x, j) => (j === i ? { ...x, unit: v } : x)) })
                }
              />
              <Field
                label="Mô tả"
                value={r.label}
                onChange={(v) =>
                  set({ rows: (beat.rows || []).map((x, j) => (j === i ? { ...x, label: v } : x)) })
                }
              />
              <button
                className="btn small"
                onClick={() => set({ rows: (beat.rows || []).filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          ))}
          {(beat.rows?.length || 0) < 4 && (
            <button
              className="btn small"
              onClick={() =>
                set({ rows: [...(beat.rows || []), { value: "1", unit: "", label: "" }] })
              }
            >
              + Dòng
            </button>
          )}
        </fieldset>
      )}
      {(t === "card" || t === "full" || t === "hook") && (
        <label className="wide">
          Ảnh {t === "card" ? "trong thẻ" : "nền"}
          <select
            value={beat.image || ""}
            onChange={(e) => set({ image: e.target.value || undefined })}
          >
            <option value="">{t === "card" ? "(không)" : "(khung hình từ footage)"}</option>
            {images.map((im) => (
              <option key={im.id} value={im.id}>
                {im.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="small muted">
        Con số trên màn hình phải đúng với lời nói hoặc brief — không tự thêm giá, pháp lý.
      </p>
    </div>
  );
}

// ---------- Claude panel ----------

export function ChatPanel({
  projectId,
  context,
  onChanged,
}: {
  projectId: string;
  context: () => { time?: number; beat?: string };
  onChanged: () => void;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [live, setLive] = useState<JobEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(
    () =>
      api
        .chatHistory(projectId)
        .then(setMsgs)
        .catch(() => {}),
    [projectId],
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    box.current?.scrollTo(0, box.current.scrollHeight);
  }, [msgs, live]);
  const send = async (text = input.trim()) => {
    if (!text || running) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text, at: Date.now() }]);
    setLive([]);
    setRunning(true);
    try {
      const { job } = await api.chat(projectId, text, context());
      followJob(job, (e) => {
        setLive((l) => [...l, e]);
        if (e.type === "done" || e.type === "error") {
          setRunning(false);
          load().then(() => setLive(e.type === "error" ? [e] : []));
          onChanged();
        }
      });
    } catch (e) {
      setRunning(false);
      setLive([{ type: "error", text: (e as Error).message, at: Date.now() }]);
    }
  };
  const SUGGEST = [
    "Thêm thẻ thông tin cho câu đang nói ở giây hiện tại",
    "Rút video còn khoảng 60 giây, giữ ý chính",
    "Kiểm tra lại phụ đề, sửa các từ nghe sai",
    "Đổi màu nhấn sang vàng gold sang trọng",
  ];
  return (
    <div className="chatpanel">
      <div className="row between">
        <b>Claude</b>
        <button
          className="btn small ghost"
          disabled={running}
          onClick={() => api.chatReset(projectId).then(load)}
        >
          Cuộc trò chuyện mới
        </button>
      </div>
      <div className="msgs" ref={box}>
        {!msgs.length && !live.length && (
          <div className="muted small">
            Ra lệnh bằng tiếng Việt. Claude đọc lời thoại, storyboard, timeline và sửa trực tiếp dự
            án; bản xem trước tự cập nhật.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.text}
            {m.tools?.length ? (
              <details className="tools">
                <summary>{m.tools.length} thao tác</summary>
                {m.tools.map((t, j) => (
                  <div key={j} className="mono small">
                    ⚙ {t}
                  </div>
                ))}
              </details>
            ) : null}
          </div>
        ))}
        {(running || live.length > 0) && (
          <div className={`msg ai ${running ? "typing" : ""}`}>
            {live
              .filter((e) => e.type === "ai")
              .map((e, i) => (
                <div key={i}>{e.text}</div>
              ))}
            {live
              .filter((e) => e.type === "tool")
              .slice(-4)
              .map((e, i) => (
                <div key={`t${i}`} className="mono small tool-line">
                  ⚙ {e.text}
                </div>
              ))}
            {running && (
              <div className="small muted">
                {live.filter((e) => e.type === "thinking").pop()?.text || "Claude đang làm…"}
              </div>
            )}
            {live
              .filter((e) => e.type === "error")
              .map((e, i) => (
                <div key={`e${i}`} className="error small">
                  {e.text}
                </div>
              ))}
          </div>
        )}
      </div>
      {!running && (
        <div className="suggest">
          {SUGGEST.map((s) => (
            <button key={s} className="chip" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="VD: thêm thẻ “Bể bơi 5.000 m²” lúc 0:42… (Enter gửi, Shift+Enter xuống dòng)"
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
        />
        <button className="btn primary" disabled={running || !input.trim()} onClick={() => send()}>
          Gửi
        </button>
      </div>
    </div>
  );
}

// ---------- sound & style ----------

function SoundPanel({ story, onChange }: { story: Story; onChange: (s: Story) => void }) {
  const [music, setMusic] = useState<Sound[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    api
      .sounds("music")
      .then(setMusic)
      .catch(() => setMusic([]));
    return () => audio.current?.pause();
  }, []);
  const preview = (rel: string) => {
    audio.current?.pause();
    if (playing === rel) return setPlaying(null);
    audio.current = new Audio(api.soundUrl(rel));
    audio.current.volume = 0.6;
    audio.current.play();
    setPlaying(rel);
  };
  return (
    <div className="inspector">
      <label className="check">
        <input
          type="checkbox"
          checked={story.music.enabled}
          onChange={(e) =>
            onChange({ ...story, music: { ...story.music, enabled: e.target.checked } })
          }
        />{" "}
        Nhạc nền (tự hạ khi có lời nói)
      </label>
      <label>
        Âm lượng nhạc: {Math.round(story.music.volume * 100)}%
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={story.music.volume}
          onChange={(e) =>
            onChange({ ...story, music: { ...story.music, volume: Number(e.target.value) } })
          }
        />
      </label>
      <div className="soundlist">
        {music.map((m) => (
          <div key={m.rel} className={`sound ${story.music.rel === m.rel ? "on" : ""}`}>
            <button className="btn small" onClick={() => preview(m.rel)}>
              {playing === m.rel ? "■" : "▶"}
            </button>
            <span className="grow" title={m.rel}>
              {m.name}
            </span>
            <button
              className="btn small"
              onClick={() =>
                onChange({ ...story, music: { ...story.music, rel: m.rel, enabled: true } })
              }
            >
              {story.music.rel === m.rel ? "Đang dùng" : "Dùng"}
            </button>
          </div>
        ))}
        {!music.length && <div className="muted small">Không tìm thấy thư viện nhạc.</div>}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={story.sfx.enabled}
          onChange={(e) => onChange({ ...story, sfx: { ...story.sfx, enabled: e.target.checked } })}
        />{" "}
        Hiệu ứng âm thanh (whoosh, hit, riser theo từng hiệu ứng)
      </label>
      <label>
        Âm lượng SFX: {Math.round(story.sfx.volume * 100)}%
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={story.sfx.volume}
          onChange={(e) =>
            onChange({ ...story, sfx: { ...story.sfx, volume: Number(e.target.value) } })
          }
        />
      </label>
    </div>
  );
}

function StylePanel({ story, onChange }: { story: Story; onChange: (s: Story) => void }) {
  const SWATCH = ["#D2FF3C", "#FFD45C", "#E8C27A", "#4FC3FF", "#FF5C8A", "#FFFFFF"];
  return (
    <div className="inspector">
      <label>
        Màu nhấn
        <div className="row">
          <input
            type="color"
            value={story.theme.accent}
            onChange={(e) =>
              onChange({
                ...story,
                theme: { ...story.theme, accent: e.target.value.toUpperCase() },
              })
            }
          />
          {SWATCH.map((c) => (
            <button
              key={c}
              className="swatch"
              style={{ background: c }}
              title={c}
              onClick={() => onChange({ ...story, theme: { ...story.theme, accent: c } })}
            />
          ))}
        </div>
      </label>
      <Field
        label="Tên hiển thị góc trên"
        value={story.theme.brand}
        onChange={(v) => onChange({ ...story, theme: { ...story.theme, brand: v } })}
        wide
      />
      <label className="wide">
        Từ khoá tô màu trong phụ đề (cách nhau dấu phẩy)
        <textarea
          rows={3}
          value={story.keywords.join(", ")}
          onChange={(e) =>
            onChange({
              ...story,
              keywords: e.target.value
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <p className="small muted">
        Con số trong phụ đề luôn được tô màu. Sửa chữ phụ đề nghe sai ở tab Kịch bản (bảng “Sửa lỗi
        phụ đề”).
      </p>
    </div>
  );
}

// ---------- editor ----------

type Side = "props" | "claude" | "sound" | "style";

export function Editor({
  p,
  onProjectChanged,
  runPlan,
  planRunning,
}: {
  p: Project;
  onProjectChanged: () => void;
  runPlan: () => void;
  planRunning: boolean;
}) {
  const [st, setSt] = useState<EditorState | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("props");
  const [time, setTime] = useState(0);
  const [version, setVersion] = useState(1);
  const [saving, setSaving] = useState<"idle" | "pending" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const undo = useRef<Story[]>([]);
  const redo = useRef<Story[]>([]);
  const timer = useRef<number | null>(null);
  const player = useRef<PlayerEl | null>(null);
  const resumeAt = useRef(0);
  const timeRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const s = await api.editor(p.id);
      setSt(s);
      setStory(s.story);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [p.id]);
  useEffect(() => {
    load();
  }, [load]);
  // Claude or a pipeline run changed the project: reload story and preview.
  const refreshAll = useCallback(() => {
    resumeAt.current = timeRef.current;
    load().then(() => setVersion((v) => v + 1));
    onProjectChanged();
  }, [load, onProjectChanged]);
  // A pipeline run (AI storyboard, compose) just finished: pick up its result.
  const wasRunning = useRef(planRunning);
  useEffect(() => {
    if (wasRunning.current && !planRunning) refreshAll();
    wasRunning.current = planRunning;
  }, [planRunning, refreshAll]);

  const save = useCallback(
    async (s: Story, force = false) => {
      setSaving("saving");
      try {
        const next = await api.saveStory(p.id, s, force);
        setSt(next);
        setBlocked(null);
        setSaving("saved");
        resumeAt.current = timeRef.current;
        setVersion((v) => v + 1);
      } catch (e) {
        if (e instanceof EngineError && e.blocked) setBlocked(e.message);
        else setError((e as Error).message);
        setSaving("pending");
      }
    },
    [p.id],
  );
  const change = useCallback(
    (next: Story, record = true) => {
      if (record && story) {
        undo.current.push(story);
        if (undo.current.length > 60) undo.current.shift();
        redo.current = [];
      }
      setStory(next);
      setSaving("pending");
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => save(next), 900);
    },
    [story, save],
  );
  const onTime = useCallback((t: number) => {
    timeRef.current = t;
    setTime(t);
  }, []);
  const seek = (t: number) => {
    timeRef.current = t;
    setTime(t);
    player.current?.seek(t);
  };

  const tl = st?.timeline;
  const placed = useMemo(() => (story && tl ? place(story, tl) : new Map()), [story, tl]);
  const rowText = useMemo(
    () => Object.fromEntries((st?.rows || []).map((r) => [r.id, r.captionText || r.text])),
    [st],
  );
  const beat = story?.beats.find((b) => b.id === selected) || null;

  const updateBeat = (b: Beat) =>
    story && change({ ...story, beats: story.beats.map((x) => (x.id === b.id ? b : x)) });
  const moveBeat = (id: string, t: number) => {
    if (!story || !tl) return;
    const b = story.beats.find((x) => x.id === id);
    if (!b) return;
    const a = anchor(t, tl, story);
    const nb: Beat = { ...b, row: undefined, at: undefined, ...a };
    change({ ...story, beats: story.beats.map((x) => (x.id === id ? nb : x)) });
  };
  const addBeat = (type: BeatType) => {
    if (!story || !tl) return;
    const base: Beat = {
      id: uid(),
      type,
      duration: type === "stats" ? 4.2 : type === "full" ? 3.2 : 3.6,
    };
    const content: Partial<Beat> =
      type === "card"
        ? { kicker: "Thông tin", title: "Tiêu đề", accent: "Dòng nhấn" }
        : type === "full"
          ? { title: "Tiêu đề lớn", accent: "Dòng nhấn" }
          : type === "stats"
            ? {
                title: "Tiêu đề",
                accent: "Dòng nhấn",
                rows: [{ value: "1", unit: "", label: "Mô tả" }],
              }
            : type === "badge"
              ? { kicker: "Cập nhật", title: "T10", sub: "Năm 2026" }
              : type === "hook"
                ? {
                    kicker: story.theme.brand,
                    title: "Nhãn ngắn",
                    stat: { value: "1", unit: "", label: "" },
                  }
                : {
                    title: story.theme.brand || "Tên dự án",
                    sub: p.brief?.cta || "Liên hệ tư vấn",
                    label: p.brief?.hotline || "",
                  };
    const where = type === "hook" || type === "outro" ? {} : anchor(time, tl, story);
    if (type === "outro" && story.beats.some((b) => b.type === "outro"))
      return setSelected(story.beats.find((b) => b.type === "outro")?.id || null);
    const nb = { ...base, ...content, ...where } as Beat;
    change({ ...story, beats: [...story.beats, nb] });
    setSelected(nb.id);
    setSide("props");
  };
  const del = () => {
    if (!story || !selected) return;
    change({ ...story, beats: story.beats.filter((b) => b.id !== selected) });
    setSelected(null);
  };
  const dup = () => {
    if (!story || !beat || !tl) return;
    const pl = placed.get(beat.id);
    const nb = {
      ...beat,
      id: uid(),
      ...(beat.type === "hook" || beat.type === "outro"
        ? {}
        : anchor((pl?.start || time) + beat.duration + 0.2, tl, story)),
    };
    change({ ...story, beats: [...story.beats, nb] });
    setSelected(nb.id);
  };
  const nudge = (dt: number) => {
    const pl = beat && placed.get(beat.id);
    if (beat && pl) moveBeat(beat.id, Math.max(0, pl.start + dt));
  };
  const doUndo = () => {
    const prev = undo.current.pop();
    if (prev && story) {
      redo.current.push(story);
      change(prev, false);
    }
  };
  const doRedo = () => {
    const next = redo.current.pop();
    if (next && story) {
      undo.current.push(story);
      change(next, false);
    }
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        doRedo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (story) {
          if (timer.current) window.clearTimeout(timer.current);
          save(story);
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && !typing && selected) {
        e.preventDefault();
        del();
      } else if (e.key === " " && !typing) {
        e.preventDefault();
        const pl = player.current;
        if (pl?.paused ?? true) pl?.play();
        else pl?.pause();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (error && !st) return <div className="error">{error}</div>;
  if (!st) return <div className="muted">Đang tải trình dựng…</div>;
  if (!tl || !story)
    return (
      <p className="muted">Chưa có bản dựng. Chạy “Phân tích” rồi “Dựng video” ở tab Quy trình.</p>
    );

  const placedSel = beat ? placed.get(beat.id) : null;
  return (
    <div className="ed">
      <div className="ed-bar">
        <button
          className="btn primary"
          disabled={planRunning}
          onClick={runPlan}
          title="Claude đọc lời thoại và lên toàn bộ storyboard (ghi đè storyboard hiện tại)"
        >
          {planRunning ? "Claude đang lên storyboard…" : "✦ AI lên storyboard"}
        </button>
        <span className="sep" />
        <span className="muted small">Thêm tại {fmt(time)}:</span>
        {(["card", "full", "stats", "badge", "hook", "outro"] as BeatType[]).map((t) => (
          <button key={t} className="btn small" onClick={() => addBeat(t)}>
            + {BEAT_LABEL[t]}
          </button>
        ))}
        <span className="sep" />
        <button
          className="btn small"
          disabled={!undo.current.length}
          onClick={doUndo}
          title="Hoàn tác (Ctrl+Z)"
        >
          ↶
        </button>
        <button
          className="btn small"
          disabled={!redo.current.length}
          onClick={doRedo}
          title="Làm lại (Ctrl+Y)"
        >
          ↷
        </button>
        <span className={`save-state ${saving}`}>
          {saving === "saving"
            ? "Đang lưu & dựng…"
            : saving === "pending"
              ? "Chưa lưu"
              : saving === "saved"
                ? "Đã lưu ✓"
                : ""}
        </span>
        <span className="grow" />
        <button
          className="btn small ghost"
          onClick={async () => {
            try {
              openUrl((await api.studio(p.id)).url);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          title="Mở HyperFrames Studio để chỉnh sâu từng lớp (sửa tay sẽ được bảo vệ khỏi bị ghi đè)"
        >
          HyperFrames Studio ↗
        </button>
      </div>
      {blocked && (
        <div className="banner warn">
          {blocked}
          <button className="btn small" onClick={() => story && save(story, true)}>
            Ghi đè bằng storyboard
          </button>
        </div>
      )}
      {error && (
        <div className="banner err" onClick={() => setError(null)}>
          {error} (bấm để ẩn)
        </div>
      )}
      {st.proxies.total > st.proxies.ready && (
        <div className="banner info">
          Đang tạo bản xem trước nhẹ cho footage ({st.proxies.ready}/{st.proxies.total}) — lần mở
          đầu có thể chậm.
        </div>
      )}
      <div className="ed-main">
        <Player
          src={api.previewUrl(p.id, version)}
          onTime={onTime}
          playerRef={player}
          resumeAt={resumeAt}
        />
        <div className="ed-side">
          <nav className="tabs small-tabs">
            {(
              [
                ["props", "Thuộc tính"],
                ["claude", "Claude"],
                ["sound", "Âm thanh"],
                ["style", "Phong cách"],
              ] as [Side, string][]
            ).map(([k, l]) => (
              <button
                key={k}
                className={`tab ${side === k ? "active" : ""}`}
                onClick={() => setSide(k)}
              >
                {l}
              </button>
            ))}
          </nav>
          <div className="side-body">
            {side === "props" &&
              (beat ? (
                <Inspector
                  beat={beat}
                  start={placedSel && !placedSel.hidden ? placedSel.start : null}
                  rowText={beat.row ? rowText[beat.row] || "" : ""}
                  images={st.images}
                  onChange={updateBeat}
                  onDelete={del}
                  onDuplicate={dup}
                  onNudge={nudge}
                />
              ) : (
                <div className="muted small pad">
                  Chọn một khối trên timeline để sửa nội dung. Thêm hiệu ứng mới tại vị trí đầu phát
                  bằng các nút phía trên.
                  <ul className="beatlist">
                    {story.beats.map((b) => (
                      <li key={b.id}>
                        <button
                          className="link"
                          onClick={() => (
                            setSelected(b.id), seek((placed.get(b.id)?.start || 0) + 0.4)
                          )}
                        >
                          <i style={{ background: TYPE_COLOR[b.type] }} />{" "}
                          {fmt(placed.get(b.id)?.start || 0)} ·{" "}
                          {b.title || b.accent || BEAT_LABEL[b.type]}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            {side === "claude" && (
              <ChatPanel
                projectId={p.id}
                context={() => ({ time: timeRef.current, beat: selected || undefined })}
                onChanged={refreshAll}
              />
            )}
            {side === "sound" && <SoundPanel story={story} onChange={(s) => change(s)} />}
            {side === "style" && <StylePanel story={story} onChange={(s) => change(s)} />}
          </div>
        </div>
      </div>
      <TimelineView
        tl={tl}
        story={story}
        rows={rowText}
        time={time}
        selected={selected}
        onSeek={seek}
        onSelect={(id) => {
          setSelected(id);
          if (id) setSide("props");
        }}
        onMove={moveBeat}
        onResize={(id, d) => {
          const b = story.beats.find((x) => x.id === id);
          if (b) updateBeat({ ...b, duration: d });
        }}
      />
    </div>
  );
}
