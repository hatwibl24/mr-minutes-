'use strict';

// ============================================================
// MR. MINUTES — Modes v1
//
// Defines the 10 operational modes for Mr. Minutes.
// Each mode carries:
//   - id, name, description
//   - preferredApps: which apps to default to in this mode
//   - allowedDomains: what capability tiers are unlocked
//   - riskPolicy: how cautious the planner should be
//   - plannerPersonality: tone hint for planner prompt injection
//   - intentExtensions: extra keywords that trigger mode context
//   - disabledActions: actions the executor is NOT allowed to run
//   - triggers: words/phrases that suggest this mode should activate
// ============================================================

const DOMAINS = {
  OS:        'OS_LEVEL',      // volume, brightness, sleep, lock
  WEB:       'WEB_LEVEL',     // browser, URLs, search
  APP:       'APP_LEVEL',     // app control, UI interaction
  FILE:      'FILE_LEVEL',    // file system, read/write
  CODE:      'CODE_LEVEL',    // terminal, git, CLI, code editors
  DEPLOY:    'DEPLOY_LEVEL',  // CI/CD, Vercel, Netlify, Docker
  DATA:      'DATA_LEVEL',    // spreadsheets, databases, SQL
  DESIGN:    'DESIGN_LEVEL',  // Figma, image tools, export
  COMMS:     'COMMS_LEVEL',   // messaging, email, meetings
  FINANCE:   'FINANCE_LEVEL', // trading platforms, portfolio tools
  MEDIA:     'MEDIA_LEVEL',   // DAWs, video editors, Spotify
};

// ── RISK POLICIES ─────────────────────────────────────────────
// STRICT  → always confirm before destructive ops, no shell access
// NORMAL  → confirm only for irreversible actions (delete, deploy)
// TRUSTED → developer-grade, runs commands without confirmation per step
const RISK = { STRICT: 'strict', NORMAL: 'normal', TRUSTED: 'trusted' };

// ── MODE DEFINITIONS ──────────────────────────────────────────
const MODES = {

  // ── 1. GENERAL ───────────────────────────────────────────────
  general: {
    id: 'general',
    name: 'General',
    description: 'Default mode. Handles everyday tasks, browsing, app control, and conversation.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Visual Studio Code',
      terminal: 'Terminal',
      notes:    'Notes',
    },
    allowedDomains: [DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE],
    riskPolicy: RISK.NORMAL,
    plannerPersonality: 'You are helping a general user. Keep plans simple, clear, and safe. Prefer keyboard shortcuts. Avoid shell commands unless asked.',
    triggers: [],
    disabledActions: ['deploy_project', 'push_repo', 'run_command'],
    intentExtensions: [],
  },

  // ── 2. DEVELOPER ─────────────────────────────────────────────
  developer: {
    id: 'developer',
    name: 'Developer',
    description: 'Full-stack developer mode. Unlocks terminal, git, CLI, deployment, and code generation.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Cursor',
      terminal: 'Terminal',
      notes:    'Notion',
    },
    allowedDomains: [
      DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE,
      DOMAINS.CODE, DOMAINS.DEPLOY,
    ],
    riskPolicy: RISK.TRUSTED,
    plannerPersonality: 'You are helping an expert software developer. Generate real, production-quality code. Use CLI tools freely. Prefer Cursor as editor. Use npm/pnpm. Commit with meaningful messages. Always set up proper project structure.',
    triggers: [
      'build', 'deploy', 'push to github', 'npm', 'git', 'vercel',
      'supabase', 'create app', 'full stack', 'api', 'backend',
      'frontend', 'terminal', 'run command', 'code', 'install',
    ],
    disabledActions: [],
    intentExtensions: [
      'scaffold', 'refactor', 'debug', 'lint', 'test', 'ci/cd',
      'docker', 'kubernetes', 'aws', 'gcp', 'firebase', 'prisma',
    ],
  },

  // ── 3. DESIGNER ──────────────────────────────────────────────
  designer: {
    id: 'designer',
    name: 'Designer',
    description: 'UI/UX designer mode. Figma-first, export-aware, asset management, and design system work.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Figma',
      terminal: 'Terminal',
      notes:    'Notion',
    },
    allowedDomains: [DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE, DOMAINS.DESIGN],
    riskPolicy: RISK.NORMAL,
    plannerPersonality: 'You are helping a UI/UX designer. Focus on Figma workflows, design asset exports, color tokens, component creation, and design system organisation. Avoid terminal unless necessary.',
    triggers: [
      'figma', 'design', 'export', 'component', 'frame', 'prototype',
      'wireframe', 'ui', 'ux', 'color', 'font', 'layout', 'icon',
      'asset', 'mockup', 'sketch',
    ],
    disabledActions: ['run_command', 'push_repo', 'deploy_project'],
    intentExtensions: [
      'auto layout', 'variants', 'component set', 'design token',
      'responsive', 'handoff', 'inspect', 'style guide',
    ],
  },

  // ── 4. WRITER ────────────────────────────────────────────────
  writer: {
    id: 'writer',
    name: 'Writer',
    description: 'Content writer mode. Research, draft, edit, and publish across writing tools.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Notion',
      terminal: 'Terminal',
      notes:    'Notes',
    },
    allowedDomains: [DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE, DOMAINS.COMMS],
    riskPolicy: RISK.NORMAL,
    plannerPersonality: 'You are helping a writer or content creator. Focus on drafting, editing, researching, and publishing. Use Notion or Google Docs. Avoid technical jargon in plans. Keep workflows content-focused.',
    triggers: [
      'write', 'draft', 'article', 'blog', 'essay', 'research',
      'edit', 'proofread', 'publish', 'content', 'copywrite',
      'notion', 'google docs', 'word',
    ],
    disabledActions: ['run_command', 'push_repo', 'deploy_project'],
    intentExtensions: [
      'seo', 'headline', 'outline', 'paragraph', 'summary',
      'newsletter', 'tweet thread', 'linkedin post',
    ],
  },

  // ── 5. ANALYST ───────────────────────────────────────────────
  analyst: {
    id: 'analyst',
    name: 'Analyst',
    description: 'Data analyst mode. CSV, Excel, Python/Pandas, SQL, charts, and reporting.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Visual Studio Code',
      terminal: 'Terminal',
      notes:    'Notion',
    },
    allowedDomains: [
      DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE,
      DOMAINS.CODE, DOMAINS.DATA,
    ],
    riskPolicy: RISK.NORMAL,
    plannerPersonality: 'You are helping a data analyst. Generate Python (Pandas, matplotlib, seaborn) or SQL for data tasks. Prefer CSV/Excel workflows. Create charts when useful. Avoid front-end code. Use Jupyter or VS Code.',
    triggers: [
      'data', 'csv', 'excel', 'chart', 'graph', 'sql', 'query',
      'dataset', 'analyse', 'analyze', 'pandas', 'python', 'spreadsheet',
      'report', 'dashboard', 'visualise', 'visualize',
    ],
    disabledActions: ['deploy_project', 'push_repo'],
    intentExtensions: [
      'pivot table', 'regression', 'correlation', 'bar chart',
      'line graph', 'heatmap', 'hypothesis', 'clean data',
    ],
  },

  // ── 6. TRADER ────────────────────────────────────────────────
  trader: {
    id: 'trader',
    name: 'Trader',
    description: 'Financial trader mode. Price alerts, portfolio tracking, market research, and trading platform control.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Visual Studio Code',
      terminal: 'Terminal',
      notes:    'Notion',
    },
    allowedDomains: [
      DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE,
      DOMAINS.DATA, DOMAINS.FINANCE,
    ],
    riskPolicy: RISK.STRICT,
    plannerPersonality: 'You are helping a financial trader. Focus on market data lookups, portfolio tracking, price alert setup, and trading tool automation. NEVER execute financial transactions autonomously. Always confirm before any action that affects real money. Keep plans precise and factual.',
    triggers: [
      'stock', 'trade', 'trading', 'portfolio', 'price', 'alert',
      'market', 'crypto', 'bitcoin', 'forex', 'chart', 'candlestick',
      'binance', 'coinbase', 'bloomberg', 'ticker',
    ],
    disabledActions: ['run_command', 'push_repo', 'deploy_project'],
    intentExtensions: [
      'stop loss', 'take profit', 'moving average', 'rsi',
      'support level', 'resistance', 'breakout', 'volume',
    ],
  },

  // ── 7. STUDENT ───────────────────────────────────────────────
  student: {
    id: 'student',
    name: 'Student',
    description: 'Student mode. Flashcards, study notes, deadline tracking, research, and summarisation.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Notion',
      terminal: 'Terminal',
      notes:    'Notes',
    },
    allowedDomains: [DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE, DOMAINS.COMMS],
    riskPolicy: RISK.STRICT,
    plannerPersonality: 'You are helping a student. Focus on study tools, flashcard creation, deadline tracking, summarising content, and research. Use simple clear language in plans. Avoid complex technical workflows.',
    triggers: [
      'study', 'flashcard', 'deadline', 'assignment', 'exam',
      'summarise', 'summarize', 'notes', 'lecture', 'textbook',
      'homework', 'quiz', 'revision', 'anki',
    ],
    disabledActions: ['run_command', 'push_repo', 'deploy_project'],
    intentExtensions: [
      'spaced repetition', 'mind map', 'cornell notes',
      'citation', 'bibliography', 'pomodoro',
    ],
  },

  // ── 8. MUSICIAN ──────────────────────────────────────────────
  musician: {
    id: 'musician',
    name: 'Musician',
    description: 'Music producer mode. DAW control, sample search, plugin management, and Spotify automation.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Notion',
      terminal: 'Terminal',
      notes:    'Notes',
    },
    allowedDomains: [
      DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE, DOMAINS.MEDIA,
    ],
    riskPolicy: RISK.NORMAL,
    plannerPersonality: 'You are helping a music producer. Focus on DAW workflows (Logic Pro, Ableton, FL Studio), sample library management, Spotify control, and audio file handling. Keep plans audio-tool-focused.',
    triggers: [
      'logic', 'ableton', 'fl studio', 'daw', 'sample', 'plugin',
      'midi', 'beat', 'track', 'mix', 'master', 'spotify',
      'playlist', 'audio', 'sound', 'produce', 'record',
    ],
    disabledActions: ['run_command', 'push_repo', 'deploy_project'],
    intentExtensions: [
      'bpm', 'tempo', 'reverb', 'eq', 'compression',
      'stem', 'bounce', 'export audio', 'vst',
    ],
  },

  // ── 9. EXECUTIVE ─────────────────────────────────────────────
  executive: {
    id: 'executive',
    name: 'Executive',
    description: 'Executive / productivity mode. Email, calendar, meetings, Slack, task management, and reporting.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Notion',
      terminal: 'Terminal',
      notes:    'Notes',
    },
    allowedDomains: [DOMAINS.OS, DOMAINS.WEB, DOMAINS.APP, DOMAINS.FILE, DOMAINS.COMMS],
    riskPolicy: RISK.STRICT,
    plannerPersonality: 'You are helping a busy executive. Focus on email management, calendar scheduling, meeting preparation, Slack/Teams communication, and productivity workflows. Keep plans fast and outcome-focused. Never send emails or messages without explicit confirmation.',
    triggers: [
      'email', 'calendar', 'meeting', 'slack', 'teams', 'zoom',
      'schedule', 'agenda', 'report', 'presentation', 'brief',
      'gmail', 'outlook', 'notion', 'task',
    ],
    disabledActions: ['run_command', 'push_repo', 'deploy_project'],
    intentExtensions: [
      'follow up', 'reply', 'forward', 'book meeting',
      'create slide', 'weekly report', 'okr', 'kpi',
    ],
  },

  // ── 10. POWER ────────────────────────────────────────────────
  power: {
    id: 'power',
    name: 'Power',
    description: 'Power user mode. Unrestricted. Full access to all domains. For advanced users who know exactly what they are doing.',
    preferredApps: {
      browser:  'Google Chrome',
      editor:   'Cursor',
      terminal: 'Terminal',
      notes:    'Notion',
    },
    allowedDomains: Object.values(DOMAINS),
    riskPolicy: RISK.TRUSTED,
    plannerPersonality: 'You are helping an advanced power user with full system access. No domain is off limits. Generate complete, production-quality plans. Use any tool available. Assume the user knows what they are asking for.',
    triggers: ['power mode', 'full access', 'advanced', 'unrestricted'],
    disabledActions: [],
    intentExtensions: [],
  },
};

// ── ACTIVE MODE STATE ─────────────────────────────────────────
let _activeMode = MODES.general;

function getActiveMode() {
  return _activeMode;
}

function setMode(modeId) {
  const mode = MODES[modeId];
  if (!mode) return { ok: false, error: `Unknown mode: ${modeId}` };
  _activeMode = mode;
  console.log(`[modes] Active mode → ${mode.name}`);
  return { ok: true, mode };
}

// ── AUTO DETECT MODE FROM TRIGGER WORDS ───────────────────────
function detectModeFromInput(input = '') {
  const cmd = input.toLowerCase();

  // Score each mode by how many trigger words match
  let bestMode = null;
  let bestScore = 0;

  for (const mode of Object.values(MODES)) {
    if (mode.id === 'general' || mode.id === 'power') continue;
    let score = 0;
    for (const trigger of mode.triggers) {
      if (cmd.includes(trigger)) score++;
    }
    for (const ext of (mode.intentExtensions || [])) {
      if (cmd.includes(ext)) score += 0.5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMode = mode;
    }
  }

  // Only suggest a switch if strong signal (score >= 2)
  if (bestScore >= 2 && bestMode && bestMode.id !== _activeMode.id) {
    return { suggested: true, mode: bestMode, score: bestScore };
  }
  return { suggested: false, mode: _activeMode, score: bestScore };
}

// ── CAPABILITY CHECKS ─────────────────────────────────────────
function isDomainAllowed(domain) {
  return _activeMode.allowedDomains.includes(domain);
}

function isActionAllowed(action = '') {
  return !_activeMode.disabledActions.includes(action);
}

function getRiskPolicy() {
  return _activeMode.riskPolicy;
}

// ── LIST MODES ────────────────────────────────────────────────
function listModes() {
  return Object.values(MODES).map(m => ({
    id: m.id,
    name: m.name,
    description: m.description,
    active: m.id === _activeMode.id,
  }));
}

// ── MODE CONTEXT STRING (injected into prompts) ───────────────
function getModeContextForPrompt() {
  const m = _activeMode;
  return [
    `Active mode: ${m.name}`,
    `Personality: ${m.plannerPersonality}`,
    `Preferred apps: browser=${m.preferredApps.browser}, editor=${m.preferredApps.editor}, terminal=${m.preferredApps.terminal}`,
    `Risk policy: ${m.riskPolicy}`,
    `Allowed domains: ${m.allowedDomains.join(', ')}`,
    m.disabledActions.length
      ? `Disabled actions: ${m.disabledActions.join(', ')}`
      : 'All actions permitted.',
  ].join('\n');
}

module.exports = {
  MODES,
  DOMAINS,
  RISK,
  getActiveMode,
  setMode,
  detectModeFromInput,
  isDomainAllowed,
  isActionAllowed,
  getRiskPolicy,
  listModes,
  getModeContextForPrompt,
};