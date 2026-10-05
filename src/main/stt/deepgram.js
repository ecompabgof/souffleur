'use strict';
const WebSocket = require('ws');
const EventEmitter = require('events');

const { STT } = require('../config');

const DG_URL = 'wss://api.deepgram.com/v1/listen';

function buildUrl({ model, language, endpointing = '300', utteranceEndMs = '1000' }) {
  const q = new URLSearchParams({
    model, language,
    encoding: 'linear16', sample_rate: '16000', channels: '1',
    interim_results: 'true', smart_format: 'true',
    endpointing: String(endpointing), utterance_end_ms: String(utteranceEndMs), vad_events: 'true',
  });
  return `${DG_URL}?${q}`;
}

// Majority language across words (Nova-3 `language=multi` tags each word).
function majorityLang(words) {
  const counts = {};
  for (const w of words || []) if (w.language) counts[w.language] = (counts[w.language] || 0) + 1;
  let best = null;
  for (const [k, v] of Object.entries(counts)) if (!best || v > counts[best]) best = k;
  return best;
}

// One streaming connection per speaker. Reconnects with backoff unless closed by us.
class DeepgramStream extends EventEmitter {
  constructor({ apiKey, speaker, model = STT.model, language = STT.language,
                endpointing = STT.endpointing, utteranceEndMs = STT.utteranceEndMs }) {
    super();
    this.apiKey = apiKey;
    this.speaker = speaker;
    this.language = language;
    this.url = buildUrl({ model, language, endpointing, utteranceEndMs });
    this.ws = null;
    this.closedByUser = false;
    this.backoff = 1000;
    this.keepalive = null;
  }

  connect() {
    this.emit('status', 'connecting');
    this.ws = new WebSocket(this.url, { headers: { Authorization: `Token ${this.apiKey}` } });
    this.ws.on('open', () => {
      this.backoff = 1000;
      this.emit('status', 'open');
      this.keepalive = setInterval(() => this._sendJson({ type: 'KeepAlive' }), 5000);
    });
    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('error', (err) => this.emit('error', err));
    this.ws.on('close', () => {
      clearInterval(this.keepalive);
      if (this.closedByUser) { this.emit('status', 'closed'); return; }
      this.emit('status', 'reconnecting');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
    return this;
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'Results') {
      const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
      if (!alt) return;
      this.emit('result', {
        speaker: this.speaker,
        transcript: alt.transcript || '',
        is_final: !!msg.is_final,
        speech_final: !!msg.speech_final,
        lang: majorityLang(alt.words),
        start: msg.start,
        duration: msg.duration,
      });
    } else if (msg.type === 'UtteranceEnd') {
      this.emit('utterance_end', { speaker: this.speaker });
    } else if (msg.type === 'Error') {
      this.emit('error', new Error(msg.description || msg.message || 'Deepgram error'));
    }
  }

  _sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  send(buf) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  // Ask Deepgram to flush buffered audio as final results now (used by "coach now", pause, stop).
  finalize() {
    this._sendJson({ type: 'Finalize' });
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.keepalive);
    this._sendJson({ type: 'Finalize' });
    this._sendJson({ type: 'CloseStream' });
    if (this.ws) this.ws.close();
  }
}

module.exports = { DeepgramStream, buildUrl, majorityLang };
