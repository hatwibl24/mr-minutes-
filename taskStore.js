'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.mr-minutes');
const TASK_FILE = path.join(STORE_DIR, 'tasks.json');

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

let _storeCache = null;
let _flushTimer = null;
function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (!_storeCache) return;
    try { ensureDir(); fs.writeFileSync(TASK_FILE, JSON.stringify(_storeCache, null, 2), 'utf8'); }
    catch (e) { console.error('[taskStore] flush error:', e.message); }
  }, 500);
}

function readStore() {
  if (_storeCache) return _storeCache;
  ensureDir();
  try {
    if (!fs.existsSync(TASK_FILE)) { _storeCache = {}; return _storeCache; }
    _storeCache = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8')) || {};
    return _storeCache;
  } catch (e) {
    console.error('[taskStore] read error:', e.message);
    _storeCache = {};
    return _storeCache;
  }
}

function writeStore(data) {
  _storeCache = data;
  scheduleFlush();
  return true;
}

function now() {
  return new Date().toISOString();
}

function makeTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function sanitizePlan(plan = {}) {
  return {
    taskId: plan.taskId || makeTaskId(),
    label: plan.label || 'Computer Use Task',
    steps: Array.isArray(plan.steps) ? plan.steps : [],
    phases: Array.isArray(plan.phases) ? plan.phases : [],
    context: plan.context || {},
    mode: plan.mode || null,
    estimates: plan.estimates || null,
    _memoryInjection: plan._memoryInjection || '',
  };
}

function create(plan = {}) {
  const store = readStore();
  const safePlan = sanitizePlan(plan);
  const record = {
    taskId: safePlan.taskId,
    label: safePlan.label,
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    endedAt: null,
    currentPhaseIndex: 0,
    currentStepIndex: 0,
    resumePhaseIndex: 0,
    contextVars: { ...(safePlan.context?.vars || {}) },
    plan: safePlan,
    checkpoints: [],
    verificationLog: [],
    failureHistory: [],
    result: null,
    blockedReason: null,
    waitingCondition: null,
  };
  store[record.taskId] = record;
  writeStore(store);
  return { ok: true, taskId: record.taskId, record };
}

function get(taskId) {
  const store = readStore();
  return store[taskId] || null;
}

function update(taskId, patch = {}) {
  const store = readStore();
  const current = store[taskId];
  if (!current) return { ok: false, error: `task not found: ${taskId}` };
  store[taskId] = {
    ...current,
    ...patch,
    updatedAt: now(),
  };
  writeStore(store);
  return { ok: true, record: store[taskId] };
}

function checkpoint(taskId, patch = {}) {
  const record = get(taskId);
  if (!record) return { ok: false, error: `task not found: ${taskId}` };
  const next = {
    ...record,
    ...patch,
    updatedAt: now(),
  };
  next.checkpoints = Array.isArray(record.checkpoints) ? [...record.checkpoints] : [];
  next.checkpoints.push({
    at: now(),
    status: next.status,
    currentPhaseIndex: next.currentPhaseIndex,
    currentStepIndex: next.currentStepIndex,
    contextVars: { ...(patch.contextVars || next.contextVars || {}) },
    blockedReason: patch.blockedReason || next.blockedReason || null,
    waitingCondition: patch.waitingCondition || next.waitingCondition || null,
  });
  if (patch.contextVars) next.contextVars = { ...patch.contextVars };
  const store = readStore();
  store[taskId] = next;
  writeStore(store);
  return { ok: true, record: next };
}

function addVerification(taskId, verification) {
  const record = get(taskId);
  if (!record) return { ok: false, error: `task not found: ${taskId}` };
  const verificationLog = [...(record.verificationLog || []), { at: now(), ...verification }];
  return update(taskId, { verificationLog });
}

function complete(taskId, result = {}) {
  return update(taskId, {
    status: 'completed',
    result,
    endedAt: now(),
    blockedReason: null,
    waitingCondition: null,
  });
}

function interrupt(taskId) {
  const record = get(taskId);
  if (!record) return { ok: false, error: `task not found: ${taskId}` };
  return update(taskId, {
    status: 'interrupted',
    resumePhaseIndex: record.currentPhaseIndex || 0,
    blockedReason: null,
  });
}

function fail(taskId, error, meta = {}) {
  const record = get(taskId);
  if (!record) return { ok: false, error: `task not found: ${taskId}` };
  const failureHistory = [...(record.failureHistory || []), {
    at: now(),
    error: error || 'task failed',
    failedStep: meta.failedStep || null,
    phaseName: meta.phaseName || null,
  }];
  return update(taskId, {
    status: 'failed',
    endedAt: now(),
    error: error || 'task failed',
    failureHistory,
    result: { ok: false, error: error || 'task failed', ...meta },
  });
}

function markWaiting(taskId, condition) {
  return update(taskId, {
    status: 'waiting',
    waitingCondition: condition || null,
  });
}

function markBlocked(taskId, reason) {
  return update(taskId, {
    status: 'blocked',
    blockedReason: reason || 'blocked',
  });
}

function resume(taskId) {
  const record = get(taskId);
  if (!record) return { ok: false, error: `task not found: ${taskId}` };
  if (!['interrupted', 'failed', 'blocked', 'waiting'].includes(record.status)) {
    return { ok: false, error: `task ${taskId} is not resumable from status ${record.status}` };
  }
  const resumePhaseIndex = Number.isFinite(record.resumePhaseIndex) ? record.resumePhaseIndex : (record.currentPhaseIndex || 0);
  return {
    ok: true,
    record,
    resumePhaseIndex,
    contextVars: { ...(record.contextVars || {}) },
    plan: record.plan,
  };
}

function markAllRunningAsInterrupted() {
  const store = readStore();
  let count = 0;
  for (const record of Object.values(store)) {
    if (record.status === 'running' || record.status === 'queued') {
      record.status = 'interrupted';
      record.resumePhaseIndex = record.currentPhaseIndex || 0;
      record.updatedAt = now();
      count += 1;
    }
  }
  writeStore(store);
  return { ok: true, count };
}

function listAll() {
  return Object.values(readStore()).sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime());
}

function listActive() {
  return listAll().filter((record) => ['queued', 'running', 'interrupted', 'blocked', 'waiting'].includes(record.status));
}

function prune(maxAgeDays = 30) {
  const store = readStore();
  const cutoff = Date.now() - maxAgeDays * 864e5;
  let removed = 0;
  for (const [taskId, record] of Object.entries(store)) {
    const ts = new Date(record.updatedAt || record.endedAt || record.createdAt || 0).getTime();
    if (ts < cutoff && ['completed', 'failed', 'cancelled'].includes(record.status)) {
      delete store[taskId];
      removed += 1;
    }
  }
  if (removed) writeStore(store);
  return { ok: true, removed };
}

module.exports = {
  create,
  get,
  update,
  checkpoint,
  addVerification,
  complete,
  interrupt,
  fail,
  markWaiting,
  markBlocked,
  resume,
  markAllRunningAsInterrupted,
  listAll,
  listActive,
  prune,
};