'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set(['app:init', 'session:start', 'session:stop', 'coach:now', 'session:pause', 'open:path', 'open:dir', 'window:hide', 'window:minimize', 'app:quit', 'memo:save']);
const EVENTS = new Set(['stt:interim', 'stt:segment', 'stt:utterance', 'stt:echo', 'llm:translation', 'llm:coach', 'status', 'level', 'warn', 'error', 'session:started', 'session:ended', 'session:paused', 'memo:toggle']);

contextBridge.exposeInMainWorld('souffleur', {
  invoke: (channel, payload) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`channel refused: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error(`event refused: ${channel}`);
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
