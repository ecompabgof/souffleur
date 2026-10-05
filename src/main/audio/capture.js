'use strict';
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { resolveFfmpeg } = require('../config');

// RMS of a 16-bit little-endian PCM buffer, normalised to 0..1
function rms(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

// One ffmpeg process per input device → 16 kHz mono s16le PCM on stdout.
// The device is addressed by NAME: avfoundation indexes shift whenever a device is (un)plugged
// between app launch and session start, which would silently swap "them" and "me".
class Capture extends EventEmitter {
  constructor({ deviceIndex, name }) {
    super();
    this.deviceIndex = deviceIndex;
    this.name = name;
    this.input = name ? `:${name}` : `:${deviceIndex}`;
    this.proc = null;
    this.stderr = '';
  }

  start() {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'avfoundation', '-i', this.input,
      '-ac', '1', '-ar', '16000', '-f', 's16le', '-',
    ];
    this.proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (buf) => {
      this.emit('data', buf);
      this.emit('level', rms(buf));
    });
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code) => this.emit('exit', { code, stderr: this.stderr.trim() }));
    return this;
  }

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill('SIGINT');
    this.proc = null;
  }
}

module.exports = { Capture, rms };
