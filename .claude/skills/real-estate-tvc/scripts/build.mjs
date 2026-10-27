#!/usr/bin/env node
// Assemble a deterministic, locally editable HyperFrames project from licensed media.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, join, extname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (key) => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
const project = resolve(arg('--project') || '.');
const briefPath = resolve(arg('--brief') || join(project, 'brief.json'));
const err = (msg) => { throw new Error(msg); };
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const num = (n) => String(Math.round(n * 1000) / 1000);
const execute = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { cwd: project, encoding: 'utf8', maxBuffer: 8388608 });
  if (r.error || r.status !== 0) err(cmd + ' failed: ' + (r.stderr || r.error?.message || 'exit ' + r.status));
  return r.stdout.trim();
};
const checkAsset = (p) => {
  if (typeof p !== 'string' || !p.startsWith('assets/') || p.includes('..') || p.includes('\\')) err('Invalid asset path: ' + p);
  const full = resolve(project, p);
  if (!full.startsWith(project + sep) || !existsSync(full)) err('Missing asset: ' + p);
  return p;
};
const probe = (p) => {
  const d = Number(execute('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',resolve(project,p)]));
  if (!(d > 0 && Number.isFinite(d))) err('Cannot read media duration: ' + p);
  return d;
};
const timeSrt = (t) => { const a = Math.round(t * 1000); return [Math.floor(a/3600000),Math.floor(a/60000)%60,Math.floor(a/1000)%60].map(v => String(v).padStart(2,'0')).join(':') + ',' + String(a%1000).padStart(3,'0'); };
const safeWrite = (p, s) => {
  if (existsSync(p) && !readFileSync(p,'utf8').startsWith('<!-- AUTO-TVC')) err('Refusing to overwrite hand-edited HTML: ' + relative(project,p));
  writeFileSync(p,s);
};

if (!existsSync(briefPath)) err('No brief found: ' + briefPath);
const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
if (!Array.isArray(brief.scenes) || !brief.scenes.length) err('scenes must be nonempty');
if (brief.aspect && !['9:16','16:9'].includes(brief.aspect)) fail('Invalid aspect; expected 9:16 or 16:9');
const width = brief.aspect === '16:9' ? 1920 : 1080;
const height = brief.aspect === '16:9' ? 1080 : 1920;
const fps = brief.fps ?? 30;
if (![24,25,30,60].includes(fps)) err('fps must be 24, 25, 30, or 60');
if (brief.music) checkAsset(brief.music);
const scenes = [];
const ids = new Set();
let total = 0;
for (const s of brief.scenes) {
  if (!/^[a-z][a-z0-9-]*$/.test(s.id) || ids.has(s.id)) err('Invalid/duplicate scene id: ' + s.id);
  ids.add(s.id);
  if (typeof s.title !== 'string' || !s.title.trim()) err('Title required for ' + s.id);
  const media = checkAsset(s.media);
  const ext = extname(media).toLowerCase();
  const video = ['.mp4','.mov','.webm','.m4v'].includes(ext);
  if (!video && !['.jpg','.jpeg','.png','.webp'].includes(ext)) err('Unsupported media: ' + media);
  const voice = s.voice ? checkAsset(s.voice) : null;
  const voiceDuration = voice ? probe(voice) : 0;
  const duration = s.duration ?? (voice ? voiceDuration + 0.35 : null);
  if (!(typeof duration === 'number' && Number.isFinite(duration) && duration >= .5 && duration <= 90)) err('Invalid duration for ' + s.id);
  if (voiceDuration > duration + .05) err('Voice too long for ' + s.id);
  if (video && probe(media) + .05 < duration) err('Video is shorter than scene ' + s.id);
  if (s.claims && (!Array.isArray(s.claims) || s.claims.some(c => !c.text || !c.source))) err('Claims require text and source in ' + s.id);
  scenes.push({ ...s, media, video, voice, voiceDuration, duration, start: total });
  total += duration;
}
total = Math.round(total * 1000) / 1000;
if (brief.music && probe(brief.music) + .05 < total) err('Music too short: prepare a loop first');
mkdirSync(join(project,'compositions'),{recursive:true});
for (const s of scenes) {
  const name = 'scene-' + s.id;
  const start = Math.min(.6,s.duration/5);
  const len = Math.max(.2,s.duration-start-.1);
  const media = s.video
    ? '<video id="media-'+s.id+'" class="clip" data-start="0" data-duration="'+num(s.duration)+'" data-track-index="0" src="'+esc(s.media)+'" muted playsinline></video>'
    : '<img id="media-'+s.id+'" class="clip" data-start="0" data-duration="'+num(s.duration)+'" data-track-index="0" src="'+esc(s.media)+'" alt=""/>';
  const css = '#root{position:absolute;inset:0;background:#080e19;overflow:hidden}#media-'+s.id+'{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}#shade-'+s.id+'{position:absolute;inset:0;background:linear-gradient(0deg,rgba(2,8,20,.86),transparent 70%);pointer-events:none}#copy-'+s.id+'{position:absolute;bottom:18%;left:8%;right:8%;color:white;font-family:Montserrat,sans-serif}#title-'+s.id+'{font-size:70px;font-weight:700;line-height:1.13;text-shadow:0 2px 14px #08101f}#sub-'+s.id+'{font-size:31px;margin-top:22px;color:#eee4cb}';
  const scene = [
    '<!-- AUTO-TVC generated from brief.json -->','<template>','<style>',css,'</style>',
    '<div id="root" data-composition-id="'+name+'" data-width="'+width+'" data-height="'+height+'">',
    media,'<div id="shade-'+s.id+'" data-layout-ignore></div>',
    '<div id="copy-'+s.id+'" class="clip" data-start="'+num(start)+'" data-duration="'+num(len)+'" data-track-index="2">',
    '<div id="title-'+s.id+'">'+esc(s.title)+'</div>',
    s.subtitle ? '<div id="sub-'+s.id+'">'+esc(s.subtitle)+'</div>' : '',
    '</div></div>','<script>',
    'const tl=gsap.timeline({paused:true});',
    "tl.fromTo('#title-"+s.id+"',{opacity:0,y:32},{opacity:1,y:0,duration:.65,ease:'power3.out'},"+num(start)+');',
    "window.__timelines=window.__timelines||{};window.__timelines['"+name+"']=tl;",
    '</script>','</template>'
  ].join('\n');
  safeWrite(join(project,'compositions',name+'.html'),scene);
}
const hosts = scenes.map(s => '<div id="host-'+s.id+'" data-composition-id="scene-'+s.id+'" data-composition-src="compositions/scene-'+s.id+'.html" data-start="'+num(s.start)+'" data-duration="'+num(s.duration)+'" data-track-index="1" data-track-kind="graphics" data-width="'+width+'" data-height="'+height+'"></div>').join('\n');
const voices = scenes.filter(s => s.voice).map(s => '<audio id="voice-'+s.id+'" class="clip" data-start="'+num(s.start)+'" data-duration="'+num(s.voiceDuration)+'" data-track-index="4" data-volume="1" src="'+esc(s.voice)+'"></audio>').join('\n');
const captions = scenes.filter(s => s.caption).map(s => '<div id="caption-'+s.id+'" class="clip" data-start="'+num(s.start)+'" data-duration="'+num(s.voice ? s.voiceDuration : s.duration)+'" data-track-index="5" style="position:absolute;left:9%;right:9%;bottom:7%;z-index:25;color:white;text-align:center;font:600 37px Montserrat,sans-serif;text-shadow:0 2px 14px black">'+esc(s.caption)+'</div>').join('\n');
const music = brief.music ? '<audio id="music" class="clip" data-start="0" data-duration="'+num(total)+'" data-track-index="3" data-volume="'+(Number.isFinite(brief.musicVolume)?Math.max(0,Math.min(.5,brief.musicVolume)):.17)+'" src="'+esc(brief.music)+'"></audio>' : '';
const html = ['<!-- AUTO-TVC generated from brief.json -->','<!doctype html><html lang="vi"><head><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><title>'+esc(brief.title || 'Real Estate TVC')+'</title></head>',
'<body style="margin:0;background:#080e19"><div id="root" data-composition-id="tvc" data-start="0" data-duration="'+num(total)+'" data-width="'+width+'" data-height="'+height+'">',
hosts,voices,music,captions,'</div><script>window.__timelines=window.__timelines||{};window.__timelines.tvc=gsap.timeline({paused:true});</script></body></html>'].join('\n');
safeWrite(join(project,'index.html'),html);
const srt = scenes.filter(s => s.narration).map((s,i) => [i+1,timeSrt(s.start)+' --> '+timeSrt(s.start+(s.voice?s.voiceDuration:s.duration)),s.narration.trim(),''].join('\n')).join('\n');
writeFileSync(join(project,'captions.draft.srt'),srt);
writeFileSync(join(project,'tvc-plan.json'),JSON.stringify({title:brief.title,aspect:brief.aspect||'9:16',fps,duration:total,music:brief.music || null, scenes:scenes.map(s => ({id:s.id,start:s.start,duration:s.duration,voiceDuration:s.voiceDuration,media:s.media,voice:s.voice,claims:s.claims||[]}))},null,2)+'\n');
console.log('Built '+scenes.length+' scene(s), '+num(total)+' s, '+width+'x'+height+'. Draft SRT is not word-aligned.');
if (args.includes('--render')) {
  execute('npx',['--no-install','hyperframes','lint']);
  execute('npx',['--no-install','hyperframes','check','--json']);
  execute('npx',['--no-install','hyperframes','render','--quality','delivery','--output','out.mp4']);
  if (Math.abs(probe('out.mp4')-total)>Math.max(.25,2/fps)) err('MP4 duration mismatch');
  console.log('Rendered '+join(project,'out.mp4'));
}
