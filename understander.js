'use strict';

// ============================================================
// MR. MINUTES — Understander v3
//
// Layer 1 of the brain stack.
//
// Fixes:
// - Removes accidental merged duplicate classifier block
// - Keeps all existing fast paths
// - Adds active-task-aware continuation detection
// - Prevents weak fragments from falling into CONVERSATION
// - Biases classification toward task continuation when a task is active
// - Safer fallback: if AI is unavailable but phrase looks like a continuation,
//   return task intent instead of chat intent
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const modes = require('./modes');
const controller = require('./controller');

// ── HELPERS ───────────────────────────────────────────────────
function normalize(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsAny(cmd, phrases) {
  return phrases.some((p) => cmd.includes(p));
}

function hasOpenVerb(cmd) {
  return containsAny(cmd, ['open ', 'launch ', 'start ', 'bring up ', 'load ']);
}

function sanitize(text) {
  return String(text || '')
    .replace(/[*_#`>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTailAfterKeyword(cmd, keyword) {
  const re = new RegExp(`\\b${escapeRegex(keyword)}\\b([\\s\\S]*)`, 'i');
  const match = cmd.match(re);
  return match ? (match[1] || '').trim() : '';
}

function hasCompoundIntentAfterKeyword(cmd, keyword) {
  const tail = extractTailAfterKeyword(cmd, keyword);
  if (!tail) return false;

  const compoundIndicators = [
    ' and ',
    ' then ',
    ' also ',
    ' after that ',
    ' after ',
    ' plus ',
    ' before ',
    ' but ',
  ];

  const tailPhrases = [
    'search',
    'search for',
    'search up',
    'look up',
    'google',
    'find',
    'report back',
    'report',
    'tell me',
    'summarize',
    'read',
    'check',
    'compare',
    'create',
    'make',
    'write',
    'code',
    'send',
    'message',
    'email',
    'navigate',
    'go to',
    'open ',
    'launch ',
    'start ',
  ];

  if (compoundIndicators.some((indicator) => tail.includes(indicator.trim()) || tail.startsWith(indicator.trim()))) {
    return true;
  }

  if (tailPhrases.some((p) => tail.includes(p))) {
    return true;
  }

  return false;
}

function isSimpleOpenAppCommand(cmd, keyword) {
  const patterns = [
    new RegExp(`^(please\\s+)?open\\s+${escapeRegex(keyword)}\\s*$`, 'i'),
    new RegExp(`^(please\\s+)?launch\\s+${escapeRegex(keyword)}\\s*$`, 'i'),
    new RegExp(`^(please\\s+)?start\\s+${escapeRegex(keyword)}\\s*$`, 'i'),
    new RegExp(`^(please\\s+)?bring up\\s+${escapeRegex(keyword)}\\s*$`, 'i'),
    new RegExp(`^(please\\s+)?load\\s+${escapeRegex(keyword)}\\s*$`, 'i'),
  ];
  return patterns.some((re) => re.test(cmd));
}

function commandMentionsWebsite(cmd) {
  return Object.keys(WEBSITE_MAP).some((name) => cmd.includes(name));
}

function tokenize(text) {
  return normalize(text).split(/\s+/).filter(Boolean);
}

function uniq(arr) {
  return Array.from(new Set((Array.isArray(arr) ? arr : []).filter(Boolean)));
}

function getActiveGoalSafe() {
  try {
    if (typeof controller.getActiveGoal === 'function') {
      return controller.getActiveGoal();
    }
  } catch (err) {
    console.warn('[understander] getActiveGoal failed:', err.message);
  }
  return null;
}

function getActiveTaskContext(provided = null) {
  if (provided && typeof provided === 'object') {
    return {
      raw: provided.raw || provided,
      taskId: provided.taskId || null,
      label: sanitize(provided.label || provided.goal || ''),
      phase: sanitize(provided.phase || provided.phaseName || ''),
      goalText: sanitize(provided.goalText || provided.goal || provided.label || ''),
      apps: uniq([
        provided.app,
        ...(Array.isArray(provided.apps) ? provided.apps : []),
        ...(Array.isArray(provided.plan?.context?.apps) ? provided.plan.context.apps : []),
        ...(Array.isArray(provided.context?.apps) ? provided.context.apps : []),
      ]),
    };
  }

  const activeGoal = getActiveGoalSafe();
  if (!activeGoal) return null;

  return {
    raw: activeGoal,
    taskId: activeGoal.taskId || null,
    label: sanitize(activeGoal.label || activeGoal.goal || ''),
    phase: sanitize(activeGoal.phase || activeGoal.phaseName || ''),
    goalText: sanitize(activeGoal.goal || activeGoal.label || ''),
    apps: uniq([
      activeGoal.app,
      ...(Array.isArray(activeGoal.apps) ? activeGoal.apps : []),
      ...(Array.isArray(activeGoal.plan?.context?.apps) ? activeGoal.plan.context.apps : []),
      ...(Array.isArray(activeGoal.context?.apps) ? activeGoal.context.apps : []),
    ]),
  };
}

function isLikelyQuestion(cmd) {
  if (!cmd) return false;
  return (
    cmd.includes('?') ||
    /^(what|why|when|where|who|how|which|can you explain|tell me about|do you know)\b/i.test(cmd)
  );
}

function isVeryShortFragment(cmd) {
  const words = tokenize(cmd);
  return words.length > 0 && words.length <= 6;
}

function startsWithContinuationVerb(cmd) {
  return /^(then\s+)?(now\s+)?(and\s+)?(continue|resume|keep going|go on|do it|finish it|complete it|save it|send it|write it|put it|type it|open it|name it|call it|title it)\b/i.test(cmd);
}

function isReferentialFragment(cmd) {
  return /\b(it|that|this|them|there|here|same|again|next one|the file|the app|the document|the note)\b/i.test(cmd);
}

function hasContinuationPhrase(cmd) {
  const patterns = [
    /\bcontinue\b/i,
    /\bresume\b/i,
    /\bgo on\b/i,
    /\bkeep going\b/i,
    /\bfinish (it|that|this)\b/i,
    /\bcomplete (it|that|this)\b/i,
    /\bsave (it|that|this)( as .+)?\b/i,
    /\bname (it|that|this) .+\b/i,
    /\bcall (it|that|this) .+\b/i,
    /\btitle (it|that|this) .+\b/i,
    /\bunder the name .+\b/i,
    /\bunder filename .+\b/i,
    /\bsave it under .+\b/i,
    // Tightened — only specific app destinations
    /\bin (word|excel|powerpoint|notion|notes|vs code|cursor|terminal|chrome|safari|figma|slack|gmail)\b/i,
    // Tightened — only file system destinations
    /\bto (desktop|downloads|documents|dropbox|the folder|my folder|the same folder)\b/i,
    // Tightened — only when followed by an action verb
    /\bnow (open|save|close|run|start|stop|create|write|send|delete|rename)\b/i,
    /\bthen (open|save|close|run|start|stop|create|write|send|delete|rename)\b/i,
  ];
  return patterns.some((re) => re.test(cmd));
}

function looksLikeTaskContinuation(cmd, activeTask) {
  if (!cmd || !activeTask) return false;
  if (isLikelyQuestion(cmd)) return false;

  const words = tokenize(cmd);
  const activeWords = new Set(
    tokenize(`${activeTask.label} ${activeTask.goalText} ${activeTask.phase}`).filter(Boolean)
  );

  let overlap = 0;
  for (const w of words) {
    if (activeWords.has(w)) overlap++;
  }

  const appMentioned = activeTask.apps.some((app) => normalize(app) && cmd.includes(normalize(app)));
  const shortRef = isVeryShortFragment(cmd) && (isReferentialFragment(cmd) || startsWithContinuationVerb(cmd));
  const semanticContinuation =
    startsWithContinuationVerb(cmd) ||
    hasContinuationPhrase(cmd) ||
    (isReferentialFragment(cmd) && words.length <= 10) ||
    overlap >= 2 ||
    appMentioned;

  return shortRef || semanticContinuation;
}

function buildContinuationIntent(raw, cmd, activeTask, forceComplexity = null) {
  const category =
    forceComplexity ||
    (activeTask?.apps?.length > 1 ? 'COMPLEX_TASK' : 'SIMPLE_TASK');

  return {
    category,
    confidence: 0.88,
    raw,
    normalized: cmd,
    goal: `${activeTask?.label || activeTask?.goalText || 'Continue current task'} — continuation: ${raw}`,
    apps: activeTask?.apps || [],
    complexity: category === 'COMPLEX_TASK' ? 'medium' : 'low',
    mode: modes.getActiveMode(),
    needsHuman: [],
    fastPath: null,
    continuationOf: activeTask?.taskId || null,
    activeTaskContext: activeTask || null,
  };
}

function coerceClassificationForActiveTask(classification, cmd, activeTask, raw) {
  if (!classification || !activeTask) return classification;

  const continuation = looksLikeTaskContinuation(cmd, activeTask);
  if (!continuation) return classification;

  if (classification.category === 'CONVERSATION') {
    return {
      ...classification,
      category: activeTask.apps.length > 1 ? 'COMPLEX_TASK' : 'SIMPLE_TASK',
      confidence: Math.max(0.8, Number(classification.confidence) || 0),
      goal: classification.goal || `${activeTask.label} — continuation: ${raw}`,
      apps: uniq([...(classification.apps || []), ...activeTask.apps]),
      complexity: activeTask.apps.length > 1 ? 'medium' : 'low',
      needsHuman: classification.needsHuman || [],
      continuationOf: activeTask.taskId,
    };
  }

  return {
    ...classification,
    apps: uniq([...(classification.apps || []), ...activeTask.apps]),
    continuationOf: activeTask.taskId,
  };
}

// ── APP MAP ───────────────────────────────────────────────────
const APP_MAP = {
  'chrome': 'Google Chrome',
  'google chrome': 'Google Chrome',
  'safari': 'Safari',
  'firefox': 'Firefox',
  'edge': 'Microsoft Edge',
  'microsoft edge': 'Microsoft Edge',
  'vs code': 'Visual Studio Code',
  'vscode': 'Visual Studio Code',
  'code': 'Visual Studio Code',
  'cursor': 'Cursor',
  'spotify': 'Spotify',
  'finder': 'Finder',
  'terminal': 'Terminal',
  'iterm': 'iTerm',
  'notes': 'Notes',
  'word': 'Microsoft Word',
  'excel': 'Microsoft Excel',
  'powerpoint': 'Microsoft PowerPoint',
  'slack': 'Slack',
  'discord': 'Discord',
  'notion': 'Notion',
  'figma': 'Figma',
  'zoom': 'Zoom',
  'mail': 'Mail',
  'messages': 'Messages',
  'calculator': 'Calculator',
  'calendar': 'Calendar',
  'photos': 'Photos',
  'maps': 'Maps',
  'xcode': 'Xcode',
  'whatsapp': 'WhatsApp',
  'linear': 'Linear',
  'obsidian': 'Obsidian',
  'arc': 'Arc',
  'brave': 'Brave Browser',
};

const WEBSITE_MAP = {
  youtube: 'https://www.youtube.com',
  instagram: 'https://www.instagram.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  whatsapp: 'https://web.whatsapp.com',
  github: 'https://github.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  linkedin: 'https://www.linkedin.com',
  reddit: 'https://www.reddit.com',
  vercel: 'https://vercel.com',
  netlify: 'https://www.netlify.com',
  figma: 'https://www.figma.com',
  notion: 'https://www.notion.so',
  supabase: 'https://supabase.com',
  chatgpt: 'https://chat.openai.com',
  claude: 'https://claude.ai',
};

// ── FAST PATH ACTION BUILDERS ─────────────────────────────────
function action(type, reply, animation, extras = {}) {
  return { type, reply, animation, ...extras };
}

function sysAction(reply, op) {
  return action('system_action', reply, null, { domain: 'OS_LEVEL', op });
}

function appAction(appName, reply) {
  return action('open_app', reply || `${appName} is open.`, null, {
    domain: 'OS_LEVEL',
    app: appName,
  });
}

function infoAction(reply, anim = 'pointing') {
  return action('info', reply, anim);
}

// ── LOCAL FAST-PATH MATCHERS ──────────────────────────────────
function matchSystemAction(cmd) {
  if (containsAny(cmd, ['volume up', 'turn up', 'louder', 'increase volume'])) return sysAction('Volume up.', 'volume_up');
  if (containsAny(cmd, ['volume down', 'turn down', 'quieter', 'lower volume', 'decrease volume'])) return sysAction('Volume down.', 'volume_down');
  if (cmd.includes('mute') && !cmd.includes('unmute') && !containsAny(cmd, ['yourself', 'stop talking', 'be quiet', 'shut up'])) return sysAction('Muted.', 'mute');
  if (containsAny(cmd, ['unmute sound', 'unmute volume', 'unmute audio', 'turn sound on'])) return sysAction('Sound is back on.', 'unmute');
  if (containsAny(cmd, ['brightness up', 'brighter', 'increase brightness'])) return sysAction('Brightness up.', 'brightness_up');
  if (containsAny(cmd, ['brightness down', 'dimmer', 'lower brightness', 'decrease brightness'])) return sysAction('Brightness down.', 'brightness_down');
  if (containsAny(cmd, ['sleep', 'go to sleep']) && !containsAny(cmd, ['sleepy', 'sleeping'])) return sysAction('Going to sleep. See you soon.', 'sleep');
  if (containsAny(cmd, ['restart', 'reboot'])) return sysAction('Restarting. Back in a moment.', 'restart');
  if (containsAny(cmd, ['shut down', 'shutdown', 'turn off', 'power off'])) return sysAction('Shutting down. Goodbye.', 'shutdown');
  if (containsAny(cmd, ['lock screen', 'lock computer'])) return sysAction('Screen locked.', 'lock');
  if (containsAny(cmd, ['screenshot', 'screen shot', 'capture screen'])) return sysAction('Screenshot taken.', 'screenshot');
  return null;
}

function matchMascotControl(cmd) {
  if (containsAny(cmd, ['go away', 'hide yourself', 'disappear'])) return action('go_away', null, null);
  if (containsAny(cmd, ['come back', 'show yourself', 'come here', 'appear'])) return action('come_back', null, null);
  if (containsAny(cmd, ['be quiet', 'shut up', 'stop talking']) && !containsAny(cmd, ['unmute'])) return action('mute', null, null);
  if (containsAny(cmd, ['speak up', 'talk to me', 'unmute yourself'])) return action('unmute', "I'm back! What do we need?", 'waveHello');
  return null;
}

function matchTimeDate(cmd) {
  if (containsAny(cmd, ["what's the time", "what time is it", 'current time', 'time now'])) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return infoAction(`It's ${t}.`, 'tipHat');
  }
  if (containsAny(cmd, ["what's the date", "what day is it", 'today date', "what's today"])) {
    const d = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    return infoAction(`Today is ${d}.`, 'tipHat');
  }
  return null;
}

function matchModeSwitch(cmd) {
  const match = cmd.match(/(?:switch to|enable|activate|turn on|use)\s+(\w+)\s+mode/i);
  if (match) {
    const modeId = match[1].toLowerCase();
    const result = modes.setMode(modeId);
    if (result.ok) {
      return infoAction(`Switched to ${result.mode.name} mode. I've adjusted my capabilities for you.`, 'waveHello');
    }
    return infoAction(
      `I don't have a mode called "${modeId}". Available modes: ${modes.listModes().map((m) => m.name).join(', ')}.`,
      'thinking'
    );
  }

  if (containsAny(cmd, ['what mode', 'current mode', 'which mode', 'list modes', 'show modes'])) {
    const active = modes.getActiveMode();
    return infoAction(`I'm in ${active.name} mode. ${active.description}`, 'tipHat');
  }

  return null;
}

function matchOpenApp(cmd) {
  if (!hasOpenVerb(cmd)) return null;

  const sorted = Object.entries(APP_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [keyword, appName] of sorted) {
    if (!cmd.includes(keyword)) continue;

    if (
      commandMentionsWebsite(cmd) &&
      !['chrome', 'google chrome', 'safari', 'firefox', 'edge', 'microsoft edge', 'arc', 'brave'].includes(keyword)
    ) {
      return null;
    }

    if (hasCompoundIntentAfterKeyword(cmd, keyword)) return null;
    if (!isSimpleOpenAppCommand(cmd, keyword)) return null;

    return appAction(appName);
  }

  return null;
}

// Detects write/create/draft commands locally — no Groq needed
// Handles: "write X in Word", "create a file called Y", "type Z in Notes", etc.
function matchWriteTask(cmd) {
  const WRITE_VERBS = ['write', 'type', 'draft', 'create', 'compose', 'make'];
  const hasWriteVerb = WRITE_VERBS.some(v => cmd.startsWith(v + ' ') || cmd.includes(' ' + v + ' '));
  if (!hasWriteVerb) return null;

  // Must mention a target app or a file to be a task (not just "write me a poem")
  const APP_MENTIONS = [
    'microsoft word', 'word', 'google docs', 'docs', 'pages',
    'notepad', 'notes', 'textedit', 'notion', 'obsidian',
    'excel', 'microsoft excel', 'numbers', 'google sheets',
    'powerpoint', 'keynote', 'google slides'
  ];
  const FILE_HINTS = ['save', 'file', 'document', 'doc', 'under the name', 'filename', 'named', 'called'];

  const mentionsApp = APP_MENTIONS.some(a => cmd.includes(a));
  const mentionsFile = FILE_HINTS.some(f => cmd.includes(f));

  if (!mentionsApp && !mentionsFile) return null;

  // Detect target app
  let app = 'Microsoft Word'; // default
  for (const a of APP_MENTIONS) {
    if (cmd.includes(a)) {
      const MAP = {
        'word': 'Microsoft Word', 'microsoft word': 'Microsoft Word',
        'google docs': 'Google Chrome', 'docs': 'Google Chrome',
        'pages': 'Pages', 'notes': 'Notes', 'notepad': 'Notepad',
        'textedit': 'TextEdit', 'notion': 'Notion', 'obsidian': 'Obsidian',
        'excel': 'Microsoft Excel', 'microsoft excel': 'Microsoft Excel',
        'numbers': 'Numbers', 'google sheets': 'Google Chrome',
        'powerpoint': 'Microsoft PowerPoint', 'keynote': 'Keynote',
        'google slides': 'Google Chrome',
      };
      app = MAP[a] || 'Microsoft Word';
      break;
    }
  }

  return action('simple_task', null, null, { app, category: 'SIMPLE_TASK' });
}

function matchSpotifyTask(cmd) {
  if (!cmd.includes('spotify')) return null;
  if (!/\b(play|listen|put on|start|queue|shuffle)\b/i.test(cmd)) return null;
  return action('simple_task', null, null, { app: 'Spotify', category: 'SIMPLE_TASK' });
}

function matchWhatsAppTask(cmd) {
  if (!cmd.includes('whatsapp') && !cmd.includes('whats app')) return null;
  if (!/\b(send|message|tell|text|say|write)\b/i.test(cmd)) return null;
  return action('simple_task', null, null, { app: 'WhatsApp', category: 'SIMPLE_TASK' });
}

function matchWebAction(cmd) {
  if (!hasOpenVerb(cmd) && !containsAny(cmd, ['search for ', 'google ', 'look up ', 'search the web for ', 'search up '])) {
    return null;
  }

  for (const [name, url] of Object.entries(WEBSITE_MAP)) {
    if (cmd.includes(name) && hasOpenVerb(cmd)) {
      if (hasCompoundIntentAfterKeyword(cmd, name)) return null;

      return action('computer_use', `Opening ${name}.`, null, {
        domain: 'WEB_LEVEL',
        label: `Open ${name}`,
        steps: [
          { action: 'open_browser', app: 'Google Chrome', pauseAfter: 700 },
          { action: 'open_url', url, pauseAfter: 1600 },
        ],
      });
    }
  }

  const urlMatch = cmd.match(/\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?)\b/i);
  if (urlMatch && hasOpenVerb(cmd)) {
    const matchedUrl = urlMatch[1];

    if (hasCompoundIntentAfterKeyword(cmd, matchedUrl)) return null;

    let url = matchedUrl;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    return action('computer_use', `Opening ${url}.`, null, {
      domain: 'WEB_LEVEL',
      label: 'Open URL',
      steps: [
        { action: 'open_browser', app: 'Google Chrome', pauseAfter: 700 },
        { action: 'open_url', url, pauseAfter: 1600 },
      ],
    });
  }

  const searchMatch =
    cmd.match(/search the web for (.+)$/i) ||
    cmd.match(/search for (.+)$/i) ||
    cmd.match(/search up (.+)$/i) ||
    cmd.match(/google (.+)$/i) ||
    cmd.match(/look up (.+)$/i);

  if (searchMatch) {
    const q = searchMatch[1].trim();
    return action('computer_use', `Searching for ${q}.`, null, {
      domain: 'WEB_LEVEL',
      label: 'Web Search',
      steps: [
        { action: 'open_browser', app: 'Google Chrome', pauseAfter: 700 },
        { action: 'open_url', url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, pauseAfter: 1800 },
      ],
    });
  }

  return null;
}

// ── GROQ AI CLASSIFIER ────────────────────────────────────────
let _cooldownUntil = 0;

function extractRetryDelay(text) {
  const m1 = String(text || '').match(/"retryDelay"\s*:\s*"(\d+)s"/i);
  if (m1) return Number(m1[1]) * 1000;
  const m2 = String(text || '').match(/Please retry in\s+([\d.]+)s/i);
  if (m2) return Math.ceil(Number(m2[1]) * 1000);
  return 30000;
}

async function classifyWithAI(raw, activeTask = null) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'qwen/qwen3-32b';
  if (!apiKey) return null;

  const now = Date.now();
  if (_cooldownUntil > now) return null;

  const modeCtx = modes.getModeContextForPrompt();

  const activeTaskBlock = activeTask
    ? `
Current active task:
- taskId: ${activeTask.taskId || 'unknown'}
- label: ${activeTask.label || 'unknown'}
- goalText: ${activeTask.goalText || 'unknown'}
- phase: ${activeTask.phase || 'unknown'}
- apps: ${(activeTask.apps || []).join(', ') || 'unknown'}

Important continuation rule:
If the user's new utterance looks like a continuation, refinement, destination, filename, save instruction,
or referential fragment related to the active task (examples: "save it as ai", "continue", "in Word", "under downloads"),
DO NOT classify it as CONVERSATION. Prefer SIMPLE_TASK or COMPLEX_TASK continuation.
`
    : `
There is no active task in progress.
`;

  const prompt = `You are the intent classifier for Mr. Minutes, a desktop AI agent.

${modeCtx}

${activeTaskBlock}

Classify the following user request. Return ONLY valid JSON, no other text.

User said: "${raw}"

Categories:
- OS_ACTION: volume, brightness, screenshot, sleep, restart, shutdown, lock
- APP_LAUNCH: open a specific app
- WEB_ACTION: open a website, search the web
- SIMPLE_TASK: single-app task, few steps
- COMPLEX_TASK: multi-step, multi-app, or requires code/deployment/research
- CONVERSATION: question, chat, no computer action needed
- MODE_SWITCH: user wants to change operating mode

Rules:
1. If the task requires terminal, git, deployment, file creation, or multi-app coordination → COMPLEX_TASK
2. If it requires one app and a few keyboard steps → SIMPLE_TASK
3. If it's purely conversational or factual → CONVERSATION
4. If an active task exists and the utterance appears to continue it, refine it, or finish it, DO NOT use CONVERSATION
5. Respect the active mode. If the mode disallows an action, note it in needsHuman.
6. Be honest about confidence.

Return this exact JSON structure:
{
  "category": string,
  "confidence": number,
  "goal": string,
  "apps": string[],
  "complexity": "low" | "medium" | "high",
  "needsHuman": string[],
  "suggestModeSwitch": string | null
}`;

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
        temperature: 0.1,
        max_tokens: 512,
        reasoning_format: 'hidden',
        reasoning_effort: 'none',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) _cooldownUntil = Date.now() + extractRetryDelay(errText);
      console.error('[understander] Groq classify error:', res.status);
      return null;
    }

    const data = await res.json();
    const rawReply = sanitize(
      String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '')
    );

    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[understander] classify error:', err.message);
    return null;
  }
}

// ── MAIN UNDERSTAND FUNCTION ──────────────────────────────────
async function understand(heard, options = {}) {
  const raw = (heard || '').trim();
  if (!raw) {
    return {
      category: 'CONVERSATION',
      confidence: 1,
      raw,
      normalized: '',
      goal: '',
      apps: [],
      complexity: 'low',
      mode: modes.getActiveMode(),
      needsHuman: [],
      fastPath: action('ai_response', "I didn't catch that — say it again?", 'thinking'),
    };
  }

  const cmd = normalize(raw);
  const activeTask = getActiveTaskContext(options.activeTaskContext || null);

  console.log('[understander] ←', cmd);
  if (activeTask) {
    console.log('[understander] activeTask →', activeTask.label || activeTask.taskId);
  }

  const localMatchers = [
    matchSystemAction,
    matchMascotControl,
    matchTimeDate,
    matchModeSwitch,
    matchSpotifyTask,
    matchWhatsAppTask,
    matchWriteTask,
    matchWebAction,
    matchOpenApp,
  ];

  for (const matcher of localMatchers) {
    const result = matcher(cmd);
    if (result) {
      console.log('[understander] fast-path →', result.type);
      modes.detectModeFromInput(cmd);
      return {
        category: resolveCategory(result.type),
        confidence: 1,
        raw,
        normalized: cmd,
        goal: raw,
        apps: result.app ? [result.app] : [],
        complexity: 'low',
        mode: modes.getActiveMode(),
        needsHuman: [],
        fastPath: result,
        activeTaskContext: activeTask,
      };
    }
  }

  if (activeTask && looksLikeTaskContinuation(cmd, activeTask)) {
    console.log('[understander] task-continuation fast-bias → active task');
    const modeDetect = modes.detectModeFromInput(cmd);
    return {
      ...buildContinuationIntent(raw, cmd, activeTask),
      suggestedMode: modeDetect.suggested ? modeDetect.mode : null,
    };
  }

  const modeDetect = modes.detectModeFromInput(cmd);
  let classification = await classifyWithAI(raw, activeTask);

  if (!classification) {
    if (activeTask && looksLikeTaskContinuation(cmd, activeTask)) {
      console.log('[understander] AI unavailable, falling back to ACTIVE TASK continuation');
      return {
        ...buildContinuationIntent(raw, cmd, activeTask),
        confidence: 0.78,
        suggestedMode: modeDetect.suggested ? modeDetect.mode : null,
      };
    }

    console.log('[understander] AI unavailable, falling back to CONVERSATION');

    // Try local write task detection before giving up
    const localWrite = matchWriteTask(cmd);
    if (localWrite) {
      console.log('[understander] AI down — local write matcher rescued classification');
      return {
        category: 'SIMPLE_TASK',
        confidence: 0.85,
        raw,
        normalized: cmd,
        goal: raw,
        apps: localWrite.app ? [localWrite.app] : [],
        complexity: 'low',
        mode: modes.getActiveMode(),
        needsHuman: [],
        fastPath: null,
        activeTaskContext: activeTask,
      };
    }

    return {
      category: 'CONVERSATION',
      confidence: 0.5,
      raw,
      normalized: cmd,
      goal: raw,
      apps: [],
      complexity: 'low',
      mode: modes.getActiveMode(),
      needsHuman: [],
      fastPath: null,
      activeTaskContext: activeTask,
    };
  }

  classification = coerceClassificationForActiveTask(classification, cmd, activeTask, raw);

  console.log(
    `[understander] AI classified → ${classification.category} ` +
    `(${Math.round((classification.confidence || 0) * 100)}% confidence, ` +
    `complexity: ${classification.complexity})`
  );

  if (classification.suggestModeSwitch && modeDetect.suggested) {
    console.log(`[understander] Mode switch suggested → ${modeDetect.mode.name}`);
  }

  return {
    category: classification.category,
    confidence: classification.confidence,
    raw,
    normalized: cmd,
    goal: classification.goal,
    apps: classification.apps || [],
    complexity: classification.complexity,
    mode: modes.getActiveMode(),
    needsHuman: classification.needsHuman || [],
    fastPath: null,
    suggestedMode: modeDetect.suggested ? modeDetect.mode : null,
    continuationOf: classification.continuationOf || null,
    activeTaskContext: activeTask,
  };
}

function resolveCategory(type) {
  const map = {
    system_action: 'OS_ACTION',
    open_app: 'APP_LAUNCH',
    computer_use: 'WEB_ACTION',
    info: 'CONVERSATION',
    go_away: 'MASCOT_CONTROL',
    come_back: 'MASCOT_CONTROL',
    mute: 'MASCOT_CONTROL',
    unmute: 'MASCOT_CONTROL',
    simple_task: 'SIMPLE_TASK',
    complex_task: 'COMPLEX_TASK',
  };
  return map[type] || 'CONVERSATION';
}

module.exports = { understand };