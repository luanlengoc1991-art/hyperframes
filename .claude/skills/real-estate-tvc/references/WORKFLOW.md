# Workflow and QA

1. Use a traceable source (project document, dated official website or approved brief) for each price, legal status, timetable, location and capacity claim. Never invent facts, rendered footage or logos.
2. Store real licensed footage, images, voice and music under the video's own assets directory; keep a provenance ledger in ASSET_SOURCES.md. Generated conceptual scenes must not be passed off as real-world completed property.
3. Write one scene per row in brief.json with id, media, title, optional subtitle, voice, narration, captions and claims [{text, source}]. Align to actual voice duration via ffprobe. For accurate word subtitles, use confirmed timestamps or forced alignment. captions.draft.srt is not word-accurate.
4. Run scripts/build.mjs --project projects/active/<slug>. This produces editable HyperFrames scene compositions and a tvc-plan.json. No real media = no fake output.
5. Run HyperFrames lint/check/snapshot; inspect each scene's first, middle and last frame, text safe areas, black/white flashes, continuity, logos, mispronunciations, music balance. Render quality delivery, then run scripts/verify.mjs --project <project> and review the audio by ear. Only report an MP4 if it exists.
6. Read the parent repository's skills/hyperframes, skills/hyperframes-cli and skills/media-use for implementation details. Keep all work in a separate video project.
