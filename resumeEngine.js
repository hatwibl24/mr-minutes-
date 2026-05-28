// ============================================================
// MR. MINUTES — resumeEngine.js v1
//
// Owns all task-resume logic: finding interrupted tasks,
// deciding whether they are resumable, slicing the phase/step
// plan to the correct restart point, and handing back a
// ready-to-run payload for the controller/executer.
//
// The controller previously did ad-hoc resume checks in two
// places with no shared validation. This module centralises:
//   • Reading interrupted tasks from the task store
//   • Classifying resume eligibility (age, status, retries)
//   • Slicing plan to correct phase + step index
//   • Merging saved contextVars back into the payload
//   • Generating a renderer-ready summary of what was resumed
//
// API:
//   findResumable(options?)       → [{ taskId, task, slicedPlan, summary }]
//   buildResumePayload(taskId)    → { ok, payload, summary } | { ok: false, reason }
//   shouldAutoResume(task)        → boolean
//   markResumed(taskId)           → void
// ============================================================

'use strict';

let taskStore = null;
try { taskStore = require('./taskStore'); } catch (_) {}

const MAX_RESUME_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_RESUME_RETRIES = 5;

// ── eligibility ──────────────────────────────────────────────
function _isEligible(task) {
  if (!task) return false;
  const resumable = ['interrupted', 'failed', 'cancelled'];
  if (!resumable.includes(task.status)) return false;
  if (task.resumeCount && task.resumeCount >= MAX_RESUME_RETRIES) return false;
  const age = Date.now() - (task.updatedAt || task.startedAt || 0);
  if (age > MAX_RESUME_AGE_MS) return false;
  const plan = task.plan || task.phases || task.steps;
  if (!plan) return false;
  return true;
}

// ── plan slicer ──────────────────────────────────────────────
// Returns the phases/steps starting from the last checkpoint.
// Prefers task.lastPhaseIndex + task.lastStepIndex when available,
// falls back to task.completedSteps / task.lastCompletedStep.
function _slicePlan(task) {
  const phases = task.plan?.phases || (Array.isArray(task.phases) ? task.phases : null);
  const steps  = task.plan?.steps  || (Array.isArray(task.steps)  ? task.steps  : null);

  // ── Phase-based plan ──
  if (phases && phases.length > 0) {
    let phaseIdx = Math.max(0, task.lastPhaseIndex ?? 0);
    let stepIdx  = Math.max(0, task.lastStepIndex  ?? 0);

    // Validate bounds
    phaseIdx = Math.min(phaseIdx, phases.length - 1);
    const phase = phases[phaseIdx];
    if (!phase) return { phases, resumePhaseIndex: 0, resumeStepIndex: 0 };

    const phaseSteps = Array.isArray(phase.steps) ? phase.steps : [];
    if (stepIdx >= phaseSteps.length) {
      // Phase was done — start next phase
      phaseIdx = Math.min(phaseIdx + 1, phases.length - 1);
      stepIdx  = 0;
    }

    const slicedPhases = phases.map((p, i) => {
      if (i < phaseIdx) return null;
      if (i === phaseIdx) {
        return {
          ...p,
          steps: Array.isArray(p.steps) ? p.steps.slice(stepIdx) : [],
          _resumedFromStep: stepIdx,
        };
      }
      return p;
    }).filter(Boolean);

    return {
      phases:             slicedPhases,
      resumePhaseIndex:   phaseIdx,
      resumeStepIndex:    stepIdx,
      originalPhaseCount: phases.length,
    };
  }

  // ── Flat steps plan ──
  if (steps && steps.length > 0) {
    // Determine how many steps were already done
    let doneCount = 0;
    if (typeof task.lastCompletedStep === 'number') {
      doneCount = task.lastCompletedStep + 1;
    } else if (typeof task.completedSteps === 'number') {
      doneCount = task.completedSteps;
    }
    doneCount = Math.max(0, Math.min(doneCount, steps.length - 1));
    return {
      steps:              steps.slice(doneCount),
      resumeStepIndex:    doneCount,
      originalStepCount:  steps.length,
    };
  }

  return null;
}

// ── summary builder ──────────────────────────────────────────
function _buildSummary(task, slicedPlan) {
  const name = task.label || task.goal || `Task ${task.id}`;

  if (slicedPlan?.phases) {
    const totalPhases  = slicedPlan.originalPhaseCount || slicedPlan.phases.length;
    const resumePhase  = slicedPlan.resumePhaseIndex + 1;
    const resumeStep   = slicedPlan.resumeStepIndex;
    const remaining    = slicedPlan.phases.reduce((n, p) => n + (p.steps?.length || 0), 0);
    return {
      label:   name,
      message: `Resuming "${name}" from phase ${resumePhase}/${totalPhases}` +
               (resumeStep > 0 ? `, step ${resumeStep + 1}` : '') +
               ` (${remaining} step${remaining !== 1 ? 's' : ''} remaining)`,
      phaseIndex:     slicedPlan.resumePhaseIndex,
      stepIndex:      slicedPlan.resumeStepIndex,
      stepsRemaining: remaining,
    };
  }

  if (slicedPlan?.steps) {
    const remaining  = slicedPlan.steps.length;
    const totalSteps = slicedPlan.originalStepCount || remaining;
    return {
      label:   name,
      message: `Resuming "${name}" from step ${slicedPlan.resumeStepIndex + 1}/${totalSteps}` +
               ` (${remaining} step${remaining !== 1 ? 's' : ''} remaining)`,
      stepIndex:      slicedPlan.resumeStepIndex,
      stepsRemaining: remaining,
    };
  }

  return { label: name, message: `Resuming "${name}"`, stepsRemaining: 0 };
}

// ── auto-resume heuristic ────────────────────────────────────
// Returns true if the task should be auto-resumed on startup
// without prompting the user (e.g. interrupted, not cancelled).
function shouldAutoResume(task) {
  if (!_isEligible(task)) return false;
  if (task.status === 'cancelled') return false;  // user explicitly cancelled
  if (task.autoResume === false)   return false;  // task opted out
  return true;
}

// ── public: findResumable ────────────────────────────────────
function findResumable(options = {}) {
  if (!taskStore) return [];
  const {
    statusFilter = ['interrupted', 'failed'],
    limit        = 5,
  } = options;

  try {
    const all = taskStore.getAll ? taskStore.getAll() : [];
    return all
      .filter((task) => statusFilter.includes(task.status) && _isEligible(task))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit)
      .map((task) => {
        const slicedPlan = _slicePlan(task);
        if (!slicedPlan) return null;
        const summary = _buildSummary(task, slicedPlan);
        return { taskId: task.id, task, slicedPlan, summary };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[resumeEngine] findResumable error:', err.message);
    return [];
  }
}

// ── public: buildResumePayload ───────────────────────────────
// Returns a controller-ready payload object for a specific taskId.
function buildResumePayload(taskId) {
  if (!taskStore) return { ok: false, reason: 'taskStore unavailable' };
  if (!taskId)    return { ok: false, reason: 'taskId required' };

  try {
    const task = taskStore.get ? taskStore.get(taskId) : null;
    if (!task)              return { ok: false, reason: `task "${taskId}" not found` };
    if (!_isEligible(task)) return { ok: false, reason: `task "${taskId}" is not resumable (status: ${task.status})` };

    const slicedPlan = _slicePlan(task);
    if (!slicedPlan) return { ok: false, reason: `task "${taskId}" has no resumable plan` };

    const summary = _buildSummary(task, slicedPlan);

    const payload = {
      taskId,
      label:          task.label || task.goal || taskId,
      isResume:       true,
      resumeCount:    (task.resumeCount || 0) + 1,
      resumePhaseIndex: slicedPlan.resumePhaseIndex || 0,
      resumeStepIndex:  slicedPlan.resumeStepIndex  || 0,
      // Merge sliced plan into payload
      ...(slicedPlan.phases ? { phases: slicedPlan.phases } : {}),
      ...(slicedPlan.steps  ? { steps:  slicedPlan.steps  } : {}),
      // Restore saved context variables
      context: {
        vars:      { ...(task.contextVars || task.context?.vars || {}) },
        processes: {},
        cwd:       task.context?.cwd || process.cwd(),
        task:      null,
        lastResult: null,
      },
      meta: task.meta || {},
    };

    return { ok: true, payload, summary };
  } catch (err) {
    console.error('[resumeEngine] buildResumePayload error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── public: markResumed ──────────────────────────────────────
// Updates the task record to reflect the new resume attempt.
function markResumed(taskId) {
  if (!taskStore || !taskId) return;
  try {
    const task = taskStore.get ? taskStore.get(taskId) : null;
    if (!task) return;
    if (taskStore.update) {
      taskStore.update(taskId, {
        status:      'running',
        resumeCount: (task.resumeCount || 0) + 1,
        resumedAt:   Date.now(),
        updatedAt:   Date.now(),
      });
    }
  } catch (err) {
    console.error('[resumeEngine] markResumed error:', err.message);
  }
}

module.exports = {
  findResumable,
  buildResumePayload,
  shouldAutoResume,
  markResumed,
  // Exposed for testing
  _isEligible,
  _slicePlan,
  _buildSummary,
};