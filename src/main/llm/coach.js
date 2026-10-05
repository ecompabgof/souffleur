'use strict';
const { getClient, Anthropic } = require('./client');
const { TRANSLATE_SYSTEM, buildCoachMessages } = require('./prompts');

function supportsEffort(model) {
  return !/haiku/.test(model);
}

// Two independent streams per prospect utterance: translation (fast, small model)
// and coach (suggestion). Only the latest coach request matters → previous one is aborted.
class Coach {
  constructor({ coachModel, translateModel, system }) {
    this.client = getClient();
    this.coachModel = coachModel;
    this.translateModel = translateModel;
    this.system = system;
    this.current = null;
    this.reqSeq = 0;
  }

  async translate(turn, onEvent) {
    try {
      const stream = this.client.messages.stream({
        model: this.translateModel,
        max_tokens: 500,
        system: TRANSLATE_SYSTEM,
        messages: [{ role: 'user', content: turn.text }],
      });
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          onEvent({ turnId: turn.id, delta: ev.delta.text });
        }
      }
      onEvent({ turnId: turn.id, done: true, text: text.trim() });
    } catch (err) {
      onEvent({ turnId: turn.id, done: true, error: describe(err) });
    }
  }

  abort() {
    if (this.current) {
      try { this.current.abort(); } catch { /* already finished */ }
      this.current = null;
    }
  }

  stop() { this.abort(); }

  async suggest(turns, onEvent, { steer = false } = {}) {
    this.abort();
    const reqId = ++this.reqSeq;
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    const forTurnId = lastTurn ? lastTurn.id : null;
    const provisional = !!(lastTurn && lastTurn.provisional);
    const params = {
      model: this.coachModel,
      max_tokens: 700,
      system: this.system,
      messages: buildCoachMessages(turns, { steer }),
    };
    if (supportsEffort(this.coachModel)) params.output_config = { effort: 'low' };

    onEvent({ reqId, forTurnId, provisional, start: true, model: this.coachModel });
    let text = '';
    try {
      const stream = this.client.messages.stream(params);
      this.current = stream;
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          onEvent({ reqId, forTurnId, delta: ev.delta.text });
        }
      }
      const final = await stream.finalMessage();
      if (this.current === stream) this.current = null;
      const usage = final.usage || {};
      if (final.stop_reason === 'refusal') {
        onEvent({ reqId, forTurnId, done: true, text, error: 'Le modèle a refusé de répondre.' });
        return;
      }
      onEvent({
        reqId, forTurnId, done: true, text: text.trim(),
        usage: { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens },
      });
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) { onEvent({ reqId, forTurnId, aborted: true }); return; }
      onEvent({ reqId, forTurnId, done: true, text, error: describe(err) });
    }
  }
}

function describe(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Clé Anthropic invalide (ANTHROPIC_API_KEY).';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limit Anthropic — réessaie dans quelques secondes.';
  if (err instanceof Anthropic.APIConnectionError) return 'Connexion Anthropic impossible (réseau ?).';
  if (err instanceof Anthropic.APIError) return `Erreur API Anthropic ${err.status}: ${err.message}`;
  return err && err.message ? err.message : String(err);
}

// provider: 'cli' (persistent `claude` processes, subscription login) or 'api' (Anthropic SDK, API key).
function createCoach({ provider, coachModel, translateModel, system, onError }) {
  if (provider === 'api') return new Coach({ coachModel, translateModel, system });
  const { CliCoach } = require('./coach-cli');
  return new CliCoach({ coachModel, translateModel, system, onError });
}

module.exports = { Coach, supportsEffort, createCoach };
