---
name: real-estate-tvc
description: Make a Vietnamese cinematic real-estate TVC or flycam promo from a grounded brief, voiceover and licensed local media using Claude in Cursor and HyperFrames; assemble scenes, verify timecodes, run QA, and render MP4.
metadata:
  internal: true
---

# Claude + HyperFrames: Auto TVC bất động sản

Run from the repo root in Cursor with Claude Code. Reuse existing `skills/hyperframes/SKILL.md`, `skills/hyperframes-cli/SKILL.md` and `skills/media-use/SKILL.md`. This is a local orchestration skill, not a new render engine.

The goal is one user command producing an editable HyperFrames project and an MP4 **when actual inputs and render dependencies exist**. Do not suggest FilmCraft or CapCut.

## Five stages

1. **Grounded script:** Read project documents and available assets; create scene-by-scene Vietnamese narration, camera/motion brief, on-screen title and citations for testable claims. Never invent price, legal status, handover schedule, infrastructure, travel times or permissions. Omit unsupported claims.
2. **Voice & music:** Reuse user-supplied files, or follow `skills/media-use/references/audio.md` to generate voice/music using accessible providers. The repo already has `skills/media-use/audio/scripts/audio.mjs`; choose local or connected provider based on actual availability. ElevenLabs/Higgsfield are optional, not guaranteed connectors. Never spend paid credits unexpectedly. Save generated assets under the video project's `assets/` and record provenance.
3. **Audio-clock/timecodes:** Measure actual voice with `ffprobe`, not guessed word counts. If available, use provider `words[]` timestamps or forced alignment for real word-level subtitles; scene-level draft captions aren't word-accurate. If audio duration changes, recalculate every later shot.
4. **Footage + assembly:** Prefer rights-cleared real footage and flycam of the actual project. Generate illustrative video only if provider access and authorization exist; never portray synthesized properties as documented reality. Write a `brief.json` using `examples/real-estate-tvc/brief.example.json` and assemble via:
   `node examples/real-estate-tvc/build.mjs --project projects/active/<slug>`
   It outputs `index.html`, separate scene compositions, draft SRT and `tvc-plan.json`. Film/overlays use the existing HyperFrames engine and GSAP. Don't modify core packages.
5. **Check, repair, deliver:** Run `npx hyperframes lint`, `npx hyperframes check --json` and `npx hyperframes snapshot` from inside the video project. Inspect first, midpoint and last frame of each shot for black gaps, unreadable text and mismatched location. Verify voice, sound and factual claims independently. Fix issues, then `npx hyperframes render --quality delivery --output out.mp4`. Run `ffprobe` on MP4 for duration, resolution and streams. Provide the actual file and review notes. When assets/providers are missing, deliver the plan or editable project and state what remains; never claim an MP4 that does not exist.

For a repeatable local assembly/render pass, use `node examples/real-estate-tvc/build.mjs --project projects/active/<slug> --render`. This does not replace human/agent visual review and voice alignment.

Example request: “/real-estate-tvc Tạo TVC Cần Giờ 45 giây từ footage thực tế trong assets, 9:16, giọng Việt cao cấp, nhạc cinematic, tự dựng bằng HyperFrames và xuất MP4.”
