'use strict';
/* global souffleur */
const $ = (id) => document.getElementById(id);

const state = {
  init: null,
  open: { them: null, me: null },   // currently open bubble element per speaker
  bubbles: new Map(),               // turnId → bubble element
  coach: { reqId: null, text: '', el: null },   // final answer stream
  preview: { reqId: null, text: '' },           // provisional stream (he is still talking)
  prev: [],                         // last final answers (text)
  timerStart: null,
  timerInt: null,
};

// ---------- helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tiny markdown: "## Title" → h3, blank-line separated lines → p, *x* → em. Enough for the coach format.
function mdToHtml(md) {
  const out = [];
  let inSay = false;
  for (const raw of String(md).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      inSay = /r[ée]ponds/i.test(h[1]);
      out.push(`<h3>${esc(h[1])}</h3>`);
      continue;
    }
    let html = esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/^[-•]\s+/, '→ ');
    out.push(`<p class="${inSay ? 'say' : ''}">${html}</p>`);
  }
  return out.join('');
}

function showBanner(msg, kind) {
  const b = $('banner');
  if (!msg) { b.hidden = true; b.textContent = ''; return; }
  b.hidden = false; b.textContent = msg; b.className = `banner ${kind || ''}`;
}

function show(screen) {
  for (const id of ['screen-start', 'screen-live', 'screen-end']) $(id).hidden = id !== screen;
}

function setDot(kind, stateName) {
  const el = $(`dot-${kind}`);
  if (el) el.className = `dot ${stateName}`;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

// ---------- start screen ----------
async function init() {
  const data = await souffleur.invoke('app:init');
  state.init = data;

  const problems = [];
  if (!data.keys.deepgram) problems.push('DEEPGRAM_API_KEY manquante dans .env.');
  if (data.provider === 'api' && !data.keys.anthropic) problems.push('ANTHROPIC_API_KEY manquante dans .env (LLM_PROVIDER=api).');
  if (data.provider === 'cli' && !(data.cliAuth && data.cliAuth.loggedIn)) {
    problems.push(`CLI Claude non connecté${data.cliAuth && data.cliAuth.error ? ' (' + data.cliAuth.error + ')' : ''} → dans un Terminal : claude auth login, puis relance.`);
  }
  const kw = $('keys-warning');
  if (problems.length) {
    kw.hidden = false;
    kw.textContent = problems.join(' ');
    $('btn-start').disabled = true;
  }
  $('coach-meta').textContent = data.provider === 'cli' ? 'via claude CLI' : 'via API';

  const fill = (sel, devices, preferred, fallbackPick) => {
    sel.innerHTML = '';
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = String(d.index); o.textContent = d.name;
      sel.appendChild(o);
    }
    const pick = devices.find((d) => d.name === preferred) || fallbackPick(devices) || devices[0];
    if (pick) sel.value = String(pick.index);
  };
  fill($('sel-them'), data.devices, data.prefs.themDevice, (ds) => ds.find((d) => /blackhole/i.test(d.name)));
  fill($('sel-me'), data.devices, data.prefs.meDevice, (ds) => ds.find((d) => !/blackhole|loopback|soundflower|virtual|camo|zoomaudio|teams/i.test(d.name)));
  if (!data.devices.length) showBanner('Aucun device audio trouvé — ffmpeg est-il installé ? (brew install ffmpeg)', 'err');

  const cx = $('contexts');
  cx.innerHTML = '';
  for (const c of data.contexts) {
    const label = document.createElement('label');
    if (c.always) label.className = 'locked';
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.value = c.name;
    chk.checked = c.always || data.prefs.contexts.includes(c.name);
    chk.disabled = c.always;
    label.append(chk, document.createTextNode(c.title));
    const sz = document.createElement('span'); sz.className = 'sz'; sz.textContent = `${Math.round(c.size / 4)} tok`;
    label.appendChild(sz);
    cx.appendChild(label);
  }

  const sm = $('sel-model');
  sm.innerHTML = '';
  for (const [id, label] of Object.entries(data.models)) {
    const o = document.createElement('option'); o.value = id; o.textContent = label; sm.appendChild(o);
  }
  sm.value = data.prefs.coachModel || 'claude-sonnet-5';
  $('chk-preview').checked = data.prefs.preview !== false;
  $('call-context').value = data.prefs.callContext || '';
  $('memo-start').value = data.prefs.memo || '';
  $('memo-text').value = data.prefs.memo || '';
}

function deviceFromSelect(sel) {
  const idx = Number(sel.value);
  return state.init.devices.find((d) => d.index === idx);
}

async function startSession() {
  const opts = {
    themDevice: deviceFromSelect($('sel-them')),
    meDevice: deviceFromSelect($('sel-me')),
    contextNames: [...$('contexts').querySelectorAll('input:checked')].map((i) => i.value),
    callContext: $('call-context').value,
    coachModel: $('sel-model').value,
    preview: $('chk-preview').checked,
  };
  if (!opts.themDevice || !opts.meDevice) { showBanner('Choisis les deux devices audio.', 'err'); return; }
  if (opts.themDevice.index === opts.meDevice.index) { showBanner('« Eux » et « Toi » doivent être deux devices différents.', 'err'); return; }
  const res = await souffleur.invoke('session:start', opts);
  if (res.error) { showBanner(res.error, 'err'); return; }
  resetLive();
  show('screen-live');
}

function resetLive() {
  $('transcript').innerHTML = '';
  $('coach-body').innerHTML = '<em class="muted">En attente du prospect…</em>';
  $('coach-meta').textContent = '';
  state.open = { them: null, me: null };
  state.bubbles.clear();
  state.coach = { reqId: null, text: '', el: null };
  state.preview = { reqId: null, text: '' };
  $('coach-preview').innerHTML = '';
  $('preview-wrap').hidden = true;
  state.prev = [];
  showBanner(null);
  $('timer').hidden = false;
  state.timerStart = Date.now();
  clearInterval(state.timerInt);
  state.timerInt = setInterval(() => { $('timer').textContent = fmtTime(Date.now() - state.timerStart); }, 1000);
}

// ---------- transcript ----------
function ensureBubble(speaker) {
  if (state.open[speaker]) return state.open[speaker];
  const el = document.createElement('div');
  el.className = `bubble ${speaker}`;
  el.innerHTML = `<div class="who">${speaker === 'them' ? 'prospect' : 'toi'}</div><div class="final"></div><div class="interim"></div><div class="trad"></div>`;
  $('transcript').appendChild(el);
  state.open[speaker] = el;
  scrollTranscript();
  return el;
}

function scrollTranscript() {
  const t = $('transcript');
  t.scrollTop = t.scrollHeight;
}

function onInterim({ speaker, text }) {
  const b = ensureBubble(speaker);
  b.querySelector('.interim').textContent = text;
  scrollTranscript();
}

function onSegment({ speaker, text }) {
  const b = ensureBubble(speaker);
  const f = b.querySelector('.final');
  f.textContent = (f.textContent ? f.textContent + ' ' : '') + text;
  b.querySelector('.interim').textContent = '';
  scrollTranscript();
}

function onUtterance(turn) {
  const b = ensureBubble(turn.speaker);
  b.querySelector('.final').textContent = turn.text;
  b.querySelector('.interim').textContent = '';
  b.dataset.turnId = String(turn.id);
  state.bubbles.set(turn.id, b);
  state.open[turn.speaker] = null;
  scrollTranscript();
}

function onTranslation(ev) {
  const b = state.bubbles.get(ev.turnId);
  if (!b) return;
  const tr = b.querySelector('.trad');
  if (ev.delta) tr.textContent += ev.delta;
  if (ev.done) {
    if (ev.error) tr.textContent = `⚠ ${ev.error}`;
    else if (ev.skipped) tr.textContent = '';
    else {
      const orig = b.querySelector('.final').textContent.trim().toLowerCase();
      if (ev.text && ev.text.trim().toLowerCase() === orig) tr.textContent = '';
    }
  }
  scrollTranscript();
}

// ---------- coach ----------
// Two zones. "Réponse" = final answer (prospect finished). Its text is never blanked: a new final
// dims the old one and replaces it only once the new text actually starts arriving.
// "Aperçu" = provisional stream while he is still talking; cleared when a final starts.
function onCoach(ev) {
  if (ev.kind === 'preview') return onPreview(ev);
  const body = $('coach-body');
  if (ev.start) {
    state.coach = { reqId: ev.reqId, text: '', el: null, started: false };
    body.classList.add('stale');
    $('coach-meta').textContent = `${(ev.model || '').replace('claude-', '')} · nouvelle réponse…`;
    $('preview-wrap').hidden = true;
    $('coach-preview').innerHTML = '';
    state.preview = { reqId: null, text: '' };
    return;
  }
  if (ev.reqId !== state.coach.reqId) return; // stale stream
  if (ev.delta) {
    if (!state.coach.started) {
      // first real token: now swap the old answer out
      state.coach.started = true;
      const old = body.querySelector('.cur');
      if (old && old.dataset.text) { state.prev.unshift(old.dataset.text); state.prev = state.prev.slice(0, 3); }
      body.classList.remove('stale');
      body.innerHTML = '';
      const cur = document.createElement('div'); cur.className = 'cur cursor';
      body.appendChild(cur);
      state.coach.el = cur;
      for (const p of state.prev) { const d = document.createElement('div'); d.className = 'prev'; d.innerHTML = mdToHtml(p); body.appendChild(d); }
      body.scrollTop = 0;
    }
    state.coach.text += ev.delta;
    state.coach.el.innerHTML = mdToHtml(state.coach.text);
    state.coach.el.dataset.text = state.coach.text;
  }
  if (ev.aborted) { body.classList.remove('stale'); if (state.coach.el) state.coach.el.classList.remove('cursor'); return; }
  if (ev.done) {
    body.classList.remove('stale');
    if (state.coach.el) state.coach.el.classList.remove('cursor');
    if (ev.error) {
      const e = document.createElement('p'); e.className = 'err'; e.textContent = `⚠ ${ev.error}`;
      (state.coach.el || body).appendChild(e);
    }
    const u = ev.usage || {};
    const cached = u.cacheRead ? ` · cache ${u.cacheRead}` : '';
    $('coach-meta').textContent = `${(ev.model || '').replace('claude-', '')} · ${u.input || 0}→${u.output || 0} tok${cached}`;
  }
}

function onPreview(ev) {
  const zone = $('coach-preview');
  if (ev.start) {
    state.preview = { reqId: ev.reqId, text: '' };
    $('preview-wrap').hidden = false;
    zone.innerHTML = '<span class="cursor"></span>';
    return;
  }
  if (ev.reqId !== state.preview.reqId) return;
  if (ev.delta) { state.preview.text += ev.delta; zone.innerHTML = mdToHtml(state.preview.text) + '<span class="cursor"></span>'; }
  if (ev.done || ev.aborted) zone.innerHTML = mdToHtml(state.preview.text) || '';
}

// ---------- memo ----------
// One text, two textareas (start screen + live panel), persisted in prefs. Never rendered in
// screen shares: the whole window is content-protected.
let memoTimer = null;
function syncMemo(from) {
  const v = from.value;
  for (const id of ['memo-start', 'memo-text']) if ($(id) !== from) $(id).value = v;
  clearTimeout(memoTimer);
  memoTimer = setTimeout(() => souffleur.invoke('memo:save', v), 400);
}
function memoSetState(state) { // 'collapsed' | 'normal' | 'full'
  const m = $('memo');
  m.classList.toggle('collapsed', state === 'collapsed');
  m.classList.toggle('full', state === 'full');
  $('screen-live').classList.toggle('memo-full', state === 'full');
  $('memo-full').textContent = state === 'full' ? '⤡' : '⤢';
  if (state !== 'collapsed') $('memo-text').focus();
}
function memoState() { const m = $('memo'); return m.classList.contains('collapsed') ? 'collapsed' : m.classList.contains('full') ? 'full' : 'normal'; }
function memoToggle() { memoSetState(memoState() === 'collapsed' ? 'normal' : 'collapsed'); }
$('memo-start').addEventListener('input', (e) => syncMemo(e.target));
$('memo-text').addEventListener('input', (e) => syncMemo(e.target));
$('memo-toggle').addEventListener('click', memoToggle);
$('memo-full').addEventListener('click', () => memoSetState(memoState() === 'full' ? 'normal' : 'full'));
souffleur.on('memo:toggle', memoToggle);

// ---------- wiring ----------
souffleur.on('stt:interim', onInterim);
souffleur.on('stt:segment', onSegment);
souffleur.on('stt:utterance', onUtterance);
souffleur.on('stt:echo', ({ text }) => {
  const el = document.createElement('div'); el.className = 'echo'; el.title = text; el.textContent = '· écho de ta voix ignoré ·';
  $('transcript').appendChild(el); scrollTranscript();
});
souffleur.on('llm:translation', onTranslation);
souffleur.on('llm:coach', onCoach);
souffleur.on('status', ({ kind, state: s }) => setDot(kind, s));
souffleur.on('level', ({ speaker, level }) => { const el = $(`lvl-${speaker}`); if (el) el.style.width = `${Math.min(100, Math.round(level * 400))}%`; });
souffleur.on('warn', ({ message }) => showBanner(message, 'warn'));
souffleur.on('error', ({ source, message }) => showBanner(`[${source}] ${message}`, 'err'));
souffleur.on('session:paused', ({ paused }) => { $('btn-pause').textContent = paused ? 'Reprendre' : 'Pause'; });
souffleur.on('session:ended', ({ file }) => {
  clearInterval(state.timerInt);
  $('timer').hidden = true;
  $('end-file').textContent = file;
  $('end-file').dataset.file = file;
  show('screen-end');
});

$('btn-start').addEventListener('click', startSession);
$('btn-stop').addEventListener('click', () => souffleur.invoke('session:stop'));
$('btn-pause').addEventListener('click', () => souffleur.invoke('session:pause'));
$('btn-coach').addEventListener('click', () => souffleur.invoke('coach:now'));
$('btn-hide').addEventListener('click', () => souffleur.invoke('window:hide'));
$('btn-quit').addEventListener('click', () => souffleur.invoke('app:quit'));
$('btn-open-contexts').addEventListener('click', () => souffleur.invoke('open:dir', state.init.contextsDir));
$('btn-open-session').addEventListener('click', () => souffleur.invoke('open:path', $('end-file').dataset.file));
$('btn-new').addEventListener('click', async () => { await init(); show('screen-start'); });

init().catch((err) => showBanner(`Init: ${err.message}`, 'err'));
