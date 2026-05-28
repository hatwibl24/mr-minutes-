'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const hands = require('./Hands');

const SNAPSHOT_PATH = path.join(os.tmpdir(), 'mr-minutes-world-model.json');
const DEFAULT_HEARTBEAT_MS = 3000;
const MAX_EVENTS = 200;
const MAX_VISIBLE_TEXTS = 100;

let emitter = null;
let heartbeatTimer = null;
let heartbeatMs = DEFAULT_HEARTBEAT_MS;
let heartbeatBusy = false;

const state = createInitialState();

function createInitialState() {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSource: 'init',
    environment: {
      apps: {
        frontmost: null,
        lastFocused: null,
        known: []
      },
      windows: {
        activeTitle: null,
        known: [],
        lastChangedAt: null
      },
      ui: {
        screenshotPath: null,
        screenshotAt: null,
        visibleTexts: [],
        visibleTextCount: 0,
        loading: false,
        modalOpen: false,
        lastObservationAt: null,
        lastObservationSource: null
      },
      processes: {},
      network: {
        urls: {},
        connectivity: 'unknown'
      }
    },
    user: {
      lastVoiceInputAt: null,
      lastManualInteractionAt: null,
      attention: 'unknown',
      present: true
    },
    tasks: {
      activeTaskId: null,
      activeGoal: null,
      phase: null,
      confidence: 1,
      blocked: [],
      waiting: [],
      completedRecent: [],
      lastVerifiedAt: null
    },
    events: []
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emit(type, payload = {}) {
  if (typeof emitter === 'function') {
    emitter({ type, ...payload });
  }
}

function touch(source = 'patch') {
  state.updatedAt = new Date().toISOString();
  state.lastSource = source;
}

function mergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (Array.isArray(value)) {
      target[key] = clone(value);
    } else if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      mergeInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

async function persistSnapshot() {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(SNAPSHOT_PATH, payload, 'utf8');
}

async function restoreSnapshot() {
  try {
    const raw = await fs.readFile(SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    mergeInto(state, parsed);
    touch('restore');
    return { ok: true, path: SNAPSHOT_PATH };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function setKnownApp(appName) {
  if (!appName) return;
  if (!state.environment.apps.known.includes(appName)) {
    state.environment.apps.known.push(appName);
  }
  state.environment.apps.lastFocused = appName;
}

function normalizeTexts(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  return list
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, MAX_VISIBLE_TEXTS);
}

function deriveAttentionState() {
  const now = Date.now();
  const lastManual = state.user.lastManualInteractionAt ? Date.parse(state.user.lastManualInteractionAt) : 0;
  const lastVoice = state.user.lastVoiceInputAt ? Date.parse(state.user.lastVoiceInputAt) : 0;
  const freshest = Math.max(lastManual, lastVoice);
  if (!freshest) return 'unknown';
  const delta = now - freshest;
  if (delta < 30_000) return 'engaged';
  if (delta < 5 * 60_000) return 'nearby';
  return 'away';
}

function snapshot() {
  state.user.attention = deriveAttentionState();
  return clone(state);
}

async function patch(delta, source = 'patch') {
  mergeInto(state, delta);
  state.user.attention = deriveAttentionState();
  touch(source);
  await persistSnapshot().catch(() => null);
  emit('world_updated', { source, world: snapshot() });
  return { ok: true, world: snapshot() };
}

async function recordEvent(event) {
  const normalized = {
    at: new Date().toISOString(),
    ...clone(event || {})
  };
  state.events.push(normalized);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }

  if (normalized.app) setKnownApp(normalized.app);
  if (normalized.type === 'voice_input') state.user.lastVoiceInputAt = normalized.at;
  if (normalized.type === 'manual_input') state.user.lastManualInteractionAt = normalized.at;
  if (normalized.type === 'task_started') {
    state.tasks.activeTaskId = normalized.taskId || state.tasks.activeTaskId;
    state.tasks.activeGoal = normalized.label || state.tasks.activeGoal;
    state.tasks.phase = normalized.phase || state.tasks.phase;
  }
  if (normalized.type === 'task_completed' || normalized.type === 'task_failed' || normalized.type === 'task_cancelled') {
    if (normalized.taskId && state.tasks.activeTaskId === normalized.taskId) {
      state.tasks.activeTaskId = null;
      state.tasks.phase = null;
    }
    state.tasks.completedRecent.unshift({
      taskId: normalized.taskId || null,
      label: normalized.label || null,
      status: normalized.type.replace('task_', ''),
      at: normalized.at
    });
    state.tasks.completedRecent = state.tasks.completedRecent.slice(0, 20);
  }

  state.user.attention = deriveAttentionState();
  touch('event');
  await persistSnapshot().catch(() => null);
  emit('world_event', { event: normalized });
  return { ok: true, event: normalized };
}

async function captureEnvironmentHint(options = {}) {
  const shouldScreenshot = options.screenshot !== false;
  const visibleTexts = normalizeTexts(options.visibleTexts);
  let screenshotPath = null;

  if (shouldScreenshot) {
    const shot = await hands.takeSystemScreenshot(options.path || null);
    if (shot.ok) {
      screenshotPath = shot.path;
      state.environment.ui.screenshotPath = shot.path;
      state.environment.ui.screenshotAt = new Date().toISOString();
    }
  }

  if (visibleTexts.length) {
    state.environment.ui.visibleTexts = visibleTexts;
    state.environment.ui.visibleTextCount = visibleTexts.length;
  }

  state.environment.ui.lastObservationAt = new Date().toISOString();
  state.environment.ui.lastObservationSource = options.source || 'captureEnvironmentHint';
  state.user.attention = deriveAttentionState();
  touch('capture');
  await persistSnapshot().catch(() => null);

  return {
    ok: true,
    screenshotPath,
    visibleTexts: state.environment.ui.visibleTexts,
    observedAt: state.environment.ui.lastObservationAt
  };
}

async function updateProcesses(processMap = {}) {
  state.environment.processes = clone(processMap);
  touch('processes');
  await persistSnapshot().catch(() => null);
  return { ok: true, count: Object.keys(processMap).length };
}

async function updateNetworkUrl(url, data = {}) {
  if (!url) return { ok: false, error: 'url required' };
  state.environment.network.urls[url] = {
    ...(state.environment.network.urls[url] || {}),
    ...clone(data),
    updatedAt: new Date().toISOString()
  };
  touch('network');
  await persistSnapshot().catch(() => null);
  return { ok: true, url };
}

function getTaskContext(taskId) {
  const recent = state.events.filter((event) => event.taskId === taskId).slice(-20);
  return {
    active: state.tasks.activeTaskId === taskId,
    taskId,
    phase: state.tasks.phase,
    confidence: state.tasks.confidence,
    recentEvents: clone(recent),
    ui: clone(state.environment.ui),
    apps: clone(state.environment.apps),
    network: clone(state.environment.network)
  };
}

async function heartbeatTick() {
  if (heartbeatBusy) return { ok: false, skipped: true, reason: 'busy' };
  heartbeatBusy = true;
  try {
    state.user.attention = deriveAttentionState();
    state.environment.ui.lastObservationAt = new Date().toISOString();
    state.environment.ui.lastObservationSource = 'heartbeat';
    touch('heartbeat');
    await persistSnapshot().catch(() => null);
    emit('world_heartbeat', { at: state.updatedAt, attention: state.user.attention });
    return { ok: true, at: state.updatedAt };
  } finally {
    heartbeatBusy = false;
  }
}

function startHeartbeat(intervalMs = DEFAULT_HEARTBEAT_MS) {
  stopHeartbeat();
  heartbeatMs = Math.max(500, Number(intervalMs) || DEFAULT_HEARTBEAT_MS);
  heartbeatTimer = setInterval(() => {
    heartbeatTick().catch(() => null);
  }, heartbeatMs);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  emit('world_heartbeat_started', { intervalMs: heartbeatMs });
  return { ok: true, intervalMs: heartbeatMs };
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  emit('world_heartbeat_stopped', {});
  return { ok: true };
}

async function init(options = {}) {
  emitter = typeof options.emit === 'function' ? options.emit : null;
  if (options.restore !== false) await restoreSnapshot().catch(() => null);
  if (options.seed) mergeInto(state, clone(options.seed));
  state.user.attention = deriveAttentionState();
  touch('init');
  await persistSnapshot().catch(() => null);
  if (options.startHeartbeat) startHeartbeat(options.heartbeatMs || DEFAULT_HEARTBEAT_MS);
  return { ok: true, world: snapshot(), path: SNAPSHOT_PATH };
}

module.exports = {
  init,
  snapshot,
  patch,
  recordEvent,
  captureEnvironmentHint,
  updateProcesses,
  updateNetworkUrl,
  deriveAttentionState,
  getTaskContext,
  heartbeatTick,
  startHeartbeat,
  stopHeartbeat,
  persistSnapshot,
  restoreSnapshot,
  constants: {
    SNAPSHOT_PATH,
    DEFAULT_HEARTBEAT_MS
  }
};