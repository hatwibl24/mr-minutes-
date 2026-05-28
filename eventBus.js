// ============================================================
// MR. MINUTES — eventBus.js v1
//
// A lightweight, synchronous-first pub/sub bus.
// Every module that needs to signal others uses this instead
// of scattered _emit / callback chains.
//
// Design rules:
//   • Synchronous by default — dispatch is O(n), no back-pressure
//   • Async subscribers supported via on(event, fn, { async: true })
//     but their promise is fire-and-forget from the bus's perspective
//   • Wildcard '*' catches every event
//   • Namespace wildcard: 'task:*' catches 'task:started', 'task:failed', etc.
//   • Once: on(event, fn, { once: true }) or once(event, fn)
//   • Off:  off(event, fn) or call the returned unsubscribe function
//   • Error isolation: a crashing subscriber is caught, logged, and
//     automatically removed so it never blocks sibling subscribers
//
// Usage:
//   const bus = require('./eventBus');
//   const unsub = bus.on('task:completed', ({ event, payload }) => { ... });
//   bus.emit('task:completed', { taskId, label });
//   unsub(); // stop listening
//
// Exported API:
//   on(event, fn, opts?)      → unsubscribe()
//   once(event, fn)           → unsubscribe()
//   off(event, fn)
//   emit(event, payload?)     → number of listeners called
//   emitAsync(event, payload?) → Promise<void>  (waits for async listeners)
//   clear(event?)             → clears one channel or all
//   listenerCount(event?)     → count
//   eventNames()              → string[]
//   EVENTS                    → frozen canonical event name constants
// ============================================================

'use strict';

// Internal registry: Map<channel, Set<entry>>
const _listeners = new Map();

function _get(event) {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  return _listeners.get(event);
}

function _makeEntry(fn, opts) {
  return {
    fn,
    once:  !!opts.once,
    async: !!opts.async,
    id:    `_sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
}

// 'task:completed' -> 'task:*' ;  'world_patch' -> null
function _wildcardOf(event) {
  const idx = event.indexOf(':');
  return idx > 0 ? event.slice(0, idx + 1) + '*' : null;
}

// All channels that should fire for a given event name
function _channelsFor(event) {
  const ch = [event];
  const wc = _wildcardOf(event);
  if (wc && wc !== event) ch.push(wc);
  if (event !== '*') ch.push('*');
  return ch;
}

function _dispatchSync(entry, event, payload, channel, remove) {
  try {
    if (entry.once) remove(entry);
    entry.fn({ event, payload, channel });
  } catch (err) {
    console.error(`[eventBus] listener error on "${event}" (id: ${entry.id}):`, err.message);
    remove(entry);
  }
}

async function _dispatchAsync(entry, event, payload, channel, remove) {
  try {
    if (entry.once) remove(entry);
    await entry.fn({ event, payload, channel });
  } catch (err) {
    console.error(`[eventBus] async listener error on "${event}" (id: ${entry.id}):`, err.message);
    remove(entry);
  }
}

// ── subscribe ────────────────────────────────────────────────
function on(event, fn, opts = {}) {
  if (typeof event !== 'string' || !event) throw new TypeError('[eventBus] on(): event must be a non-empty string');
  if (typeof fn !== 'function')            throw new TypeError('[eventBus] on(): fn must be a function');
  const set   = _get(event);
  const entry = _makeEntry(fn, opts);
  set.add(entry);
  return function unsubscribe() {
    const s = _listeners.get(event);
    if (s) s.delete(entry);
  };
}

function once(event, fn) {
  return on(event, fn, { once: true });
}

function off(event, fn) {
  const set = _listeners.get(event);
  if (!set) return;
  for (const entry of set) {
    if (entry.fn === fn) { set.delete(entry); break; }
  }
}

// ── emit (synchronous) ───────────────────────────────────────
function emit(event, payload = null) {
  if (typeof event !== 'string' || !event) return 0;
  let called = 0;
  for (const channel of _channelsFor(event)) {
    const set = _listeners.get(channel);
    if (!set || set.size === 0) continue;
    // snapshot so once-removal is safe mid-iteration
    for (const entry of [...set]) {
      if (entry.async) {
        _dispatchAsync(entry, event, payload, channel, (e) => set.delete(e)).catch(() => null);
      } else {
        _dispatchSync(entry, event, payload, channel, (e) => set.delete(e));
      }
      called++;
    }
  }
  return called;
}

// ── emitAsync (awaits all async subscribers) ─────────────────
async function emitAsync(event, payload = null) {
  if (typeof event !== 'string' || !event) return;
  const promises = [];
  for (const channel of _channelsFor(event)) {
    const set = _listeners.get(channel);
    if (!set || set.size === 0) continue;
    for (const entry of [...set]) {
      if (entry.async) {
        promises.push(_dispatchAsync(entry, event, payload, channel, (e) => set.delete(e)));
      } else {
        _dispatchSync(entry, event, payload, channel, (e) => set.delete(e));
      }
    }
  }
  await Promise.allSettled(promises);
}

// ── management ───────────────────────────────────────────────
function clear(event) {
  if (event) {
    _listeners.delete(event);
  } else {
    _listeners.clear();
  }
}

function listenerCount(event) {
  if (!event) {
    let total = 0;
    for (const s of _listeners.values()) total += s.size;
    return total;
  }
  return _listeners.get(event)?.size || 0;
}

function eventNames() {
  return [..._listeners.keys()].filter((k) => (_listeners.get(k)?.size || 0) > 0);
}

// ── canonical event name constants ──────────────────────────
// Import EVENTS in other modules to avoid magic strings.
const EVENTS = Object.freeze({
  // Task lifecycle
  TASK_QUEUED:           'task:queued',
  TASK_STARTED:          'task:started',
  TASK_COMPLETED:        'task:completed',
  TASK_FAILED:           'task:failed',
  TASK_CANCELLED:        'task:cancelled',
  TASK_INTERRUPTED:      'task:interrupted',
  TASK_RESUME:           'task:resume',
  TASK_BLOCKED:          'task:blocked',
  TASK_WAITING:          'task:waiting',

  // Phase lifecycle
  PHASE_STARTED:         'phase:started',
  PHASE_COMPLETED:       'phase:completed',
  PHASE_FAILED:          'phase:failed',

  // Step lifecycle
  STEP_STARTED:          'step:started',
  STEP_SUCCEEDED:        'step:succeeded',
  STEP_FAILED:           'step:failed',
  STEP_RETRY:            'step:retry',
  STEP_FALLBACK:         'step:fallback',
  STEP_SKIPPED:          'step:skipped',
  OCR_MISS:              'step:ocr_miss',

  // Verification
  VERIFY_PASSED:         'verify:passed',
  VERIFY_WARNED:         'verify:warned',
  VERIFY_FAILED:         'verify:failed',

  // Memory
  MEMORY_LEARNED:        'memory:learned',
  MEMORY_REINFORCED:     'memory:reinforced',
  MEMORY_PRUNED:         'memory:pruned',

  // Health
  HEALTH_UPDATED:        'health:updated',
  HEALTH_DEGRADED:       'health:degraded',
  HEALTH_RECOVERED:      'health:recovered',

  // World model
  WORLD_PATCHED:         'world:patched',
  WORLD_EVENT:           'world:event',

  // User
  USER_INPUT:            'user:input',
  USER_INTERRUPT:        'user:interrupt',

  // System
  STARTUP_COMPLETE:      'system:startup_complete',
  STARTUP_ERROR:         'system:startup_error',
  BEFORE_QUIT:           'system:before_quit',

  // Scheduler
  SCHEDULER_TICK:        'scheduler:tick',
  SCHEDULER_IDLE:        'scheduler:idle',
  SCHEDULER_FINISHED:    'scheduler:finished',
});

module.exports = { on, once, off, emit, emitAsync, clear, listenerCount, eventNames, EVENTS };