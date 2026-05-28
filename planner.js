'use strict';

const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const modes = require('./modes');
const memoryRanker = require('./memoryRanker');
const sysEnv = require('./systemEnvironment');

let cooldownUntil = 0;
const _planCache = new Map();
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
function hashIntent(intent) {
  const key = [(intent.goal||'').slice(0,80).toLowerCase().trim(),(intent.category||'').toUpperCase().replace(/\s+/g,'_'),(intent.apps||[]).slice().sort().join(',')].join('|');
  let h = 0; for (let i=0;i<key.length;i++) h=(Math.imul(31,h)+key.charCodeAt(i))|0; return String(h);
}

function makeTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitize(text) {
  return String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function extractRetryDelay(text) {
  const m1 = String(text || '').match(/retryDelay["':\s]+(\d+)/i);
  if (m1) return Number(m1[1]) * 1000;

  const m2 = String(text || '').match(/Please retry in\s+(\d+)s/i);
  if (m2) return Math.ceil(Number(m2[1]) * 1000);

  return 30000;
}

function estimateCost(stepCount) {
  const inputTokens = 2000;
  const outputTokens = Math.max(1, stepCount) * 150;
  const cost = ((inputTokens * 0.075) + (outputTokens * 0.30)) / 1000000;
  return cost.toFixed(4);
}

function uniq(list = []) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function normalizeApps(apps) {
  if (Array.isArray(apps)) return uniq(apps.map((v) => String(v).trim()).filter(Boolean));
  if (typeof apps === 'string') {
    return uniq(
      apps.split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    );
  }
  return [];
}

function normalizeList(input) {
  if (Array.isArray(input)) return uniq(input.map((v) => String(v).trim()).filter(Boolean));
  if (typeof input === 'string') return uniq([input.trim()].filter(Boolean));
  return [];
}

function buildMemoryContextForIntent(intent = {}) {
  const apps = normalizeApps(intent.apps);
  const actions = normalizeList(intent.actions);
  const tags = normalizeList(intent.tags);

  const taskType =
    intent.taskType ||
    (intent.category === 'COMPLEX_TASK' ? 'complex_task'
      : intent.category === 'SIMPLE_TASK' ? 'simple_task'
      : intent.category === 'WEB_ACTION' ? 'web_action'
      : intent.category === 'APP_LAUNCH' ? 'app_launch'
      : intent.category === 'OS_ACTION' ? 'os_action'
      : 'general');

  return {
    taskType,
    apps,
    goal: intent.goal || intent.raw || '',
    actions,
    tags,
  };
}

function getPlannerMemory(intent = {}) {
  try {
    const ctx = buildMemoryContextForIntent(intent);
    const lessons = memoryRanker.getRelevantLessons(ctx);
    const injection = memoryRanker.buildPlannerInjection(lessons);

    return {
      ok: true,
      ctx,
      lessons,
      injection,
    };
  } catch (err) {
    console.error('[planner] memory context error:', err.message);
    return {
      ok: false,
      error: err.message,
      ctx: null,
      lessons: [],
      injection: '',
    };
  }
}

function buildPlannerPrompt(intent) {
  const mode = modes.getActiveMode();
  const modeCtx = modes.getModeContextForPrompt();
  const homeDir = os.homedir();

  // Refresh running apps right before planning so the block is current
  sysEnv.refreshRunning();
  const sysBlock = sysEnv.getPromptBlock();

  const memoryPack = getPlannerMemory(intent);
  const memoryBlock = memoryPack.injection
    ? `${memoryPack.injection}\n\n`
    : '';

  const activeTaskBlock = intent?.activeTaskContext
    ? `
ACTIVE TASK CONTEXT
- taskId: ${intent.activeTaskContext.taskId || 'unknown'}
- label: ${intent.activeTaskContext.label || 'unknown'}
- goalText: ${intent.activeTaskContext.goalText || 'unknown'}
- phase: ${intent.activeTaskContext.phase || 'unknown'}
- apps: ${(intent.activeTaskContext.apps || []).join(', ') || 'unknown'}

If the new request is a continuation of this active task, continue the same task instead of creating a totally unrelated plan.
`
    : '';

  const wc = intent?.worldContext;
  const worldBlock = wc ? `
CURRENT SCREEN STATE
- Frontmost app: ${wc.frontmostApp || 'unknown'}
- User attention: ${wc.userAttention || 'unknown'}
- Visible UI text: ${(wc.visibleTexts || []).slice(0, 8).join(' | ') || 'none'}
Use this to avoid opening apps already open and to target actions at what is visible.
` : '';

  return `
You are the task planner for Mr. Minutes, a desktop AI agent running on macOS.

${sysBlock}

${modeCtx}

${memoryBlock}${activeTaskBlock}${worldBlock}

You have access to these action primitives. Use EXACT action names.

FILE SYSTEM
- createfolder path
- createfile path, text
- writefile path, text
- appendfile path, text
- readfile path, storeAs
- pathexists path, storeAs

PROCESS / TERMINAL
- runcommand command, cwd, background?, name?, storeStdoutAs?, storeStderrAs?, timeout?
- stopcommand name|pid
- waitforserver url, timeout

APP / NAVIGATION
- ensureapp app  — focus an existing app window (non-Office apps only)
- opennewdoc app  — opens a NEW document in Word/Excel/Pages/Numbers/Keynote via AppleScript. Use for any Office/iWork writing task. IMPORTANT: app name goes in the "app" field, NOT in the action string. Correct: {"action":"opennewdoc","app":"Microsoft Word"}. Wrong: {"action":"opennewdoc Microsoft Word"}
- openeditor app
- openterminal app
- openbrowser app
- openurl url
- openproject app, path
- openpreview url|localUrl

UI / KEYBOARD
- focusandtype app, text, target?, clearFirst?
- key key
- type text
- paste text
- typesmart text
- clearandtype text
- presssequence keys
- findandclick target
- waitfor target, timeout
- waitandclick target, timeout
- scrolluntil target, direction

HIGH-LEVEL ACTIONS
- pushrepo cwd, message, remote?, branch?
- deployproject cwd, command?
- setdomain cwd, domain, project?
- humanhandoff message, waitFor?
- sleep ms

VARIABLES
- You may reference variables as {{varName}} inside string fields.
- Use storeStdoutAs, storeStderrAs, or storeAs when later steps depend on earlier output.

DEFAULTS
- Home directory: ${homeDir}
- Current mode: ${mode.name}
- Preferred browser: ${mode.preferredApps?.browser || 'Google Chrome'}
- Preferred editor: ${mode.preferredApps?.editor || 'Visual Studio Code'}
- Preferred terminal: ${mode.preferredApps?.terminal || 'Terminal'}

TASK
- Goal: ${intent.goal || ''}
- Raw request: ${intent.raw || ''}
- Apps likely needed: ${normalizeApps(intent.apps).join(', ') || 'auto-detect'}
- Complexity: ${intent.complexity || 'unknown'}
- Human handoffs already identified: ${normalizeList(intent.needsHuman).join(', ') || 'none'}

PLANNING RULES
1. Return ONLY valid JSON. No markdown fences, no explanation.
2. Use exact action names from the list above.
3. Prefer keyboard-first actions when practical.
4. DO NOT use humanhandoff for basic desktop actions that Mr. Minutes can perform directly: opening apps, typing text, creating notes, drafting documents, saving files, navigating pages, copying/pasting, pressing shortcuts, or basic browser use.
5. Use humanhandoff ONLY for true blockers: passwords, login credentials, 2FA, CAPTCHAs, payments, permission prompts, legal/financial confirmation, or decisions that must be explicitly made by the human.
6. For document-writing requests, plan the actual execution: open the app, type the content, save the file. Do not stop after opening the app.
7. If the user asks to write, create, draft, save, search, message, or open something, the plan must contain actionable steps that complete the request as far as safely possible.
8. Include waits and verification-oriented steps where UI or servers may need time.
9. Respect execution order: setup before install, install before run, run before deploy.
10. Respect the current mode's disabled actions and risk posture.
11. Write production-quality file contents when creating code or config files.
12. Group steps into phases with clear names.
13. If behavioral memory is present above, apply it proactively and silently while planning.
14. Output strict JSON only.

CRITICAL FORMAT RULES — follow exactly or the step will fail:
- Action name in "action" field ONLY. App name in "app" field ONLY.
  ✅ {"action":"opennewdoc","app":"Microsoft Word"}  ❌ {"action":"opennewdoc Microsoft Word"}
- Text to type goes in "text" field: ✅ {"action":"typesmart","text":"hello"}  ❌ {"action":"typesmart","content":"hello"}
- Keys: ✅ {"action":"key","key":"cmd+s"}  ✅ {"action":"presssequence","keys":["cmd","shift","s"],"pauseAfter":1800}
- Save flow for Office apps — ALWAYS this exact sequence:
  {"action":"presssequence","keys":["cmd","shift","s"],"pauseAfter":1800}
  {"action":"sleep","ms":1200}
  {"action":"presssequence","keys":["cmd","a"],"pauseAfter":200}
  {"action":"typesmart","text":"FILENAME","pauseAfter":600}
  {"action":"key","key":"enter","pauseAfter":1500}
- NEVER use waitfor for native app dialogs — use sleep instead
- sleep: {"action":"sleep","ms":2000}

JSON schema:
{
  "label": "string",
  "briefing": "string",
  "context": {
    "taskType": "string",
    "apps": ["string"],
    "tags": ["string"],
    "vars": {
      "projectName": "string",
      "projectPath": "string",
      "editorApp": "string",
      "browserApp": "string",
      "terminalApp": "string"
    }
  },
  "phases": [
    {
      "name": "string",
      "steps": [
        {
          "action": "string"
        }
      ]
    }
  ]
}
`.trim();
}

// ── GEMINI PLANNER (complex tasks) ────────────────────────────
async function generatePlanWithAI(intent, attempt = 1) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY in .env');

  const now = Date.now();
  if (cooldownUntil > now) {
    const secs = Math.ceil((cooldownUntil - now) / 1000);
    throw new Error(`Rate limited. Try again in ${secs}s.`);
  }

  const prompt = buildPlannerPrompt(intent);
  console.log(`[planner] Calling Gemini to generate plan... (attempt ${attempt})`);

  // FIX: correct Gemini API URL
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
      cooldownUntil = Date.now() + extractRetryDelay(errText);
      const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
      throw new Error(`Rate limited. Try again in ${secs}s.`);
    }
    throw new Error(`Gemini planner error: ${res.status} — ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawText = sanitize(
    String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '')
  );

  if (!rawText) throw new Error('Planner returned empty output.');

  try {
    return JSON.parse(rawText);
  } catch (err) {
    console.error('[planner] JSON parse failed:', err.message);
    console.error('[planner] Raw text:', rawText.slice(0, 1200));
    if (attempt < 2) return generatePlanWithAI(intent, attempt + 1);
    throw new Error('Planner returned invalid JSON. Try again.');
  }
}

// ── SIMPLE TASK DETERMINISTIC PLANNER ─────────────────────────

// FIX: never return iWork apps (Pages/Numbers/Keynote) unless explicitly named,
// and recognise "versus code" as VS Code
function inferDocumentApp(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();

  if (text.includes('word') || text.includes('docx') || text.includes('document')) return 'Microsoft Word';
  if (text.includes('excel') || text.includes('spreadsheet')) return 'Microsoft Excel';
  if (text.includes('powerpoint') || text.includes('slides') || text.includes('presentation')) return 'Microsoft PowerPoint';
  if (text.includes('notes') || text.includes('note')) return 'Notes';
  if (text.includes('vs code') || text.includes('vscode') || text.includes('visual studio code') || text.includes('versus code')) return 'Visual Studio Code';

  // Filter iWork apps out unless the user explicitly said "Pages" / "Numbers" / "Keynote"
  const IWORK = ['pages', 'numbers', 'keynote'];
  const apps = normalizeApps(intent.apps).filter((a) => {
    const lower = a.toLowerCase();
    return !IWORK.includes(lower) || text.includes(lower);
  });
  return apps[0] || null;
}

function extractQuotedText(raw = '') {
  const match = String(raw).match(/[""](.+?)[""]/);
  return match ? match[1].trim() : '';
}

// FIX: handle "under the name X", "save [long thing] as X", strip "the name" prefix
function extractSaveAsName(text = '') {
  const patterns = [
    /\bsave (?:it|this|that)?\s*(?:as|under the name|under|named|called)\s+([a-zA-Z0-9_\- ]{1,80})/i,
    /\bunder the name\s+([a-zA-Z0-9_\- ]{1,80})/i,
    /\bsave\b.{0,80}\bas\s+([a-zA-Z0-9_\-]{1,40})/i,   // "save the folder on desktop as restaurant"
    /\bname (?:it|this|that)?\s+([a-zA-Z0-9_\- ]{1,80})/i,
    /\bcall (?:it|this|that)?\s+([a-zA-Z0-9_\- ]{1,80})/i,
    /\btitle (?:it|this|that)?\s+([a-zA-Z0-9_\- ]{1,80})/i,
  ];

  for (const re of patterns) {
    const m = String(text).match(re);
    if (m && m[1]) {
      return m[1].trim().replace(/^the name\s+/i, '').replace(/[.]+$/, '');
    }
  }

  return '';
}

// FIX: bail out early if it's really a project/code task
function looksLikeWriteTask(intent = {}) {
  if (looksLikeProjectTask(intent) || looksLikeCodeFileTask(intent)) return false;
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  return /\b(write|draft|create|make|type)\b/.test(text);
}

// FIX: "website" always means multi-file — never single-file
function looksLikeCodeFileTask(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  // A "website" or "web app" is always a project, not a single file
  if (/\b(website|web app|web site)\b/.test(text)) return false;
  const hasCodeType = /\b(html|css|javascript|js|python|py|json|xml|markdown|md|php|ruby|swift|bash|shell|script)\b/.test(text);
  const hasFileConcept = /\b(file|page|site|script|app)\b/.test(text);
  const hasProjectConcept = /\b(project|folder|directory|workspace|multiple files|with files)\b/.test(text);
  return hasCodeType && hasFileConcept && !hasProjectConcept;
}

// FIX: catch "website", "X pages", "versus code", multi-file indicators
function looksLikeProjectTask(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  const hasProjectWord = /\b(project|folder|directory|workspace)\b/.test(text);
  const hasMultiFile = /\bhtml.+css|css.+html|multiple files|with files|and (a |an )?(css|js|javascript|html|python)\b/.test(text);
  const hasCodeType = /\b(html|css|javascript|python|node|react|vue)\b/.test(text);
  const isWebsite = /\b(website|web app|web site)\b/.test(text);
  const hasPageCount = /\b(\d+|multiple|several|many)\s+(file\s+)?pages?\b/.test(text);
  const mentionsEditor = /\b(vs code|vscode|visual studio code|versus code)\b/.test(text);
  return (hasProjectWord && hasCodeType) ||
    (hasMultiFile && hasCodeType) ||
    isWebsite ||
    (hasPageCount && hasCodeType) ||
    mentionsEditor;
}

function inferProjectPath(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  const saveAs = extractSaveAsName(intent.raw || '') || extractSaveAsName(intent.goal || '');
  const nameMatch = text.match(/(?:project|folder|called|named|app)\s+(?:called\s+|named\s+)?([a-z0-9_\- ]{2,30})/i);
  const name = saveAs
    ? saveAs.replace(/\s+/g, '-').toLowerCase()
    : nameMatch ? nameMatch[1].trim().replace(/\s+/g, '-').toLowerCase()
    : 'my-project';
  const home = require('os').homedir();
  return `${home}/Desktop/${name}`;
}

function inferCodeFilePath(intent = {}, defaultName = 'index') {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  const saveAs = extractSaveAsName(intent.raw || '') || extractSaveAsName(intent.goal || '');
  const ext = text.includes('css') ? 'css'
    : text.includes('python') || text.includes('.py') ? 'py'
    : text.includes('javascript') || text.includes(' js ') ? 'js'
    : text.includes('json') ? 'json'
    : 'html';
  const name = saveAs || defaultName;
  const home = require('os').homedir();
  return `${home}/Desktop/${name}.${ext}`;
}

function looksLikeContentWriteTask(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  return /\b(essay|letter|report|story|article|poem|email|memo|paragraph|words?)\b/.test(text)
    || /\bwrite (a|an|the|me|my|us|about)\b/.test(text);
}

function extractWordCount(text = '') {
  const m = String(text).match(/(\d+)\s*(?:word|words)/i);
  return m ? parseInt(m[1], 10) : 0;
}

// Content generation uses Groq (fast, cheap, good for writing)
async function generateWriteContent(intent) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'qwen/qwen3-32b';
  if (!apiKey) return null;

  const raw = `${intent.goal || ''} ${intent.raw || ''}`;
  const wordCount = extractWordCount(raw);
  const countNote = wordCount > 0 ? ` Write exactly around ${wordCount} words.` : '';

  const systemPrompt =
    'You are a professional writer. Write exactly what the user asks for. ' +
    'Output ONLY the written content itself — no preamble, no commentary, no markdown formatting, ' +
    'no title unless the user asked for one.' + countNote;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: raw },
        ],
        temperature: 0.7,
        max_tokens: 2048,
        reasoning_format: 'hidden',
        stream: false,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || '').trim() || null;
  } catch {
    return null;
  }
}

function looksLikeSearchTask(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  return /\b(search|google|look up|find online|search for)\b/.test(text);
}

function looksLikeSpotifyTask(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  return text.includes('spotify') && /\b(play|listen|put on|start|queue|shuffle)\b/.test(text);
}

function looksLikeWhatsAppTask(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  return (text.includes('whatsapp') || text.includes('whats app'))
    && /\b(send|message|tell|text|say|write)\b/.test(text);
}

function extractContactName(text = '') {
  const patterns = [
    /(?:send|message|text|tell|whatsapp)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:a\s+)?(?:message|saying|that)/i,
    /(?:send|message|text|tell)\s+(?:a\s+message\s+to\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /(?:to|@)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:on\s+whatsapp|saying|that|a\s+message)/i,
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

function extractMessageBody(text = '') {
  const patterns = [
    /(?:saying|say|message\s+saying|that\s+says?|with\s+the\s+(?:message|text)?)[:\s]+["']?(.+?)["']?$/i,
    /(?:tell\s+(?:them|him|her))[:\s]+["']?(.+?)["']?$/i,
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

function extractSpotifyTarget(text = '') {
  const patterns = [
    /(?:play|listen to|put on|start|queue)\s+(?:my\s+)?(?:the\s+)?["']?([a-z0-9 \-_&']+?)["']?\s+(?:playlist|album|by|on\s+spotify)/i,
    /(?:play|listen to|put on|start|queue)\s+(?:my\s+)?(?:the\s+)?["']?([a-z0-9 \-_&']+?)["']?\s*(?:on\s+spotify|$)/i,
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m?.[1] && m[1].toLowerCase() !== 'spotify') return m[1].trim();
  }
  return '';
}

function looksLikeContinuationSaveInstruction(intent = {}) {
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();
  return /\b(save|save it|save it as|name it|call it|title it|under)\b/.test(text);
}

function buildMacSaveFlow(app, saveAs) {
  const steps = [];

  if (saveAs) {
    steps.push({ action: 'presssequence', keys: ['cmd', 'shift', 's'], pauseAfter: 1800 });
    steps.push({ action: 'sleep', ms: 1200 });
    steps.push({ action: 'presssequence', keys: ['cmd', 'a'], pauseAfter: 200 });
    steps.push({ action: 'typesmart', text: saveAs, pauseAfter: 600 });
    steps.push({ action: 'key', key: 'enter', pauseAfter: 1500 });
    return steps;
  }

  steps.push({ action: 'key', key: 'cmd+s', pauseAfter: 1000 });
  return steps;
}

async function buildSimpleExecutablePlan(intent) {
  const mode = modes.getActiveMode();
  const apps = normalizeApps(intent.apps);
  const textBlob = `${intent.goal || ''} ${intent.raw || ''}`;

  const browserApp = mode.preferredApps?.browser || 'Google Chrome';
  const editorApp = mode.preferredApps?.editor || 'Visual Studio Code';
  const terminalApp = mode.preferredApps?.terminal || 'Terminal';

  // 1) Direct app launch
  if (intent.category === 'APP_LAUNCH' && apps.length) {
    return {
      label: intent.goal || `Open ${apps[0]}`,
      briefing: `Opening ${apps[0]}.`,
      context: {
        taskType: 'app_launch',
        apps,
        tags: normalizeList(intent.tags),
        vars: { browserApp, editorApp, terminalApp },
      },
      phases: [
        {
          name: 'Open App',
          steps: [
            { action: 'ensureapp', app: apps[0], pauseAfter: 1200 },
          ],
        },
      ],
    };
  }

  // 2) Spotify
  if (looksLikeSpotifyTask(intent)) {
    const raw = intent.raw || intent.goal || '';
    const target = extractSpotifyTarget(raw.toLowerCase());
    const searchQuery = target || 'liked songs';

    return {
      label: `Play ${searchQuery} on Spotify`,
      briefing: `Playing ${searchQuery} on Spotify.`,
      context: { taskType: 'spotify', apps: ['Spotify'], tags: normalizeList(intent.tags), vars: { browserApp, editorApp, terminalApp } },
      phases: [
        {
          name: 'Open Spotify',
          steps: [
            { action: 'ensure_app', app: 'Spotify', settleMs: 2000 },
          ],
        },
        {
          name: 'Search and Play',
          steps: [
            { action: 'key', key: 'cmd+l', pauseAfter: 500 },
            { action: 'type_smart', text: searchQuery, pauseAfter: 800 },
            { action: 'key', key: 'enter', pauseAfter: 1500 },
            { action: 'sleep', ms: 1500 },
            { action: 'find_and_click', target: searchQuery, region: 'center', continueOnFail: true },
          ],
        },
      ],
    };
  }

  // 2b) WhatsApp
  if (looksLikeWhatsAppTask(intent)) {
    const raw = intent.raw || intent.goal || '';
    const contact = extractContactName(raw);
    const messageBody = extractMessageBody(raw);

    if (!contact) {
      return {
        label: 'Open WhatsApp',
        briefing: 'Opening WhatsApp — who should I message?',
        context: { taskType: 'whatsapp', apps: ['WhatsApp'], tags: normalizeList(intent.tags), vars: { browserApp, editorApp, terminalApp } },
        phases: [{
          name: 'Open WhatsApp',
          steps: [{ action: 'open_url', url: 'https://web.whatsapp.com', pauseAfter: 3000 }],
        }],
      };
    }

    return {
      label: `WhatsApp ${contact}${messageBody ? `: "${messageBody}"` : ''}`,
      briefing: `Sending ${contact} a message on WhatsApp.`,
      context: { taskType: 'whatsapp', apps: ['Google Chrome'], tags: normalizeList(intent.tags), vars: { browserApp, editorApp, terminalApp } },
      phases: [
        {
          name: 'Open WhatsApp',
          steps: [
            { action: 'open_url', url: 'https://web.whatsapp.com', pauseAfter: 3500 },
          ],
        },
        {
          name: 'Find Contact',
          steps: [
            { action: 'key', key: 'cmd+alt+/', pauseAfter: 600 },
            { action: 'type_smart', text: contact, pauseAfter: 1200 },
            { action: 'sleep', ms: 1000 },
            { action: 'find_and_click', target: contact, continueOnFail: false, pauseAfter: 800 },
          ],
        },
        ...(messageBody ? [{
          name: 'Send Message',
          steps: [
            { action: 'sleep', ms: 800 },
            { action: 'type_smart', text: messageBody, pauseAfter: 500 },
            { action: 'key', key: 'enter', pauseAfter: 500 },
          ],
        }] : []),
      ],
    };
  }

  // 2c) Search
  if (looksLikeSearchTask(intent)) {
    const m =
      textBlob.match(/search the web for (.+)$/i) ||
      textBlob.match(/search for (.+)$/i) ||
      textBlob.match(/google (.+)$/i) ||
      textBlob.match(/look up (.+)$/i);

    const query = m?.[1]?.trim();
    if (query) {
      return {
        label: `Search for ${query}`,
        briefing: `Searching for ${query}.`,
        context: {
          taskType: 'web_action',
          apps: [browserApp],
          tags: normalizeList(intent.tags),
          vars: { browserApp, editorApp, terminalApp },
        },
        phases: [
          {
            name: 'Open Browser',
            steps: [
              { action: 'openbrowser', app: browserApp, pauseAfter: 1000 },
            ],
          },
          {
            name: 'Search',
            steps: [
              { action: 'openurl', url: `https://www.google.com/search?q=${encodeURIComponent(query)}`, pauseAfter: 1800 },
            ],
          },
        ],
      };
    }
  }

  // 3a) Single code file (NOT a website — websites go to 3b)
  if (looksLikeCodeFileTask(intent)) {
    const filePath = inferCodeFilePath(intent);
    const isHtml = filePath.endsWith('.html');

    let fileContent = '';
    console.log('[planner] Generating code file content via AI...');
    fileContent = await generateWriteContent(intent) || '';
    if (fileContent) console.log(`[planner] Code content generated (${fileContent.length} chars)`);

    const phases = [
      {
        name: 'Create File',
        steps: [
          { action: 'create_file', path: filePath, text: fileContent, overwrite: true },
        ],
      },
    ];

    if (isHtml) {
      phases.push({
        name: 'Open in Browser',
        steps: [
          { action: 'open_url', url: `file://${filePath}`, pauseAfter: 1500 },
        ],
      });
    }

    return {
      label: intent.goal || 'Create code file',
      briefing: `Creating ${filePath.split('/').pop()} on your Desktop.`,
      context: {
        taskType: 'code_file',
        apps: isHtml ? [browserApp] : [],
        tags: normalizeList(intent.tags),
        vars: { browserApp, editorApp, terminalApp, filePath },
      },
      phases,
    };
  }

  // 3b) Multi-file project / website scaffold
  if (looksLikeProjectTask(intent)) {
    const projectPath = inferProjectPath(intent);
    const projectName = projectPath.split('/').pop();
    const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();

    // For any website, default to HTML + CSS + JS even if not explicitly mentioned
    const isWebsite = /\b(website|web app|web site)\b/.test(text);
    const needsHtml = /\bhtml\b/.test(text) || isWebsite;
    const needsCss  = /\bcss\b/.test(text)  || isWebsite;
    const needsJs   = /\b(js|javascript)\b/.test(text) || isWebsite;
    const needsPython = /\b(python|py)\b/.test(text);
    const needsReadme = /\breadme\b/.test(text);

    // Parse page count — "six file pages", "6 pages", etc.
    const PAGE_WORDS = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10 };
    const pageCountMatch = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(file\s+)?pages?\b/i);
    const pageCount = pageCountMatch
      ? (PAGE_WORDS[pageCountMatch[1].toLowerCase()] || parseInt(pageCountMatch[1], 10) || 1)
      : 1;

    // Use restaurant-specific page names if relevant, else generic
    const isRestaurant = /\brestaurant\b/.test(text);
    const restaurantPages = ['index', 'menu', 'about', 'gallery', 'reservations', 'contact'];
    const genericPages    = ['index', 'about', 'services', 'portfolio', 'blog', 'contact'];
    const pageNames = (isRestaurant ? restaurantPages : genericPages).slice(0, Math.max(1, pageCount));

    console.log(`[planner] Generating ${pageNames.length}-page project files via AI...`);

    const siteDesc = `A ${isRestaurant ? 'restaurant' : ''} website with pages: ${pageNames.join(', ')}. ` +
      `Use modern HTML5, CSS3, and JavaScript. All pages must be interlinked with a shared nav bar. ` +
      `Make it visually appealing with a dark/modern theme.`;

    // Generate each HTML page
    const htmlContents = {};
    if (needsHtml) {
      for (const page of pageNames) {
        htmlContents[page] = await generateWriteContent({
          ...intent,
          goal: `${page}.html page for: ${siteDesc}. Link to style.css and script.js. ` +
                `Nav links to: ${pageNames.map(p => p + '.html').join(', ')}.`,
        }) || '';
      }
    }

    const cssContent = needsCss
      ? await generateWriteContent({ ...intent, goal: `CSS stylesheet for: ${siteDesc}` }) || ''
      : '';
    const jsContent = needsJs
      ? await generateWriteContent({ ...intent, goal: `JavaScript (nav, animations, interactivity) for: ${siteDesc}` }) || ''
      : '';
    const pyContent = needsPython
      ? await generateWriteContent({ ...intent, goal: `Python script for: ${intent.goal}` }) || ''
      : '';

    const createSteps = [{ action: 'create_folder', path: projectPath }];

    if (needsHtml) {
      for (const page of pageNames) {
        createSteps.push({ action: 'create_file', path: `${projectPath}/${page}.html`, text: htmlContents[page], overwrite: true });
      }
    }
    if (needsCss)    createSteps.push({ action: 'create_file', path: `${projectPath}/style.css`,  text: cssContent, overwrite: true });
    if (needsJs)     createSteps.push({ action: 'create_file', path: `${projectPath}/script.js`,  text: jsContent,  overwrite: true });
    if (needsPython) createSteps.push({ action: 'create_file', path: `${projectPath}/main.py`,    text: pyContent,  overwrite: true });
    if (needsReadme || (!needsHtml && !needsCss && !needsJs && !needsPython)) {
      createSteps.push({ action: 'create_file', path: `${projectPath}/README.md`, text: `# ${projectName}\n`, overwrite: true });
    }

    const phases = [
      { name: 'Create Project', steps: createSteps },
      {
        name: 'Open in VS Code',
        steps: [
          { action: 'run_command', command: `open -a "Visual Studio Code" "${projectPath}"`, pauseAfter: 2000 },
        ],
      },
    ];

    if (needsHtml) {
      phases.push({
        name: 'Preview in Browser',
        steps: [
          { action: 'open_url', url: `file://${projectPath}/index.html`, pauseAfter: 1500 },
        ],
      });
    }

    return {
      label: intent.goal || `Create ${projectName} project`,
      briefing: `Creating ${projectName} on your Desktop — ${pageNames.length} pages, ${createSteps.length - 1} files.`,
      context: {
        taskType: 'project_scaffold',
        apps: [editorApp],
        tags: normalizeList(intent.tags),
        vars: { browserApp, editorApp, terminalApp, projectPath },
      },
      phases,
    };
  }

  // 3) Write/create task into an app
  if (looksLikeWriteTask(intent)) {
    const app = inferDocumentApp(intent) || editorApp;
    const quoted = extractQuotedText(intent.raw || '') || '';
    const saveAs = extractSaveAsName(intent.raw || '') || extractSaveAsName(intent.goal || '');

    let generatedContent = '';
    if (!quoted && looksLikeContentWriteTask(intent)) {
      console.log('[planner] Generating write content via AI...');
      generatedContent = await generateWriteContent(intent) || '';
      if (generatedContent) {
        console.log(`[planner] Content generated (${generatedContent.length} chars)`);
      }
    }

    const contentToType = quoted || generatedContent;

    const OFFICE_APPS = ['microsoft word', 'word', 'microsoft excel', 'excel', 'pages', 'numbers', 'keynote'];
    const isOfficeApp = OFFICE_APPS.includes(app.toLowerCase());

    const openPhaseSteps = isOfficeApp
      ? [{ action: 'opennewdoc', app, settleMs: 1800 }]
      : [{ action: 'ensureapp', app, pauseAfter: 2200 }];

    const writePhaseSteps = isOfficeApp ? [] : [{ action: 'key', key: 'cmd+n', pauseAfter: 1500 }];

    if (contentToType) {
      writePhaseSteps.push({ action: 'typesmart', text: contentToType, pauseAfter: 900 });
    }

    const savePhaseSteps = buildMacSaveFlow(app, saveAs);

    const phases = [
      { name: 'Open App', steps: openPhaseSteps },
      { name: 'Write Content', steps: writePhaseSteps },
      { name: 'Save', steps: savePhaseSteps },
    ];

    return {
      label: intent.goal || 'Write content in app',
      briefing: saveAs
        ? `Writing and saving as "${saveAs}" in ${app}.`
        : `Writing it in ${app}.`,
      context: {
        taskType: 'simple_task',
        apps: uniq([app]),
        tags: normalizeList(intent.tags),
        vars: {
          browserApp,
          editorApp,
          terminalApp,
          targetApp: app,
          fileName: saveAs || '',
        },
      },
      phases,
    };
  }

  // 4) Continuation — save/name/title instructions for active task
  if (intent.activeTaskContext?.apps?.length) {
    const primaryApp = intent.activeTaskContext.apps[0];
    const saveAs = extractSaveAsName(intent.raw || '') || extractSaveAsName(intent.goal || '');

    if (looksLikeContinuationSaveInstruction(intent)) {
      return {
        label: intent.goal || intent.activeTaskContext.label || 'Continue current task',
        briefing: saveAs ? `Saving current work as "${saveAs}".` : 'Saving current work.',
        context: {
          taskType: 'simple_task',
          apps: normalizeApps(intent.activeTaskContext.apps),
          tags: normalizeList(intent.tags),
          vars: { browserApp, editorApp, terminalApp, targetApp: primaryApp, fileName: saveAs || '' },
        },
        phases: [
          {
            name: 'Focus App',
            steps: [
              { action: 'ensureapp', app: primaryApp, pauseAfter: 1000 },
            ],
          },
          {
            name: 'Save',
            steps: buildMacSaveFlow(primaryApp, saveAs),
          },
        ],
      };
    }

    return {
      label: intent.goal || intent.activeTaskContext.label || 'Continue current task',
      briefing: 'Continuing the task.',
      context: {
        taskType: 'simple_task',
        apps: normalizeApps(intent.activeTaskContext.apps),
        tags: normalizeList(intent.tags),
        vars: { browserApp, editorApp, terminalApp, targetApp: primaryApp },
      },
      phases: [
        {
          name: 'Resume Task',
          steps: [
            { action: 'ensureapp', app: primaryApp, pauseAfter: 1000 },
          ],
        },
      ],
    };
  }

  // 5) Safe default
  if (apps.length > 0) {
    return {
      label: intent.goal || 'Simple Task',
      briefing: `Opening ${apps[0]} and getting ready.`,
      context: {
        taskType: 'simple_task',
        apps,
        tags: normalizeList(intent.tags),
        vars: { browserApp, editorApp, terminalApp },
      },
      phases: [
        {
          name: 'Open App',
          steps: [
            { action: 'ensureapp', app: apps[0], pauseAfter: 1200 },
          ],
        },
      ],
    };
  }

  return {
    label: intent.goal || 'Simple Task',
    briefing: "I'm not sure which app fits best yet, so I'm holding position for the next instruction.",
    context: {
      taskType: 'simple_task',
      apps: [],
      tags: normalizeList(intent.tags),
      vars: { browserApp, editorApp, terminalApp },
    },
    phases: [
      {
        name: 'Pause',
        steps: [
          { action: 'sleep', ms: 100, pauseAfter: 0 },
        ],
      },
    ],
  };
}

// ── PLAN SANITIZING ────────────────────────────────────────────
function stepLooksLikeBadHandoff(step = {}, intent = {}) {
  if (!step || step.action !== 'humanhandoff') return false;

  const msg = String(step.message || '').toLowerCase();
  const text = `${intent.goal || ''} ${intent.raw || ''}`.toLowerCase();

  const allowedReasons = [
    'password', 'login', 'sign in', '2fa', 'two-factor', 'otp', 'captcha',
    'payment', 'pay', 'billing', 'confirm purchase', 'permission', 'grant access',
    'administrator', 'admin approval', 'legal confirmation', 'financial confirmation',
  ];

  if (allowedReasons.some((r) => msg.includes(r) || text.includes(r))) return false;

  const clearlyAutomatable = [
    'open', 'launch', 'write', 'type', 'save', 'search',
    'click', 'press', 'paste', 'go to', 'navigate', 'create', 'draft',
  ];

  if (clearlyAutomatable.some((r) => text.includes(r))) return true;

  return true;
}

function sanitizeHumanHandoffs(plan, intent = {}) {
  if (!plan?.phases?.length) return plan;

  return {
    ...plan,
    phases: plan.phases
      .map((phase) => ({
        ...phase,
        steps: (phase.steps || []).filter((step) => !stepLooksLikeBadHandoff(step, intent)),
      }))
      .filter((phase) => phase.steps.length > 0),
  };
}

function normalizeStep(rawStep = {}) {
  if (!rawStep || typeof rawStep !== 'object' || !rawStep.action) return null;

  const step = { ...rawStep };
  step.action = String(step.action).toLowerCase().replace(/-/g, '');

  if (!step.animHint) {
    if (['runcommand', 'writefile', 'appendfile', 'createfile', 'createfolder', 'readfile'].includes(step.action)) {
      step.animHint = 'thinking';
    } else if (['openurl', 'openbrowser', 'openproject', 'openeditor', 'openterminal', 'ensureapp'].includes(step.action)) {
      step.animHint = 'pointing';
    } else {
      step.animHint = 'tap';
    }
  }

  if (step.pauseAfter === undefined) {
    if (['runcommand', 'waitforserver'].includes(step.action)) step.pauseAfter = 500;
    else if (['openurl', 'openbrowser', 'openproject', 'openeditor', 'openterminal', 'ensureapp'].includes(step.action)) step.pauseAfter = 1200;
    else step.pauseAfter = 200;
  }

  return step;
}

function validateAndNormalizePlan(plan, intent = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Invalid plan: not an object');
  }

  if (!Array.isArray(plan.phases) || plan.phases.length === 0) {
    throw new Error('Invalid plan: no phases');
  }

  const mode = modes.getActiveMode();
  const allowedAction = (name) => modes.isActionAllowed(String(name || '').toLowerCase().replace(/-/g, ''));

  const cleaned = {
    taskId: makeTaskId(),
    label: plan.label || intent.goal || 'Computer Use Task',
    briefing: plan.briefing || `Working on ${intent.goal || 'your task'}.`,
    context: {
      taskType: plan.context?.taskType || buildMemoryContextForIntent(intent).taskType,
      apps: normalizeApps(plan.context?.apps || intent.apps),
      tags: normalizeList(plan.context?.tags || intent.tags),
      vars: { ...((plan.context && plan.context.vars) || {}) },
    },
    phases: [],
    mode: mode.id,
  };

  let totalSteps = 0;
  let humanHandoffs = 0;

  for (const phase of plan.phases) {
    if (!phase?.name || !Array.isArray(phase.steps)) continue;

    const cleanSteps = [];
    for (const rawStep of phase.steps) {
      const step = normalizeStep(rawStep);
      if (!step) continue;

      if (!allowedAction(step.action)) {
        console.warn('[planner] stripped disallowed action:', step.action, 'for mode', mode.name);
        continue;
      }

      if (step.action === 'humanhandoff') humanHandoffs += 1;

      cleanSteps.push(step);
      totalSteps += 1;
    }

    if (cleanSteps.length) {
      cleaned.phases.push({
        name: phase.name,
        steps: cleanSteps,
      });
    }
  }

  if (!cleaned.phases.length) {
    throw new Error('Plan has no valid steps after validation');
  }

  const vars = cleaned.context.vars;
  if (!vars.editorApp) vars.editorApp = mode.preferredApps?.editor || 'Visual Studio Code';
  if (!vars.browserApp) vars.browserApp = mode.preferredApps?.browser || 'Google Chrome';
  if (!vars.terminalApp) vars.terminalApp = mode.preferredApps?.terminal || 'Terminal';

  if (!vars.projectName) {
    vars.projectName = (intent.goal || 'mr minutes project')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 4)
      .join('-') || 'mr-minutes-project';
  }

  if (!vars.projectPath) {
    vars.projectPath = `~/Desktop/${vars.projectName}`;
  }

  cleaned.estimates = {
    steps: totalSteps,
    phases: cleaned.phases.length,
    minutes: Math.max(1, Math.round(totalSteps * 0.4)),
    humanHandoffs,
    cost: estimateCost(totalSteps),
  };

  const memoryPack = getPlannerMemory(intent);
  cleaned.memoryContext = memoryPack.ctx || null;
  cleaned.memoryLessons = memoryPack.lessons || [];
  cleaned.memoryInjection = memoryPack.injection || '';
  cleaned._memoryInjection = cleaned.memoryInjection;

  return cleaned;
}

async function plan(intent) {
  let rawPlan;

  if (!intent || typeof intent !== 'object') {
    throw new Error('plan(intent) requires an intent object');
  }

  const _cat = (intent.category || '').toUpperCase().replace(/\s+/g, '_');

  // Gate: skip replanning if active task is running and this is a continuation
  if (intent.continuationOf && intent._activeTaskRunning) {
    throw new Error('SKIP_PLAN_ACTIVE_TASK');
  }

  // Cache: reuse recent identical plans
  const cacheKey = hashIntent(intent);
  const cached = _planCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < PLAN_CACHE_TTL_MS && !intent.forceReplan) {
    console.log('[planner] cache hit — reusing plan');
    return cached.plan;
  }

  if (
    _cat === 'SIMPLE_TASK' ||
    _cat === 'APP_LAUNCH' ||
    intent.continuationOf
  ) {
    rawPlan = await buildSimpleExecutablePlan(intent);
  } else {
    rawPlan = await generatePlanWithAI(intent);
    rawPlan = sanitizeHumanHandoffs(rawPlan, intent);
  }

  const validated = validateAndNormalizePlan(rawPlan, intent);

  if (_cat !== 'SIMPLE_TASK' && _cat !== 'APP_LAUNCH') {
    _planCache.set(cacheKey, { plan: validated, cachedAt: Date.now() });
  }

  console.log(
    '[planner] Plan ready —',
    validated.estimates.steps, 'steps,',
    validated.estimates.phases, 'phases,',
    validated.estimates.minutes, 'min,',
    validated.estimates.humanHandoffs, 'handoffs'
  );

  return validated;
}

module.exports = {
  buildPlannerPrompt,
  getPlannerMemory,
  validateAndNormalizePlan,
  generatePlanWithAI,
  plan,
};