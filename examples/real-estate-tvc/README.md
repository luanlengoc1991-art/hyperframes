# Auto TVC bất động sản · Claude + HyperFrames

Pilot workflow for **Claude inside Cursor IDE**, built on the existing HyperFrames engine. No FilmCraft or CapCut required.

## Quick start

1. Create a **separate video project** at `projects/active/cangio-tvc/` with real licensed footage/images and voice/music files in `assets/`. Do not use footage from the tutorial as property footage.
2. Copy the sample manifest into `projects/active/cangio-tvc/brief.json`. Replace paths with actual local media and verify any factual claims against official sources.
3. Run from the **repository root**:

```bash
node examples/real-estate-tvc/build.mjs --project projects/active/cangio-tvc
cd projects/active/cangio-tvc
npx hyperframes lint
npx hyperframes check --json
npx hyperframes snapshot
npx hyperframes preview
npx hyperframes render --quality delivery --output out.mp4
```

If assets are ready and the CLI is installed, pass `--render` to the builder to run lint/check/render and verify MP4 length. Review snapshots before delivery.

## Manifest contract

- `aspect`: `9:16` (default) or `16:9`; `fps`: 24, 25, 30 or 60.
- Each `scene`: `id`, `title`, optional `subtitle`, `media` path under `assets/`; optional `voice`, `duration`, `narration`, `caption` and `claims` (each claim with a `text` and a real `source`).
- If `voice` exists, duration is measured from `ffprobe` plus 0.35 seconds unless the scene overrides it. If no `voice`, duration is mandatory. Video footage must be long enough to cover the shot.
- Optional `music` and `musicVolume`: audio under `assets/`; track must cover the whole film. Prepare loops separately.
- `caption` is short visible overlay text; `captions.draft.srt` is **scene-aligned only**, not verified word timing. For word-accurate captions, read real word-level timing or run forced alignment.
- Claim `source` fields are provenance, not automatic truth verification; Claude must check them.

Builder outputs `index.html`, `compositions/scene-*.html`, `tvc-plan.json` and `captions.draft.srt`. `out.mp4` only exists after a successful renderer pass. Builder does not invoke ElevenLabs, Higgsfield or synthetic image APIs, and never fabricates missing footage. Requirements: Node.js 22+, FFmpeg/ffprobe, HyperFrames CLI for rendering. It refuses to overwrite manually edited HTML compositions without its own generation marker.
