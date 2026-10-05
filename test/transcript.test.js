import { describe, it, expect } from 'vitest';
import { Transcript } from '../src/main/stt/transcript.js';

const res = (transcript, extra = {}) => ({ transcript, is_final: false, speech_final: false, ...extra });

describe('Transcript reducer', () => {
  it('emits interim, then segment, then utterance on speech_final', () => {
    const t = new Transcript();
    const events = [];
    for (const ev of ['interim', 'segment', 'utterance']) t.on(ev, (p) => events.push([ev, p]));
    t.onResult('them', res('hello'));
    t.onResult('them', res('hello there', { is_final: true }));
    t.onResult('them', res('how are you', { is_final: true, speech_final: true }));
    expect(events.map((e) => e[0])).toEqual(['interim', 'segment', 'segment', 'utterance']);
    expect(events[3][1]).toMatchObject({ id: 1, speaker: 'them', text: 'hello there how are you' });
    expect(t.turns).toHaveLength(1);
  });

  it('ignores empty transcripts', () => {
    const t = new Transcript();
    t.onResult('them', res('   ', { is_final: true, speech_final: true }));
    expect(t.turns).toHaveLength(0);
  });

  it('flushes on UtteranceEnd', () => {
    const t = new Transcript();
    t.onResult('me', res('oui je vois', { is_final: true }));
    expect(t.turns).toHaveLength(0);
    t.onUtteranceEnd('me');
    expect(t.turns[0]).toMatchObject({ speaker: 'me', text: 'oui je vois' });
    t.onUtteranceEnd('me'); // no-op
    expect(t.turns).toHaveLength(1);
  });

  it('closes the other speaker when speaker switches, keeping chronology', () => {
    const t = new Transcript();
    t.onResult('them', res('what is the price', { is_final: true }));
    t.onResult('me', res('alors', { is_final: true, speech_final: true }));
    expect(t.turns.map((x) => x.speaker)).toEqual(['them', 'me']);
  });

  it('picks the majority language', () => {
    const t = new Transcript();
    t.onResult('them', res('hello', { is_final: true, lang: 'en' }));
    t.onResult('them', res('bonjour', { is_final: true, lang: 'fr' }));
    t.onResult('them', res('ok bye', { is_final: true, lang: 'en', speech_final: true }));
    expect(t.turns[0].lang).toBe('en');
  });
});

describe('snapshot', () => {
  it('appends a provisional turn with the id the utterance will get', () => {
    const t = new Transcript();
    t.onResult('them', res('first', { is_final: true, speech_final: true }));
    t.onResult('them', res('second part', { is_final: true }));
    const snap = t.snapshot('them');
    expect(snap.provisional).toBe(true);
    expect(snap.turns).toHaveLength(2);
    expect(snap.turns[1]).toMatchObject({ id: 2, speaker: 'them', text: 'second part', provisional: true });
    t.onUtteranceEnd('them');
    expect(t.turns[1].id).toBe(2);
    expect(t.snapshot('them').provisional).toBe(false);
  });
});

describe('echo guard', () => {
  it('drops a "them" segment that repeats what "me" just said', () => {
    let t0 = 1000;
    const t = new Transcript({ now: () => t0 });
    const echoes = [];
    t.on('echo', (e) => echoes.push(e.text));
    t.onResult('me', res('we book qualified meetings directly in your calendar', { is_final: true }));
    t0 += 800;
    t.onResult('them', res('We book qualified meetings directly in your calendar.', { is_final: true, speech_final: true }));
    expect(echoes).toHaveLength(1);
    expect(t.turns).toHaveLength(0);
  });
  it('keeps a genuine reply that reuses a few words', () => {
    const t = new Transcript({ now: () => 1000 });
    t.onResult('me', res('we book qualified meetings directly in your calendar', { is_final: true }));
    t.onResult('them', res('Qualified meetings, okay, but how do you find the decision makers?', { is_final: true, speech_final: true }));
    expect(t.turns.map((x) => x.speaker)).toEqual(['me', 'them']);
  });
  it('forgets "me" words after the window', () => {
    let t0 = 1000;
    const t = new Transcript({ now: () => t0 });
    t.onResult('me', res('what about the price of the plan', { is_final: true, speech_final: true }));
    t0 += 9000;
    t.onResult('them', res('what about the price of the plan', { is_final: true, speech_final: true }));
    expect(t.turns.map((x) => x.speaker)).toEqual(['me', 'them']);
  });
  it('uses me interims too (echo arrives before the me final)', () => {
    const t = new Transcript({ now: () => 1000 });
    t.onResult('me', res('can you see my screen'));
    t.onResult('them', res('Can you see my screen?', { is_final: true, speech_final: true }));
    expect(t.turns).toHaveLength(0);
  });
});
