'use strict';
const { ClaudeCliSession } = require('./cli-session');
const { TRANSLATE_SYSTEM, STEER_HINT, turnLabel } = require('./prompts');

const CLI_COACH_ADDENDUM = `

Cette conversation EST l'appel : chaque message que tu reçois contient les nouveaux tours de parole depuis ton dernier message. Tu réponds toujours pour le dernier tour du PROSPECT.
Un tour marqué [en cours] est une phrase pas terminée : le message suivant la répétera en entier, ne la compte pas deux fois.`;

const CLI_TRANSLATE_ADDENDUM = `
Chaque message est une phrase indépendante à traduire. Ne fais jamais référence aux messages précédents.`;

// Only the turns the coach session hasn't seen yet, plus the provisional one if any.
function formatNewTurns(turns, lastSentId) {
  const lines = [];
  let maxId = lastSentId;
  for (const t of turns) {
    if (t.provisional) { lines.push(`${turnLabel(t)} [en cours]`); continue; }
    if (t.id <= lastSentId) continue;
    lines.push(turnLabel(t));
    maxId = Math.max(maxId, t.id);
  }
  return { text: lines.join('\n'), lastSentId: maxId };
}

// Same interface as the API Coach, backed by two persistent `claude` processes
// (subscription auth, no API key). Coach session = the running conversation.
class CliCoach {
  constructor({ coachModel, translateModel, system, onError }) {
    const sys = Array.isArray(system) ? system.map((b) => b.text).join('\n\n') : String(system);
    this.coachSess = new ClaudeCliSession({ model: coachModel, systemPrompt: sys + CLI_COACH_ADDENDUM, effort: 'low', label: 'coach' });
    this.transSess = new ClaudeCliSession({ model: translateModel, systemPrompt: TRANSLATE_SYSTEM + CLI_TRANSLATE_ADDENDUM, effort: 'low', label: 'translate' });
    this.coachModel = coachModel;
    this.lastSentId = 0;
    this.handlers = new Map(); // reqId → { onEvent, forTurnId, provisional }
    this.transHandlers = new Map();
    for (const s of [this.coachSess, this.transSess]) {
      s.on('error', (err) => onError && onError(err));
      s.on('exit', ({ code }) => onError && onError(new Error(`process claude (${s.label}) terminé, code ${code}. Relance la session.`)));
      s.start();
    }
    this.coachSess.on('delta', ({ reqId, text }) => { const h = this.handlers.get(reqId); if (h) h.onEvent({ reqId, forTurnId: h.forTurnId, delta: text }); });
    this.coachSess.on('done', ({ reqId, text, error, usage }) => {
      const h = this.handlers.get(reqId); if (!h) return;
      this.handlers.delete(reqId);
      if (h.aborted && !error) { h.onEvent({ reqId, forTurnId: h.forTurnId, aborted: true }); return; }
      h.onEvent({ reqId, forTurnId: h.forTurnId, done: true, text, error, usage, model: this.coachModel });
    });
    this.transSess.on('delta', ({ reqId, text }) => { const h = this.transHandlers.get(reqId); if (h) h.onEvent({ turnId: h.turnId, delta: text }); });
    this.transSess.on('done', ({ reqId, text, error }) => {
      const h = this.transHandlers.get(reqId); if (!h) return;
      this.transHandlers.delete(reqId);
      h.onEvent({ turnId: h.turnId, done: true, text, error });
    });
  }

  translate(turn, onEvent) {
    try {
      const reqId = this.transSess.send(turn.text);
      this.transHandlers.set(reqId, { turnId: turn.id, onEvent });
    } catch (err) { onEvent({ turnId: turn.id, done: true, error: err.message }); }
    return Promise.resolve();
  }

  abort() {
    for (const h of this.handlers.values()) h.aborted = true;
    this.coachSess.interrupt();
  }

  suggest(turns, onEvent, { steer = false } = {}) {
    this.abort();
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    const forTurnId = lastTurn ? lastTurn.id : null;
    const provisional = !!(lastTurn && lastTurn.provisional);
    let { text, lastSentId } = formatNewTurns(turns, this.lastSentId);
    if (steer) text = text ? `${text}\n${STEER_HINT}` : STEER_HINT;
    if (!text) return Promise.resolve();
    this.lastSentId = lastSentId;
    try {
      const reqId = this.coachSess.send(text);
      this.handlers.set(reqId, { onEvent, forTurnId, provisional, aborted: false });
      onEvent({ reqId, forTurnId, provisional, start: true, model: this.coachModel });
    } catch (err) { onEvent({ reqId: -1, forTurnId, done: true, error: err.message }); }
    return Promise.resolve();
  }

  stop() {
    this.coachSess.stop();
    this.transSess.stop();
  }
}

module.exports = { CliCoach, formatNewTurns };
