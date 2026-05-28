'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const hands = require('./Hands');
const bodyOS = require('./bodyOS');
const worldModel = require('./worldModel');

const CONFIDENCE_PASS = 0.75;
const CONFIDENCE_WARN = 0.45;

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function emptyDelta() {
  return { newFiles: [], removedFiles: [], newText: [], goneText: [] };
}

function resolveTemplateText(value, context = {}) {
  return String(value || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (context?.vars?.[key] !== undefined) return String(context.vars[key]);
    return `{{${key}}}`;
  });
}

function normalizePath(inputPath, context = {}) {
  const raw = resolveTemplateText(inputPath || '', context).trim();
  if (!raw) return raw;
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  if (raw === '~') return os.homedir();
  return path.resolve(raw);
}

async function runExplicitVerify(verifyBlock, context) {
  if (!verifyBlock) return null;
  const executer = require('./executer');
  const checks = Array.isArray(verifyBlock) ? verifyBlock : [verifyBlock];

  for (const raw of checks) {
    const step = typeof raw === 'string'
      ? { action: 'wait_for', target: raw, timeout: 8000 }
      : raw;
    const r = await executer.runStep(step, context);
    if (!r.ok) {
      return {
        ok: false,
        confidence: 0.1,
        evidence: [],
        warnings: [`Explicit verify failed: ${r.error}`],
        worldDelta: emptyDelta(),
        action: 'retry',
      };
    }
  }

  return {
    ok: true,
    confidence: 0.95,
    evidence: ['All explicit verify checks passed'],
    warnings: [],
    worldDelta: emptyDelta(),
    action: 'continue',
  };
}

async function verifyFilePhase(phase, context) {
  const fileSteps = (phase.steps || []).filter((s) => ['write_file', 'create_file', 'create_folder', 'append_file', 'path_exists'].includes(norm(s.action || s.verb || '')));
  if (!fileSteps.length) return null;

  const evidence = [];
  const warnings = [];
  const newFiles = [];
  let passed = 0;

  for (const s of fileSteps) {
    const raw = s.path || s.file || s.target || '';
    if (!raw) continue;
    const resolved = normalizePath(raw, context);
    if (fs.existsSync(resolved)) {
      passed += 1;
      evidence.push(`exists: ${resolved}`);
      newFiles.push(resolved);
    } else {
      warnings.push(`missing: ${resolved}`);
    }
  }

  const ratio = fileSteps.length ? passed / fileSteps.length : 1;
  const confidence = Math.min(0.95, 0.4 + ratio * 0.55);
  return {
    ok: ratio === 1,
    confidence,
    evidence,
    warnings,
    worldDelta: { newFiles, removedFiles: [], newText: [], goneText: [] },
    action: ratio === 1 ? 'continue' : ratio >= 0.5 ? 'warn' : 'retry',
  };
}

async function verifyCommandPhase(_phase, context) {
  const out = `${context?.vars?.lastStdout || ''} ${context?.vars?.lastStderr || ''}`.toLowerCase();
  if (!out.trim()) return null;

  const SUCCESS = ['successfully', 'success', 'done', 'complete', 'finished', 'created', 'installed', 'built', 'deployed', 'started', 'ready', 'listening', 'compiled', 'running'];
  const FAILURE = ['error:', 'fatal:', 'failed', 'exception', 'traceback', 'enoent', 'permission denied', 'command not found', 'segfault', 'aborted', 'killed'];

  const hasSuccess = SUCCESS.some((s) => out.includes(s));
  const hasFailure = FAILURE.some((s) => out.includes(s));
  const confidence = hasSuccess && !hasFailure ? 0.82 : hasFailure ? 0.12 : 0.48;

  return {
    ok: !hasFailure,
    confidence,
    evidence: hasSuccess ? ['stdout contains success signal'] : [],
    warnings: hasFailure ? ['stdout contains failure signal'] : confidence < CONFIDENCE_WARN ? ['no clear signal in stdout'] : [],
    worldDelta: emptyDelta(),
    action: hasFailure ? 'retry' : confidence >= CONFIDENCE_PASS ? 'continue' : 'warn',
  };
}

async function verifyServerPhase(_phase, context) {
  const url = context?.vars?.lastUrl || context?.vars?.devServerUrl || context?.vars?.localUrl || null;
  if (!url) return null;
  try {
    const r = await bodyOS.waitForServer({ url, timeout: 8000, interval: 500 }, context);
    return {
      ok: r.ok,
      confidence: r.ok ? 0.93 : 0.08,
      evidence: r.ok ? [`server up: ${url}`] : [],
      warnings: r.ok ? [] : [`server not responding: ${url}`],
      worldDelta: emptyDelta(),
      action: r.ok ? 'continue' : 'retry',
    };
  } catch (e) {
    return {
      ok: false,
      confidence: 0.08,
      evidence: [],
      warnings: [e.message],
      worldDelta: emptyDelta(),
      action: 'warn',
    };
  }
}

async function verifyUIPhase(phase, context) {
  const expectations = [];
  for (const step of phase.steps || []) {
    if (step.expectedText) expectations.push(resolveTemplateText(step.expectedText, context));
    if (step.verifyText) expectations.push(resolveTemplateText(step.verifyText, context));
  }

  const worldSnapshot = worldModel.snapshot();
  const visible = new Set((worldSnapshot?.environment?.ui?.visibleTexts || []).map((t) => String(t)));
  if (!expectations.length && visible.size === 0) return null;

  const evidence = [];
  const warnings = [];
  const newText = [];
  let found = 0;

  for (const text of expectations) {
    if (!text) continue;
    if (visible.has(text)) {
      found += 1;
      evidence.push(`world confirmed: "${text}"`);
      newText.push(text);
      continue;
    }
    const r = await hands.findText(text);
    if (r.ok) {
      found += 1;
      evidence.push(`UI confirmed: "${text}"`);
      newText.push(text);
    } else {
      warnings.push(`UI missing: "${text}"`);
    }
  }

  if (!expectations.length) {
    return {
      ok: true,
      confidence: 0.58,
      evidence: ['UI phase completed; no explicit expectedText fields were provided'],
      warnings: ['UI verification used fallback confidence because no expected text was defined'],
      worldDelta: { newFiles: [], removedFiles: [], newText: Array.from(visible), goneText: [] },
      action: 'warn',
    };
  }

  const ratio = found / expectations.length;
  const confidence = Math.min(0.95, 0.3 + ratio * 0.65);
  return {
    ok: ratio >= 0.5,
    confidence,
    evidence,
    warnings,
    worldDelta: { newFiles: [], removedFiles: [], newText, goneText: [] },
    action: confidence >= CONFIDENCE_PASS ? 'continue' : confidence >= CONFIDENCE_WARN ? 'warn' : 'retry',
  };
}

function detectType(phase) {
  const actions = (phase.steps || []).map((s) => norm(s.action || s.verb || ''));
  if (actions.some((a) => ['write_file', 'create_file', 'create_folder', 'append_file', 'path_exists'].includes(a))) return 'file';
  if (actions.some((a) => ['run_command', 'osascript'].includes(a))) return 'command';
  if (actions.some((a) => ['wait_for_server', 'deploy_project', 'push_repo', 'open_preview'].includes(a))) return 'server';
  if (actions.some((a) => ['find_and_click', 'wait_and_click', 'click', 'find_text', 'focus_and_type'].includes(a))) return 'ui';
  return 'generic';
}

function merge(results) {
  const valid = results.filter(Boolean);
  if (!valid.length) {
    return {
      ok: true,
      confidence: 0.55,
      evidence: [],
      warnings: [],
      worldDelta: emptyDelta(),
      action: 'continue',
    };
  }

  const minConf = Math.min(...valid.map((r) => r.confidence));
  const anyFail = valid.some((r) => !r.ok);
  const evidence = valid.flatMap((r) => r.evidence || []);
  const warnings = valid.flatMap((r) => r.warnings || []);
  const wd = {
    newFiles: valid.flatMap((r) => r.worldDelta?.newFiles || []),
    removedFiles: valid.flatMap((r) => r.worldDelta?.removedFiles || []),
    newText: valid.flatMap((r) => r.worldDelta?.newText || []),
    goneText: valid.flatMap((r) => r.worldDelta?.goneText || []),
  };
  const action = anyFail
    ? (minConf < 0.2 ? 'fail' : 'retry')
    : minConf >= CONFIDENCE_PASS ? 'continue'
    : minConf >= CONFIDENCE_WARN ? 'warn'
    : 'retry';

  return { ok: !anyFail, confidence: minConf, evidence, warnings, worldDelta: wd, action };
}

async function verifyPhase(phase, phaseResult, context) {
  if (!phaseResult?.ok) {
    return {
      ok: false,
      confidence: 0.99,
      evidence: [],
      warnings: [`Executer reported failure: ${phaseResult?.error}`],
      worldDelta: emptyDelta(),
      action: 'retry',
    };
  }

  if (phase.verify) {
    const r = await runExplicitVerify(phase.verify, context);
    if (r) return r;
  }

  const type = detectType(phase);
  const checks = await Promise.all([
    type === 'file' ? verifyFilePhase(phase, context) : null,
    type === 'command' ? verifyCommandPhase(phase, context) : null,
    type === 'server' ? verifyServerPhase(phase, context) : null,
    type === 'ui' ? verifyUIPhase(phase, context) : null,
  ]);

  const valid = checks.filter(Boolean);
  if (!valid.length) {
    return {
      ok: true,
      confidence: 0.55,
      evidence: [`Phase "${phase.name || type}" completed without explicit verification errors`],
      warnings: ['No specific verification was available for this phase type'],
      worldDelta: emptyDelta(),
      action: 'continue',
    };
  }

  return merge(valid);
}

function summarise(verificationLog) {
  if (!Array.isArray(verificationLog) || !verificationLog.length) {
    return { overallConfidence: 0.5, totalPhases: 0, passedPhases: 0, failedPhases: 0 };
  }

  const passed = verificationLog.filter((v) => v.ok).length;
  const avgConf = verificationLog.reduce((s, v) => s + (v.confidence || 0), 0) / verificationLog.length;
  return {
    overallConfidence: Math.round(avgConf * 100) / 100,
    totalPhases: verificationLog.length,
    passedPhases: passed,
    failedPhases: verificationLog.length - passed,
    evidence: verificationLog.flatMap((v) => v.evidence || []),
    warnings: verificationLog.flatMap((v) => v.warnings || []),
  };
}

module.exports = {
  verifyPhase,
  summarise,
  CONFIDENCE_PASS,
  CONFIDENCE_WARN,
};