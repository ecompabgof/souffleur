'use strict';
const { Capture } = require('../audio/capture');
const { DeepgramStream } = require('../stt/deepgram');
const { Transcript } = require('../stt/transcript');
const { createCoach } = require('../llm/coach');
const { buildCoachSystem } = require('../llm/prompts');
const store = require('../context/store');
const { SessionLog } = require('./log');
const { SESSIONS_DIR, TRANSLATE_MODEL, llmProvider } = require('../config');

const SPEAKERS = ['them', 'me'];
// Final answer: fires FINAL_DELAY_MS after the prospect's utterance closes; cancelled if he resumes.
// Preview: fires while he is still talking, PREVIEW_DEBOUNCE_MS after each final segment. Never
// interrupts a final answer in flight.
const FINAL_DELAY_MS = 600;
const PREVIEW_DEBOUNCE_MS = 900;
const MIN_WORDS_FINAL = 3;
const MIN_WORDS_PREVIEW = 6;
const LEVEL_THROTTLE_MS = 100;
const SILENCE_WARN_MS = 20000;

// Orchestrates one call: 2 captures → 2 Deepgram streams → transcript → coach → log.
// `emit(channel, payload)` pushes events to the renderer.
class Session {
  constructor(opts, emit) {
    this.opts = opts;
    this.emit = emit;
    this.capture = {};
    this.dg = {};
    this.paused = false;
    this.running = false;
    this.lastLevelSent = { them: 0, me: 0 };
    this.lastAudio = { them: 0, me: 0 };
    this.finalTimer = null;
    this.previewTimer = null;
    this.finalInFlight = false;
    this.previewEnabled = opts.preview !== false;
    this.warned = false;
  }

  start() {
    const { themDevice, meDevice, contextNames = [], callContext = '', coachModel } = this.opts;
    const contexts = store.readContexts(contextNames.filter((n) => n !== store.PERSONA_FILE.replace('.md', '')));
    const persona = store.readPersona();
    const system = buildCoachSystem({ persona, contexts, callContext });

    this.coach = createCoach({
      provider: llmProvider(), coachModel, translateModel: TRANSLATE_MODEL, system,
      onError: (err) => this.emit('error', { source: 'claude-cli', message: err.message }),
    });
    this.transcript = new Transcript();
    this.log = new SessionLog({
      dir: SESSIONS_DIR,
      meta: { contexts: contexts.map((c) => c.name), callContext, coachModel, themDevice: themDevice.name, meDevice: meDevice.name },
    });

    this.transcript.on('interim', (p) => { this.emit('stt:interim', p); if (p.speaker === 'them') this._prospectResumed(); });
    this.transcript.on('segment', (p) => { this.emit('stt:segment', p); if (p.speaker === 'them') { this._prospectResumed(); this._schedulePreview(); } });
    this.transcript.on('utterance', (turn) => this._onUtterance(turn));
    this.transcript.on('echo', (p) => { if (p.isFinal) this.emit('stt:echo', p); });

    for (const speaker of SPEAKERS) {
      const device = speaker === 'them' ? themDevice : meDevice;
      this._wireSpeaker(speaker, device);
    }

    this.startedAt = Date.now();
    this.running = true;
    this.autosave = setInterval(() => this._safeSave(), 30000);
    this.watchdog = setInterval(() => this._checkSilence(), 5000);
    this.emit('session:started', { startedAt: this.startedAt });
  }

  _wireSpeaker(speaker, device) {
    const dg = new DeepgramStream({ apiKey: process.env.DEEPGRAM_API_KEY, speaker });
    const cap = new Capture({ deviceIndex: device.index, name: device.name });

    dg.on('status', (s) => this.emit('status', { kind: speaker, state: s }));
    dg.on('error', (err) => this.emit('error', { source: `deepgram:${speaker}`, message: err.message }));
    dg.on('result', (r) => { if (!this.paused) this.transcript.onResult(speaker, r); });
    dg.on('utterance_end', () => this.transcript.onUtteranceEnd(speaker));

    cap.on('data', (buf) => { if (!this.paused) dg.send(buf); });
    cap.on('level', (level) => this._onLevel(speaker, level));
    cap.on('error', (err) => this.emit('error', { source: `ffmpeg:${speaker}`, message: `ffmpeg introuvable ou refusé : ${err.message}` }));
    cap.on('exit', ({ code, stderr }) => {
      if (this.running && code !== 0 && code !== null) {
        this.emit('error', { source: `ffmpeg:${speaker}`, message: `Capture "${device.name}" arrêtée (code ${code}). ${stderr || 'Vérifie le device et la permission micro.'}` });
        this.emit('status', { kind: speaker, state: 'closed' });
      }
    });

    this.dg[speaker] = dg;
    this.capture[speaker] = cap;
    dg.connect();
    cap.start();
  }

  _onLevel(speaker, level) {
    const now = Date.now();
    if (level > 0.005) this.lastAudio[speaker] = now;
    if (now - this.lastLevelSent[speaker] < LEVEL_THROTTLE_MS) return;
    this.lastLevelSent[speaker] = now;
    this.emit('level', { speaker, level });
  }

  // "me" is talking but "them" never produced audio → system output is not routed to BlackHole.
  _checkSilence() {
    if (!this.running || this.paused) return;
    const now = Date.now();
    const meRecent = now - this.lastAudio.me < SILENCE_WARN_MS;
    const themSilent = now - Math.max(this.lastAudio.them, this.startedAt) > SILENCE_WARN_MS;
    if (meRecent && themSilent && !this.warned) {
      this.warned = true;
      this.emit('warn', { message: `Aucun son sur "${this.opts.themDevice.name}" depuis 20 s. Vérifie que la sortie audio système est bien le Multi-Output Device (BlackHole + tes écouteurs).` });
    } else if (!themSilent && this.warned) {
      this.warned = false;
      this.emit('warn', { message: null });
    }
  }

  _onUtterance(turn) {
    this.log.addTurn(turn);
    this.emit('stt:utterance', turn);
    if (turn.speaker !== 'them') return;

    if (turn.lang !== 'fr') {
      this.coach.translate(turn, (ev) => {
        this.emit('llm:translation', ev);
        if (ev.done && ev.text) this.log.setTranslation(turn.id, ev.text);
      });
    } else {
      this.emit('llm:translation', { turnId: turn.id, done: true, skipped: true });
    }

    if (turn.text.split(/\s+/).length < MIN_WORDS_FINAL) return;
    clearTimeout(this.previewTimer);
    clearTimeout(this.finalTimer);
    this.finalTimer = setTimeout(() => this._runCoach({ kind: 'final' }), FINAL_DELAY_MS);
  }

  // He started talking again during the post-utterance delay → not finished, hold the final answer.
  _prospectResumed() {
    clearTimeout(this.finalTimer);
    this.finalTimer = null;
  }

  _schedulePreview() {
    if (!this.previewEnabled || this.finalInFlight) return;
    const { turns, provisional } = this.transcript.snapshot('them');
    const last = turns[turns.length - 1];
    if (!provisional || !last || last.text.split(/\s+/).length < MIN_WORDS_PREVIEW) return;
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this._runCoach({ kind: 'preview' }), PREVIEW_DEBOUNCE_MS);
  }

  _runCoach({ kind = 'final', steer = false } = {}) {
    if (!this.running) return;
    if (kind === 'preview' && this.finalInFlight) return;
    if (kind === 'final') { clearTimeout(this.previewTimer); this.finalInFlight = true; }
    this.emit('status', { kind: 'llm', state: 'busy' });
    const { turns } = this.transcript.snapshot('them');
    this.coach.suggest(turns, (ev) => {
      this.emit('llm:coach', { ...ev, kind });
      if (ev.done || ev.aborted) {
        if (kind === 'final') this.finalInFlight = false;
        this.emit('status', { kind: 'llm', state: ev.error ? 'error' : 'idle' });
      }
      if (ev.done && ev.text && kind === 'final') {
        this.log.addSuggestion({ reqId: ev.reqId, forTurnId: ev.forTurnId, text: ev.text, model: ev.model || this.opts.coachModel, usage: ev.usage });
      }
    }, { steer });
  }

  // ⌘⇧R / "Coach now": the one place where steering back to the call objectives is allowed.
  coachNow() {
    if (!this.running) return;
    clearTimeout(this.finalTimer);
    clearTimeout(this.previewTimer);
    // Flush whatever Deepgram still buffers, give finals ~300 ms to land, then coach.
    for (const s of SPEAKERS) this.dg[s] && this.dg[s].finalize();
    setTimeout(() => {
      if (!this.running) return;
      this.transcript.flushAll();
      this.finalInFlight = false;
      this._runCoach({ kind: 'final', steer: true });
    }, 300);
  }

  togglePause() {
    this.paused = !this.paused;
    this.emit('session:paused', { paused: this.paused });
    return this.paused;
  }

  _safeSave() {
    try { this.log.save(); } catch (err) { this.emit('error', { source: 'log', message: err.message }); }
  }

  stop() {
    this.running = false;
    clearInterval(this.autosave);
    clearInterval(this.watchdog);
    clearTimeout(this.finalTimer);
    clearTimeout(this.previewTimer);
    this.coach.stop();
    for (const s of SPEAKERS) {
      try { this.capture[s] && this.capture[s].stop(); } catch { /* ignore */ }
      try { this.dg[s] && this.dg[s].close(); } catch { /* ignore */ }
    }
    this.transcript.flushAll();
    const file = this.log.save();
    this.emit('session:ended', { file });
    return file;
  }
}

module.exports = { Session };
