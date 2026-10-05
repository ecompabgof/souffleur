'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const { app, BrowserWindow, ipcMain, globalShortcut, shell } = require('electron');
const { listAudioDevices } = require('./audio/devices');
const store = require('./context/store');
const config = require('./config');
const { Session } = require('./session/session');
const { checkCliAuth } = require('./llm/cli-session');

let win = null;
let session = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 780,
    minWidth: 360,
    minHeight: 480,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#111318',
    title: 'Souffleur',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Invisible to screen sharing / recorders (NSWindowSharingNone on macOS).
  win.setContentProtection(true);
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => { win = null; });

  // Debug: SOUFFLEUR_SNAPSHOT=/path.png → capture the rendered window and quit.
  // capturePage works even with content protection on (it reads the renderer, not the screen).
  if (process.env.SOUFFLEUR_SNAPSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // SOUFFLEUR_SNAPSHOT_JS: optional JS to run in the page first (e.g. switch to the live screen).
        if (process.env.SOUFFLEUR_SNAPSHOT_JS) { try { await win.webContents.executeJavaScript(process.env.SOUFFLEUR_SNAPSHOT_JS); } catch (e) { console.error('snapshot js:', e.message); } await new Promise((r) => setTimeout(r, 300)); }
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.SOUFFLEUR_SNAPSHOT, img.toPNG());
        app.quit();
      }, 2500);
    });
  }
}

function toggleVisibility() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+C', toggleVisibility);
  globalShortcut.register('CommandOrControl+Shift+R', () => session && session.coachNow());
  globalShortcut.register('CommandOrControl+Shift+P', () => session && session.togglePause());
  globalShortcut.register('CommandOrControl+Shift+M', () => { if (win) { win.show(); send('memo:toggle', {}); } });
}

ipcMain.handle('app:init', async () => {
  config.ensureDirs();
  const [devices, cliAuth] = await Promise.all([listAudioDevices(), config.llmProvider() === 'cli' ? checkCliAuth() : Promise.resolve(null)]);
  return {
    provider: config.llmProvider(),
    cliAuth,
    devices,
    contexts: store.listContexts(),
    prefs: config.loadPrefs(),
    models: config.COACH_MODELS,
    keys: { anthropic: !!process.env.ANTHROPIC_API_KEY, deepgram: !!process.env.DEEPGRAM_API_KEY },
    dataDir: config.DATA_DIR,
    contextsDir: config.CONTEXTS_DIR,
  };
});

ipcMain.handle('session:start', async (_e, opts) => {
  if (session) return { error: 'Session déjà en cours' };
  config.savePrefs({
    themDevice: opts.themDevice.name,
    meDevice: opts.meDevice.name,
    contexts: opts.contextNames,
    coachModel: opts.coachModel,
    callContext: opts.callContext,
    preview: opts.preview !== false,
  });
  session = new Session(opts, send);
  try {
    session.start();
    return { ok: true };
  } catch (err) {
    session = null;
    return { error: err.message };
  }
});

ipcMain.handle('session:stop', async () => {
  if (!session) return { ok: true };
  const file = session.stop();
  session = null;
  return { ok: true, file };
});

ipcMain.handle('coach:now', async () => { if (session) session.coachNow(); return { ok: true }; });
ipcMain.handle('session:pause', async () => ({ paused: session ? session.togglePause() : false }));
ipcMain.handle('open:path', async (_e, p) => { shell.showItemInFolder(p); return { ok: true }; });
ipcMain.handle('open:dir', async (_e, p) => { shell.openPath(p); return { ok: true }; });
ipcMain.handle('window:hide', async () => { if (win) win.hide(); return { ok: true }; });
ipcMain.handle('window:minimize', async () => { if (win) win.minimize(); return { ok: true }; });
ipcMain.handle('app:quit', async () => { app.quit(); return { ok: true }; });
ipcMain.handle('memo:save', async (_e, memo) => { config.savePrefs({ memo: String(memo || '') }); return { ok: true }; });

app.whenReady().then(() => {
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (session) { try { session.stop(); } catch { /* best effort */ } }
});

app.on('window-all-closed', () => app.quit());

// `pkill`/Ctrl-C: flush the running session to disk before dying (will-quit does not fire on SIGTERM).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (session) { try { session.stop(); } catch { /* best effort */ } session = null; }
    app.quit();
  });
}
