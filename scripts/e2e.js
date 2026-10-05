'use strict';
// Headless end-to-end check against the real APIs, no UI, no BlackHole:
// TTS sentence → ffmpeg PCM → Deepgram stream → Transcript → Claude translate + coach.
// Usage: node scripts/e2e.js ["custom english sentence"]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { DeepgramStream } = require('../src/main/stt/deepgram');
const { Transcript } = require('../src/main/stt/transcript');
const { resolveFfmpeg } = require('../src/main/config');

const TEXT = process.argv[2] || "Thanks for taking the time today. Before we go further, I need to understand how your pricing works, because we already have an internal sales team and I'm not sure this is the right moment for us.";
const SKIP_LLM = process.env.SKIP_LLM === '1';

async function main() {
  const t0 = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'souffleur-'));
  const aiff = path.join(tmp, 'say.aiff');
  execFileSync('say', ['-v', 'Samantha', '-o', aiff, TEXT]);
  console.log(`[tts] ${Date.now() - t0} ms`);

  const transcript = new Transcript();
  const dg = new DeepgramStream({ apiKey: process.env.DEEPGRAM_API_KEY, speaker: 'them' });
  const utterances = [];
  let firstInterim = null;
  let tStream = 0;
  let sent = 0;
  transcript.on('interim', ({ text }) => { if (!firstInterim) { firstInterim = Date.now(); console.log(`[interim +${firstInterim - tStream} ms] ${text}`); } });
  transcript.on('utterance', (u) => { utterances.push(u); console.log(`[utterance lang=${u.lang}] ${u.text}`); });
  dg.on('result', (r) => transcript.onResult('them', r));
  dg.on('utterance_end', () => transcript.onUtteranceEnd('them'));
  dg.on('error', (e) => console.error('[deepgram error]', e.message));
  dg.on('status', (s) => console.log(`[deepgram] ${s}`));

  await new Promise((resolve, reject) => {
    dg.on('status', (s) => { if (s === 'open') resolve(); });
    dg.once('error', reject);
    dg.connect();
  });
  tStream = Date.now();
  // -re = real-time pacing, like a live mic
  const ff = spawn(resolveFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-re', '-i', aiff, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stdout.on('data', (b) => { sent += b.length; dg.send(b); });
  ff.stderr.on('data', (d) => process.stderr.write(`[ffmpeg] ${d}`));
  const code = await new Promise((r) => ff.on('exit', r));
  console.log(`[audio streamed] ${Date.now() - tStream} ms, ${sent} bytes, ffmpeg exit ${code}`);
  // A live mic keeps sending silence; a file stops dead. Feed 2.5 s of silence so endpointing fires.
  const silence = Buffer.alloc(3200); // 100 ms @ 16 kHz mono s16le
  for (let i = 0; i < 25; i++) { dg.send(silence); await new Promise((r) => setTimeout(r, 100)); }
  dg.finalize();
  await new Promise((r) => setTimeout(r, 1500));
  transcript.flushAll();
  dg.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  if (!utterances.length) { console.error('FAIL: no utterance from Deepgram'); process.exit(1); }
  if (SKIP_LLM) { console.log('SKIP_LLM=1 → done.'); return; }

  const { createCoach } = require('../src/main/llm/coach');
  const { llmProvider } = require('../src/main/config');
  const { buildCoachSystem } = require('../src/main/llm/prompts');
  const store = require('../src/main/context/store');
  const system = buildCoachSystem({ persona: store.readPersona(), contexts: store.readContexts(['objections', 'mon-offre']), callContext: 'Call découverte avec Mark, Head of Sales chez Acme SaaS (50 pers). Objectif : qualifier et obtenir un 2e RDV avec le CEO.' });
  const coach = createCoach({ provider: llmProvider(), coachModel: 'claude-sonnet-5', translateModel: 'claude-haiku-4-5', system, onError: (e) => console.error('[coach error]', e.message) });
  console.log(`[llm provider] ${llmProvider()}`);
  if (coach.coachSess) await new Promise((r) => { let n = 0; const done = () => (++n === 2) && r(); coach.coachSess.once('ready', done); coach.transSess.once('ready', done); setTimeout(r, 8000); });

  const last = utterances[utterances.length - 1];
  let t1 = Date.now(), firstTok = null;
  await new Promise((resolve) => coach.translate(last, (ev) => { if (ev.delta && !firstTok) firstTok = Date.now(); if (ev.done) { console.log(`\n[translation ${firstTok ? firstTok - t1 : '?'} ms → ${Date.now() - t1} ms]${ev.error ? ' ERROR ' + ev.error : ''}\n${ev.text || ''}`); resolve(); } }));

  t1 = Date.now(); firstTok = null;
  await new Promise((resolve) => coach.suggest(utterances, (ev) => {
    if (ev.delta && !firstTok) firstTok = Date.now();
    if (ev.done || ev.aborted) { console.log(`\n[coach first token ${firstTok ? firstTok - t1 : '?'} ms → total ${Date.now() - t1} ms]${ev.error ? ' ERROR ' + ev.error : ''}\n${ev.text || ''}\n[usage] ${JSON.stringify(ev.usage || {})}`); resolve(); }
  }));
  // Second turn on warm sessions → the latency that matters in a real call.
  const turn2 = { id: last.id + 1, speaker: 'them', text: "Okay, and what about pricing? How much is it per month, and is there a minimum commitment?", lang: 'en' };
  utterances.push({ id: last.id + 0.5, speaker: 'me', text: "Bonne question. Avant le prix, vous traitez combien de leads par mois aujourd'hui ?" }, turn2);
  console.log('\n=== tour 2 (sessions chaudes) ===');
  t1 = Date.now(); firstTok = null;
  const pTrans = new Promise((resolve) => coach.translate(turn2, (ev) => { if (ev.delta && !firstTok) firstTok = Date.now(); if (ev.done) { console.log(`\n[translation warm: first ${firstTok ? firstTok - t1 : '?'} ms → ${Date.now() - t1} ms]${ev.error ? ' ERROR ' + ev.error : ''}\n${ev.text || ''}`); resolve(); } }));
  let t2 = Date.now(), firstTok2 = null;
  const pCoach = new Promise((resolve) => coach.suggest(utterances, (ev) => {
    if (ev.delta && !firstTok2) firstTok2 = Date.now();
    if (ev.done || ev.aborted) { console.log(`\n[coach warm: first ${firstTok2 ? firstTok2 - t2 : '?'} ms → total ${Date.now() - t2} ms, ${(ev.text || '').split(/\s+/).length} mots]${ev.error ? ' ERROR ' + ev.error : ''}\n${ev.text || ''}\n[usage] ${JSON.stringify(ev.usage || {})}`); resolve(); }
  }));
  await Promise.all([pTrans, pCoach]);
  if (coach.stop) coach.stop();
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
