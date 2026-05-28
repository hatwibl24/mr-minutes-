// ============================================================
// MR. MINUTES — capabilityRegistry.js v1
//
// Single source of truth for what the agent can actually do.
//
// Problems it solves:
//   • brain.js was building plans based on guessed action names
//   • executer.js silently returned "Unknown step action" errors
//   • No runtime check: does the platform support this action?
//   • No way to inspect or enumerate available capabilities
//
// Concepts:
//   Capability:  a named thing the agent can do (action, verb, skill)
//   Category:    grouping — input, navigation, ocr, filesystem, process,
//                           deploy, visual, spatial, system
//   Platform:    'mac' | 'windows' | 'linux' | 'all'
//   Cost:        rough execution cost  1=cheap, 5=expensive
//   Aliases:     alternative action names mapped to canonical name
//
// API:
//   register(cap)              → registers or updates a capability
//   registerAll(caps)          → bulk register array
//   resolve(nameOrAlias)       → canonical capability object or null
//   has(nameOrAlias)           → boolean
//   check(nameOrAlias)         → { ok, reason }  platform-aware
//   list(filter?)              → filtered capability array
//   getActionsForBrain()       → compact list for brain prompt injection
//   assertSupported(name)      → throws if unsupported on current platform
// ============================================================

'use strict';

const _platform = process.platform === 'darwin'  ? 'mac'
                : process.platform === 'win32'    ? 'windows'
                : 'linux';

const _registry = new Map();
const _aliases  = new Map();

function _norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

function register(cap) {
  if (!cap?.name) throw new TypeError('[capabilityRegistry] register(): cap.name required');
  const key = _norm(cap.name);
  const entry = {
    name:        key,
    label:       cap.label       || key,
    description: cap.description || '',
    category:    cap.category    || 'misc',
    platform:    cap.platform    || 'all',
    cost:        cap.cost        || 1,
    requires:    Array.isArray(cap.requires) ? cap.requires.map(_norm) : [],
    aliases:     Array.isArray(cap.aliases)  ? cap.aliases.map(_norm)  : [],
    params:      cap.params      || [],
    examples:    cap.examples    || [],
    tags:        Array.isArray(cap.tags) ? cap.tags.map(_norm) : [],
    deprecated:  !!cap.deprecated,
  };
  _registry.set(key, entry);
  for (const alias of entry.aliases) _aliases.set(alias, key);
  _aliases.set(key, key);
  return entry;
}

function registerAll(caps) {
  for (const cap of caps) register(cap);
}

function resolve(nameOrAlias) {
  const key = _norm(nameOrAlias);
  const canonical = _aliases.get(key) || key;
  return _registry.get(canonical) || null;
}

function has(nameOrAlias) {
  return resolve(nameOrAlias) !== null;
}

function check(nameOrAlias) {
  const cap = resolve(nameOrAlias);
  if (!cap)          return { ok: false, reason: `unknown capability: "${nameOrAlias}"` };
  if (cap.deprecated) return { ok: false, reason: `"${cap.name}" is deprecated` };
  if (cap.platform !== 'all' && cap.platform !== _platform) {
    return { ok: false, reason: `"${cap.name}" requires ${cap.platform}, running on ${_platform}` };
  }
  return { ok: true, cap };
}

function assertSupported(nameOrAlias) {
  const result = check(nameOrAlias);
  if (!result.ok) throw new Error(`[capabilityRegistry] ${result.reason}`);
  return result.cap;
}

function list(filter = {}) {
  return [..._registry.values()].filter((cap) => {
    if (filter.category  && cap.category !== filter.category) return false;
    if (filter.platform  && cap.platform !== 'all' && cap.platform !== filter.platform) return false;
    if (filter.tag       && !cap.tags.includes(_norm(filter.tag))) return false;
    if (filter.available !== undefined) {
      const c = check(cap.name);
      if (filter.available && !c.ok) return false;
      if (!filter.available && c.ok) return false;
    }
    return !cap.deprecated || !!filter.includeDeprecated;
  });
}

function getActionsForBrain() {
  return list({ available: true })
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map((cap) => ({
      name:        cap.name,
      category:    cap.category,
      description: cap.description,
      examples:    cap.examples,
      params:      cap.params,
      cost:        cap.cost,
    }));
}

// ── Built-in catalogue ────────────────────────────────────────
registerAll([
  // INPUT
  { name: 'click',           label: 'Click',                 category: 'input',      platform: 'all', cost: 1,
    description: 'Left-click at x,y or at a found text target.',
    aliases: ['left_click'],
    params: [{ name: 'x', required: false }, { name: 'y', required: false }, { name: 'target', required: false }] },
  { name: 'right_click',     label: 'Right-click',           category: 'input',      platform: 'all', cost: 1,
    description: 'Right-click at x,y or at a found text target.',
    params: [{ name: 'x', required: false }, { name: 'y', required: false }, { name: 'target', required: false }] },
  { name: 'double_click',    label: 'Double-click',          category: 'input',      platform: 'all', cost: 1,
    description: 'Double-click at x,y or at a found text target.',
    aliases: ['doubleclick'] },
  { name: 'type',            label: 'Type text',             category: 'input',      platform: 'all', cost: 2,
    description: 'Type a string character-by-character.',
    params: [{ name: 'text', required: true }] },
  { name: 'paste',           label: 'Paste text',            category: 'input',      platform: 'all', cost: 1,
    description: 'Paste text via clipboard.',
    params: [{ name: 'text', required: true }] },
  { name: 'type_smart',      label: 'Smart type',            category: 'input',      platform: 'all', cost: 2,
    description: 'Type short text, paste long text above threshold.',
    aliases: ['typesmart'],
    params: [{ name: 'text', required: true }, { name: 'pasteThreshold', required: false }] },
  { name: 'clear_and_type',  label: 'Clear and type',        category: 'input',      platform: 'all', cost: 2,
    description: 'Select all, clear, then type new text.',
    aliases: ['clearandtype'],
    params: [{ name: 'text', required: true }] },
  { name: 'key',             label: 'Press key',             category: 'input',      platform: 'all', cost: 1,
    description: 'Press a key or combo (e.g. cmd+s, enter, escape).',
    params: [{ name: 'key', required: true }] },
  { name: 'press_sequence',  label: 'Press key sequence',    category: 'input',      platform: 'all', cost: 2,
    description: 'Press multiple keys in order with optional pause.',
    aliases: ['presssequence'] },
  { name: 'press_until',     label: 'Press until text',      category: 'input',      platform: 'all', cost: 3,
    description: 'Repeat a key until a target text appears on screen.',
    aliases: ['pressuntil'] },
  { name: 'scroll_down',     label: 'Scroll down',           category: 'input',      platform: 'all', cost: 1, aliases: ['scrolldown'] },
  { name: 'scroll_up',       label: 'Scroll up',             category: 'input',      platform: 'all', cost: 1, aliases: ['scrollup'] },
  { name: 'scroll_left',     label: 'Scroll left',           category: 'input',      platform: 'all', cost: 1, aliases: ['scrollleft'] },
  { name: 'scroll_right',    label: 'Scroll right',          category: 'input',      platform: 'all', cost: 1, aliases: ['scrollright'] },
  { name: 'drag',            label: 'Drag',                  category: 'input',      platform: 'all', cost: 2,
    description: 'Click and drag from one coordinate to another.' },
  { name: 'drag_by',         label: 'Drag by offset',        category: 'input',      platform: 'all', cost: 2, aliases: ['dragby'] },
  { name: 'drag_path',       label: 'Drag along path',       category: 'input',      platform: 'all', cost: 3, aliases: ['dragpath'] },
  { name: 'mouse_hold',      label: 'Hold mouse button',     category: 'input',      platform: 'all', cost: 1, aliases: ['mousehold'] },
  { name: 'mouse_release',   label: 'Release mouse',         category: 'input',      platform: 'all', cost: 1, aliases: ['mouserelease'] },
  { name: 'move_by',         label: 'Move mouse by offset',  category: 'input',      platform: 'all', cost: 1, aliases: ['moveby'] },
  { name: 'move_smooth',     label: 'Move mouse smoothly',   category: 'input',      platform: 'all', cost: 1, aliases: ['movesmooth'] },
  { name: 'nudge_mouse',     label: 'Nudge mouse',           category: 'input',      platform: 'all', cost: 1, aliases: ['nudgemouse'] },

  // NAVIGATION
  { name: 'focus_app',       label: 'Focus app',             category: 'navigation', platform: 'all', cost: 1,
    description: 'Bring an application window to focus.',
    aliases: ['focusapp'],
    params: [{ name: 'app', required: true }] },
  { name: 'ensure_app',      label: 'Ensure app ready',      category: 'navigation', platform: 'all', cost: 3,
    description: 'Launch if not running, focus, wait for ready.',
    aliases: ['ensureapp'] },
  { name: 'launch_app',      label: 'Launch app',            category: 'navigation', platform: 'all', cost: 2,
    description: 'Open an application by name.',
    aliases: ['launchapp', 'openapp'],
    params: [{ name: 'app', required: true }],
    examples: ['launch_app Terminal', 'launch_app Google Chrome'] },
  { name: 'focus_and_type',  label: 'Focus app and type',    category: 'navigation', platform: 'all', cost: 3,
    aliases: ['focusandtype'] },
  { name: 'open_editor',     label: 'Open editor',           category: 'navigation', platform: 'all', cost: 2, aliases: ['openeditor'] },
  { name: 'open_browser',    label: 'Open browser',          category: 'navigation', platform: 'all', cost: 2, aliases: ['openbrowser'] },
  { name: 'open_terminal',   label: 'Open terminal',         category: 'navigation', platform: 'all', cost: 2, aliases: ['openterminal'] },
  { name: 'open_url',        label: 'Open URL',              category: 'navigation', platform: 'all', cost: 2,
    aliases: ['openurl'], params: [{ name: 'url', required: true }] },
  { name: 'open_project',    label: 'Open project folder',   category: 'navigation', platform: 'all', cost: 3, aliases: ['openproject'] },
  { name: 'open_preview',    label: 'Open preview URL',      category: 'navigation', platform: 'all', cost: 2, aliases: ['openpreview'] },

  // OCR
  { name: 'find_text',           label: 'Find text on screen',      category: 'ocr', platform: 'all', cost: 2,
    description: 'OCR-locate text on screen, returns coordinates.',
    aliases: ['findtext'], params: [{ name: 'target', required: true }] },
  { name: 'find_text_any',       label: 'Find any of texts',        category: 'ocr', platform: 'all', cost: 2, aliases: ['findtextany'] },
  { name: 'find_and_click',      label: 'Find text and click',      category: 'ocr', platform: 'all', cost: 3,
    description: 'OCR-locate text then click it.',
    aliases: ['findandclick'], params: [{ name: 'target', required: true }] },
  { name: 'retry_click',         label: 'Retry find and click',     category: 'ocr', platform: 'all', cost: 3, aliases: ['retryclick'] },
  { name: 'wait_for',            label: 'Wait for text',            category: 'ocr', platform: 'all', cost: 3,
    description: 'Poll screen until target text appears.',
    aliases: ['waitfor'], params: [{ name: 'target', required: true }, { name: 'timeout', required: false }] },
  { name: 'wait_for_any',        label: 'Wait for any text',        category: 'ocr', platform: 'all', cost: 3, aliases: ['waitforany'] },
  { name: 'wait_for_gone',       label: 'Wait for text gone',       category: 'ocr', platform: 'all', cost: 3, aliases: ['waitforgone'] },
  { name: 'wait_and_click',      label: 'Wait then click',          category: 'ocr', platform: 'all', cost: 3, aliases: ['waitandclick'] },
  { name: 'scroll_and_find',     label: 'Scroll and find',          category: 'ocr', platform: 'all', cost: 4, aliases: ['scrollandfind'] },
  { name: 'scroll_until',        label: 'Scroll until text',        category: 'ocr', platform: 'all', cost: 4, aliases: ['scrolluntil'] },
  { name: 'wait_for_app_ready',  label: 'Wait for app ready',       category: 'ocr', platform: 'all', cost: 4, aliases: ['waitforappready'] },

  // FILESYSTEM
  { name: 'create_folder',  label: 'Create folder',   category: 'filesystem', platform: 'all', cost: 1,
    aliases: ['createfolder'], params: [{ name: 'path', required: true }] },
  { name: 'create_file',    label: 'Create file',     category: 'filesystem', platform: 'all', cost: 1,
    aliases: ['createfile'], params: [{ name: 'path', required: true }] },
  { name: 'write_file',     label: 'Write file',      category: 'filesystem', platform: 'all', cost: 1,
    aliases: ['writefile'], params: [{ name: 'path', required: true }, { name: 'text', required: true }] },
  { name: 'append_file',    label: 'Append to file',  category: 'filesystem', platform: 'all', cost: 1, aliases: ['appendfile'] },
  { name: 'read_file',      label: 'Read file',       category: 'filesystem', platform: 'all', cost: 1, aliases: ['readfile'] },
  { name: 'path_exists',    label: 'Check path',      category: 'filesystem', platform: 'all', cost: 1, aliases: ['pathexists'] },

  // PROCESS
  { name: 'run_command',    label: 'Run shell command',      category: 'process', platform: 'all', cost: 3,
    description: 'Execute a shell command; supports background mode.',
    aliases: ['runcommand'], params: [{ name: 'command', required: true }],
    examples: ['run_command npm install', 'run_command git push origin main'] },
  { name: 'stop_command',   label: 'Stop background process', category: 'process', platform: 'all', cost: 1, aliases: ['stopcommand'] },
  { name: 'wait_for_server', label: 'Wait for server ready', category: 'process', platform: 'all', cost: 3,
    aliases: ['waitforserver'], params: [{ name: 'url', required: true }] },
  { name: 'osascript',      label: 'Run AppleScript',        category: 'process', platform: 'mac', cost: 2,
    description: 'Execute an AppleScript snippet.', aliases: ['runosascript', 'run_osascript'] },

  // DEPLOY
  { name: 'push_repo',      label: 'Push git repo',   category: 'deploy', platform: 'all', cost: 4,
    aliases: ['pushrepo'], examples: ['push_repo to origin main'] },
  { name: 'deploy_project', label: 'Deploy project',  category: 'deploy', platform: 'all', cost: 5, aliases: ['deployproject'] },
  { name: 'set_domain',     label: 'Set domain',      category: 'deploy', platform: 'all', cost: 3, aliases: ['setdomain'] },

  // VISUAL
  { name: 'find_image',          label: 'Find image',           category: 'visual', platform: 'all', cost: 4, aliases: ['findimage'] },
  { name: 'find_image_any',      label: 'Find any image',       category: 'visual', platform: 'all', cost: 4, aliases: ['findimageany'] },
  { name: 'click_image',         label: 'Click image',          category: 'visual', platform: 'all', cost: 4, aliases: ['clickimage'] },
  { name: 'wait_for_image',      label: 'Wait for image',       category: 'visual', platform: 'all', cost: 4, aliases: ['waitforimage'] },
  { name: 'wait_for_image_gone', label: 'Wait for image gone',  category: 'visual', platform: 'all', cost: 4, aliases: ['waitforimagegone'] },
  { name: 'find_color',          label: 'Find color',           category: 'visual', platform: 'all', cost: 3, aliases: ['findcolor'] },

  // SPATIAL
  { name: 'save_point',        label: 'Save screen point',         category: 'spatial', platform: 'all', cost: 1, aliases: ['savepoint'] },
  { name: 'save_region',       label: 'Save screen region',        category: 'spatial', platform: 'all', cost: 1, aliases: ['saveregion'] },
  { name: 'click_point',       label: 'Click saved point',         category: 'spatial', platform: 'all', cost: 2, aliases: ['clickpoint'] },
  { name: 'drag_points',       label: 'Drag between saved points', category: 'spatial', platform: 'all', cost: 2, aliases: ['dragpoints'] },
  { name: 'snapshot_region',   label: 'Snapshot region',           category: 'spatial', platform: 'all', cost: 2, aliases: ['snapshotregion'] },
  { name: 'compare_snapshot',  label: 'Compare snapshots',         category: 'spatial', platform: 'all', cost: 3, aliases: ['comparesnapshot'] },
  { name: 'verify_changed',    label: 'Verify region changed',     category: 'spatial', platform: 'all', cost: 3, aliases: ['verifychanged'] },
  { name: 'verify_unchanged',  label: 'Verify region unchanged',   category: 'spatial', platform: 'all', cost: 3, aliases: ['verifyunchanged'] },
  { name: 'search_grid',       label: 'Search screen grid',        category: 'spatial', platform: 'all', cost: 4, aliases: ['searchgrid'] },
  { name: 'search_spiral',     label: 'Search screen spiral',      category: 'spatial', platform: 'all', cost: 4, aliases: ['searchspiral'] },
  { name: 'click_near',        label: 'Click near point',          category: 'spatial', platform: 'all', cost: 2, aliases: ['clicknear'] },
  { name: 'micro_adjust',      label: 'Micro-adjust click',        category: 'spatial', platform: 'all', cost: 3, aliases: ['microadjust'] },
  { name: 'refine_click',      label: 'Refine click',              category: 'spatial', platform: 'all', cost: 4, aliases: ['refineclick'] },

  // SYSTEM
  { name: 'sleep',           label: 'Sleep (delay)',  category: 'system',  platform: 'all', cost: 1,
    description: 'Wait for a number of milliseconds.', params: [{ name: 'ms', required: true }] },
  { name: 'screenshot',      label: 'Take screenshot', category: 'system',  platform: 'all', cost: 2 },
  { name: 'set_volume',      label: 'Set volume',      category: 'system',  platform: 'all', cost: 1, aliases: ['setvolume'] },
  { name: 'mute_volume',     label: 'Mute',            category: 'system',  platform: 'all', cost: 1, aliases: ['mutevolume'] },
  { name: 'unmute_volume',   label: 'Unmute',          category: 'system',  platform: 'all', cost: 1, aliases: ['unmutevolume'] },
  { name: 'set_brightness',  label: 'Set brightness',  category: 'system',  platform: 'mac', cost: 1, aliases: ['setbrightness'] },
  { name: 'sleep_system',    label: 'Sleep system',    category: 'system',  platform: 'all', cost: 5, aliases: ['sleepsystem'] },
  { name: 'lock_screen',     label: 'Lock screen',     category: 'system',  platform: 'all', cost: 3, aliases: ['lockscreen'] },
]);

module.exports = { register, registerAll, resolve, has, check, assertSupported, list, getActionsForBrain };