'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// IMPORTANT:
// Do NOT require('./brain') at module top level.
// controller -> brain and brain -> controller is a circular dependency.
// Use lazy require instead so controller is fully initialized first.
let _brainModule = null;
function getBrain() {
  if (!_brainModule) {
    _brainModule = require('./brain');
  }
  return _brainModule;
}

const executer = require('./executer');
const taskStore = require('./taskStore');
const verifier = require('./verifier');
const memory = require('./memory');
const memoryRanker = require('./memoryRanker');
const modes = require('./modes');

// Optional modules — controller degrades gracefully if absent
let worldModel = null;
let healthMonitor = null;
let scheduler = null;
let vision = null;

try { worldModel = require('./worldModel'); } catch { console.warn('[controller] worldModel not found — world tracking disabled'); }
try { healthMonitor = require('./healthMonitor'); } catch { console.warn('[controller] healthMonitor not found — health tracking disabled'); }
try { scheduler = require('./scheduler'); } catch { console.warn('[controller] scheduler not found — falling back to direct executer'); }
try { vision = require('./vision'); } catch { console.warn('[controller] vision not found — screen understanding disabled'); }

// ── internal state ────────────────────────────────────────────
let _emit = null;
let _activeGoal = null;
let _interrupted = false;
let _tickRunning = false;
let _tickStartedAt = 0;
const _enqueuedTaskIds = new Set();

const TICK_TIMEOUT_MS = 90_000;

// ── safe helpers ──────────────────────────────────────────────
function safeEmit(event) {
  if (typeof _emit !== 'function') return;
  try {
    _emit(event);
  } catch (err) {
    console.error('[controller] emit error:', err.message, '| event type:', event?.type);
  }
}

async function safeWorldPatch(delta, source) {
  if (!worldModel) return;
  try {
    await worldModel.patch(delta, source);
  } catch (err) {
    console.error('[controller] worldModel.patch error:', err.message);
  }
}

async function safeWorldEvent(ev) {
  if (!worldModel) return;
  try {
    await worldModel.recordEvent(ev);
  } catch (err) {
    console.error('[controller] worldModel.recordEvent error:', err.message);
  }
}

function safeHealthObserve(ev) {
  if (!healthMonitor) return;
  try {
    healthMonitor.observe(ev);
  } catch (err) {
    console.error('[controller] healthMonitor.observe error:', err.message);
  }
}

function safeHealthObserveVerification(ev) {
  if (!healthMonitor) return;
  try {
    healthMonitor.observeVerification(ev);
  } catch (err) {
    console.error('[controller] healthMonitor.observeVerification error:', err.message);
  }
}

function safeHealthObserveTaskResult(result) {
  if (!healthMonitor) return;
  try {
    healthMonitor.observeTaskResult(result);
  } catch (err) {
    console.error('[controller] healthMonitor.observeTaskResult error:', err.message);
  }
}

function safeHealthGetHealth() {
  if (!healthMonitor) return null;
  try {
    return healthMonitor.getHealth();
  } catch {
    return null;
  }
}

function safeVisionAvailable() {
  return !!(vision && typeof vision.describeScreen === 'function');
}

async function safeVisionDescribe(options) {
  if (!safeVisionAvailable()) {
    return { ok: false, error: 'vision module not available' };
  }

  try {
    return await vision.describeScreen(options);
  } catch (err) {
    console.error('[controller] vision.describeScreen error', err.message);
    return { ok: false, error: err.message };
  }
}

async function safeVisionStoreInWorld(observation, source = 'visionobservation') {
  if (!observation?.ok) return;

  const screenshotPath = observation.screenshotPath || observation.local?.screenshotPath || null;
  const visibleTexts = Array.isArray(observation.visibleText) ? observation.visibleText : [];
  const now = new Date().toISOString();

  await safeWorldPatch({
    ui: {
      screenshotPath,
      screenshotAt: now,
      visibleTexts,
      visibleTextCount: visibleTexts.length,
      loading: !!observation.loading,
      modalOpen: !!observation.modalOpen,
      pageReady: !!observation.pageReady,
      app: observation.app || null,
      summary: observation.summary || null,
      lastObservationAt: now,
      lastObservationSource: source,
    },
    tasks: {
      confidence: Number.isFinite(observation.confidence) ? observation.confidence : 1,
    },
    perception: {
      latestObservation: observation,
    },
  }, source);
}

// ── emitter setup ─────────────────────────────────────────────
function setEmitter(fn) {
  _emit = typeof fn === 'function' ? fn : null;
}

function makeGoalId() {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeInnerEventType(type) {
  const t = String(type || '').trim();
  const map = {
    taskstart: 'task_started',
    task_started: 'task_started',
    tasksucceeded: 'task_succeeded',
    task_succeeded: 'task_succeeded',
    taskfailed: 'task_failed',
    task_failed: 'task_failed',
    taskcancelled: 'task_cancelled',
    task_cancelled: 'task_cancelled',
    stepretry: 'step_retry',
    step_retry: 'step_retry',
    stepfailed: 'step_failed',
    step_failed: 'step_failed',
    ocrmiss: 'ocr_miss',
    ocr_miss: 'ocr_miss',
    fallbacktriggered: 'fallback_triggered',
    fallback_triggered: 'fallback_triggered',
    phasestarted: 'phase_started',
    phase_started: 'phase_started',
    phasecompleted: 'phase_completed',
    phase_completed: 'phase_completed',
    phasefailed: 'phase_failed',
    phase_failed: 'phase_failed',
  };
  return map[t] || t;
}

function normalizeSchedulerEventType(type) {
  const t = String(type || '').trim();
  const map = {
    schedulerready: 'scheduler_ready',
    scheduler_ready: 'scheduler_ready',
    schedulerstarted: 'scheduler_started',
    scheduler_started: 'scheduler_started',
    schedulerfinished: 'scheduler_finished',
    scheduler_finished: 'scheduler_finished',
    schedulertaskprogress: 'scheduler_task_progress',
    scheduler_task_progress: 'scheduler_task_progress',
    schedulercancelled: 'scheduler_cancelled',
    scheduler_cancelled: 'scheduler_cancelled',
    schedulerblocked: 'scheduler_blocked',
    scheduler_blocked: 'scheduler_blocked',
    schedulerwaiting: 'scheduler_waiting',
    scheduler_waiting: 'scheduler_waiting',
    schedulerpromoted: 'scheduler_promoted',
    scheduler_promoted: 'scheduler_promoted',
  };
  return map[t] || t;
}

function isTaskStateStatus(status) {
  return new Set([
    'queued',
    'started',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]).has(status);
}

function extractAppsFromPlanLike(source) {
  return Array.from(new Set([
    source?.app,
    ...(Array.isArray(source?.apps) ? source.apps : []),
    ...(Array.isArray(source?.context?.apps) ? source.context.apps : []),
    ...(Array.isArray(source?.plan?.context?.apps) ? source.plan.context.apps : []),
  ].filter(Boolean)));
}

async function syncTaskStateToWorld({ taskId, label, status, phase = null, error = null }) {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const patch = {
    tasks: {
      activeTaskId: terminal ? null : (taskId || null),
      activeGoal: terminal ? null : (label || null),
      phase: terminal ? null : (phase || null),
      lastTaskStatus: status || null,
      lastTaskError: error || null,
      lastTaskUpdatedAt: new Date().toISOString(),
    },
  };
  await safeWorldPatch(patch, 'controller_task_state_sync');
}

// ── scheduler telemetry bridge ────────────────────────────────
async function reflectSchedulerTelemetry(event) {
  try {
    const outerType = normalizeSchedulerEventType(event?.type);
    if (!outerType) return;

    // ── inner execution events forwarded by scheduler ──
    if (outerType === 'scheduler_task_progress' && event.event) {
      const inner = { ...event.event, type: normalizeInnerEventType(event.event?.type) };

      safeEmit({ type: 'execution-progress', ...inner });

      if (inner.type === 'task' && isTaskStateStatus(inner.status)) {
        safeEmit({
          type: 'task-state',
          taskId: inner.taskId,
          label: inner.label,
          status: inner.status,
          error: inner.error || null,
        });

        await syncTaskStateToWorld({
          taskId: inner.taskId,
          label: inner.label,
          status: inner.status,
          phase: inner.phaseName || null,
          error: inner.error || null,
        });
      }

      if (inner.type === 'phase' && inner.phaseName && inner.status) {
        await safeWorldPatch({
          tasks: {
            activeTaskId: inner.taskId || _activeGoal?.taskId || null,
            activeGoal: _activeGoal?.label || event.label || null,
            phase: inner.status === 'completed' || inner.status === 'failed' || inner.status === 'cancelled'
              ? null
              : inner.phaseName,
            lastPhaseStatus: inner.status,
            lastPhaseUpdatedAt: new Date().toISOString(),
          },
        }, 'scheduler_phase_progress');
      }

      const progressTypes = new Set([
        'task_started',
        'task_failed',
        'task_cancelled',
        'task_succeeded',
        'step_retry',
        'step_failed',
        'ocr_miss',
        'fallback_triggered',
      ]);

      if (progressTypes.has(inner.type)) {
        safeHealthObserve({
          type: inner.type,
          taskId: inner.taskId,
          detail: inner.error || null,
        });
      }

      if (inner.type === 'phase_completed' || inner.type === 'phase_failed') {
        await safeWorldEvent({
          type: inner.type,
          taskId: inner.taskId,
          phase: inner.phaseName,
          label: inner.phaseName,
        });
      }

      if (inner.type === 'task_succeeded') {
        safeEmit({
          type: 'task-state',
          taskId: inner.taskId,
          label: _activeGoal?.label || event.label || inner.taskId,
          status: 'completed',
          error: null,
        });

        await syncTaskStateToWorld({
          taskId: inner.taskId,
          label: _activeGoal?.label || event.label || inner.taskId,
          status: 'completed',
        });
      }

      if (inner.type === 'task_failed') {
        safeEmit({
          type: 'task-state',
          taskId: inner.taskId,
          label: _activeGoal?.label || event.label || inner.taskId,
          status: 'failed',
          error: inner.error || null,
        });

        await syncTaskStateToWorld({
          taskId: inner.taskId,
          label: _activeGoal?.label || event.label || inner.taskId,
          status: 'failed',
          error: inner.error || null,
        });
      }

      if (inner.type === 'task_cancelled') {
        safeEmit({
          type: 'task-state',
          taskId: inner.taskId,
          label: _activeGoal?.label || event.label || inner.taskId,
          status: 'cancelled',
          error: inner.error || null,
        });

        await syncTaskStateToWorld({
          taskId: inner.taskId,
          label: _activeGoal?.label || event.label || inner.taskId,
          status: 'cancelled',
          error: inner.error || null,
        });
      }

      return;
    }

    // ── scheduler lifecycle: a task was dequeued and started ──
    if (outerType === 'scheduler_started') {
      const record = event.taskId ? taskStore.get(event.taskId) : null;
      const planLike = record?.plan || {};
      const inferredApps = extractAppsFromPlanLike(planLike);

      _activeGoal = {
        goalId: makeGoalId(),
        taskId: event.taskId,
        label: event.label,
        goal: record?.label || event.label || '',
        phase: null,
        app: inferredApps[0] || null,
        apps: inferredApps,
        plan: planLike,
        context: planLike?.context || {},
        status: 'running',
        startedAt: new Date().toISOString(),
        locks: event.locks || [],
      };

      await safeWorldPatch({
        tasks: {
          activeTaskId: event.taskId,
          activeGoal: event.label,
          phase: null,
          lastTaskStatus: 'started',
          lastTaskUpdatedAt: new Date().toISOString(),
        },
      }, 'scheduler_started');

      await safeWorldEvent({
        type: 'task_started',
        taskId: event.taskId,
        label: event.label,
      });

      safeEmit({
        type: 'task-state',
        taskId: event.taskId,
        label: event.label,
        status: 'started',
      });
      return;
    }

    // ── scheduler lifecycle: task finished ──
    if (outerType === 'scheduler_finished') {
      const resultShape = {
        ok: !!event.ok,
        cancelled: !!event.cancelled,
        error: event.error || null,
        taskId: event.taskId,
      };

      safeHealthObserveTaskResult(resultShape);

      await safeWorldPatch({
        tasks: {
          activeTaskId: null,
          activeGoal: null,
          phase: null,
          lastTaskStatus: event.cancelled ? 'cancelled' : event.ok ? 'completed' : 'failed',
          lastTaskError: event.error || null,
          lastTaskUpdatedAt: new Date().toISOString(),
        },
      }, 'scheduler_finished');

      await safeWorldEvent({
        type: event.cancelled ? 'task_cancelled' : event.ok ? 'task_completed' : 'task_failed',
        taskId: event.taskId,
        label: _activeGoal?.label || event.taskId,
      });

      try {
        const record = taskStore.get(event.taskId);
        if (record) {
          const lr = memory.learn(record, record.verificationLog || []);
          if (lr.newLessons?.length) {
            console.log(`[controller] learned ${lr.newLessons.length} lesson(s) from "${record.label}"`);
          }
        }
      } catch (err) {
        console.error('[controller] memory.learn error:', err.message);
      }

      _enqueuedTaskIds.delete(event.taskId);
      _activeGoal = null;
      _interrupted = false;
      return;
    }

    if (outerType === 'scheduler_cancelled') {
      await safeWorldEvent({
        type: 'task_cancelled',
        taskId: event.taskId,
        label: event.label || _activeGoal?.label || event.taskId,
      });

      await syncTaskStateToWorld({
        taskId: event.taskId,
        label: event.label || _activeGoal?.label || event.taskId,
        status: 'cancelled',
      });

      safeEmit({
        type: 'task-state',
        taskId: event.taskId,
        label: event.label || _activeGoal?.label || event.taskId,
        status: 'cancelled',
      });

      _enqueuedTaskIds.delete(event.taskId);

      if (_activeGoal?.taskId === event.taskId) {
        _activeGoal = null;
        _interrupted = false;
      }
      return;
    }

    safeEmit({ type: 'agent-event', ...event });
  } catch (err) {
    console.error('[controller] reflectSchedulerTelemetry unhandled error:', err.message);
  }
}

// ── startup ───────────────────────────────────────────────────
async function onStartup() {
  console.log('[controller] startup check');

  if (worldModel) {
    try {
      await worldModel.init({
        emit: async (payload) => {
          if (payload?.type?.startsWith('world_')) safeEmit(payload);
        },
        restore: true,
        startHeartbeat: true,
        heartbeatMs: 3000,
      });
    } catch (err) {
      console.error('[controller] worldModel.init error:', err.message);
    }
  }

  if (scheduler) {
    try {
      scheduler.init({
        emit: (payload) => {
          reflectSchedulerTelemetry(payload).catch((err) => {
            console.error('[controller] scheduler telemetry error:', err.message);
          });
        },
      });
    } catch (err) {
      console.error('[controller] scheduler.init error:', err.message);
    }
  }

  try { taskStore.markAllRunningAsInterrupted(); } catch (err) { console.error('[controller] markAllRunningAsInterrupted error:', err.message); }
  try { taskStore.prune(30); } catch (err) { console.error('[controller] taskStore.prune error:', err.message); }
  try { memory.prune(90, 0.3); } catch (err) { console.error('[controller] memory.prune error:', err.message); }

  let active = [];
  try { active = taskStore.listActive(); } catch (err) { console.error('[controller] taskStore.listActive error:', err.message); }

  if (active.length > 0) {
    const msg = active.length === 1
      ? `I was in the middle of "${active[0].label}" when we stopped. Want me to pick up where I left off?`
      : `I had ${active.length} tasks going when we stopped. Want to review them?`;

    safeEmit({
      type: 'interrupted_tasks',
      tasks: active.map((t) => ({
        taskId: t.taskId,
        label: t.label,
        status: t.status,
      })),
      message: msg,
    });

    console.log(`[controller] ${active.length} interrupted task(s) found`);
  }

  await safeWorldPatch({
    tasks: {
      blocked: [],
      waiting: [],
      activeTaskId: null,
      activeGoal: null,
      phase: null,
    },
  }, 'startup');

  return {
    ok: true,
    interruptedTasks: active,
    world: worldModel?.snapshot?.() || null,
    health: safeHealthGetHealth(),
    visionAvailable: safeVisionAvailable(),
  };
}

// ── scheduler tick ────────────────────────────────────────────
async function runSchedulerTick() {
  if (!scheduler) return { ok: false, skipped: true, reason: 'scheduler not loaded' };

  if (_tickRunning) {
    const elapsed = Date.now() - _tickStartedAt;
    if (elapsed > TICK_TIMEOUT_MS) {
      console.warn(`[controller] tick timeout after ${elapsed}ms — releasing tick lock`);
      _tickRunning = false;
      _tickStartedAt = 0;
    } else {
      return { ok: true, skipped: true, reason: 'tick already running' };
    }
  }

  _tickRunning = true;
  _tickStartedAt = Date.now();

  try {
    return await scheduler.tick();
  } catch (err) {
    console.error('[controller] scheduler.tick error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    _tickRunning = false;
    _tickStartedAt = 0;
  }
}

// ── phase verification + checkpoint ──────────────────────────
async function verifyPhaseAndCheckpoint(plan, taskId, phaseName, context) {
  const phaseObj = (plan.phases || []).find((p) => p.name === phaseName);
  if (!phaseObj) return null;

  let vr;
  try {
    vr = await verifier.verifyPhase(phaseObj, { ok: true }, context);
  } catch (err) {
    console.error('[controller] verifier.verifyPhase error:', err.message);
    vr = {
      ok: true,
      confidence: 0.5,
      evidence: [],
      warnings: [`verifier threw: ${err.message}`],
      action: 'warn',
    };
  }

  vr.phaseName = phaseName;

  try {
    taskStore.addVerification(taskId, vr);
  } catch (err) {
    console.error('[controller] addVerification error:', err.message);
  }

  safeHealthObserveVerification({ ...vr, taskId });

  const phaseIdx = (plan.phases || []).findIndex((p) => p.name === phaseName);
  try {
    taskStore.checkpoint(taskId, {
      currentPhaseIndex: phaseIdx + 1,
      contextVars: { ...(context?.vars || {}) },
    });
  } catch (err) {
    console.error('[controller] taskStore.checkpoint error:', err.message);
  }

  await safeWorldPatch({
    tasks: {
      phase: phaseName,
      confidence: Number.isFinite(vr.confidence) ? vr.confidence : 1,
      lastVerifiedAt: new Date().toISOString(),
    },
  }, 'phase_verified');

  if (vr.action === 'warn') {
    safeEmit({
      type: 'speech',
      text: `That phase finished but I'm only ${Math.round((vr.confidence || 0) * 100)}% sure it worked. Carrying on.`,
      taskId,
    });
  }

  return vr;
}

// ── vision query interface ───────────────────────────────────
async function describeCurrentScreen(options = {}) {
  const merged = {
    appHint: _activeGoal?.label || null,
    phaseHint: getWorldState()?.tasks?.phase || null,
    goal: _activeGoal?.label
      ? `Understand the current screen while working on ${_activeGoal.label}.`
      : 'Understand the current screen for the desktop assistant.',
    ...options,
  };

  const observation = await safeVisionDescribe(merged);
  if (!observation?.ok) return observation;

  await safeVisionStoreInWorld(observation, 'controller.describeCurrentScreen');
  await safeWorldEvent({
    type: 'screendescribed',
    taskId: _activeGoal?.taskId || null,
    label: _activeGoal?.label || null,
    source: 'controller.describeCurrentScreen',
  });

  safeEmit({
    type: 'screen-observation',
    observation,
    taskId: _activeGoal?.taskId || null,
  });

  return observation;
}

// ── plan construction ─────────────────────────────────────────
function buildPlanFromBrain(brainResult) {
  if (!brainResult || typeof brainResult !== 'object') {
    throw new TypeError('buildPlanFromBrain: brainResult must be an object');
  }

  const planRoot = brainResult.plan && typeof brainResult.plan === 'object'
    ? brainResult.plan
    : brainResult;

  return {
    taskId: planRoot.taskId || brainResult.taskId || `task_${Date.now()}`,
    label: planRoot.label || brainResult.label || 'Computer Use Task',
    steps: Array.isArray(planRoot.steps) ? planRoot.steps : [],
    phases: Array.isArray(planRoot.phases) ? planRoot.phases : [],
    context: planRoot.context || brainResult.context || {},
    mode: planRoot.mode || brainResult.mode || null,
    estimates: planRoot.estimates || brainResult.estimates || null,
    briefing: planRoot.briefing || brainResult.briefing || null,
    memoryInjection: planRoot.memoryInjection || brainResult.memoryInjection || '',
    memoryLessons: Array.isArray(planRoot.memoryLessons)
      ? planRoot.memoryLessons
      : Array.isArray(brainResult.memoryLessons)
      ? brainResult.memoryLessons
      : [],
    memoryContext: planRoot.memoryContext || brainResult.memoryContext || null,
  };
}

function collectPlanActions(plan) {
  return []
    .concat(plan.steps || [])
    .concat(...(plan.phases || []).map((p) => p.steps || []))
    .map((s) => s.action || s.verb || '')
    .filter(Boolean);
}

function injectMemoryIntoPlan(plan) {
  try {
    const lessons = memoryRanker.getRelevantLessons({
      taskType: plan.context?.taskType || '',
      apps: plan.context?.apps || (plan.app ? [plan.app] : []),
      goal: plan.label,
      actions: collectPlanActions(plan),
      tags: plan.context?.tags || [],
    });

    if (lessons.length) {
      const injection = memoryRanker.buildPlannerInjection(lessons);
      plan.memoryLessons = lessons;
      plan.memoryInjection = injection;
      plan._memoryInjection = injection;
      console.log(`[controller] injected ${lessons.length} memory lesson(s) into "${plan.label}"`);
    }

    return lessons;
  } catch (err) {
    console.error('[controller] memory injection error:', err.message);
    return [];
  }
}

// ── queue plan (dedup guard) ──────────────────────────────────
async function queuePlan(plan, opts = {}) {
  const taskId = plan.taskId;

  if (_enqueuedTaskIds.has(taskId)) {
    console.warn(`[controller] queuePlan: taskId ${taskId} already enqueued — skipping duplicate`);
    return { ok: false, skipped: true, reason: 'duplicate task id', taskId };
  }
  _enqueuedTaskIds.add(taskId);

  try {
    const existingRecord = taskStore.get(taskId);
    if (existingRecord) {
      taskStore.update(taskId, {
        label: plan.label,
        status: 'queued',
        plan: { ...(existingRecord.plan || {}), ...plan },
        contextVars: {
          ...(existingRecord.contextVars || {}),
          ...(plan.context?.vars || {}),
        },
      });
    } else {
      taskStore.create(plan);
    }
  } catch (err) {
    console.error('[controller] taskStore create/update error:', err.message);
  }

  await safeWorldPatch({
    tasks: {
      activeGoal: plan.label,
      activeTaskId: taskId,
      lastTaskStatus: 'queued',
      lastTaskUpdatedAt: new Date().toISOString(),
    },
  }, 'queue_plan');

  let queued;
  if (scheduler) {
    try {
      queued = scheduler.enqueue({
        taskId,
        label: plan.label,
        priority: opts.priority || 10,
        background: !!opts.isBackground,
        locks: opts.locks || (opts.isBackground ? [] : ['ui_lock']),
        payload: {
          ...plan,
          contextSeed: { vars: { ...(plan.context?.vars || {}) } },
        },
      });
    } catch (err) {
      _enqueuedTaskIds.delete(taskId);
      console.error('[controller] scheduler.enqueue error:', err.message);
      safeEmit({
        type: 'speech',
        text: `Scheduler could not accept the task: ${err.message}`,
        taskId,
      });
      return { ok: false, error: err.message, taskId };
    }
  } else {
    queued = { ok: true, taskId, direct: true };

    setImmediate(() => {
      const inferredApps = extractAppsFromPlanLike(plan);

      _activeGoal = {
        goalId: makeGoalId(),
        taskId,
        label: plan.label,
        goal: plan.label,
        phase: null,
        app: inferredApps[0] || null,
        apps: inferredApps,
        plan,
        context: plan.context || {},
        status: 'running',
        startedAt: new Date().toISOString(),
        locks: [],
      };

      executer.run(
        { ...plan, contextSeed: { vars: { ...(plan.context?.vars || {}) } } },
        (ev) => {
          safeEmit({ type: 'execution-progress', ...ev });
        }
      )
      .then(async (result) => {
        _enqueuedTaskIds.delete(taskId);

        if (result.ok) taskStore.complete(taskId, result);
        else taskStore.fail(taskId, result.error, { failedStep: result.failedStep });

        safeHealthObserveTaskResult({
          ok: !!result.ok,
          cancelled: !!result.cancelled,
          error: result.error || null,
          taskId,
        });

        await safeWorldPatch({
          tasks: {
            activeTaskId: null,
            activeGoal: null,
            phase: null,
            lastTaskStatus: result.ok ? 'completed' : result.cancelled ? 'cancelled' : 'failed',
            lastTaskError: result.error || null,
            lastTaskUpdatedAt: new Date().toISOString(),
          },
        }, 'direct_execution_finished');

        safeEmit({
          type: 'task-state',
          taskId,
          label: plan.label,
          status: result.ok ? 'completed' : result.cancelled ? 'cancelled' : 'failed',
          error: result.error || null,
        });

        _activeGoal = null;
        _interrupted = false;
      })
      .catch(async (err) => {
        _enqueuedTaskIds.delete(taskId);
        taskStore.fail(taskId, err.message, {});

        await safeWorldPatch({
          tasks: {
            activeTaskId: null,
            activeGoal: null,
            phase: null,
            lastTaskStatus: 'failed',
            lastTaskError: err.message,
            lastTaskUpdatedAt: new Date().toISOString(),
          },
        }, 'direct_execution_error');

        safeEmit({ type: 'speech', text: `Task error: ${err.message}`, taskId });
        safeEmit({ type: 'task-state', taskId, label: plan.label, status: 'failed', error: err.message });

        _activeGoal = null;
        _interrupted = false;
      });
    });
  }

  safeEmit({ type: 'task-state', taskId, label: plan.label, status: 'queued' });
  await safeWorldEvent({ type: 'task_queued', taskId, label: plan.label });

  setImmediate(() => {
    runSchedulerTick().catch((err) => {
      console.error('[controller] scheduler tick error after enqueue:', err.message);
      safeEmit({ type: 'speech', text: `Scheduler error: ${err.message}`, taskId });
    });
  });

  return { ok: true, taskId, queued };
}

// ── resume ────────────────────────────────────────────────────
async function resumeTask(taskId) {
  let info;
  try {
    info = taskStore.resume(taskId);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (!info.ok) return { ok: false, error: info.error };

  const { record, resumePhaseIndex, contextVars, plan } = info;

  if (_enqueuedTaskIds.has(taskId)) {
    return { ok: false, error: `task ${taskId} is already queued or running` };
  }

  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];

  const resumePlan = {
    ...plan,
    taskId,
    label: record.label,
    phases: phases.slice(Math.max(0, resumePhaseIndex)),
    steps: resumePhaseIndex === 0 ? steps : [],
    context: { ...(plan?.context || {}), vars: contextVars },
  };

  try {
    taskStore.checkpoint(taskId, {
      status: 'queued',
      currentPhaseIndex: resumePhaseIndex,
    });
  } catch (err) {
    console.error('[controller] resume checkpoint error:', err.message);
  }

  safeEmit({
    type: 'speech',
    text: `Picking up "${record.label}" from where we left off.`,
    taskId,
  });

  await safeWorldEvent({
    type: 'task_resume_requested',
    taskId,
    label: record.label,
  });

  return queuePlan(resumePlan, { priority: 10 });
}

// ── main entry point ──────────────────────────────────────────
async function handleUserInput(heard) {
  const raw = (heard || '').trim();
  if (!raw) {
    return {
      type: 'ai_response',
      reply: "Didn't catch that — say it again?",
      animation: 'thinking',
    };
  }

  await safeWorldEvent({ type: 'voice_input', text: raw });

  if (_activeGoal && !_interrupted) {
    console.log(`[controller] interrupt: user spoke while "${_activeGoal.label}" running`);
    _interrupted = true;

    safeEmit({
      type: 'interrupt',
      activeGoalId: _activeGoal.goalId,
      heard: raw,
    });

    await safeWorldEvent({
      type: 'manual_input',
      taskId: _activeGoal.taskId,
      label: _activeGoal.label,
      text: raw,
    });
  }

  let brainResult;
  try {
    brainResult = await getBrain().processCommand(raw);
  } catch (err) {
    console.error('[controller] brain.processCommand error:', err.message);
    return {
      type: 'ai_response',
      reply: 'Something went wrong while I was thinking. Try again?',
      animation: 'thinking',
      error: err.message,
    };
  }

  if (!brainResult || typeof brainResult !== 'object') {
    console.warn('[controller] brain returned a non-object result:', typeof brainResult);
    return {
      type: 'ai_response',
      reply: "I didn't get a clear response. Try again?",
      animation: 'thinking',
    };
  }

  if (brainResult.type === 'computer_use') {
    const source = brainResult.plan && typeof brainResult.plan === 'object' ? brainResult.plan : brainResult;
    const hasSteps = Array.isArray(source.steps) && source.steps.length > 0;
    const hasPhases = Array.isArray(source.phases) && source.phases.length > 0;

    // Apply suggested mode switch
    if (brainResult._suggestedModeId) {
      const switched = modes.setMode(brainResult._suggestedModeId);
      if (switched?.ok) console.log(`[controller] mode switched → ${brainResult._suggestedModeId}`);
    }

    if (hasSteps || hasPhases) {
      let plan;
      try {
        plan = buildPlanFromBrain(brainResult);
      } catch (err) {
        console.error('[controller] buildPlanFromBrain error:', err.message);
        return brainResult;
      }

      // healthMonitor gate — stop if task is already degraded
      if (healthMonitor && plan.taskId) {
        try {
          const escalation = healthMonitor.shouldEscalate(plan.taskId);
          if (escalation?.escalate) {
            console.warn(`[controller] healthMonitor blocked ${plan.taskId} — ${escalation.health}`);
            safeEmit({
              type: 'speech',
              text: `This task keeps hitting problems. Want me to try a different approach?`,
              taskId: plan.taskId,
            });
            return brainResult;
          }
        } catch (_) { /* non-fatal */ }
      }

      injectMemoryIntoPlan(plan);
      _interrupted = false;

      queuePlan(plan, {
        priority: 10,
        isBackground: false,
        locks: ['ui_lock'],
      }).catch((err) => {
        console.error('[controller] queuePlan error:', err.message);
        safeEmit({
          type: 'speech',
          text: `Could not start the task: ${err.message}`,
          taskId: plan.taskId,
        });
      });
    } else {
      console.warn('[controller] computer_use intent had no steps or phases — ignoring');
    }
  }

  return brainResult;
}

// ── task control ──────────────────────────────────────────────
function cancelActiveTask() {
  if (!_activeGoal) return { ok: false, error: 'No active task' };

  const { taskId, label, goalId } = _activeGoal;
  _activeGoal = null;
  _interrupted = false;
  _enqueuedTaskIds.delete(taskId);

  if (scheduler) {
    Promise.resolve(scheduler.cancel(taskId)).catch((err) => {
      console.error('[controller] scheduler.cancel error:', err.message);
    });
  }

  try {
    executer.cancelTask(taskId);
  } catch (err) {
    console.error('[controller] executer.cancelTask error:', err.message);
  }

  try {
    taskStore.interrupt(taskId);
  } catch (err) {
    console.error('[controller] taskStore.interrupt error:', err.message);
  }

  safeWorldEvent({ type: 'task_cancelled', taskId, label }).catch(() => null);
  safeWorldPatch({
    tasks: {
      activeTaskId: null,
      activeGoal: null,
      phase: null,
      lastTaskStatus: 'cancelled',
      lastTaskUpdatedAt: new Date().toISOString(),
    },
  }, 'cancel_active_task').catch(() => null);

  safeEmit({ type: 'speech', text: 'Stopping the current task.', taskId });
  safeEmit({ type: 'task-state', taskId, label, status: 'cancelled' });

  return { ok: true, taskId, goalId };
}

// ── query interface ───────────────────────────────────────────
function getWorldState() { try { return worldModel?.snapshot?.() || null; } catch { return null; } }
function getActiveGoal() { return _activeGoal ? { ..._activeGoal } : null; }
function getGoalQueue() { try { return scheduler?.getQueue?.() || scheduler?.getState?.()?.queued || []; } catch { return []; } }
function getMemoryLessons() { try { return memory.listAll(); } catch { return []; } }
function getTaskHistory() { try { return taskStore.listAll(); } catch { return []; } }
function getHealthState() { return safeHealthGetHealth(); }
function isVisionAvailable() { return safeVisionAvailable(); }

module.exports = {
  // Lifecycle
  onStartup,
  setEmitter,

  // Main entry
  handleUserInput,

  // Task control
  resumeTask,
  cancelActiveTask,

  // Internal (used by executer / scheduler callbacks)
  verifyPhaseAndCheckpoint,
  runSchedulerTick,
  queuePlan,

  // Vision
  describeCurrentScreen,
  isVisionAvailable,

  // State queries
  getWorldState,
  getActiveGoal,
  getGoalQueue,
  getMemoryLessons,
  getTaskHistory,
  getHealthState,
};