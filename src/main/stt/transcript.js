'use strict';
const EventEmitter = require('events');

const ECHO_WINDOW_MS = 8000;
const ECHO_MIN_WORDS = 3;
const ECHO_CONTAINMENT = 0.7;

function words(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
}

// Pure reducer: Deepgram results → interim / segment / utterance events.
// An utterance = concatenated final segments closed by speech_final or UtteranceEnd.
// Echo guard: "them" text that mostly repeats what "me" just said (the user's voice leaking back
// through the other party's speakers → Meet → BlackHole) is dropped, emitted as 'echo'.
class Transcript extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.turns = [];
    this.pending = { them: [], me: [] };
    this.interim = { them: null, me: null };
    this.recentMe = []; // [{ words:Set, ts }]
    this.nextId = 1;
  }

  _rememberMe(text) {
    const ts = this.now();
    this.recentMe.push({ words: new Set(words(text)), ts });
    this.recentMe = this.recentMe.filter((e) => ts - e.ts < ECHO_WINDOW_MS);
  }

  isEcho(text) {
    const ws = words(text);
    if (ws.length < ECHO_MIN_WORDS) return false;
    const ts = this.now();
    const recent = this.recentMe.filter((e) => ts - e.ts < ECHO_WINDOW_MS);
    if (!recent.length) return false;
    const pool = new Set();
    for (const e of recent) for (const w of e.words) pool.add(w);
    const hit = ws.filter((w) => pool.has(w)).length;
    return hit / ws.length >= ECHO_CONTAINMENT;
  }

  onResult(speaker, r) {
    const text = String(r.transcript || '').trim();
    if (!text) return;
    if (speaker === 'me') this._rememberMe(text);
    else if (this.isEcho(text)) { this.emit('echo', { text, isFinal: !!r.is_final }); return; }
    if (!r.is_final) {
      this.interim[speaker] = text;
      this.emit('interim', { speaker, text });
      return;
    }
    // Speaker switch: close the other speaker's open utterance first to keep chronology.
    const other = speaker === 'them' ? 'me' : 'them';
    if (this.pending[other].length) this.flush(other);

    this.pending[speaker].push({ text, lang: r.lang || null });
    this.interim[speaker] = null;
    this.emit('segment', { speaker, text });
    if (r.speech_final) this.flush(speaker);
  }

  onUtteranceEnd(speaker) {
    this.flush(speaker);
  }

  flush(speaker) {
    const parts = this.pending[speaker];
    if (!parts.length) return null;
    const text = parts.map((p) => p.text).join(' ');
    const counts = {};
    for (const p of parts) if (p.lang) counts[p.lang] = (counts[p.lang] || 0) + 1;
    let lang = null;
    for (const [k, v] of Object.entries(counts)) if (!lang || v > counts[lang]) lang = k;
    const turn = { id: this.nextId++, speaker, text, lang, ts: Date.now() };
    this.turns.push(turn);
    this.pending[speaker] = [];
    this.emit('utterance', turn);
    return turn;
  }

  flushAll() {
    this.flush('them');
    this.flush('me');
  }

  // Turns + a provisional turn for the speaker's not-yet-closed utterance (early coaching).
  // The provisional id is the one the utterance will get on flush, so logs line up.
  snapshot(speaker) {
    const parts = this.pending[speaker];
    if (!parts.length) return { turns: this.turns, provisional: false };
    const text = parts.map((p) => p.text).join(' ');
    return { turns: [...this.turns, { id: this.nextId, speaker, text, provisional: true }], provisional: true };
  }
}

module.exports = { Transcript, words };
