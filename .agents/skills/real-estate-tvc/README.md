# Claude Skill: real-estate-tvc

Standalone local Skill for Claude Code in Cursor IDE to create real-estate videos with HyperFrames. Install this folder into `.claude/skills/real-estate-tvc/` under your HyperFrames checkout. Invoke `/real-estate-tvc` followed by your request.

Use `node .claude/skills/real-estate-tvc/scripts/init.mjs --project projects/active/my-tvc`, add footage and adjust `brief.json`, then use `node .claude/skills/real-estate-tvc/scripts/build.mjs --project projects/active/my-tvc`. Render using installed HyperFrames CLI after lint/check/snapshot, then verify the output MP4. Requires Node.js 22+, FFmpeg/ffprobe and an actual functioning HyperFrames renderer. Missing assets/provider permissions are not auto-supplied. See SKILL.md and references/WORKFLOW.md.
