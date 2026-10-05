'use strict';
const { execFile } = require('child_process');
const { resolveFfmpeg } = require('../config');

// Parses `ffmpeg -f avfoundation -list_devices true -i ""` stderr into audio devices.
function parseDeviceList(stderr) {
  const lines = String(stderr).split('\n');
  const out = [];
  let inAudio = false;
  for (const line of lines) {
    if (/AVFoundation audio devices/i.test(line)) { inAudio = true; continue; }
    if (/AVFoundation video devices/i.test(line)) { inAudio = false; continue; }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) out.push({ index: Number(m[1]), name: m[2] });
  }
  return out;
}

function listAudioDevices() {
  return new Promise((resolve) => {
    execFile(resolveFfmpeg(), ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], (err, stdout, stderr) => {
      // ffmpeg exits non-zero after listing; the list is on stderr either way
      resolve(parseDeviceList(stderr || (err && err.message) || ''));
    });
  });
}

module.exports = { parseDeviceList, listAudioDevices };
