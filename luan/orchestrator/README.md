# LUAN AI Video Studio — Orchestrator

Bộ điều phối sản xuất TVC. Không thay thế HyperFrames: gọi `ffmpeg`, `ffprobe` và CLI `hyperframes` có sẵn, không sửa `packages/`.

## Đã có (Phase 2, công đoạn 1–3)

| Công đoạn                | File                    | Đầu ra                                                                                                                                                      |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Nhập tư liệu          | `stages/ingest.mjs`     | Danh sách video, ảnh, audio, tài liệu kèm dấu vân tay; file gốc không bị chép hay sửa                                                                       |
| 2. Phân tích footage     | `stages/analyze.mjs`    | `analysis/<id>/analysis.json`, `contact.jpg`: metadata, shot, khung đen, đứng hình, độ mờ, khoảng lặng, loudness, true peak, vai trò A-roll/B-roll/nhạc/SFX |
| 3. Transcript tiếng Việt | `stages/transcribe.mjs` | `analysis/<id>/transcript.json` theo từng từ (whisper, `--language vi`); báo "blocked" khi chưa có `whisper-cli`                                            |
| Báo cáo                  | `stages/report.mjs`     | `analysis/footage-report.json` và `.md`                                                                                                                     |

Trạng thái nằm ở `<project>/pipeline.json`. Chạy lại thì bỏ qua phần đã xong với tư liệu không đổi, và tiếp tục từ công đoạn bị lỗi hoặc bị chặn.

## Chạy

```bash
node luan/orchestrator/cli.mjs analyze --project <thư mục dự án> --sources <thư mục hoặc file>[,<...>]
node luan/orchestrator/cli.mjs status --project <thư mục dự án>
node --test luan/orchestrator/test/analyze.test.mjs
```

Cần FFmpeg (`winget install Gyan.FFmpeg`). Transcript cần `whisper-cli` trên PATH.
