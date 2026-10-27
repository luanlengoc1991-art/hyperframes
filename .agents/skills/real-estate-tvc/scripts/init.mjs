#!/usr/bin/env node
import {existsSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const a=process.argv.slice(2),i=a.indexOf('--project');if(i<0||!a[i+1])throw Error('Supply --project <path>');
const project=resolve(a[i+1]);
mkdirSync(join(project,'assets'),{recursive:true});mkdirSync(join(project,'compositions'),{recursive:true});
const sample=resolve(dirname(fileURLToPath(import.meta.url)),'../assets/brief.example.json');
if(!existsSync(join(project,'brief.json')))copyFileSync(sample,join(project,'brief.json'));
if(!existsSync(join(project,'ASSET_SOURCES.md')))writeFileSync(join(project,'ASSET_SOURCES.md'),'# Media provenance\n\n| File | Source / license | Verified date |\n|---|---|---|\n');
console.log('TVC scaffold ready: '+project+' (add footage to assets and edit brief.json)');
