'use strict';

// ============================================================
// MR. MINUTES — systemEnvironment.js v1
//
// THE MISSING REALITY LAYER.
//
// Problem: The planner has always been a smart brain inside a
// hallucination-friendly void. It knows modes, intents, and
// action primitives — but it has never known WHAT IS ACTUALLY
// ON THIS MACHINE RIGHT NOW.
//
// This module fixes that. It runs once at startup, probes the
// real macOS environment, builds a verified app registry, and
// exposes a prompt-injection block that gets prepended to every
// planner call so the LLM cannot hallucinate apps or paths.
//
// What it detects:
//   • OS + version
//   • Home/Desktop/Downloads paths
//   • Which apps are installed (via /Applications + ~/Applications)
//   • Which apps are currently running (via pgrep / ps)
//   • Default browser (via macOS LSCopyDefaultApplicationURLForURL)
//   • Hard-forbidden app mappings per task domain
//   • Canonical app name → process name mappings
//
// API:
//   await systemEnvironment.init()          — run at startup
//   systemEnvironment.getPromptBlock()      — inject into planner
//   systemEnvironment.isAppInstalled(name)  — boolean check
//   systemEnvironment.isAppRunning(name)    — boolean check
//   systemEnvironment.resolveApp(alias)     — canonical app name or null
//   systemEnvironment.snapshot()            — full state object
// ============================================================

const { execSync, exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── CANONICAL APP MAP ─────────────────────────────────────────
// Maps every known alias / hallucination bait → canonical .app name
// Add entries here as you discover new planner hallucinations.
const APP_ALIASES = {
  // Editors
  'vscode':                  'Visual Studio Code',
  'vs code':                 'Visual Studio Code',
  'visual studio code':      'Visual Studio Code',
  'visual studio':           'Visual Studio Code',   // common hallucination
  'cursor':                  'Cursor',
  'sublime':                 'Sublime Text',
  'sublime text':            'Sublime Text',
  'atom':                    'Atom',
  'webstorm':                'WebStorm',
  'xcode':                   'Xcode',
  'zed':                     'Zed',

  // Browsers
  'chrome':                  'Google Chrome',
  'google chrome':           'Google Chrome',
  'firefox':                 'Firefox',
  'safari':                  'Safari',
  'arc':                     'Arc',
  'brave':                   'Brave Browser',
  'edge':                    'Microsoft Edge',
  'opera':                   'Opera',

  // Terminals
  'terminal':                'Terminal',
  'iterm':                   'iTerm',
  'iterm2':                  'iTerm',
  'warp':                    'Warp',
  'alacritty':               'Alacritty',
  'hyper':                   'Hyper',
  'ghostty':                 'Ghostty',

  // Office / docs
  'word':                    'Microsoft Word',
  'microsoft word':          'Microsoft Word',
  'excel':                   'Microsoft Excel',
  'microsoft excel':         'Microsoft Excel',
  'powerpoint':              'Microsoft PowerPoint',
  'microsoft powerpoint':    'Microsoft PowerPoint',
  'outlook':                 'Microsoft Outlook',
  'microsoft outlook':       'Microsoft Outlook',
  'pages':                   'Pages',
  'apple pages':             'Pages',
  'numbers':                 'Numbers',
  'apple numbers':           'Numbers',
  'keynote':                 'Keynote',
  'apple keynote':           'Keynote',
  'notion':                  'Notion',
  'obsidian':                'Obsidian',
  'notes':                   'Notes',
  'apple notes':             'Notes',
  'bear':                    'Bear',

  // Communication
  'slack':                   'Slack',
  'discord':                 'Discord',
  'zoom':                    'Zoom',
  'teams':                   'Microsoft Teams',
  'microsoft teams':         'Microsoft Teams',
  'whatsapp':                'WhatsApp',
  'telegram':                'Telegram',
  'messages':                'Messages',
  'mail':                    'Mail',
  'apple mail':              'Mail',
  'facetime':                'FaceTime',

  // Media
  'spotify':                 'Spotify',
  'vlc':                     'VLC',
  'quicktime':               'QuickTime Player',
  'youtube':                 'Google Chrome',       // web app → browser

  // Utilities / OS
  'finder':                  'Finder',
  'file manager':            'Finder',              // common hallucination
  'files':                   'Finder',
  'file explorer':           'Finder',
  'activity monitor':        'Activity Monitor',
  'system preferences':      'System Preferences',
  'system settings':         'System Settings',     // macOS 13+
  'calculator':              'Calculator',
  'calendar':                'Calendar',
  'reminders':               'Reminders',
  'maps':                    'Maps',

  // Dev tools
  'figma':                   'Figma',
  'postman':                 'Postman',
  'insomnia':                'Insomnia',
  'tableplus':               'TablePlus',
  'sequelpro':               'Sequel Pro',
  'docker':                  'Docker',
  'sourcetree':              'Sourcetree',
  'github desktop':          'GitHub Desktop',
};

// ── FORBIDDEN APP MAPPINGS ────────────────────────────────────
// Per task-domain: apps the planner must NEVER suggest.
// These become hard negative constraints in the prompt block.
const FORBIDDEN_FOR_DOMAIN = {
  web_development: [
    'Apple Pages', 'Pages', 'Microsoft Word', 'Word',
    'Numbers', 'Microsoft Excel', 'Keynote', 'Microsoft PowerPoint',
    'TextEdit',
  ],
  file_management: [
    // "file manager" hallucination → always use Finder on macOS
  ],
  coding: [
    'Apple Pages', 'Pages', 'Microsoft Word', 'TextEdit',
    'Numbers', 'Keynote',
  ],
  document_writing: [
    // intentionally empty — Word/Pages are valid here
  ],
};

// ── PROCESS NAME MAP ──────────────────────────────────────────
// Canonical app name → macOS process name (for pgrep checks)
const PROCESS_NAMES = {
  'Visual Studio Code': 'Electron',   // VS Code runs as Electron
  'Cursor':             'Cursor',
  'Google Chrome':      'Google Chrome',
  'Firefox':            'firefox',
  'Safari':             'Safari',
  'Arc':                'Arc',
  'Terminal':           'Terminal',
  'iTerm':              'iTerm2',
  'Warp':               'Warp',
  'Microsoft Word':     'Microsoft Word',
  'Microsoft Excel':    'Microsoft Excel',
  'Slack':              'Slack',
  'Spotify':            'Spotify',
  'Finder':             'Finder',
  'Figma':              'Figma',
  'Notion':             'Notion',
  'WhatsApp':           'WhatsApp',
  'Discord':            'Discord',
  'Zoom':               'zoom.us',
};

// ── STATE ─────────────────────────────────────────────────────
let _initialized = false;
let _state = {
  os: {
    platform: 'macos',
    version: null,
    arch: null,
  },
  paths: {
    home:      os.homedir(),
    desktop:   path.join(os.homedir(), 'Desktop'),
    downloads: path.join(os.homedir(), 'Downloads'),
    documents: path.join(os.homedir(), 'Documents'),
  },
  apps: {
    installed: [],      // canonical names of installed .app bundles
    running:   [],      // canonical names of currently-running apps
    defaultBrowser: null,
  },
  promptBlock: '',      // cached prompt injection string
  scannedAt: null,
};

// ── HELPERS ───────────────────────────────────────────────────
function run(cmd) {
  try {
    return execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function appExists(canonicalName) {
  const appPath1 = `/Applications/${canonicalName}.app`;
  const appPath2 = `${os.homedir()}/Applications/${canonicalName}.app`;
  return fs.existsSync(appPath1) || fs.existsSync(appPath2);
}

function scanInstalledApps() {
  // Get every .app name in /Applications and ~/Applications
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  const found = new Set();
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith('.app')) {
          found.add(entry.replace(/\.app$/, ''));
        }
      }
    } catch { /* dir may not exist */ }
  }
  return [...found].sort();
}

function scanRunningApps() {
  // Use 'ps -A' to get running process names
  const psOut = run('ps -A -o comm=');
  if (!psOut) return [];
  const procs = new Set(psOut.split('\n').map(p => path.basename(p.trim())));
  const running = [];
  for (const [canonical, procName] of Object.entries(PROCESS_NAMES)) {
    if (procs.has(procName) || procs.has(canonical)) {
      running.push(canonical);
    }
  }
  return running;
}

function detectDefaultBrowser() {
  // Use AppleScript to ask macOS which browser handles http://
  const result = run(`osascript -e 'tell application "Finder" to get name of (info for (path to front application))'`);
  // Fallback: check for common browsers in order of likelihood
  const candidates = ['Arc', 'Google Chrome', 'Firefox', 'Safari', 'Brave Browser', 'Microsoft Edge'];
  for (const b of candidates) {
    if (appExists(b)) return b;
  }
  return 'Safari'; // macOS always has Safari
}

function getOSVersion() {
  return run('sw_vers -productVersion') || 'unknown';
}

// ── BUILD PROMPT BLOCK ────────────────────────────────────────
function buildPromptBlock() {
  const { installed, running, defaultBrowser } = _state.apps;
  const { home, desktop } = _state.paths;

  // Which key apps are confirmed installed?
  const keyApps = [
    'Visual Studio Code', 'Cursor', 'Sublime Text',
    'Google Chrome', 'Firefox', 'Safari', 'Arc', 'Brave Browser',
    'Terminal', 'iTerm', 'Warp',
    'Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint', 'Microsoft Outlook',
    'Pages', 'Numbers', 'Keynote',
    'Slack', 'Discord', 'Zoom', 'WhatsApp', 'Telegram',
    'Spotify', 'Figma', 'Notion', 'Obsidian', 'Docker',
  ];

  const confirmedInstalled = keyApps.filter(a => installed.includes(a));
  const confirmedMissing   = keyApps.filter(a => !installed.includes(a));

  const runningList = running.length ? running.join(', ') : 'none detected';

  // Build the forbidden-apps section
  const forbiddenLines = Object.entries(FORBIDDEN_FOR_DOMAIN)
    .filter(([, apps]) => apps.length > 0)
    .map(([domain, apps]) => `  - ${domain}: NEVER use ${apps.join(', ')}`)
    .join('\n');

  return `
SYSTEM REALITY (verified at startup — treat as GROUND TRUTH)
════════════════════════════════════════════════════════════
OS: macOS ${_state.os.version} (${_state.os.arch})
Home: ${home}
Desktop: ${desktop}

INSTALLED APPS (confirmed on disk):
${confirmedInstalled.length ? confirmedInstalled.map(a => `  ✅ ${a}`).join('\n') : '  (none of the key apps found)'}

NOT INSTALLED (do NOT suggest these):
${confirmedMissing.length ? confirmedMissing.map(a => `  ❌ ${a}`).join('\n') : '  (all key apps installed)'}

CURRENTLY RUNNING: ${runningList}
DEFAULT BROWSER: ${defaultBrowser || 'Safari'}

APP SUBSTITUTION RULES (macOS):
  - "file manager" → use Finder (NEVER "file manager" — it does not exist on macOS)
  - "file explorer" → use Finder
  - "text editor"   → use ${confirmedInstalled.includes('Visual Studio Code') ? 'Visual Studio Code' : confirmedInstalled.includes('Cursor') ? 'Cursor' : 'TextEdit'}

FORBIDDEN APP MAPPINGS (hard constraints):
${forbiddenLines || '  (none)'}

CRITICAL RULES:
1. ONLY suggest apps from the INSTALLED list above. If an app is ❌ NOT INSTALLED, use the best available substitute.
2. For file management on macOS, ALWAYS use "Finder" — never "file manager", "files", or "file explorer".
3. For web development tasks, NEVER open Word, Pages, Numbers, Keynote, or any office/document app.
4. If the preferred editor is NOT INSTALLED, fall back to the next available: ${
  confirmedInstalled.find(a => ['Visual Studio Code','Cursor','Sublime Text','TextEdit'].includes(a)) || 'TextEdit'
}.
════════════════════════════════════════════════════════════
`.trim();
}

// ── PUBLIC API ────────────────────────────────────────────────

async function init() {
  if (_initialized) return snapshot();

  _state.os.version  = getOSVersion();
  _state.os.arch     = os.arch();
  _state.apps.installed     = scanInstalledApps();
  _state.apps.running       = scanRunningApps();
  _state.apps.defaultBrowser = detectDefaultBrowser();
  _state.promptBlock = buildPromptBlock();
  _state.scannedAt   = new Date().toISOString();
  _initialized = true;

  console.log(`[sysEnv] macOS ${_state.os.version} | ${_state.apps.installed.length} apps found | browser: ${_state.apps.defaultBrowser}`);
  console.log(`[sysEnv] Running: ${_state.apps.running.join(', ') || 'none'}`);

  return snapshot();
}

// Re-scan running apps (cheap, call before each plan)
function refreshRunning() {
  _state.apps.running  = scanRunningApps();
  _state.promptBlock   = buildPromptBlock(); // rebuild with fresh running list
  return _state.apps.running;
}

function getPromptBlock() {
  if (!_initialized) {
    return '⚠️  systemEnvironment not initialized — call init() at startup.';
  }
  return _state.promptBlock;
}

function isAppInstalled(name) {
  const canonical = resolveApp(name) || name;
  return _state.apps.installed.includes(canonical);
}

function isAppRunning(name) {
  const canonical = resolveApp(name) || name;
  return _state.apps.running.includes(canonical);
}

// Resolve any alias or hallucinated name → canonical app name
// Returns null if the canonical app is not installed.
function resolveApp(nameOrAlias) {
  if (!nameOrAlias) return null;
  const key = String(nameOrAlias).toLowerCase().trim();
  const canonical = APP_ALIASES[key] || nameOrAlias;
  // Return canonical only if it's actually installed (or is Finder, which always exists)
  if (canonical === 'Finder') return 'Finder';
  if (_state.apps.installed.includes(canonical)) return canonical;
  return null;
}

// Best available app for a role ('editor', 'browser', 'terminal')
function bestAppForRole(role) {
  const preferences = {
    editor:   ['Cursor', 'Visual Studio Code', 'Sublime Text', 'Zed', 'TextEdit'],
    browser:  ['Arc', 'Google Chrome', 'Firefox', 'Brave Browser', 'Safari'],
    terminal: ['Warp', 'iTerm', 'Terminal', 'Alacritty'],
    notes:    ['Notion', 'Obsidian', 'Bear', 'Notes'],
  };
  const list = preferences[role] || [];
  return list.find(a => _state.apps.installed.includes(a)) || null;
}

function snapshot() {
  return JSON.parse(JSON.stringify(_state));
}

module.exports = {
  init,
  refreshRunning,
  getPromptBlock,
  isAppInstalled,
  isAppRunning,
  resolveApp,
  bestAppForRole,
  snapshot,
  APP_ALIASES,
  FORBIDDEN_FOR_DOMAIN,
};