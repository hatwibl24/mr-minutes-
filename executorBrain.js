'use strict';

// ============================================================
// MR. MINUTES — ExecutorBrain v4
//
// Layer 5 of the brain stack.
//
// Job:
//   Bridge between planner output and executer.js runtime.
//
// Upgrades:
//   - target app pinning
//   - pre-step focus guards for input-sensitive actions
//   - stronger replan context
//   - safer retries/replans that preserve app/task continuity
//   - payload sanitization for type/focus actions
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const executer = require('./executer');
const modes = require('./modes');
const reporter = require('./reporter');

let vision = null;
try {
  vision = require('./vision');
} catch (err) {
  console.warn('[executorBrain] vision not available:', err.message);
}

const RECOVERY_POLICY = {
  runcommand: 'retry',
  writefile: 'retry',
  createfile: 'retry',
  createfolder: 'skip',
  ensureapp: 'retry',
  launchapp: 'retry',
  openbrowser: 'retry',
  openurl: 'retry',
  openproject: 'retry',
  openeditor: 'retry',
  openterminal: 'retry',
  focusandtype: 'retry',
  type: 'retry',
  paste: 'retry',
  typesmart: 'retry',
  clearandtype: 'retry',
  presssequence: 'retry',
  key: 'retry',
  waitforserver: 'retry',
  findandclick: 'replan',
  waitandclick: 'replan',
  waitfor: 'retry',
  waitforany: 'retry',
  pushrepo: 'human',
  deployproject: 'human',
  humanhandoff: 'abort',
  default: 'retry',
};

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;
const REPLAN_MAX_ATTEMPTS = 2;
const SCREEN_INSPECT_TIMEOUT_MS = 12000;

const _handoffAcks = new Set();
const _cancelledTasks = new Set();

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function normalizeActionName(name) {
  return String(name || 'default')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function truncate(text, max = 240) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function safeEmit(emit, payload) {
  try {
    if (typeof emit === 'function') emit(payload);
  } catch (err) {
    console.error('[executorBrain] emit error:', err.message);
  }
}

function uniq(list = []) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function isGenericUiWord(value) {
  const v = String(value || '').trim().toLowerCase();
  return [
    'document',
    'page',
    'window',
    'screen',
    'app',
    'application',
    'file',
    'text',
    'editor',
    'content',
    'area',
    'field',
    'box',
    'input',
  ].includes(v);
}

function sanitizeReadyTexts(input) {
  const arr = Array.isArray(input) ? input : input ? [input] : [];
  return arr
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .filter((x) => x.length >= 2)
    .filter((x) => !isGenericUiWord(x));
}

function sanitizeVisualTarget(target) {
  if (typeof target !== 'string') return null;
  const v = target.trim();
  if (!v) return null;
  if (v.length < 2) return null;
  if (isGenericUiWord(v)) return null;
  return v;
}

function sanitizeKeySequence(keys) {
  if (Array.isArray(keys)) {
    return keys.map((k) => String(k || '').trim()).filter(Boolean);
  }
  if (typeof keys === 'string') {
    const one = keys.trim();
    return one ? [one] : [];
  }
  return [];
}

function sanitizeStep(step, context) {
  if (!step || typeof step !== 'object') return step;

  const s = { ...step };
  const action = normalizeActionName(s.action);

  if (action === 'focusandtype') {
    s.target = sanitizeVisualTarget(s.target);
    s.readyTexts = sanitizeReadyTexts(s.readyTexts);
    if (!s.target) {
      delete s.target;
      s.waitForTarget = false;
    }
    if (!s.app && context?.vars?.pinnedApp) {
      s.app = context.vars.pinnedApp;
    }
    if (s.text == null && typeof s.value === 'string') {
      s.text = s.value;
    }
  }

  if (['type', 'paste', 'typesmart', 'clearandtype'].includes(action)) {
    if (s.text == null && typeof s.value === 'string') s.text = s.value;
    if (s.value == null && typeof s.text === 'string') s.value = s.text;
    if (!s.app && context?.vars?.pinnedApp) {
      s.app = context.vars.pinnedApp;
    }
  }

  if (action === 'presssequence') {
    s.keys = sanitizeKeySequence(s.keys || s.sequence || s.key);
    if (!s.keys.length && s.key) {
      s.keys = [String(s.key).trim()].filter(Boolean);
    }
  }

  if (action === 'waitforany') {
    s.texts = sanitizeReadyTexts(s.texts || s.targets || s.readyTexts);
  }

  if (action === 'waitfor') {
    const safeTarget = sanitizeVisualTarget(s.target || s.text);
    if (safeTarget) {
      s.target = safeTarget;
      s.text = safeTarget;
    } else if (isGenericUiWord(s.target || s.text)) {
      delete s.target;
      delete s.text;
    }
  }

  return s;
}

function inferFailedStep(phaseResult, phase, phaseIndexHint = null) {
  if (phaseResult?.failedStep && typeof phaseResult.failedStep === 'object') {
    return phaseResult.failedStep;
  }

  if (Number.isInteger(phaseResult?.failedStep)) {
    const idx = phaseResult.failedStep - 1;
    if (idx >= 0 && idx < (phase?.steps?.length || 0)) {
      return phase.steps[idx];
    }
  }

  if (Number.isInteger(phaseResult?.stepIndex)) {
    const idx = phaseResult.stepIndex;
    if (idx >= 0 && idx < (phase?.steps?.length || 0)) {
      return phase.steps[idx];
    }
  }

  if (Number.isInteger(phaseIndexHint)) {
    const idx = phaseIndexHint;
    if (idx >= 0 && idx < (phase?.steps?.length || 0)) {
      return phase.steps[idx];
    }
  }

  return null;
}

function extractRetryDelay(text) {
  const m1 = String(text || '').match(/"retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Number(m1[1]) * 1000;
  const m2 = String(text || '').match(/Please retry in\s+([\d.]+)s/i);
  if (m2) return Math.ceil(Number(m2[1]) * 1000);
  return 30000;
}

function isVisionAvailable() {
  return !!(vision && typeof vision.describeScreen === 'function');
}

function actionUsesKeyboard(step) {
  const a = normalizeActionName(step?.action);
  return [
    'focusandtype',
    'type',
    'paste',
    'typesmart',
    'clearandtype',
    'presssequence',
    'key',
  ].includes(a);
}

function actionLikelyChangesForeground(step) {
  const a = normalizeActionName(step?.action);
  return [
    'ensureapp',
    'launchapp',
    'openbrowser',
    'openeditor',
    'openterminal',
    'openproject',
    'openurl',
  ].includes(a);
}

function inferAppFromStep(step, context) {
  if (step?.app) return step.app;
  const action = normalizeActionName(step?.action);

  if (action === 'openbrowser') return step.app || context?.vars?.browserApp || null;
  if (action === 'openeditor') return step.app || context?.vars?.editorApp || null;
  if (action === 'openterminal') return step.app || context?.vars?.terminalApp || null;
  if (action === 'openurl') return context?.vars?.browserApp || context?.vars?.pinnedApp || null;

  return null;
}

function inferPinnedAppFromPlan(plan) {
  const apps = uniq([
    ...(Array.isArray(plan?.context?.apps) ? plan.context.apps : []),
    plan?.context?.vars?.targetApp,
    plan?.context?.vars?.activeApp,
    plan?.context?.vars?.browserApp,
  ]);

  if (apps.length === 1) return apps[0];

  const firstPhaseSteps = Array.isArray(plan?.phases) ? plan.phases.flatMap((p) => p.steps || []) : [];
  for (const step of firstPhaseSteps) {
    const app = step?.app;
    if (app) return app;
  }

  return apps[0] || null;
}

function shouldRefocusBeforeStep(step, context) {
  if (!step) return false;
  if (step.skipFocusGuard) return false;
  if (!actionUsesKeyboard(step)) return false;
  return !!(step.app || context?.vars?.pinnedApp || context?.vars?.activeApp);
}

function buildFocusGuardStep(step, context) {
  const app =
    step?.app ||
    context?.vars?.pinnedApp ||
    context?.vars?.activeApp ||
    null;

  if (!app) return null;

  return sanitizeStep({
    action: 'ensureapp',
    app,
    readyTexts: step.readyTexts || null,
    settleMs: 350,
    pauseAfter: 250,
    animHint: 'pointing',
    _focusGuard: true,
  }, context);
}

async function inspectScreenForRecovery({ taskId, phaseName, failedStep, error, context }) {
  if (!isVisionAvailable()) return null;

  const localTargets = [
    failedStep?.target,
    failedStep?.text,
    failedStep?.app,
    context?.vars?.pinnedApp,
    context?.vars?.activeApp,
    'Error',
    'Retry',
    'Try again',
    'Continue',
    'Allow',
    'Open',
    'Install',
    'Permission denied',
    'Not found',
  ].filter(Boolean).slice(0, 10);

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('screen inspection timeout')), SCREEN_INSPECT_TIMEOUT_MS)
    );

    const describePromise = vision.describeScreen({
      goal: `Recover from a failed desktop automation step in phase "${phaseName}" while staying inside the correct target app.`,
      appHint: context?.vars?.pinnedApp || failedStep?.app || context?.vars?.activeApp || null,
      phaseHint: phaseName || null,
      localTargets,
      temperature: 0.2,
      maxOutputTokens: 1000,
      localFirst: true,
      modelForBroadView: true,
      modelOnLocalFailure: true,
    });

    const result = await Promise.race([describePromise, timeoutPromise]);
    if (!result?.ok) return null;

    return result;
  } catch (err) {
    console.error('[executorBrain] inspectScreenForRecovery failed:', err.message);
    return null;
  }
}

async function replanStep(failedStep, error, context, recoveryVision = null) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'qwen/qwen3-32b';
  if (!apiKey) return null;

  const mode = modes.getActiveMode();
  const visionText = recoveryVision?.ok
    ? JSON.stringify({
        summary: recoveryVision.summary || recoveryVision.result?.summary || null,
        nextBestAction: recoveryVision.nextBestAction || recoveryVision.result?.nextBestAction || null,
        visibleText: Array.isArray(recoveryVision.visibleText) ? recoveryVision.visibleText : (recoveryVision.result?.visibleText || []),
        errors: Array.isArray(recoveryVision.errors) ? recoveryVision.errors : (recoveryVision.result?.errors || []),
        blockers: Array.isArray(recoveryVision.blockers) ? recoveryVision.blockers : (recoveryVision.result?.blockers || []),
        confidence: Number.isFinite(recoveryVision.confidence) ? recoveryVision.confidence : (recoveryVision.result?.confidence ?? null),
      }, null, 2)
    : 'null';

  const prompt = `You are the recovery planner for Mr. Minutes, a desktop AI agent on macOS.

A step in a running task just failed. Generate 1-5 alternative steps to achieve the same sub-goal.

Failed step:
${JSON.stringify(failedStep || null, null, 2)}

Error:
${String(error || 'Unknown error')}

Current context vars:
${JSON.stringify(context?.vars || {}, null, 2)}

Pinned target app:
${JSON.stringify(context?.vars?.pinnedApp || context?.vars?.activeApp || null)}

Current phase:
${JSON.stringify(context?.vars?.currentPhase || null)}

Active mode:
${mode.name}

Mode personality:
${mode.plannerPersonality}

Visible screen recovery context:
${visionText}

The replacement steps must:
1. Achieve the same outcome as the failed step
2. Use a different approach or tool
3. Use ONLY valid Mr. Minutes action names
4. Stay inside the pinned target app unless switching apps is absolutely necessary
5. Avoid human help unless absolutely necessary
6. Include animHint and pauseAfter on every step
7. Prefer keyboard and app-focus alternatives for OCR misses
8. If the screen clearly shows a blocker, address that blocker first

Return ONLY a JSON array of step objects.
No explanation.
No markdown fences.`;

  try {
    const res = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 1024,
          reasoning_format: 'hidden',
          reasoning_effort: 'default',
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) {
        const delay = extractRetryDelay(errText);
        console.warn(`[executorBrain] Replan rate limited. Cooldown ${delay}ms`);
      }
      return null;
    }

    const data = await res.json();
    const rawText = String(data?.choices?.[0]?.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();

    const arrMatch = rawText.match(/\[[\s\S]*\]/);
    if (!arrMatch) return null;

    const steps = JSON.parse(arrMatch[0]);
    if (!Array.isArray(steps) || steps.length === 0) return null;

    const normalized = steps.map((step) => {
      const s = sanitizeStep({ ...step }, context);
      if (!s.animHint) s.animHint = actionUsesKeyboard(s) ? 'tap' : 'pointing';
      if (s.pauseAfter === undefined) s.pauseAfter = actionUsesKeyboard(s) ? 300 : 600;
      if (shouldRefocusBeforeStep(s, context) && !s.app && context?.vars?.pinnedApp) {
        s.app = context.vars.pinnedApp;
      }
      return s;
    });

    console.log(`[executorBrain] Replan injected ${normalized.length} alternative steps`);
    return normalized;
  } catch (err) {
    console.error('[executorBrain] Replan failed:', err.message);
    return null;
  }
}

async function performHumanHandoff(step, context, emit) {
  const message = reporter.handoffPrompt(step, context);
  console.log('[executorBrain] Human handoff:', message);

  safeEmit(emit, {
    type: 'human_handoff',
    message,
    waitFor: step?.waitFor || null,
    taskId: context?.taskId || null,
  });

  const taskId = context.taskId;
  const timeout = step?.timeout || 300_000;
  const start = Date.now();

  while (!_handoffAcks.has(taskId)) {
    if (Date.now() - start > timeout) {
      return { ok: false, error: 'Human handoff timed out.' };
    }
    if (isCancelled(taskId)) {
      return { ok: false, error: 'Task was cancelled during human handoff.' };
    }
    await sleep(500);
  }

  _handoffAcks.delete(taskId);
  console.log('[executorBrain] Handoff acknowledged — continuing.');
  return { ok: true };
}

function acknowledgeHandoff(taskId) {
  if (!taskId) return { ok: false, error: 'No taskId provided' };
  _handoffAcks.add(taskId);
  console.log(`[executorBrain] Handoff acknowledged for task ${taskId}`);
  return { ok: true };
}

function cancelTask(taskId) {
  if (!taskId) return { ok: false, error: 'No taskId' };
  _cancelledTasks.add(taskId);
  try {
    executer.cancelTask(taskId);
  } catch (err) {
    console.error('[executorBrain] executer.cancelTask error:', err.message);
  }
  console.log(`[executorBrain] Cancellation requested for task ${taskId}`);
  return { ok: true };
}

function isCancelled(taskId) {
  return !!taskId && _cancelledTasks.has(taskId);
}

function decoratePhaseSteps(steps = [], context) {
  const out = [];

  for (const rawStep of steps) {
    const step = sanitizeStep({ ...rawStep }, context);

    const inferredApp = inferAppFromStep(step, context);
    if (inferredApp) {
      context.vars.activeApp = inferredApp;
      if (!context.vars.pinnedApp) {
        context.vars.pinnedApp = inferredApp;
      }
    }

    if (actionLikelyChangesForeground(step) && step.app) {
      context.vars.activeApp = step.app;
      if (!context.vars.pinnedApp) {
        context.vars.pinnedApp = step.app;
      }
    }

    if (shouldRefocusBeforeStep(step, context)) {
      const guard = buildFocusGuardStep(step, context);
      if (guard) out.push(guard);
    }

    out.push(step);
  }

  return out;
}

async function runPhaseOnce(phasePayload, emit, taskId, phaseName) {
  try {
    const result = await executer.run(phasePayload, (progress) => {
      const progressType = String(progress?.type || '').trim().toLowerCase();

      if (progressType === 'step' && progress?.status === 'started' && progress?.step) {
        const stepApp = progress.step?.app || inferAppFromStep(progress.step, phasePayload?.context);
        if (stepApp) {
          phasePayload.context.vars.activeApp = stepApp;
          if (!phasePayload.context.vars.pinnedApp) {
            phasePayload.context.vars.pinnedApp = stepApp;
          }
        }

        const startComment = reporter.commentOnEvent({
          type: 'stepstarted',
          step: progress.step,
          phaseName,
          taskId,
        });
        if (startComment) safeEmit(emit, { type: 'speech', text: startComment, taskId });
      }

      if (progressType === 'step' && progress?.status === 'succeeded' && progress?.step) {
        const stepApp = progress.step?.app || inferAppFromStep(progress.step, phasePayload?.context);
        if (stepApp) {
          phasePayload.context.vars.activeApp = stepApp;
          if (!phasePayload.context.vars.pinnedApp) {
            phasePayload.context.vars.pinnedApp = stepApp;
          }
        }

        const doneComment = reporter.commentOnEvent({
          type: 'stepsucceeded',
          step: progress.step,
          phaseName,
          taskId,
        });
        if (doneComment) safeEmit(emit, { type: 'speech', text: doneComment, taskId });
      }

      safeEmit(emit, { ...progress, taskId });
    });

    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function runPlan(plan, emitFn) {
  const emit = typeof emitFn === 'function' ? emitFn : () => {};

  if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
    return { ok: false, error: 'Invalid plan: no phases.' };
  }

  const taskId = plan.taskId;
  const label = plan.label || 'Task';
  const pinnedApp = inferPinnedAppFromPlan(plan);

  const context = {
    taskId,
    vars: {
      ...(plan.context?.vars || {}),
      activeApp: plan.context?.vars?.activeApp || pinnedApp || null,
      pinnedApp: plan.context?.vars?.pinnedApp || pinnedApp || null,
      currentPhase: null,
    },
    lastResult: null,
  };

  let completedSteps = 0;
  let totalSteps = plan.phases.reduce((n, p) => n + (p.steps?.length || 0), 0);
  let replanAttempts = 0;

  console.log(
    `[executorBrain] Starting plan: "${label}" (${plan.phases.length} phases, ${totalSteps} steps)`
  );
  if (context.vars.pinnedApp) {
    console.log(`[executorBrain] pinned app → ${context.vars.pinnedApp}`);
  }

  safeEmit(emit, {
    type: 'taskstarted',
    taskId,
    label,
    totalSteps,
    pinnedApp: context.vars.pinnedApp || null,
  });

  for (let phaseIdx = 0; phaseIdx < plan.phases.length; phaseIdx++) {
    const phase = plan.phases[phaseIdx];

    if (isCancelled(taskId)) {
      return { ok: false, cancelled: true, completedSteps, taskId };
    }

    context.vars.currentPhase = phase.name || `Phase ${phaseIdx + 1}`;

    console.log(`[executorBrain] Phase ${phaseIdx + 1}/${plan.phases.length}: "${phase.name}"`);
    safeEmit(emit, {
      type: 'phasestarted',
      taskId,
      phaseName: phase.name,
      phaseIndex: phaseIdx,
      pinnedApp: context.vars.pinnedApp || null,
      activeApp: context.vars.activeApp || null,
    });

    const phaseStartComment = reporter.commentOnEvent({
      type: 'phasestarted',
      phaseName: phase.name,
      taskId,
    });
    if (phaseStartComment) {
      safeEmit(emit, { type: 'speech', text: phaseStartComment, taskId });
    }

    const guardedSteps = decoratePhaseSteps(phase.steps || [], context);

    const phasePayload = {
      taskId: `${taskId}-phase${phaseIdx}`,
      label: phase.name,
      steps: guardedSteps,
      context,
    };

    let phaseResult = await runPhaseOnce(phasePayload, emit, taskId, phase.name);

    if (phaseResult?.ok) {
      completedSteps += guardedSteps.length || 0;
    }

    if (!phaseResult.ok && !phaseResult.cancelled) {
      const failedStep = inferFailedStep(phaseResult, { ...phase, steps: guardedSteps }, phaseResult?.failedStep - 1);
      const error = phaseResult.error || 'Unknown error';
      const action = normalizeActionName(failedStep?.action || 'default');
      const policy = RECOVERY_POLICY[action] || RECOVERY_POLICY.default;

      console.log(
        `[executorBrain] Phase "${phase.name}" failed at step "${action}": ${error}`
      );
      console.log(`[executorBrain] Recovery policy: ${policy}`);

      let recoveryVision = null;
      if (isVisionAvailable()) {
        recoveryVision = await inspectScreenForRecovery({
          taskId,
          phaseName: phase.name,
          failedStep,
          error,
          context,
        });

        if (recoveryVision?.ok) {
          safeEmit(emit, {
            type: 'screen_observation',
            taskId,
            phaseName: phase.name,
            observation: recoveryVision,
          });
        }
      }

      safeEmit(emit, {
        type: 'phase_failed',
        taskId,
        phaseName: phase.name,
        failedStep,
        error,
        policy,
        pinnedApp: context.vars.pinnedApp || null,
        activeApp: context.vars.activeApp || null,
        observation: recoveryVision?.ok ? recoveryVision : null,
      });

      const recoveryComment = reporter.recoverySuggestion(failedStep, error, 1);
      if (recoveryComment) {
        safeEmit(emit, { type: 'speech', text: recoveryComment, taskId });
      }

      if (policy === 'retry') {
        let retrySuccess = false;

        for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
          if (isCancelled(taskId)) break;

          const delayMs = RETRY_BASE_DELAY_MS * attempt;
          console.log(`[executorBrain] Retry ${attempt}/${MAX_RETRY_ATTEMPTS} in ${delayMs}ms`);
          await sleep(delayMs);

          const retryComment = reporter.recoverySuggestion(failedStep, error, attempt + 1);
          if (attempt > 1 && retryComment) {
            safeEmit(emit, { type: 'speech', text: retryComment, taskId });
          }

          const retrySteps = decoratePhaseSteps(phase.steps || [], context);
          const retryPayload = {
            ...phasePayload,
            steps: retrySteps,
            context,
          };

          phaseResult = await runPhaseOnce(retryPayload, () => {}, taskId, phase.name);

          if (phaseResult.ok) {
            retrySuccess = true;
            completedSteps += retrySteps.length || 0;
            console.log(`[executorBrain] Retry ${attempt} succeeded`);
            break;
          }
        }

        if (!retrySuccess) {
          return {
            ok: false,
            error,
            completedSteps,
            taskId,
            failedPhase: phase.name,
            failedStep,
            pinnedApp: context.vars.pinnedApp || null,
          };
        }
      } else if (policy === 'replan' && replanAttempts < REPLAN_MAX_ATTEMPTS) {
        replanAttempts++;
        console.log(`[executorBrain] Replanning step (attempt ${replanAttempts})`);
        safeEmit(emit, { type: 'speech', text: 'Trying a different approach.', taskId });

        const alternativeSteps = await replanStep(failedStep, error, context, recoveryVision);

        if (alternativeSteps && alternativeSteps.length > 0) {
          const guardedAltSteps = decoratePhaseSteps(alternativeSteps, context);

          const altPayload = {
            taskId: `${taskId}-replan${replanAttempts}`,
            label: `${phase.name} (alternative)`,
            steps: guardedAltSteps,
            context,
          };

          try {
            const altResult = await executer.run(altPayload, () => {});
            if (!altResult.ok) {
              return {
                ok: false,
                error: altResult.error || 'Replan also failed',
                completedSteps,
                taskId,
                failedPhase: phase.name,
                failedStep,
                pinnedApp: context.vars.pinnedApp || null,
              };
            }

            console.log('[executorBrain] Replan succeeded');
            safeEmit(emit, { type: 'speech', text: 'Alternative approach worked.', taskId });
            completedSteps += guardedAltSteps.length || 0;
          } catch (err) {
            return {
              ok: false,
              error: err.message,
              completedSteps,
              taskId,
              failedPhase: phase.name,
              failedStep,
              pinnedApp: context.vars.pinnedApp || null,
            };
          }
        } else {
          return {
            ok: false,
            error,
            completedSteps,
            taskId,
            failedPhase: phase.name,
            failedStep,
            pinnedApp: context.vars.pinnedApp || null,
          };
        }
      } else if (policy === 'human') {
        const handoffStep = failedStep || {
          action: 'humanhandoff',
          message: reporter.handoffPrompt(failedStep, context),
        };

        const handoffResult = await performHumanHandoff(handoffStep, context, emit);
        if (!handoffResult.ok) {
          return {
            ok: false,
            error: handoffResult.error,
            completedSteps,
            taskId,
            failedPhase: phase.name,
            failedStep,
            pinnedApp: context.vars.pinnedApp || null,
          };
        }

        const resumedSteps = decoratePhaseSteps(phase.steps || [], context);
        const resumedPayload = {
          ...phasePayload,
          steps: resumedSteps,
          context,
        };

        phaseResult = await runPhaseOnce(resumedPayload, () => {}, taskId, phase.name);
        if (!phaseResult.ok) {
          return {
            ok: false,
            error: phaseResult.error || error,
            completedSteps,
            taskId,
            failedPhase: phase.name,
            failedStep,
            pinnedApp: context.vars.pinnedApp || null,
          };
        }

        completedSteps += resumedSteps.length || 0;
      } else if (policy === 'skip') {
        console.log(`[executorBrain] Skipping failed step in "${phase.name}"`);
        safeEmit(emit, {
          type: 'speech',
          text: 'Skipping that step and continuing.',
          taskId,
        });
      } else {
        return {
          ok: false,
          error,
          completedSteps,
          taskId,
          failedPhase: phase.name,
          failedStep,
          pinnedApp: context.vars.pinnedApp || null,
        };
      }
    }

    if (isCancelled(taskId)) {
      return { ok: false, cancelled: true, completedSteps, taskId, pinnedApp: context.vars.pinnedApp || null };
    }

    const phaseComment = reporter.commentOnEvent({
      type: 'phasecompleted',
      phaseName: phase.name,
      taskId,
    });
    if (phaseComment) {
      safeEmit(emit, { type: 'speech', text: phaseComment, taskId });
    }

    safeEmit(emit, {
      type: 'phasecompleted',
      taskId,
      phaseName: phase.name,
      phaseIndex: phaseIdx,
      pinnedApp: context.vars.pinnedApp || null,
      activeApp: context.vars.activeApp || null,
    });
  }

  const result = {
    ok: true,
    completedSteps,
    stepsRun: completedSteps,
    taskId,
    contextVars: { ...context.vars },
  };

  safeEmit(emit, { type: 'tasksucceeded', taskId, label, result });
  return result;
}

module.exports = {
  runPlan,
  cancelTask,
  acknowledgeHandoff,
  isVisionAvailable,
};