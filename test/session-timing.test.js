import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Session } from '../src/main/session/session.js';

// Drive the scheduler with fake timers, no audio/Deepgram/LLM: wiring is stubbed, coach is fake.
class FakeCoach {
  constructor() { this.calls = []; this.streamMs = 1500; }
  suggest(turns, onEvent, opts) {
    const call = { kind: null, turns: turns.map((t) => t.text), opts, aborted: false };
    this.calls.push(call);
    onEvent({ reqId: this.calls.length, start: true });
    call.timer = setTimeout(() => { if (!call.aborted) onEvent({ reqId: this.calls.length, done: true, text: 'x' }); }, this.streamMs);
    call.finish = () => { clearTimeout(call.timer); onEvent({ reqId: this.calls.length, done: true, text: 'x' }); };
    call.abortFn = () => { call.aborted = true; clearTimeout(call.timer); onEvent({ reqId: this.calls.length, aborted: true }); };
    return Promise.resolve();
  }
  abort() { const c = this.calls[this.calls.length - 1]; if (c && !c.aborted) c.abortFn(); }
  stop() {}
  translate() { return Promise.resolve(); }
}

function makeSession(opts = {}) {
  const events = [];
  const s = new Session({ themDevice: { index: 0, name: 'BH' }, meDevice: { index: 1, name: 'Mic' }, contextNames: [], coachModel: 'm', ...opts }, (ch, p) => events.push([ch, p]));
  s._wireSpeaker = () => {};
  s.start();
  s.coach = new FakeCoach();
  return { s, events, coach: s.coach };
}
const seg = (text, extra = {}) => ({ transcript: text, is_final: true, speech_final: false, ...extra });
const kinds = (events) => events.filter((e) => e[0] === 'llm:coach' && e[1].start).map((e) => e[1].kind);

describe('coach scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('final answer fires 600 ms after the utterance closes, not before', () => {
    const { s, events } = makeSession();
    s.transcript.onResult('them', seg('what about the price', { speech_final: true }));
    vi.advanceTimersByTime(500);
    expect(kinds(events)).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(kinds(events)).toEqual(['final']);
  });

  it('is cancelled when the prospect resumes during the delay, then fires after the next close', () => {
    const { s, events } = makeSession();
    s.transcript.onResult('them', seg('what about the price', { speech_final: true }));
    vi.advanceTimersByTime(300);
    s.transcript.onResult('them', seg('and the', { is_final: false }));   // interim: he resumed
    vi.advanceTimersByTime(1000);
    expect(kinds(events)).toEqual([]);
    s.transcript.onResult('them', seg('and the minimum commitment', { speech_final: true }));
    vi.advanceTimersByTime(650);
    expect(kinds(events)).toEqual(['final']);
    expect(s.coach.calls[0].turns).toEqual(['what about the price', 'and the minimum commitment']);
  });

  it('preview fires while he keeps talking, and never while a final is in flight', () => {
    const { s, events } = makeSession();
    s.transcript.onResult('them', seg('so the thing is we already have a team'));  // final segment, utterance still open
    vi.advanceTimersByTime(950);
    expect(kinds(events)).toEqual(['preview']);
    s.transcript.onResult('them', seg('and they do outbound already', { speech_final: true }));
    vi.advanceTimersByTime(650);
    expect(kinds(events)).toEqual(['preview', 'final']);
    // final streaming (1500 ms) — a new segment must not start a preview
    s.transcript.onResult('them', seg('but honestly they are not great at it'));
    vi.advanceTimersByTime(1000);
    expect(kinds(events)).toEqual(['preview', 'final']);
  });

  it('preview disabled → only finals', () => {
    const { s, events } = makeSession({ preview: false });
    s.transcript.onResult('them', seg('so the thing is we already have a team'));
    vi.advanceTimersByTime(2000);
    expect(kinds(events)).toEqual([]);
  });

  it('coachNow sends a steer request', () => {
    const { s } = makeSession();
    s.transcript.onResult('them', seg('we had a crazy week with servers down', { speech_final: true }));
    s.coachNow();
    vi.advanceTimersByTime(400);
    expect(s.coach.calls.at(-1).opts.steer).toBe(true);
  });
});
