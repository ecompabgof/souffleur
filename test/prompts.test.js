import { describe, it, expect } from 'vitest';
import { buildCoachMessages, windowTurns, buildCoachSystem } from '../src/main/llm/prompts.js';

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, speaker: i % 2 ? 'me' : 'them', text: `t${i + 1}` }));

describe('windowTurns', () => {
  it('keeps everything under the max', () => {
    expect(windowTurns(mk(60), { maxTurns: 60, block: 20 })).toHaveLength(60);
  });
  it('trims in blocks so the prefix stays stable between boundaries', () => {
    const a = windowTurns(mk(61), { maxTurns: 60, block: 20 });
    const b = windowTurns(mk(79), { maxTurns: 60, block: 20 });
    const c = windowTurns(mk(81), { maxTurns: 60, block: 20 });
    expect(a[0].id).toBe(21);
    expect(b[0].id).toBe(21);
    expect(c[0].id).toBe(41);
  });
});

describe('buildCoachMessages', () => {
  it('labels speakers, caches the last turn, ends with the instruction', () => {
    const msgs = buildCoachMessages(mk(3));
    expect(msgs).toHaveLength(4);
    expect(msgs[0].content).toBe('PROSPECT: t1');
    expect(msgs[1].content).toBe('MOI: t2');
    expect(msgs[2].content[0]).toMatchObject({ type: 'text', text: 'PROSPECT: t3', cache_control: { type: 'ephemeral' } });
    expect(msgs[3].role).toBe('user');
    expect(msgs[3].content).toMatch(/dernier tour/);
  });
});

describe('buildCoachSystem', () => {
  it('produces one cached block containing persona, contexts and call notes', () => {
    const sys = buildCoachSystem({ persona: 'P', contexts: [{ title: 'Offre', text: 'X' }], callContext: 'Call with Bob' });
    expect(sys).toHaveLength(1);
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[0].text).toContain('PERSONA');
    expect(sys[0].text).toContain('CONTEXTE — Offre');
    expect(sys[0].text).toContain('Call with Bob');
    expect(sys[0].text.indexOf('RÈGLE FINALE')).toBeGreaterThan(sys[0].text.indexOf('Call with Bob'));
  });
});

describe('steer hint', () => {
  it('replaces the default instruction when steer is requested', async () => {
    const { buildCoachMessages: b, STEER_HINT } = await import('../src/main/llm/prompts.js');
    const msgs = b(mk(1), { steer: true });
    expect(msgs[msgs.length - 1].content).toBe(STEER_HINT);
    expect(b(mk(1))[1].content).not.toBe(STEER_HINT);
  });
});
