'use strict';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_EVENTS = 500;

const state = {
  events: [],
  taskStats: {},
  system: {
    health: 'healthy',
    updatedAt: new Date().toISOString(),
    reasons: []
  }
};

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureTask(taskId = 'system') {
  if (!state.taskStats[taskId]) {
    state.taskStats[taskId] = {
      taskId,
      retries: 0,
      verificationWarnings: 0,
      verificationFailures: 0,
      stepFailures: 0,
      taskFailures: 0,
      cancellations: 0,
      ocrMisses: 0,
      fallbackCount: 0,
      lastEventAt: null,
      health: 'healthy',
      reasons: []
    };
  }
  return state.taskStats[taskId];
}

function trimWindow() {
  const cutoff = Date.now() - WINDOW_MS;
  state.events = state.events.filter((event) => Date.parse(event.at) >= cutoff);
}

function logEvent(type, payload = {}) {
  state.events.push({ at: nowIso(), type, ...clone(payload) });
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  trimWindow();
}

function evaluateTask(task) {
  const reasons = [];
  let health = 'healthy';

  if (task.retries >= 3) {
    health = 'degraded';
    reasons.push('high_retry_rate');
  }
  if (task.verificationWarnings >= 3 || task.ocrMisses >= 3) {
    health = 'degraded';
    reasons.push('perception_instability');
  }
  if (task.stepFailures >= 3 || task.fallbackCount >= 2) {
    health = health === 'healthy' ? 'degraded' : 'unstable';
    reasons.push('repeated_step_failure');
  }
  if (task.taskFailures >= 2 || task.cancellations >= 2) {
    health = 'unstable';
    reasons.push('execution_instability');
  }
  if (task.verificationFailures >= 2) {
    health = 'unsafe';
    reasons.push('verification_breakdown');
  }

  task.health = health;
  task.reasons = Array.from(new Set(reasons));
  task.lastEventAt = nowIso();
  return task;
}

function evaluateSystem() {
  const tasks = Object.values(state.taskStats);
  const reasons = new Set();
  let health = 'healthy';

  for (const task of tasks) {
    evaluateTask(task);
    if (task.health === 'degraded' && health === 'healthy') health = 'degraded';
    if (task.health === 'unstable') health = 'unstable';
    if (task.health === 'unsafe') health = 'unsafe';
    task.reasons.forEach((reason) => reasons.add(reason));
  }

  const recentCancels = state.events.filter((event) => event.type === 'task_cancelled').length;
  if (recentCancels >= 3 && health !== 'unsafe') {
    health = 'unstable';
    reasons.add('global_interrupt_pressure');
  }

  state.system = {
    health,
    updatedAt: nowIso(),
    reasons: Array.from(reasons)
  };
  return clone(state.system);
}

function observe(event = {}) {
  const taskId = event.taskId || 'system';
  const task = ensureTask(taskId);
  logEvent(event.type || 'unknown', event);

  switch (event.type) {
    case 'step_retry':
    case 'retry':
      task.retries += 1;
      break;
    case 'verification_warn':
      task.verificationWarnings += 1;
      break;
    case 'verification_failed':
      task.verificationFailures += 1;
      break;
    case 'ocr_miss':
      task.ocrMisses += 1;
      break;
    case 'step_failed':
      task.stepFailures += 1;
      break;
    case 'fallback_triggered':
      task.fallbackCount += 1;
      break;
    case 'task_failed':
      task.taskFailures += 1;
      break;
    case 'task_cancelled':
      task.cancellations += 1;
      break;
    case 'task_succeeded':
      task.retries = 0;
      task.verificationWarnings = 0;
      task.ocrMisses = 0;
      break;
    default:
      break;
  }

  evaluateTask(task);
  evaluateSystem();
  return { ok: true, health: clone(task), system: clone(state.system) };
}

function observeVerification(result = {}) {
  if (result.ok === false) {
    return observe({ type: 'verification_failed', taskId: result.taskId, detail: result.error || null });
  }
  if (result.warn) {
    return observe({ type: 'verification_warn', taskId: result.taskId, detail: result.warn });
  }
  return observe({ type: 'verification_ok', taskId: result.taskId });
}

function observeTaskResult(result = {}) {
  if (result.cancelled) return observe({ type: 'task_cancelled', taskId: result.taskId });
  if (result.ok) return observe({ type: 'task_succeeded', taskId: result.taskId });
  return observe({ type: 'task_failed', taskId: result.taskId, detail: result.error || null });
}

function getTaskHealth(taskId) {
  return clone(evaluateTask(ensureTask(taskId)));
}

function getHealth() {
  return evaluateSystem();
}

function shouldEscalate(taskId) {
  const task = getTaskHealth(taskId);
  return {
    ok: true,
    escalate: ['unstable', 'unsafe'].includes(task.health),
    health: task.health,
    reasons: task.reasons
  };
}

function buildWarning(taskId) {
  const task = getTaskHealth(taskId);
  if (task.health === 'healthy') return { ok: true, warning: null };
  return {
    ok: true,
    warning: {
      taskId,
      health: task.health,
      reasons: task.reasons,
      message: `Task ${taskId} is ${task.health}: ${task.reasons.join(', ') || 'unknown_issue'}`
    }
  };
}

module.exports = {
  observe,
  observeVerification,
  observeTaskResult,
  getHealth,
  getTaskHealth,
  shouldEscalate,
  buildWarning
};