'use strict';

// ============================================================
// MR. MINUTES — Brain v9
//
// Thin orchestrator.
//
// Fixes:
// - Injects active task context into understander
// - Prevents active-task follow-ups from falling into chat
// - Uses safer planner fallback when a task is clearly intended
// - Keeps backward-compatible action shape for main.js / controller
// - Hardens continuation handling for short fragments like
//   "save it as ai", "under downloads", "in word"
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const understander = require('./understander');
const planner = require('./planner');
const executorBrain = require('./executorBrain');
const reporter = require('./reporter');
const modes = require('./modes');
const controller = require('./controller');
let worldModel = null;
try { worldModel = require('./worldModel'); } catch { /* optional */ }

function action(type, reply, animation, extras = {}) {
  return { type, reply, animation, ...extras };
}

function sanitize(text) {
  return String(text || '')
    .replace(/[*_#`>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── CONVERSATION MEMORY ───────────────────────────────────────
const AI_HISTORY = [];
const MAX_HISTORY = 12;
let _chatCooldown = 0;

function pushHistory(role, text) {
  const clean = sanitize(text);
  if (!clean) return;
  AI_HISTORY.push({ role, text: clean });
  while (AI_HISTORY.length > MAX_HISTORY) AI_HISTORY.shift();
}

function extractRetryDelay(text) {
  const m1 = String(text || '').match(/"retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Number(m1[1]) * 1000;
  const m2 = String(text || '').match(/Please retry in\s+([\d.]+)s/i);
  if (m2) return Math.ceil(Number(m2[1]) * 1000);
  return 30000;
}

function getActiveTaskContext() {
  try {
    const activeGoal = controller?.getActiveGoal?.();
    if (!activeGoal) return null;

    const apps = Array.from(new Set([
      activeGoal.app,
      ...(Array.isArray(activeGoal.apps) ? activeGoal.apps : []),
      ...(Array.isArray(activeGoal.plan?.context?.apps) ? activeGoal.plan.context.apps : []),
      ...(Array.isArray(activeGoal.context?.apps) ? activeGoal.context.apps : []),
    ].filter(Boolean)));

    return {
      taskId: activeGoal.taskId || null,
      label: sanitize(activeGoal.label || activeGoal.goal || ''),
      goalText: sanitize(activeGoal.goal || activeGoal.label || ''),
      phase: sanitize(activeGoal.phase || activeGoal.phaseName || ''),
      apps,
      raw: activeGoal,
    };
  } catch (err) {
    console.warn('[brain] getActiveTaskContext failed:', err.message);
    return null;
  }
}

function isTaskIntent(intent) {
  return !!intent && (
    intent.category === 'SIMPLE_TASK' ||
    intent.category === 'COMPLEX_TASK'
  );
}

function isWeakConversationIntent(intent) {
  if (!intent) return false;
  return intent.category === 'CONVERSATION' && Number(intent.confidence || 0) < 0.8;
}

function looksLikeContinuationText(raw) {
  const cmd = String(raw || '').toLowerCase().trim();
  if (!cmd) return false;

  const veryShort = cmd.split(/\s+/).filter(Boolean).length <= 6;

  return (
    /^(then\s+)?(now\s+)?(and\s+)?(continue|resume|go on|keep going|finish it|complete it|save it|send it|write it|put it|type it|name it|call it|title it|open it)\b/i.test(cmd) ||
    /\b(it|that|this|them|there|here|same|again|the file|the app|the document|the note)\b/i.test(cmd) ||
    /\b(save it as|name it|call it|title it|under|into|to|in word|in excel|in powerpoint|in notes|under downloads)\b/i.test(cmd) ||
    (veryShort && /^(ai|essay|document|word|excel|powerpoint|notes|downloads|desktop|folder|file)\b/i.test(cmd))
  );
}

function shouldSuppressConversationFallback(raw, intent, activeTaskContext) {
  if (!activeTaskContext) return false;
  if (intent?.continuationOf) return true;
  if (looksLikeContinuationText(raw)) return true;
  if (isWeakConversationIntent(intent)) return true;
  return false;
}

function forceIntentIntoActiveTask(intent, raw, activeTaskContext) {
  const apps = Array.from(new Set([
    ...(Array.isArray(intent?.apps) ? intent.apps : []),
    ...(Array.isArray(activeTaskContext?.apps) ? activeTaskContext.apps : []),
  ].filter(Boolean)));

  const category = apps.length > 1 ? 'COMPLEX_TASK' : 'SIMPLE_TASK';

  return {
    ...(intent || {}),
    category,
    confidence: Math.max(0.75, Number(intent?.confidence || 0)),
    goal: sanitize(
      intent?.goal ||
      `${activeTaskContext?.label || activeTaskContext?.goalText || 'Continue active task'} — ${raw}`
    ),
    apps,
    complexity: category === 'COMPLEX_TASK' ? 'medium' : 'low',
    continuationOf: activeTaskContext?.taskId || null,
    activeTaskContext,
  };
}

// ── GROQ CHAT ─────────────────────────────────────────────────
async function chat(heard) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'qwen/qwen3-32b';

  if (!apiKey) {
    return action(
      'ai_response',
      "I'm offline right now — add my API key to .env.",
      'thinking'
    );
  }

  const now = Date.now();
  if (_chatCooldown > now) {
    const secs = Math.max(1, Math.ceil((_chatCooldown - now) / 1000));
    return action(
      'ai_response',
      `I'm rate limited. Try me again in about ${secs} seconds.`,
      'thinking'
    );
  }

  const mode = modes.getActiveMode();
  const modeCtx = modes.getModeContextForPrompt();
  const historyText = AI_HISTORY.length
    ? AI_HISTORY.map((m) => `${m.role === 'user' ? 'User' : 'Mr. Minutes'}: ${m.text}`).join('\n')
    : '(no prior context)';

  const prompt = [
    'You are Mr. Minutes — a sharp, capable desktop AI assistant.',
    `You are currently in ${mode.name} mode.`,
    modeCtx,
    '',
    'Rules:',
    '- Sound natural, spoken, confident, and direct.',
    '- Never reveal you are an AI or a language model.',
    '- No markdown. Plain spoken sentences only.',
    '- Finish every thought completely — no sentence fragments.',
    '- For casual questions, be brief. For factual or technical questions, answer fully.',
    '- Use recent conversation context for follow-up questions.',
    '',
    'Recent conversation:',
    historyText,
    '',
    `User: ${heard}`,
    'Mr. Minutes:',
  ].join('\n');

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 512,
        reasoning_format: 'hidden',
        reasoning_effort: 'none',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) {
        _chatCooldown = Date.now() + extractRetryDelay(errText);
        const secs = Math.max(1, Math.ceil((_chatCooldown - Date.now()) / 1000));
        return action('ai_response', `Rate limited. Give me ${secs}s.`, 'thinking');
      }

      console.error('[brain] Groq chat error:', res.status, errText.slice(0, 300));
      return action('ai_response', 'My thoughts got tangled. Try again.', 'thinking');
    }

    const data = await res.json();
    const reply = sanitize(
      String(data.choices?.[0]?.message?.content || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
    );

    if (!reply) {
      return action('ai_response', 'I drew a blank on that one.', 'thinking');
    }

    pushHistory('user', heard);
    pushHistory('assistant', reply);

    return action('ai_response', reply, 'thinking');
  } catch (err) {
    console.error('[brain] chat error:', err.message);
    return action('ai_response', 'Something went wrong on my end.', 'thinking');
  }
}

// ── PLAN PAYLOAD BUILDER ──────────────────────────────────────
function buildComputerUseResult(plan) {
  const briefingText = reporter.briefing(plan);

  let visionAvailable = false;
  try {
    visionAvailable = !!executorBrain?.isVisionAvailable?.();
  } catch {
    visionAvailable = false;
  }

  return action('computer_use', briefingText, null, {
    domain: 'PLAN_LEVEL',
    label: plan.label,
    taskId: plan.taskId,
    plan,
    phases: plan.phases,
    steps: plan.steps,
    context: plan.context,
    estimates: plan.estimates || null,
    briefing: briefingText,
    visionAvailable,
  });
}

// ── MAIN ENTRY ────────────────────────────────────────────────
async function processCommand(heard) {
  const raw = String(heard || '').trim();

  if (!raw) {
    return action('ai_response', "I didn't catch that — say it again?", 'thinking');
  }

  if (raw === '__accessibility_needed__') {
    return action(
      'info',
      'Hey — I need one permission to work properly. I just opened System Settings for you. Go to Accessibility, find me in the list, and switch me on.',
      'pointing'
    );
  }

  console.log('🧠 Brain v9 ←', raw);

  const activeTaskContext = getActiveTaskContext();
  if (activeTaskContext) {
    console.log('[brain] active task →', activeTaskContext.label || activeTaskContext.taskId);
  }

  let intent;
  try {
    intent = await understander.understand(raw, { activeTaskContext });
  } catch (err) {
    console.error('[brain] Understander error:', err.message);

    if (activeTaskContext && looksLikeContinuationText(raw)) {
      return action(
        'ai_response',
        "I still have the current task in mind, but my understanding layer hit an issue. Say that again and I'll keep the task moving.",
        'thinking',
        { activeTaskContext }
      );
    }

    return chat(raw);
  }

  console.log(
    `[brain] Intent: category=${intent.category} complexity=${intent.complexity} ` +
    `confidence=${Math.round((intent.confidence || 0) * 100)}%`
  );

  if (intent.fastPath) {
    const fpType = intent.fastPath.type;
    console.log('[brain] Fast path →', fpType);

    // simple_task fast-path: classification is done locally, but still needs the planner
    // to generate the actual execution steps — don't return early
    if (fpType === 'simple_task' || fpType === 'complex_task') {
      // intent already has category=SIMPLE_TASK from understander, just continue
    } else {
      return intent.fastPath;
    }
  }

  if (intent.category === 'MODE_SWITCH') {
    return chat(raw);
  }

  const continuationGuard = shouldSuppressConversationFallback(raw, intent, activeTaskContext);

  if (intent.category === 'CONVERSATION' && !continuationGuard) {
    return chat(raw);
  }

  if (intent.category === 'CONVERSATION' && continuationGuard) {
    console.log('[brain] suppressing conversation fallback due to active task');
    intent = forceIntentIntoActiveTask(intent, raw, activeTaskContext);
  }

  let plan;
  try {
    const world = worldModel ? worldModel.snapshot() : null;
    const worldContext = world ? {
      frontmostApp: world.environment?.apps?.frontmost || null,
      userAttention: world.user?.attention || null,
      visibleTexts: world.environment?.ui?.visibleTexts || [],
    } : null;

    plan = await planner.plan({
      ...intent,
      activeTaskContext,
      worldContext,
      _activeTaskRunning: !!activeTaskContext,
    });
  } catch (err) {
    if (err.message === 'SKIP_PLAN_ACTIVE_TASK') {
      console.log('[brain] skipped replan — active task running');
      return action('ai_response', 'On it — still working on the current task.', 'thinking');
    }
    console.error('[brain] Planner error:', err.message);

    if (isTaskIntent(intent) || continuationGuard) {
      return action(
        'ai_response',
        "I understood that as a task, but my planner couldn't shape the next steps right now. Try again and I'll keep the task context.",
        'thinking',
        { activeTaskContext }
      );
    }

    return action(
      'ai_response',
      "I can't plan that right now — my AI brain is having trouble connecting. Give it another try in a moment.",
      'thinking'
    );
  }

  if (!plan) {
    if (isTaskIntent(intent) || continuationGuard) {
      console.log('[brain] planner returned null, refusing chat fallback for active task');
      return action(
        'ai_response',
        "I recognized that as part of the task, but I didn't get a usable plan back. Say it once more and I'll continue from the active task.",
        'thinking',
        { activeTaskContext, suppressedChatFallback: true }
      );
    }

    return chat(raw);
  }

  const result = buildComputerUseResult(plan);

  console.log(
    `[brain] Returning computer_use plan "${plan.label}" ` +
    `(${plan.estimates?.steps ?? 0} steps, ${plan.estimates?.phases ?? 0} phases)`
  );

  if (intent.suggestedMode) {
    const modeAnnounce = reporter.modeAnnouncement(intent.suggestedMode);
    result._suggestedModeAnnouncement = modeAnnounce;
    result._suggestedModeId = intent.suggestedMode.id;
  }

  if (activeTaskContext) {
    result._continuedFromTaskId = activeTaskContext.taskId || null;
  }

  return result;
}

// ── EXECUTOR CONTROLS ─────────────────────────────────────────
function cancelTask(taskId) {
  return executorBrain.cancelTask(taskId);
}

function acknowledgeHandoff(taskId) {
  return executorBrain.acknowledgeHandoff(taskId);
}

module.exports = {
  processCommand,
  cancelTask,
  acknowledgeHandoff,
};