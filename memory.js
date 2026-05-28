'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.mr-minutes');
const MEMORY_FILE = path.join(STORE_DIR, 'memory.json');

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function readMem() {
  ensureDir();
  try {
    if (!fs.existsSync(MEMORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')) || {};
  } catch (e) {
    console.error('[memory] read error:', e.message);
    return {};
  }
}

function writeMem(data) {
  ensureDir();
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[memory] write error:', e.message);
    return false;
  }
}

function makeId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function uniq(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function collectAppsFromPlan(plan = {}) {
  const apps = [];

  for (const step of plan.steps || []) {
    if (step.app) apps.push(norm(step.app));
  }

  for (const phase of plan.phases || []) {
    for (const step of phase.steps || []) {
      if (step.app) apps.push(norm(step.app));
    }
  }

  return uniq(apps);
}

function collectActionsFromPlan(plan = {}) {
  const actions = [];

  for (const step of plan.steps || []) {
    if (step.action || step.verb) actions.push(norm(step.action || step.verb));
  }

  for (const phase of plan.phases || []) {
    for (const step of phase.steps || []) {
      if (step.action || step.verb) actions.push(norm(step.action || step.verb));
    }
  }

  return uniq(actions);
}

function collectErrors(record = {}, verificationLog = []) {
  const errors = [];

  for (const f of record.failureHistory || []) {
    if (f?.error) errors.push(String(f.error));
  }

  if (record.error) errors.push(String(record.error));

  for (const v of verificationLog || []) {
    for (const w of v?.warnings || []) {
      errors.push(String(w));
    }
  }

  return errors;
}

const EXTRACTORS = [
  {
    match: (record) =>
      collectErrors(record).some((e) => /\.env|env var|environment variable|enoent.*\.env/i.test(e)),
    extract: () => ({
      type: 'env_requirement',
      scope: 'global',
      apps: [],
      trigger: { taskType: 'deploy', actions: ['deployproject', 'runcommand'] },
      lesson: 'Verify the .env file exists and required environment variables are set before deploy or startup tasks.',
      tags: ['deploy', 'env', 'preflight'],
    }),
  },
  {
    match: (record) =>
      collectErrors(record).some((e) => /permission denied|eperm|eacces/i.test(e)),
    extract: (record) => ({
      type: 'preflight_check',
      scope: 'global',
      apps: collectAppsFromPlan(record.plan),
      trigger: { taskType: 'file_operation', actions: ['writefile', 'createfile', 'appendfile'] },
      lesson: 'Check write permissions on the target path before creating or modifying files.',
      tags: ['filesystem', 'permissions'],
    }),
  },
  {
    match: (record) =>
      collectErrors(record).some((e) => /eaddrinuse|port.*in use|address already/i.test(e)),
    extract: () => ({
      type: 'preflight_check',
      scope: 'global',
      apps: ['terminal'],
      trigger: { taskType: 'server_start', actions: ['runcommand', 'waitforserver'] },
      lesson: 'Check whether the intended port is already occupied before starting a local server.',
      tags: ['server', 'port'],
    }),
  },
  {
    match: (record) =>
      collectErrors(record).some((e) => /cannot find module|node_modules|npm install|pnpm install|yarn install/i.test(e)),
    extract: () => ({
      type: 'step_order',
      scope: 'global',
      apps: ['terminal'],
      trigger: { taskType: 'runcommand', actions: ['runcommand'] },
      lesson: 'Install project dependencies before running build, start, or dev commands.',
      tags: ['dependencies', 'terminal'],
    }),
  },
  {
    match: (record) =>
      collectErrors(record).some((e) => /git.*auth|ssh.*refused|remote.*denied|403.*git/i.test(e)),
    extract: () => ({
      type: 'preflight_check',
      scope: 'global',
      apps: ['terminal'],
      trigger: { taskType: 'git', actions: ['pushrepo', 'runcommand'] },
      lesson: 'Verify git authentication and remote access before pushing commits or tags.',
      tags: ['git', 'auth'],
    }),
  },
  {
    match: (record) =>
      collectErrors(record).some((e) => /project.*name|name.*mismatch|vercel.*name/i.test(e)),
    extract: () => ({
      type: 'preflight_check',
      scope: 'app',
      apps: ['vercel'],
      trigger: { taskType: 'deploy', app: 'vercel', actions: ['deployproject', 'setdomain'] },
      lesson: 'Make sure the local project name matches the remote deployment target before deploy actions.',
      tags: ['deploy', 'vercel'],
    }),
  },
  {
    match: (record) =>
      collectErrors(record).some((e) => /not found on screen|ocr|findtext|findandclick|ui missing/i.test(e)),
    extract: (record) => {
      const apps = collectAppsFromPlan(record.plan);
      const app = apps[0] || 'ui';

      return {
        type: 'app_quirk',
        scope: app === 'ui' ? 'global' : 'app',
        apps: app === 'ui' ? [] : [app],
        trigger: { app, actions: ['findandclick', 'waitfor', 'waitandclick'] },
        lesson: 'When a UI target is unstable or missing, add an explicit wait or readiness check before trying to click it.',
        tags: ['ocr', 'ui', 'timing'],
      };
    },
  },
  {
    match: (_record, verificationLog) =>
      Array.isArray(verificationLog) &&
      verificationLog.some((v) => (v.confidence || 0) < 0.45 && (v.warnings || []).length),
    extract: (_record, verificationLog) => {
      const worst = verificationLog
        .filter((v) => (v.confidence || 0) < 0.45)
        .sort((a, b) => (a.confidence || 0) - (b.confidence || 0))[0];

      const warn = worst?.warnings?.[0] || 'uncertain verification';

      return {
        type: 'retry_hint',
        scope: 'global',
        apps: [],
        trigger: { general: true },
        lesson: `A past task had uncertain verification: "${warn}". Add stronger verify blocks or explicit state checks to similar phases.`,
        tags: ['verification', 'confidence'],
      };
    },
  },
];

function mergeLesson(existing, raw, taskRecord) {
  existing.confidence = Math.min(1.0, Number(existing.confidence || 0.6) + 0.1);
  existing.seenCount = (existing.seenCount || 1) + 1;
  existing.lastSeen = new Date().toISOString();
  existing.sourceTaskIds = uniq([...(existing.sourceTaskIds || []), taskRecord.taskId]);
  existing.apps = uniq([...(existing.apps || []), ...(raw.apps || [])]);
  existing.tags = uniq([...(existing.tags || []), ...(raw.tags || [])]);
  existing.trigger = { ...(existing.trigger || {}), ...(raw.trigger || {}) };
  return existing;
}

function createLesson(raw, taskRecord) {
  const now = new Date().toISOString();

  return {
    id: makeId(),
    type: raw.type,
    trigger: raw.trigger || {},
    lesson: raw.lesson,
    scope: raw.scope || 'global',
    apps: uniq(raw.apps || []),
    tags: uniq(raw.tags || []),
    confidence: raw.confidence || 0.6,
    seenCount: 1,
    firstSeen: now,
    lastSeen: now,
    sourceTaskIds: [taskRecord.taskId],
  };
}

function learn(taskRecord, verificationLog = []) {
  if (!taskRecord) return { ok: false, error: 'no task record' };

  const store = readMem();
  const newLessons = [];
  const reinforced = [];

  for (const ex of EXTRACTORS) {
    try {
      if (!ex.match(taskRecord, verificationLog)) continue;

      const raw = ex.extract(taskRecord, verificationLog);
      if (!raw || !raw.lesson) continue;

      const existing = Object.values(store).find(
        (m) => m.type === raw.type && m.lesson === raw.lesson
      );

      if (existing) {
        store[existing.id] = mergeLesson(existing, raw, taskRecord);
        reinforced.push(store[existing.id]);
        console.log(
          `[memory] reinforced: "${raw.lesson.slice(0, 55)}…" → ${store[existing.id].confidence.toFixed(2)}`
        );
      } else {
        const lesson = createLesson(raw, taskRecord);
        store[lesson.id] = lesson;
        newLessons.push(lesson);
        console.log(`[memory] new lesson: "${raw.lesson.slice(0, 55)}…"`);
      }
    } catch (e) {
      console.error('[memory] extractor error:', e.message);
    }
  }

  writeMem(store);
  return { ok: true, newLessons, reinforced };
}

function forget(id) {
  const store = readMem();
  if (!store[id]) return { ok: false, error: `not found: ${id}` };

  delete store[id];
  writeMem(store);
  return { ok: true };
}

function listAll() {
  return Object.values(readMem()).sort(
    (a, b) =>
      (Number(b.confidence || 0) - Number(a.confidence || 0)) ||
      (Number(b.seenCount || 0) - Number(a.seenCount || 0))
  );
}

function getById(id) {
  const store = readMem();
  return store[id] || null;
}

function prune(maxAgeDays = 90, minConfidence = 0.3) {
  const store = readMem();
  const cutoff = Date.now() - maxAgeDays * 864e5;
  let removed = 0;

  for (const [id, m] of Object.entries(store)) {
    const seenAt = new Date(m.lastSeen || m.firstSeen || 0).getTime();
    if (seenAt < cutoff && Number(m.confidence || 0) < minConfidence) {
      delete store[id];
      removed += 1;
    }
  }

  if (removed) {
    writeMem(store);
    console.log(`[memory] pruned ${removed} stale lesson(s)`);
  }

  return { ok: true, removed };
}

module.exports = {
  learn,
  forget,
  listAll,
  getById,
  prune,
};