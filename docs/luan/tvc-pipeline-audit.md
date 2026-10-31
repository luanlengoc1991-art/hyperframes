# LUAN AI Video Studio — audit trước khi xây dựng

Ngày audit: 2026-11-01 · Máy: Máy Nhà - Luân (Windows 11) · Nhánh: `feat/tvc-orchestrator` (tách từ `main` @ `74bf17b75`)

Mục tiêu: một câu lệnh, Claude điều phối, HyperFrames dựng TVC hoàn chỉnh và project chỉnh sửa lại được. Báo cáo này phân loại những gì đã có, để không xây lại.

## 1. Phân loại

### Already Implemented — dùng lại, không viết lại

| Chức năng | Nằm ở đâu | Ghi chú |
|---|---|---|
| Dựng, xem trước, render | `packages/core`, `engine`, `producer`, `studio`; CLI `init`, `preview`, `render` | 1920×1080 30 fps mặc định; render 10 s mất ~18 s trên máy này |
| Sửa timeline, lịch sử, hoàn tác | CLI `timeline`, `history` (list/undo/restore); Studio | Đây là cơ chế "hoàn tác mọi quyết định cắt" |
| Transcript theo từng từ | CLI `transcribe`; `skills/media-use/scripts/transcribe.mjs` | Whisper đa ngôn ngữ: `--language vi` tự đổi sang model `small`/`medium`/`large-v3` |
| Cắt theo transcript | `skills/media-use/scripts/transcript-cut.mjs` | Cắt khoảng lặng (`--cut-silence`), từ đệm (`--remove-fillers`), đoạn theo thời gian hoặc theo chỉ số từ; `--plan` trả về JSON các đoạn giữ lại mà không encode |
| Audio engine | `skills/media-use/audio/scripts/audio.mjs` | TTS: HeyGen → ElevenLabs → Kokoro. BGM: HeyGen retrieve, hoặc Lyria/MusicGen. SFX: Openverse, hoặc thư viện đóng gói sẵn |
| Adapter ElevenLabs | `skills/media-use/audio/scripts/lib/tts.mjs` | Có sẵn; cần `ELEVENLABS_API_KEY` và `pip install elevenlabs` |
| Ducking | `skills/media-use/scripts/audio-duck.mjs`; `data-automation` | Tạo lane âm lượng từ timestamp của giọng nói |
| Hoà âm trong composition | `references/mixing.md`: `data-fx-chain` | highpass, EQ, compressor, limiter, reverb…; `carve.mjs` khoét dải tần giọng khỏi nhạc |
| Loudness, clipping, onset, khoảng lặng | CLI `audio --json`, `normalize-audio` | Đã thử trên file thật: báo đỉnh âm, LUFS, true peak, khoảng lặng |
| Lưới beat của nhạc | CLI `beats` | Căn điểm cắt theo nhịp |
| Motion graphics | Registry: 210 block, 239 component | Có logo reveal, title, kinetic text, `count-up`, `cta-close`/`cta-lockup`, `caption-highlight`, `cinematic-zoom`, `parallax-zoom`, `whip-pan`, `transitions-*` |
| Kiểm tra composition | CLI `lint`, `check`, `snapshot --review`, `inspect` | Bố cục, độ tương phản, motion, chữ khó đọc, khung chuyển cảnh |
| Quy trình sáng tạo | `skills/hyperframes/references/story.md`, `spec.md`, `review.md` | Ba hướng câu chuyện → SPEC → review |
| TTS/STT tiếng Việt qua Vbee | `mcp/vbee/` (máy Admin-PC thêm) | MCP server; cần `VBEE_APP_ID`, `VBEE_TOKEN` |
| Skill TVC bất động sản | `.claude/skills/real-estate-tvc/` (máy Admin-PC thêm) | `brief.json` → các scene composition + SRT theo cảnh + `verify.mjs` |

### Available But Not Orchestrated — có nhưng chưa nối thành dây chuyền

- `transcribe` → `transcript-cut --plan` → timeline: hiện `transcript-cut` encode ra file mới (sinh bản sao). Chưa có bước biến các đoạn giữ lại thành clip `data-media-start` trỏ vào video gốc, nên **chưa dựng được kiểu không phá huỷ**.
- `audio.mjs`, `audio-duck.mjs`, `normalize-audio`, `beats` chạy riêng lẻ. `real-estate-tvc/build.mjs` chưa gọi cái nào.
- `check`, `snapshot`, `audio --json`, `ffprobe` là các kiểm tra rời. Chưa có một báo cáo QA chung.
- Vbee chưa nằm trong chuỗi provider của `audio.mjs`.

### Needs Improvement — có nhưng chưa đủ yêu cầu

- `real-estate-tvc/build.mjs`: mỗi cảnh chỉ một media, phụ đề theo cảnh (không theo từ), không phân tích footage, không có EDL, không mix audio. Project nằm trong `projects/active/` của repo, trong khi app quản lý dùng `quan-ly-video/videos/`.
- Nhận giọng tiếng Việt: Parakeet (mặc định, nhanh nhất) **không hỗ trợ tiếng Việt**, phải dùng whisper.
- SFX/nhạc nội bộ: thư viện `SOUND` không còn trên máy này. Máy Admin-PC dùng skill `local-sound-library` nằm ngoài repo (`D:\CLAUDE CODE\skills`), nên máy này không có.

### Missing — phải xây mới

1. **Phân tích footage thô**: metadata, chuyển cảnh, khung đen/đứng hình, rung/mất nét, chất lượng âm thanh, contact sheet, phân loại A-roll/B-roll → Footage Analysis Report. Làm được bằng ffmpeg đã có (`scdet`, `blackdetect`, `freezedetect`, `silencedetect`, `ebur128`, `tile`), không cần Python.
2. **Phát hiện câu nói hỏng, nói lại**: từ transcript, Claude quyết định. Cần đầu ra có cấu trúc.
3. **Edit Decision List** (schema JSON) và **trình biên dịch EDL → composition HyperFrames** không phá huỷ, xem trước và hoàn tác được.
4. **Orchestrator**: 14 công đoạn, mỗi công đoạn có file đầu vào/đầu ra và tiêu chí đạt. Lưu checkpoint để lỗi ở công đoạn nào thì chạy lại từ đó.
5. **6 preset Creative Direction** (Luxury Real Estate, Cinematic Commercial, Premium Corporate, Social Media Dynamic, Talking Head Professional, Property Showcase).
6. **Audio Cue Sheet, Asset Manifest, QA Report**, và cấu trúc **Output Package**.
7. **Backend + Render Worker** cho 50–100 sale (giai đoạn sau).

### Blocked By External API / chưa cài

| Thứ | Trạng thái trên máy này | Gỡ bằng cách |
|---|---|---|
| `whisper-cli` (transcript tiếng Việt) | Chưa có | Tải bản build sẵn cho Windows của whisper.cpp (miễn phí) |
| Giọng AI tiếng Việt | Không có key HeyGen / ElevenLabs / Vbee. Kokoro chưa cài và không có tiếng Việt | Cần bạn duyệt một nhà cung cấp trả phí và nhập key; nếu không thì chỉ dùng giọng gốc trong video |
| Tạo nhạc nền | Không có key | Dùng nhạc của bạn hoặc thư viện nội bộ |
| Python | Chỉ có `uv`, chưa có Python | Không bắt buộc (ffmpeg làm được phần phân tích) |
| Docker | Không có | Chỉ cần cho render tất định / worker sau này |
| Seedance | Không tích hợp | Theo yêu cầu |

## 2. Kế hoạch theo phase

Mỗi phase có code chạy được, kiểm thử bằng footage thật, và đầu ra rõ ràng. Chỉ thêm file mới trong skill riêng; không sửa `packages/`.

| Phase | Nội dung | Đầu ra | Phụ thuộc |
|---|---|---|---|
| 1 | Ingest + Footage Analysis (ffprobe, ffmpeg detect, contact sheet, transcript tiếng Việt) | `analysis/footage-report.json` + `.md` + contact sheet | `whisper-cli`; footage thật |
| 2 | EDL + Smart Cut: transcript-cut `--plan` + chuyển cảnh → EDL → composition clip `data-media-start` | `edl.json`, composition mở được trong Studio, hoàn tác bằng `history` | Phase 1 |
| 3 | Creative Director: 6 preset, script, storyboard, shot list | `creative/*.json` + `.md` | Phase 1–2 |
| 4 | Audio: nhạc, SFX, ducking, carve, normalize, kiểm tra loudness | `audio/cue-sheet.json`, các `<audio>` trong composition | Nhạc/SFX nội bộ; TTS chỉ khi được duyệt |
| 5 | Motion + phụ đề theo từng từ: block Registry, preset theo phong cách | Composition hoàn chỉnh | Phase 2–4 |
| 6 | QA + Output Package + MVP Acceptance Test (footage 3–5 phút → TVC 45–60 s) | `final.mp4`, `qa/report.md`, gói đầy đủ | Footage thật |
| 7 | Thiết kế backend + Render Worker cho 50–100 sale | Tài liệu kiến trúc | Phase 6 ổn định |

Orchestrator lưu `pipeline.json` (trạng thái từng công đoạn), nên chạy lại chỉ làm lại công đoạn lỗi và các công đoạn sau nó.
