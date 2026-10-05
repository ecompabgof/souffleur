import { describe, it, expect } from 'vitest';
import { parseDeviceList } from '../src/main/audio/devices.js';
import { rms } from '../src/main/audio/capture.js';
import { majorityLang, buildUrl } from '../src/main/stt/deepgram.js';
import { parseTitle } from '../src/main/context/store.js';
import { toMarkdown } from '../src/main/session/log.js';
import { supportsEffort } from '../src/main/llm/coach.js';

describe('parseDeviceList', () => {
  it('extracts only audio devices', () => {
    const stderr = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] BlackHole 2ch
[AVFoundation indev @ 0x1] [1] EarPods Microphone
: Input/output error`;
    expect(parseDeviceList(stderr)).toEqual([{ index: 0, name: 'BlackHole 2ch' }, { index: 1, name: 'EarPods Microphone' }]);
  });
});

describe('rms', () => {
  it('is 0 for silence and ~0.7 for a full-scale square wave', () => {
    expect(rms(Buffer.alloc(320))).toBe(0);
    const b = Buffer.alloc(4);
    b.writeInt16LE(32767, 0); b.writeInt16LE(-32767, 2);
    expect(rms(b)).toBeCloseTo(1, 3);
  });
});

describe('deepgram helpers', () => {
  it('majorityLang picks the most frequent word language', () => {
    expect(majorityLang([{ language: 'en' }, { language: 'fr' }, { language: 'en' }])).toBe('en');
    expect(majorityLang([])).toBeNull();
  });
  it('buildUrl sets the streaming params', () => {
    const u = buildUrl({ model: 'nova-3', language: 'multi' });
    expect(u).toContain('model=nova-3');
    expect(u).toContain('language=multi');
    expect(u).toContain('interim_results=true');
    expect(u).toContain('utterance_end_ms=1000');
    expect(u).toContain('endpointing=300');
  });
  it('buildUrl takes the tuning overrides', () => {
    const u = buildUrl({ model: 'nova-3', language: 'en', endpointing: 800, utteranceEndMs: 1800 });
    expect(u).toContain('language=en');
    expect(u).toContain('endpointing=800');
    expect(u).toContain('utterance_end_ms=1800');
  });
});

describe('parseTitle', () => {
  it('uses the first H1 or the fallback', () => {
    expect(parseTitle('---\nx\n---\n# Mon titre\ntext', 'f')).toBe('Mon titre');
    expect(parseTitle('no title', 'f')).toBe('f');
  });
});

describe('toMarkdown', () => {
  it('renders turns with translation and suggestion', () => {
    const md = toMarkdown({
      startedAt: '2026-09-11', callContext: 'ctx', contexts: ['a'], coachModel: 'm',
      turns: [{ id: 1, speaker: 'them', text: 'hi', translation: 'salut' }, { id: 2, speaker: 'me', text: 'yo' }],
      suggestions: [{ forTurnId: 1, text: '## Réponds\nSalut !' }],
    });
    expect(md).toContain('**PROSPECT** : hi');
    expect(md).toContain('> _salut_');
    expect(md).toContain('<details><summary>Souffleur</summary>');
    expect(md).toContain('**MOI** : yo');
  });
});

describe('supportsEffort', () => {
  it('excludes haiku', () => {
    expect(supportsEffort('claude-haiku-4-5')).toBe(false);
    expect(supportsEffort('claude-sonnet-5')).toBe(true);
  });
});

describe('Capture input addressing', () => {
  it('addresses the device by name, falling back to index', async () => {
    const { Capture } = await import('../src/main/audio/capture.js');
    expect(new Capture({ deviceIndex: 1, name: 'BlackHole 2ch' }).input).toBe(':BlackHole 2ch');
    expect(new Capture({ deviceIndex: 1 }).input).toBe(':1');
  });
});
