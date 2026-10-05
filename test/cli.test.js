import { describe, it, expect } from 'vitest';
import { formatNewTurns } from '../src/main/llm/coach-cli.js';
import { childEnv } from '../src/main/llm/cli-session.js';

describe('formatNewTurns', () => {
  const turns = [
    { id: 1, speaker: 'them', text: 'hi' },
    { id: 2, speaker: 'me', text: 'salut' },
    { id: 3, speaker: 'them', text: 'price?' },
  ];
  it('sends only unseen turns and advances the cursor', () => {
    const a = formatNewTurns(turns, 0);
    expect(a.text).toBe('PROSPECT: hi\nMOI: salut\nPROSPECT: price?');
    expect(a.lastSentId).toBe(3);
    const b = formatNewTurns(turns, 3);
    expect(b.text).toBe('');
    expect(b.lastSentId).toBe(3);
  });
  it('appends a provisional turn without advancing the cursor', () => {
    const r = formatNewTurns([...turns, { id: 4, speaker: 'them', text: 'and also', provisional: true }], 3);
    expect(r.text).toBe('PROSPECT: and also [en cours]');
    expect(r.lastSentId).toBe(3);
  });
});

describe('childEnv', () => {
  it('strips API key and nested-session markers', () => {
    process.env.ANTHROPIC_API_KEY = 'x'; process.env.CLAUDECODE = '1';
    const env = childEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });
});
