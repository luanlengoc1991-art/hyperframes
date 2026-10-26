# LUAN AI VIDEO PRO — Claude + HyperFrames

Workflow for **one Vietnamese brief → one finished MP4**. This integration uses HyperFrames' official video skills and CLI; FilmCraft is not needed.

## One-time setup (Windows / Claude Code)

1. Install **Node.js 22+**, **FFmpeg** and **Claude Code** on the computer doing the render.
2. Use a clone of `luanlengoc1991-art/hyperframes` containing the `.claude/skills/video-pro/SKILL.md` file (this file must be merged into `main` before it appears there).
3. In a terminal, register the official HyperFrames plugin for Claude Code:

   ```powershell
   claude plugin marketplace add heygen-com/hyperframes
   claude plugin install hyperframes@hyperframes
   claude plugin details hyperframes
   ```

   If it is already installed, do not install it twice. For plugin updates use `claude plugin update hyperframes@hyperframes` and reload plugins.

4. Check your environment from the HyperFrames checkout:

   ```powershell
   node --version
   ffmpeg -version
   npx hyperframes doctor
   claude
   ```

5. Inside Claude Code, run this command:

   ```text
   /video-pro Tạo video quảng cáo bất động sản 30 giây, 9:16, tiếng Việt, phong cách cinematic luxury, chỉ dùng thông tin và hình ảnh dự án đã xác minh. Tự làm từ kịch bản đến MP4.
   ```

   The project-local `/video-pro` skill works with the official `/hyperframes:hyperframes` plugin and the `hyperframes-cli`, registry and media skills.

## What happens

1. Claude writes `SPEC.md` with scenes, timing, factual content and design decisions.
2. Claude prepares or selects approved footage, images, music, narration and captions. It uses user-provided assets preferentially.
3. HyperFrames builds editable HTML motion compositions.
4. Claude runs `hyperframes lint`, `hyperframes check`, preview/snapshot review and fixes problems.
5. HyperFrames renders `final.mp4`; Claude checks the actual file, resolution, duration and audio before reporting it as finished.

## Output structure

```text
video-productions/
  20261026-vinhomes-intro/
    index.html
    compositions/
    assets/
    SPEC.md
    ASSETS.md
    final.mp4
```

The `video-productions/` directory is gitignored so large media assets and renders do not get committed to the framework's source tree. To back up or publish finished videos, copy them to your chosen storage explicitly.

## Defaults

- Vietnamese copy and voice when requested; 9:16, 1080 × 1920, 30 fps, 20–30 seconds unless you specify otherwise.
- One polished render, no storyboard approval loop. The command may still ask about indispensable missing assets, rights or paid-service authorization.
- User assets and verified project facts take precedence. An AI-rendered building must not be represented as verified on-site footage.
- Local HTML animation and MP4 rendering can work without FilmCraft; external AI footage generation, cloud rendering, music, voice or avatars may need separate setup, provider access or fees.

## Notes

- This is an **agent workflow**, not an executable video that magically renders from a GitHub PR. It starts working after the skill is present in your local checkout and you run Claude Code with the required tools.
- Test first using a short, supplied-media video before relying on unattended production of longer projects.
- Do **not** run `npx skills add heygen-com/hyperframes --all` inside the HyperFrames source checkout: see its root `CLAUDE.md` warning. Use the official Claude plugin.

See also the official [HyperFrames Claude plugin guide](https://hyperframes.heygen.com/guides/plugins) and [CLI reference](https://hyperframes.heygen.com/packages/cli).
