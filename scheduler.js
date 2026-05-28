'use strict';

const executer = require('./executer');

const queues = {
  foreground: [],
  background: []
};

const running = new Map();
const locks = new Map();
let emitter = null;

function emit(type, payload = {}) {
  if (typeof emitter === 'function') {
    emitter({ type, ...payload });
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLocks(goal) {
  const list = Array.isArray(goal.locks) ? goal.locks : [];
  if (list.length) return Array.from(new Set(list));
  if (goal.background) return [];
  return ['ui_lock'];
}

function makeQueuedGoal(goal = {}) {
  return {
    taskId: goal.taskId || `sched-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label: goal.label || 'Untitled Goal',
    priority: Number.isFinite(goal.priority) ? goal.priority : 5,
    background: !!goal.background,
    locks: normalizeLocks(goal),
    payload: goal.payload || goal,
    status: 'queued',
    enqueuedAt: new Date().toISOString(),
    waitReason: null,
    resumeCondition: goal.resumeCondition || null,
    nextCheckAt: goal.nextCheckAt || null
  };
}

function sortQueue(queue) {
  queue.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt);
  });
}

function enqueue(goal) {
  const item = makeQueuedGoal(goal);
  const lane = item.background ? queues.background : queues.foreground;
  lane.push(item);
  sortQueue(lane);
  emit('scheduler_enqueued', { taskId: item.taskId, label: item.label, background: item.background, priority: item.priority });
  return { ok: true, task: clone(item) };
}

function peek() {
  const foreground = queues.foreground[0] || null;
  const background = queues.background[0] || null;
  return { ok: true, foreground: clone(foreground), background: clone(background) };
}

function dequeue(laneName = 'foreground') {
  const lane = queues[laneName];
  if (!lane || !lane.length) return { ok: false, error: `No queued task in ${laneName}` };
  const item = lane.shift();
  emit('scheduler_dequeued', { taskId: item.taskId, lane: laneName });
  return { ok: true, task: clone(item) };
}

function canRun(goal) {
  for (const lock of goal.locks || []) {
    const owner = locks.get(lock);
    if (owner && owner !== goal.taskId) {
      return { ok: true, canRun: false, blockedBy: owner, lock };
    }
  }
  return { ok: true, canRun: true };
}

function acquireLocks(taskId, lockNames = []) {
  for (const lockName of lockNames) {
    const owner = locks.get(lockName);
    if (owner && owner !== taskId) {
      return { ok: false, error: `lock ${lockName} held by ${owner}` };
    }
  }
  for (const lockName of lockNames) {
    locks.set(lockName, taskId);
  }
  emit('scheduler_locks_acquired', { taskId, locks: lockNames });
  return { ok: true, taskId, locks: lockNames };
}

function releaseLocks(taskId) {
  const released = [];
  for (const [lockName, owner] of locks.entries()) {
    if (owner === taskId) {
      locks.delete(lockName);
      released.push(lockName);
    }
  }
  emit('scheduler_locks_released', { taskId, locks: released });
  return { ok: true, taskId, locks: released };
}

function markBlocked(taskId, reason = 'blocked') {
  for (const lane of [queues.foreground, queues.background]) {
    const task = lane.find((item) => item.taskId === taskId);
    if (task) {
      task.status = 'blocked';
      task.waitReason = reason;
      emit('scheduler_blocked', { taskId, reason });
      return { ok: true, task: clone(task) };
    }
  }
  return { ok: false, error: 'task not found' };
}

function markWaiting(taskId, condition = null, nextCheckAt = null) {
  const all = [...queues.foreground, ...queues.background, ...Array.from(running.values())];
  const task = all.find((item) => item.taskId === taskId);
  if (!task) return { ok: false, error: 'task not found' };
  task.status = 'waiting';
  task.resumeCondition = condition;
  task.nextCheckAt = nextCheckAt;
  emit('scheduler_waiting', { taskId, condition, nextCheckAt });
  return { ok: true, task: clone(task) };
}

function promote(taskId) {
  const idx = queues.background.findIndex((item) => item.taskId === taskId);
  if (idx === -1) return { ok: false, error: 'background task not found' };
  const [task] = queues.background.splice(idx, 1);
  task.background = false;
  task.locks = task.locks.length ? task.locks : ['ui_lock'];
  queues.foreground.push(task);
  sortQueue(queues.foreground);
  emit('scheduler_promoted', { taskId });
  return { ok: true, task: clone(task) };
}

async function cancel(taskId) {
  for (const lane of [queues.foreground, queues.background]) {
    const idx = lane.findIndex((item) => item.taskId === taskId);
    if (idx !== -1) {
      const [task] = lane.splice(idx, 1);
      task.status = 'cancelled';
      emit('scheduler_cancelled', { taskId, queued: true });
      return { ok: true, task: clone(task) };
    }
  }

  if (running.has(taskId)) {
    await executer.cancelTask(taskId);
    releaseLocks(taskId);
    const task = running.get(taskId);
    running.delete(taskId);
    emit('scheduler_cancelled', { taskId, running: true });
    return { ok: true, task: clone(task) };
  }

  return { ok: false, error: 'task not found' };
}

async function runTask(task) {
  const lockResult = acquireLocks(task.taskId, task.locks);
  if (!lockResult.ok) {
    task.status = 'blocked';
    task.waitReason = lockResult.error;
    return { ok: false, blocked: true, error: lockResult.error };
  }

  task.status = 'running';
  task.startedAt = new Date().toISOString();
  running.set(task.taskId, task);
  emit('scheduler_started', { taskId: task.taskId, label: task.label, locks: task.locks });

  try {
    const result = await executer.run({
      ...(task.payload || {}),
      taskId: task.taskId,
      label: task.label
    }, (event) => emit('scheduler_task_progress', { taskId: task.taskId, event }));

    task.status = result.ok ? 'completed' : (result.cancelled ? 'cancelled' : 'failed');
    task.finishedAt = new Date().toISOString();
    emit('scheduler_finished', { taskId: task.taskId, status: task.status, ok: !!result.ok, cancelled: !!result.cancelled });
    return result;
  } finally {
    running.delete(task.taskId);
    releaseLocks(task.taskId);
  }
}

async function tick() {
  sortQueue(queues.foreground);
  sortQueue(queues.background);

  const candidate = queues.foreground[0] || queues.background[0] || null;
  if (!candidate) return { ok: true, idle: true };

  const permission = canRun(candidate);
  if (!permission.canRun) {
    candidate.status = 'blocked';
    candidate.waitReason = `lock:${permission.lock}`;
    return { ok: true, blocked: true, taskId: candidate.taskId, reason: candidate.waitReason };
  }

  const laneName = candidate.background ? 'background' : 'foreground';
  const { task } = dequeue(laneName);
  return runTask(task);
}

function getState() {
  return {
    ok: true,
    queued: {
      foreground: clone(queues.foreground),
      background: clone(queues.background)
    },
    running: clone(Array.from(running.values())),
    locks: Object.fromEntries(locks.entries())
  };
}

function init(options = {}) {
  emitter = typeof options.emit === 'function' ? options.emit : null;
  emit('scheduler_ready', {});
  return { ok: true };
}

module.exports = {
  init,
  enqueue,
  dequeue,
  peek,
  tick,
  canRun,
  acquireLocks,
  releaseLocks,
  markBlocked,
  markWaiting,
  promote,
  cancel,
  getState
};