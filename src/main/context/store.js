'use strict';
const fs = require('fs');
const path = require('path');
const { CONTEXTS_DIR, SEED_DIR, ensureDirs } = require('../config');

const PERSONA_FILE = '_persona.md';

// First "# Title" line wins, else the file name.
function parseTitle(text, fallback) {
  const m = String(text).match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : fallback;
}

// First run: copy seeds so the user has something to edit.
function ensureSeeds() {
  ensureDirs();
  const existing = fs.readdirSync(CONTEXTS_DIR).filter((f) => f.endsWith('.md'));
  if (existing.length) return false;
  if (!fs.existsSync(SEED_DIR)) return false;
  for (const f of fs.readdirSync(SEED_DIR)) {
    if (f.endsWith('.md')) fs.copyFileSync(path.join(SEED_DIR, f), path.join(CONTEXTS_DIR, f));
  }
  return true;
}

function listContexts() {
  ensureSeeds();
  return fs.readdirSync(CONTEXTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const text = fs.readFileSync(path.join(CONTEXTS_DIR, f), 'utf8');
      const name = f.replace(/\.md$/, '');
      return { name, title: parseTitle(text, name), always: f.startsWith('_'), size: text.length };
    });
}

function readContexts(names) {
  const out = [];
  for (const name of names) {
    const file = path.join(CONTEXTS_DIR, `${name}.md`);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    out.push({ name, title: parseTitle(text, name), text });
  }
  return out;
}

function readPersona() {
  const file = path.join(CONTEXTS_DIR, PERSONA_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

module.exports = { parseTitle, ensureSeeds, listContexts, readContexts, readPersona, PERSONA_FILE };
