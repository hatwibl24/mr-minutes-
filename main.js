'use strict';

// ============================================================
// MR. MINUTES — main.js v8
//
// Fixes:
//   • Restores listener init (ears / Deepgram / mic)
//   • Keeps free mascot transparent overlay mode
//   • Restores missing IPC used by preload.js
//   • Preserves controller, vision, task, and system wiring
// ============================================================

const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const controller      = require('./controller');
const brainModule     = require('./brain');
const hands           = require('./Hands');
const bodyOS          = require('./bodyOS');
const listener        = require('./listener');
const sysEnv          = require('./Systemenvironment');

let mainWindow = null;

// ── renderer bridge ───────────────────────────────────────────
function emitToRenderer(channel, payload) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
    wc.send(channel, payload);
  } catch (err) {
    console.error('[main] emitToRenderer error on channel', channel, err.message);
  }
}

// ── window creation (FREE MASCOT MODE) ────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:mrminutes',
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ── controller emitter wiring ─────────────────────────────────
function setupControllerEmitter() {
  controller.setEmitter((payload) => {
    try {
      emitToRenderer('agent-event', payload);

      if (payload?.type === 'execution-progress') {
        emitToRenderer('execution-progress', payload);
      }

      if (payload?.type === 'task-state') {
        emitToRenderer('task-state', payload);
      }
    } catch (err) {
      console.error('[main] controller emitter wrapper error:', err.message);
    }
  });
}

// ── accessibility check (macOS) ───────────────────────────────
function checkAccessibility() {
  if (process.platform !== 'darwin') return;
  try {
    const { systemPreferences } = require('electron');
    const granted = systemPreferences.isTrustedAccessibilityClient(false);
    if (!granted) {
      console.warn('[main] Accessibility permission not granted');
      setTimeout(() => {
        emitToRenderer('agent-event', {
          type: 'accessibility_missing',
          message: 'Accessibility permissions are required for computer control. Please grant access in System Settings → Privacy & Security → Accessibility.',
        });
      }, 1500);
    }
  } catch (err) {
    console.warn('[main] Accessibility check failed:', err.message);
  }
}

// ── IPC helpers ───────────────────────────────────────────────
function safe(handler) {
  return async (_event, ...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error('[main] IPC handler error:', err.message);
      return { ok: false, error: err.message };
    }
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

// ── IPC registration ──────────────────────────────────────────
function registerIpc() {
  // ── primary brain entry point via controller ──
  ipcMain.handle('brain-command', safe((heard) => {
    return controller.handleUserInput(heard);
  }));

  // ── task control ──
  ipcMain.handle('resume-task', safe((taskId) => {
    return controller.resumeTask(taskId);
  }));

  ipcMain.handle('computer-use-cancel', safe(() => {
    return controller.cancelActiveTask();
  }));

  // optional compatibility endpoints expected by preload
  ipcMain.handle('computer-use', safe((payload) => {
    if (typeof payload === 'string') return controller.handleUserInput(payload);
    if (payload?.goal) return controller.handleUserInput(payload.goal);
    if (payload?.text) return controller.handleUserInput(payload.text);
    return { ok: false, error: 'computer-use requires a goal/text payload' };
  }));

  ipcMain.handle('computer-use-state', safe(() => {
    return {
      ok: true,
      activeGoal: controller.getActiveGoal?.() || null,
      queue: controller.getGoalQueue?.() || [],
      world: controller.getWorldState?.() || null,
    };
  }));

  // ── state queries ──
  ipcMain.handle('get-world-state', safe(() => controller.getWorldState()));
  ipcMain.handle('get-health-state', safe(() => controller.getHealthState()));
  ipcMain.handle('get-memory-lessons', safe(() => controller.getMemoryLessons()));
  ipcMain.handle('get-task-history', safe(() => controller.getTaskHistory()));
  ipcMain.handle('get-active-goal', safe(() => controller.getActiveGoal()));
  ipcMain.handle('get-goal-queue', safe(() => controller.getGoalQueue()));

  // ── vision ──
  ipcMain.handle('describe-current-screen', safe((options = {}) => {
    return controller.describeCurrentScreen(options || {});
  }));

  ipcMain.handle('is-vision-available', safe(() => {
    return { ok: true, available: !!controller.isVisionAvailable?.() };
  }));

  // ── system actions ──
  ipcMain.handle('system-action', safe((action, payload = {}) => {
    const key = String(action || '').toLowerCase().trim();
    switch (key) {
      case 'volumeup': {
        const next = clamp((payload.volume ?? 50) + (payload.step ?? 10), 0, 100);
        return hands.setVolume(next);
      }
      case 'volumedown': {
        const next = clamp((payload.volume ?? 50) - (payload.step ?? 10), 0, 100);
        return hands.setVolume(next);
      }
      case 'setvolume':
        return hands.setVolume(clamp(payload.volume ?? payload.value ?? 50, 0, 100));
      case 'mute':
        return hands.muteVolume();
      case 'unmute':
        return hands.unmuteVolume();
      case 'brightnessup': {
        const next = clamp((payload.brightness ?? 50) + (payload.step ?? 10), 0, 100);
        return hands.setBrightness(next);
      }
      case 'brightnessdown': {
        const next = clamp((payload.brightness ?? 50) - (payload.step ?? 10), 0, 100);
        return hands.setBrightness(next);
      }
      case 'setbrightness':
        return hands.setBrightness(clamp(payload.brightness ?? payload.value ?? 50, 0, 100));
      case 'sleep':
        return hands.sleepSystem();
      case 'restart':
        return hands.restartSystem();
      case 'shutdown':
        return hands.shutdownSystem();
      case 'lock':
      case 'lockscreen':
        return hands.lockScreen();
      case 'screenshot':
        return hands.takeSystemScreenshot(payload.path || null);
      default:
        return { ok: false, error: `Unknown system action: "${action}"` };
    }
  }));

  // ── direct hands passthrough ──
  ipcMain.handle('hands-action', safe((action, payload = {}) => {
    const key = String(action || '').trim();
    const fn = hands[key];
    if (typeof fn !== 'function') {
      return { ok: false, error: `Unknown hands action: "${action}"` };
    }
    const args = Array.isArray(payload.args) ? payload.args : [];
    return fn(...args);
  }));

  // explicit helper routes expected by preload.js
  ipcMain.handle('hands-find-text', safe((text, region) => {
    if (typeof hands.findText !== 'function') {
      return { ok: false, error: 'Hands.findText is unavailable' };
    }
    return hands.findText(text, region);
  }));

  ipcMain.handle('hands-click', safe((x, y) => {
    if (typeof hands.click !== 'function') {
      return { ok: false, error: 'Hands.click is unavailable' };
    }
    return hands.click(x, y);
  }));

  ipcMain.handle('hands-type', safe((text) => {
    if (typeof hands.type !== 'function') {
      return { ok: false, error: 'Hands.type is unavailable' };
    }
    return hands.type(text);
  }));

  ipcMain.handle('hands-key', safe((combo) => {
    if (typeof hands.key !== 'function') {
      return { ok: false, error: 'Hands.key is unavailable' };
    }
    return hands.key(combo);
  }));

  // ── convenience shortcut ──
  ipcMain.handle('open-app', safe((appName) => {
    return bodyOS.launchApp(appName);
  }));

  // ── legacy direct-brain path ──
  ipcMain.handle('brain-command-legacy', safe((heard) => {
    return brainModule.processCommand(heard);
  }));

  // ── mouse hit-test toggle ──
  // Renderer sends this every mousemove frame.
  // When the cursor is over Mr. Minutes we enable mouse events so
  // clicks actually land on the Electron window; otherwise we keep
  // the window transparent so the user can interact with apps below.
  ipcMain.on('set-ignore-mouse', (_event, ignore) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });

  // ── utility dialog hooks ──
  ipcMain.handle('show-message-box', safe(async (options = {}) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: 'main window is not available' };
    }
    const result = await dialog.showMessageBox(mainWindow, options);
    return { ok: true, result };
  }));
}

// ── single-instance lock ──────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      emitToRenderer('agent-event', { type: 'second_instance', argv });
    }
  });
}

// ── app lifecycle ─────────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();
  setupControllerEmitter();
  registerIpc();

  // Boot the system environment scanner FIRST — planner depends on it
  try {
    await sysEnv.init();
  } catch (err) {
    console.error('[main] sysEnv.init error:', err.message);
  }

  try {
    listener.init(mainWindow);
  } catch (err) {
    console.error('[main] listener.init error:', err.message);
    emitToRenderer('agent-event', { type: 'listener_error', message: err.message });
  }

  try {
    await controller.onStartup();
  } catch (err) {
    console.error('[main] controller.onStartup error:', err.message);
    emitToRenderer('agent-event', { type: 'startup_error', message: err.message });
  }

  checkAccessibility();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      try { listener.init(mainWindow); }
      catch (err) { console.error('[main] listener.init re-activate error:', err.message); }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    const active = controller.getActiveGoal();
    if (active?.taskId) {
      console.log(`[main] before-quit: cancelling active task "${active.label}"`);
      controller.cancelActiveTask();
    }
  } catch (err) {
    console.error('[main] before-quit cleanup error:', err.message);
  }
});