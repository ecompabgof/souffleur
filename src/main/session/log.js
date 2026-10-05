'use strict';
const fs = require('fs');
const path = require('path');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}`;
}

function toMarkdown(data) {
  const lines = [];
  lines.push(`# Session ${data.startedAt}`);
  lines.push('');
  if (data.callContext) { lines.push('## Contexte du call'); lines.push(''); lines.push(data.callContext.trim()); lines.push(''); }
  lines.push(`Contextes : ${(data.contexts || []).join(', ') || 'aucun'} · Modèle coach : ${data.coachModel}`);
  lines.push('');
  lines.push('## Transcript');
  lines.push('');
  const sugByTurn = {};
  for (const s of data.suggestions || []) if (s.forTurnId && s.text) sugByTurn[s.forTurnId] = s;
  for (const t of data.turns || []) {
    const who = t.speaker === 'them' ? 'PROSPECT' : 'MOI';
    lines.push(`**${who}** : ${t.text}`);
    if (t.translation && t.translation !== t.text) lines.push(`> _${t.translation}_`);
    const s = sugByTurn[t.id];
    if (s) {
      lines.push('');
      lines.push('<details><summary>Souffleur</summary>');
      lines.push('');
      lines.push(s.text.trim());
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');
  }
  return lines.join('\n');
}

// In-memory session record, flushed to <dir>/<stamp>.json + .md
class SessionLog {
  constructor({ dir, meta }) {
    this.dir = dir;
    this.base = path.join(dir, stamp());
    this.data = { startedAt: new Date().toISOString(), ...meta, turns: [], suggestions: [] };
  }

  addTurn(turn) { this.data.turns.push({ ...turn }); }

  setTranslation(turnId, text) {
    const t = this.data.turns.find((x) => x.id === turnId);
    if (t) t.translation = text;
  }

  addSuggestion(s) { this.data.suggestions.push({ ...s, ts: Date.now() }); }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.data.endedAt = new Date().toISOString();
    fs.writeFileSync(`${this.base}.json`, JSON.stringify(this.data, null, 2));
    fs.writeFileSync(`${this.base}.md`, toMarkdown(this.data));
    return `${this.base}.md`;
  }
}

module.exports = { SessionLog, toMarkdown, stamp };
