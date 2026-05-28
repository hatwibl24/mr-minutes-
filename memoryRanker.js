'use strict';

const memory = require('./memory');

const DEFAULTS = {
  minConfidence: 0.5,
  minScore: 0.55,
  limit: 8,
  weights: {
    globalScope: 0.05,
    generalTrigger: 0.08,
    taskType: 0.20,
    triggerApp: 0.20,
    lessonApps: 0.18,
    triggerAction: 0.18,
    triggerKeyword: 0.12,
    lessonTags: 0.10,
    lessonTextGoalHint: 0.04,
  },
};

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function uniq(list) {
  return Array.from(
    new Set((Array.isArray(list) ? list : []).filter(Boolean).map(norm))
  );
}

function normalizeContext(ctx = {}) {
  return {
    taskType: norm(ctx.taskType),
    apps: uniq(ctx.apps),
    goal: norm(ctx.goal),
    actions: uniq(ctx.actions),
    tags: uniq(ctx.tags),
  };
}

function scoreLesson(lesson, rawCtx = {}, options = {}) {
  const ctx = normalizeContext(rawCtx);
  const cfg = {
    ...DEFAULTS,
    ...options,
    weights: { ...DEFAULTS.weights, ...(options.weights || {}) },
  };

  let score = Number(lesson?.confidence || 0);
  const reasons = [];
  const trigger = lesson?.trigger || {};

  if (lesson?.scope === 'global') {
    score += cfg.weights.globalScope;
    reasons.push('scope:global');
  }

  if (trigger.general) {
    score += cfg.weights.generalTrigger;
    reasons.push('trigger:general');
  }

  if (trigger.taskType && ctx.taskType && ctx.taskType.includes(norm(trigger.taskType))) {
    score += cfg.weights.taskType;
    reasons.push(`taskType:${norm(trigger.taskType)}`);
  }

  if (trigger.app && ctx.apps.includes(norm(trigger.app))) {
    score += cfg.weights.triggerApp;
    reasons.push(`triggerApp:${norm(trigger.app)}`);
  }

  if ((lesson?.apps || []).some((app) => ctx.apps.includes(norm(app)))) {
    score += cfg.weights.lessonApps;
    reasons.push('apps:match');
  }

  if ((trigger.actions || []).some((action) => ctx.actions.includes(norm(action)))) {
    score += cfg.weights.triggerAction;
    reasons.push('actions:match');
  }

  if (trigger.keyword && ctx.goal.includes(norm(trigger.keyword))) {
    score += cfg.weights.triggerKeyword;
    reasons.push(`keyword:${norm(trigger.keyword)}`);
  }

  if ((lesson?.tags || []).some((tag) => ctx.tags.includes(norm(tag)))) {
    score += cfg.weights.lessonTags;
    reasons.push('tags:match');
  }

  if (ctx.goal && norm(lesson?.lesson).includes(ctx.goal.slice(0, Math.min(ctx.goal.length, 12)))) {
    score += cfg.weights.lessonTextGoalHint;
    reasons.push('lessonText:goalHint');
  }

  return {
    ...lesson,
    score: Math.round(score * 1000) / 1000,
    reasons,
  };
}

function rankLessons(lessons = [], ctx = {}, options = {}) {
  const cfg = {
    ...DEFAULTS,
    ...options,
    weights: { ...DEFAULTS.weights, ...(options.weights || {}) },
  };

  return (Array.isArray(lessons) ? lessons : [])
    .map((lesson) => scoreLesson(lesson, ctx, cfg))
    .filter((lesson) => Number(lesson.confidence || 0) >= cfg.minConfidence)
    .filter((lesson) => Number(lesson.score || 0) >= cfg.minScore)
    .sort((a, b) => (b.score - a.score) || (Number(b.confidence || 0) - Number(a.confidence || 0)))
    .slice(0, cfg.limit);
}

function getRelevantLessons(ctx = {}, options = {}) {
  const all = typeof memory.listAll === 'function' ? memory.listAll() : [];
  return rankLessons(all, ctx, options);
}

function buildPlannerInjection(lessons = []) {
  if (!lessons.length) return '';

  const lines = lessons.map((m, i) => {
    const scope = m.scope === 'global'
      ? 'GLOBAL'
      : m.apps?.length
        ? `APP:${m.apps.join(',')}`
        : 'LOCAL';

    return `${i + 1}. [${String(m.type || '').toUpperCase()} | ${scope}] ${m.lesson} (confidence: ${Math.round((m.confidence || 0) * 100)}%, seen: ${m.seenCount || 1})`;
  });

  return [
    '=== BEHAVIORAL MEMORY — apply these lessons before planning ===',
    ...lines,
    '=== END MEMORY ===',
  ].join('\n');
}

module.exports = {
  DEFAULTS,
  normalizeContext,
  scoreLesson,
  rankLessons,
  getRelevantLessons,
  buildPlannerInjection,
};