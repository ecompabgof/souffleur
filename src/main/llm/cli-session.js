'use strict';
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const readline = require('readline');

// Env for the child: never leak a placeholder/dev API key or a nested-session marker;
// the CLI must authenticate with the user's own Claude Code login.
function childEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
  // The CLI turns extended thinking on by default (Haiku: ~200 thinking tokens before the first
  // word → +1.5 s). Real-time copilot: no thinking, first token ASAP.
  env.MAX_THINKING_TOKENS = '0';
  return env;
}

function resolveClaude() {
  return process.env.CLAUDE_PATH || 'claude';
}

// `claude auth status` → { loggedIn, authMethod }
function checkCliAuth() {
  return new Promise((resolve) => {
    execFile(resolveClaude(), ['auth', 'status'], { env: childEnv(), timeout: 10000 }, (err, stdout) => {
      if (err && !stdout) return resolve({ loggedIn: false, error: err.code === 'ENOENT' ? 'claude introuvable (CLI Claude Code non installé ?)' : err.message });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ loggedIn: false, error: 'réponse auth illisible' }); }
    });
  });
}

// One persistent `claude -p --input-format stream-json` process = one conversation.
// send(text) → reqId; events: 'delta' {reqId,text}, 'done' {reqId,text,error,usage}, 'error', 'exit'.
// Requests are FIFO: the CLI answers in order, so deltas/results attach to queue[0].
class ClaudeCliSession extends EventEmitter {
  constructor({ model, systemPrompt, effort = 'low', label = 'cli' }) {
    super();
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.effort = effort;
    this.label = label;
    this.proc = null;
    this.queue = [];      // [{ reqId, text }]
    this.nextReq = 1;
    this.ready = false;
    this.stopped = false;
  }

  start() {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      // --setting-sources "" : no user/project settings → no hooks, no plugins, no MCP → clean prompt,
      // fast start, and OAuth login still read (unlike --bare, which skips the login).
      '--include-partial-messages', '--verbose', '--setting-sources', '', '--strict-mcp-config',
      '--tools', '', '--no-session-persistence',
      '--effort', this.effort, '--model', this.model, '--system-prompt', this.systemPrompt,
    ];
    this.proc = spawn(resolveClaude(), args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (err) => this.emit('error', new Error(err.code === 'ENOENT' ? 'claude introuvable — installe le CLI Claude Code ou mets CLAUDE_PATH dans .env' : err.message)));
    this.proc.on('exit', (code) => {
      this.ready = false;
      if (!this.stopped) this.emit('exit', { code });
      for (const q of this.queue) this.emit('done', { reqId: q.reqId, text: q.text, error: `process claude terminé (code ${code})` });
      this.queue = [];
    });
    let stderr = '';
    this.proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this._onLine(line));
    return this;
  }

  _onLine(line) {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const cur = this.queue[0];
    if (m.type === 'system' && m.subtype === 'init') { this.ready = true; this.emit('ready'); return; }
    if (m.type === 'stream_event') {
      const ev = m.event || {};
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && cur) {
        cur.text += ev.delta.text;
        this.emit('delta', { reqId: cur.reqId, text: ev.delta.text });
      }
      return;
    }
    if (m.type === 'result') {
      const q = this.queue.shift();
      if (!q) return;
      const u = m.usage || {};
      const error = m.is_error ? (m.result || 'erreur CLI') : null;
      this.emit('done', {
        reqId: q.reqId, text: q.text.trim(), error,
        usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, apiMs: m.duration_api_ms, costUsd: m.total_cost_usd },
      });
    }
  }

  send(text) {
    if (!this.proc || this.stopped) throw new Error('session CLI non démarrée');
    const reqId = this.nextReq++;
    this.queue.push({ reqId, text: '' });
    this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    return reqId;
  }

  // Stop the in-flight generation (the CLI still emits its `result`, which pops the queue).
  interrupt() {
    if (!this.proc || !this.queue.length) return;
    this.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: `i${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n');
  }

  get busy() { return this.queue.length > 0; }

  stop() {
    this.stopped = true;
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    const p = this.proc;
    setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* ignore */ } }, 500);
    this.proc = null;
  }
}

module.exports = { ClaudeCliSession, checkCliAuth, childEnv, resolveClaude };
