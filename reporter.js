'use strict';

// ============================================================
// MR. MINUTES — Reporter v1
//
// Layer 4 of the brain stack.
//
// Job: Turn execution events (from executer.js progress callbacks)
//      into natural, contextual, real-time speech for Mr. Minutes.
//
// Also: Generates spoken briefing before a task starts and a
//       spoken summary when it finishes (or fails).
//
// Design principles:
//   - Sound like a smart colleague, not a status bar
//   - Never repeat the same line twice in a session
//   - Keep mid-task speech SHORT (under 10 words)
//   - Briefings can be longer (up to 3 sentences)
//   - Summaries should be honest about failures
//   - Always use context from the plan (app names, goal, etc.)
// ============================================================

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── PHRASE POOLS ──────────────────────────────────────────────
// Used for mid-task filler to avoid robotic repetition.
// Reporter picks randomly from these and tracks recent history
// to avoid saying the same thing twice in a row.

const POOL_THINKING = [
  "Working on it.",
  "On it.",
  "Let me handle this.",
  "Just a moment.",
  "Doing that now.",
  "This one needs a second.",
  "Getting into it.",
];

const POOL_PROGRESS = [
  "Still going.",
  "Making progress.",
  "Getting there.",
  "Almost done with this step.",
  "Moving along.",
  "Chipping away at it.",
];

const POOL_APP_OPENED = [
  app => `${app} is up.`,
  app => `Got ${app} open.`,
  app => `${app} is ready.`,
  app => `${app} is live.`,
];

const POOL_FILE_WRITTEN = [
  file => `${file} is written.`,
  file => `${file} is done.`,
  file => `Created ${file}.`,
  file => `${file} saved.`,
];

const POOL_COMMAND_RUNNING = [
  cmd => `Running ${cmd}.`,
  cmd => `Executing ${cmd}.`,
  cmd => `Firing off ${cmd}.`,
  cmd => `${cmd} is running.`,
];

const POOL_STEP_DONE = [
  "Done with that step.",
  "Step complete.",
  "That's done.",
  "Got that.",
  "Checked.",
  "Done.",
];

const POOL_PHASE_DONE = [
  phase => `${phase} is complete.`,
  phase => `Finished the ${phase} phase.`,
  phase => `${phase} — done.`,
  phase => `Wrapped up ${phase}.`,
];

// ── DEDUPLICATION TRACKER ─────────────────────────────────────
const _recentPhrases = [];
const DEDUPE_WINDOW = 5;

function pickFresh(pool, arg = null) {
  const available = pool.filter(item => {
    const phrase = typeof item === 'function' ? item(arg) : item;
    return !_recentPhrases.includes(phrase);
  });
  const list = available.length > 0 ? available : pool;
  const item = list[Math.floor(Math.random() * list.length)];
  const phrase = typeof item === 'function' ? item(arg) : item;
  _recentPhrases.push(phrase);
  if (_recentPhrases.length > DEDUPE_WINDOW) _recentPhrases.shift();
  return phrase;
}

// ── BRIEF DURATION ESTIMATOR ──────────────────────────────────
function humanDuration(minutes) {
  if (minutes < 1)  return 'under a minute';
  if (minutes === 1) return 'about a minute';
  if (minutes < 5)  return `a few minutes`;
  if (minutes < 15) return `around ${minutes} minutes`;
  return `about ${minutes} minutes`;
}

// ── PRE-TASK BRIEFING ─────────────────────────────────────────
function briefing(plan) {
  if (!plan) return "Working on it.";

  // Use AI-generated briefing if available
  if (plan.briefing) return plan.briefing;

  const { label, estimates } = plan;
  const durationStr = estimates ? humanDuration(estimates.minutes) : 'a moment';
  const handoffs    = estimates?.humanHandoffs || 0;
  const phaseNames  = plan.phases?.map(p => p.name).join(', ') || '';

  let speech = `I'm starting on: ${label}. This should take ${durationStr}.`;

  if (handoffs > 0) {
    speech += ` I'll pause ${handoffs > 1 ? `${handoffs} times` : 'once'} when I need you.`;
  }

  if (phaseNames) {
    speech += ` My plan: ${phaseNames}.`;
  }

  return speech;
}

// ── MID-TASK COMMENTARY ───────────────────────────────────────
// Called by executorBrain for each execution event
function commentOnEvent(event) {
  if (!event) return null;

  const { type, step, phaseName, error, label } = event;

  switch (type) {
    case 'phasestarted':
      return phaseName ? `Starting the ${phaseName} phase.` : pickFresh(POOL_THINKING);

    case 'phasecompleted':
      return phaseName ? pickFresh(POOL_PHASE_DONE, phaseName) : pickFresh(POOL_STEP_DONE);

    case 'stepstarted':
      if (!step) return null;
      {
        const action = step.action;
        if (action === 'runcommand') return pickFresh(POOL_COMMAND_RUNNING, step.command || 'the command');
        if (action === 'ensureapp') return pickFresh(POOL_APP_OPENED, step.app || 'the app');
        if (action === 'openurl') return `Opening ${step.url || 'the page'}.`;
        if (action === 'openbrowser') return null;
        if (action === 'writefile') return `Writing ${shortPath(step.path)}.`;
        if (action === 'createfile') return `Creating ${shortPath(step.path)}.`;
        if (action === 'createfolder') return `Creating ${shortPath(step.path)}.`;
        if (action === 'humanhandoff') return step.message || 'I need you for a second.';
        if (action === 'waitforserver') return 'Waiting for the server to come up.';
        if (action === 'pushrepo') return 'Pushing to git.';
        if (action === 'deployproject') return 'Deploying the project.';
        return null;
      }

    case 'stepsucceeded':
      if (!step) return null;
      {
        const action = step.action;
        if (action === 'runcommand') return pickFresh(POOL_STEP_DONE);
        if (action === 'writefile') return pickFresh(POOL_FILE_WRITTEN, shortPath(step.path));
        if (action === 'createfile') return pickFresh(POOL_FILE_WRITTEN, shortPath(step.path));
        if (action === 'deployproject') return 'Deployment done.';
        if (action === 'pushrepo') return 'Pushed to git.';
        return null;
      }

    case 'stepretry':
      return "That step didn't work. Trying again.";

    case 'stepfailed':
      return error ? `Ran into a problem: ${truncate(error, 60)}.` : 'That step ran into an issue.';

    case 'humanhandoff':
      return event.message || 'Pausing — I need you here.';

    case 'taskstarted':
      return label ? `Starting ${label}.` : pickFresh(POOL_THINKING);

    case 'tasksucceeded':
      return null;

    case 'taskfailed':
      return null;

    default:
      return null;
  }
}

// ── POST-TASK SUMMARY ─────────────────────────────────────────
function summary(result, plan) {
  const label = plan?.label || 'The task';

  if (!result) {
    return `${label} is done.`;
  }

  // Full success
  if (result.ok && !result.cancelled) {
    const stepsRun = result.stepsRun ?? plan?.estimates?.steps ?? '?';
    const templates = [
      `${label} is done. Ran ${stepsRun} steps.`,
      `All finished. ${label} completed in ${stepsRun} steps.`,
      `Done! ${label} went through without issues.`,
      `That's wrapped up. ${label} is complete.`,
    ];
    return templates[Math.floor(Math.random() * templates.length)];
  }

  // Cancelled
  if (result.cancelled) {
    return `Stopped. ${label} was cancelled.`;
  }

  // Partial success
  if (result.completedSteps > 0) {
    return (
      `${label} hit a problem after ${result.completedSteps} steps. ` +
      `${result.error ? `The issue was: ${truncate(result.error, 80)}.` : ''} ` +
      `Let me know if you want to retry or pick up where we left off.`
    ).trim();
  }

  // Full failure
  return (
    `${label} didn't go through. ` +
    (result.error ? `Here's what happened: ${truncate(result.error, 80)}.` : 'Something went wrong.') +
    ` Want me to try a different approach?`
  );
}

// ── RECOVERY SUGGESTION ───────────────────────────────────────
// Called when executorBrain detects a failure and wants a spoken suggestion
function recoverySuggestion(failedStep, error, attempt) {
  const action = failedStep?.action || '';
  const err    = (error || '').toLowerCase();

  if (err.includes('rate limit') || err.includes('429'))
    return "I'm being rate limited. Waiting a moment before retrying.";
  if (err.includes('not found') && action === 'find_and_click')
    return "I couldn't find that on screen. Trying an alternative approach.";
  if (err.includes('timeout'))
    return `That's taking longer than expected. Retry ${attempt}.`;
  if (err.includes('permission') || err.includes('denied'))
    return "I hit a permissions issue. You might need to approve this manually.";
  if (err.includes('network') || err.includes('fetch') || err.includes('econnrefused'))
    return "Network issue. Waiting for connection to come back.";
  if (action === 'run_command')
    return attempt <= 2 ? `The command failed. Adjusting and retrying.` : "That command isn't working. I may need to take a different path.";

  return attempt <= 2 ? "That didn't work. Trying again." : "Still failing. Let me try something different.";
}

// ── HUMAN HANDOFF PROMPT ──────────────────────────────────────
function handoffPrompt(step, context) {
  if (step?.message) return step.message;

  const action = step?.action || '';
  if (action === 'human_handoff') {
    const reason = step?.reason || step?.waitFor || '';
    if (reason.toLowerCase().includes('login') || reason.toLowerCase().includes('auth'))
      return "I need you to log in here. Let me know when you're done.";
    if (reason.toLowerCase().includes('confirm') || reason.toLowerCase().includes('approval'))
      return "I need your confirmation to proceed. Tap in when ready.";
    if (reason.toLowerCase().includes('2fa') || reason.toLowerCase().includes('verification'))
      return "There's a verification step here. Handle that and I'll continue.";
    return "I need your input here. Let me know when ready.";
  }
  return "Your turn — let me know when to continue.";
}

// ── UTILS ─────────────────────────────────────────────────────
function shortPath(p) {
  if (!p) return 'the file';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// ── MODE SWITCH ANNOUNCEMENT ──────────────────────────────────
function modeAnnouncement(newMode) {
  const templates = [
    name => `Switching to ${name} mode. I've adjusted my capabilities.`,
    name => `${name} mode is now active.`,
    name => `I'm now in ${name} mode. Ready to go.`,
  ];
  const fn = templates[Math.floor(Math.random() * templates.length)];
  return fn(newMode.name);
}

module.exports = {
  briefing,
  commentOnEvent,
  summary,
  recoverySuggestion,
  handoffPrompt,
  modeAnnouncement,
};