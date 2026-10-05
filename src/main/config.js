'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(os.homedir(), 'souffleur');
const CONTEXTS_DIR = path.join(DATA_DIR, 'contexts');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const SEED_DIR = path.join(__dirname, '../../contexts.seed');

const COACH_MODELS = {
  'claude-sonnet-5': 'Sonnet 5 — rapide (défaut)',
  'claude-opus-5': 'Opus 5 — qualité max',
  'claude-haiku-4-5': 'Haiku 4.5 — ultra rapide',
};
const TRANSLATE_MODEL = 'claude-haiku-4-5';

// Speech-to-text tuning. Overridable from .env so a call can be re-tuned without a code change.
// language: 'multi' lets Nova-3 tag each word (handy for mixed calls, but it mislabels short
//   French turns as Dutch); a fixed code like 'en' or 'fr' is markedly more accurate.
// endpointing: ms of silence that closes a segment. Too low and a normal breath cuts the speaker.
// utteranceEndMs: ms of silence that closes a whole turn.
const STT = {
  model: process.env.STT_MODEL || 'nova-3',
  language: process.env.STT_LANGUAGE || 'multi',
  endpointing: String(process.env.STT_ENDPOINTING || '300'),
  utteranceEndMs: String(process.env.STT_UTTERANCE_END || '1000'),
};
// 'cli' = your Claude Code subscription via the `claude` binary (default). 'api' = ANTHROPIC_API_KEY.
function llmProvider() { return process.env.LLM_PROVIDER === 'api' ? 'api' : 'cli'; }

const DEFAULT_PREFS = {
  themDevice: null,
  meDevice: null,
  contexts: [],
  coachModel: 'claude-sonnet-5',
  callContext: '',
  preview: true,
  memo: '',
};

function ensureDirs() {
  for (const d of [DATA_DIR, CONTEXTS_DIR, SESSIONS_DIR]) fs.mkdirSync(d, { recursive: true });
}

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  ensureDirs();
  fs.writeFileSync(PREFS_FILE, JSON.stringify({ ...loadPrefs(), ...prefs }, null, 2));
}

function resolveFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    if (c === 'ffmpeg') {
      // relies on PATH — fine from a terminal, may fail from Finder; later candidates cover that
      continue;
    }
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

module.exports = {
  DATA_DIR, CONTEXTS_DIR, SESSIONS_DIR, PREFS_FILE, SEED_DIR,
  COACH_MODELS, TRANSLATE_MODEL, STT, DEFAULT_PREFS, llmProvider,
  ensureDirs, loadPrefs, savePrefs, resolveFfmpeg,
};
