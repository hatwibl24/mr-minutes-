// ============================================================
//  MR. MINUTES — Speech Engine v3
//  Original voice quality. Lightweight sync layer only.
// ============================================================

"use strict";

// ── CORE ENGINE ───────────────────────────────────────────────
function browserSpeak(text, onEnd = null) {
  const synth = window.speechSynthesis;
  synth.cancel();
  const utt   = new SpeechSynthesisUtterance(text);
  utt.rate    = 0.95;
  utt.pitch   = 1.1;
  utt.volume  = 1;
  if (onEnd) utt.onend = onEnd;
  synth.speak(utt);
}

// ── SYNCHRONIZED WRAPPER ──────────────────────────────────────
// Adds onStart / onWord / onEnd / onError hooks for animation
// and subtitle sync. Voice settings are identical to original.
window.mrMinutesSpeak = (text, callbacks = {}) => {
  const {
    onStart = null,
    onWord  = null,
    onEnd   = null,
    onError = null,
  } = callbacks;

  const synth = window.speechSynthesis;
  synth.cancel();

  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 0.95;
  utt.pitch  = 1.1;
  utt.volume = 1;

  const words = text.split(" ");
  let wordIndex = 0;

  utt.onstart = () => {
    onStart?.();
  };

  utt.onboundary = (e) => {
    if (e.name !== "word") return;
    const progressive = words.slice(0, wordIndex + 1).join(" ");
    wordIndex++;
    onWord?.(progressive, text, e.charIndex);
  };

  utt.onend = () => {
    onEnd?.();
  };

  utt.onerror = (err) => {
    // interrupted / canceled are normal flow — treat as end
    if (err.error === "interrupted" || err.error === "canceled") {
      onEnd?.();
      return;
    }
    onError?.(err);
  };

  synth.speak(utt);
};

// ── SAFE CANCEL ───────────────────────────────────────────────
window.mrMinutesCancel = () => {
  try { window.speechSynthesis.cancel(); } catch (_) {}
};

// ── TEXT INPUT BOX ────────────────────────────────────────────
// Follows Mr. Minutes wherever he goes.
// Toggle: double-click the mascot, OR press Cmd+Shift+Space.
// Submit: Enter key or the ▶ button.
// The command goes through the exact same brainCommand IPC path
// as voice — so the planner/executer handle it identically.

window.mrMinutesTextInput = (function () {
  const wrap    = document.getElementById('text-input-wrap');
  const input   = document.getElementById('text-input');
  const sendBtn = document.getElementById('text-send-btn');

  if (!wrap || !input || !sendBtn) return { isOpen: false, reposition: () => {} };

  let isOpen = false;

  // Called every frame by move.js applyTransform so the box
  // always sits above the mascot regardless of where he walked.
  // mascotX, mascotY = top-left pixel of the mascot element
  // mascotW = current rendered width (changes with depth scale)
  function reposition(mascotX, mascotY, mascotW) {
    if (!isOpen) return;
    const boxW = wrap.offsetWidth || 298;   // input(260) + gap(6) + btn(32)
    // centre the box horizontally over the mascot, 12px above him
    const left = mascotX + mascotW / 2 - boxW / 2;
    const top  = mascotY - wrap.offsetHeight - 12;
    wrap.style.left = `${left}px`;
    wrap.style.top  = `${top}px`;
  }

  function open() {
    isOpen = true;
    wrap.style.display = 'flex';
    setTimeout(() => input.focus(), 40);
  }

  function close() {
    isOpen = false;
    input.value = '';
    wrap.style.display = 'none';
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    close();
    if (window.electronAPI?.brainCommand) {
      try {
        const action = await window.electronAPI.brainCommand(text.toLowerCase());
        // Fire through the same action executor as voice commands
        if (typeof window.mrMinutesExecuteAction === 'function') {
          window.mrMinutesExecuteAction(action);
        }
      } catch (err) {
        console.error('[text-input] brainCommand error:', err);
      }
    }
  }

  sendBtn.addEventListener('click', (e) => { e.stopPropagation(); submit(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  wrap.addEventListener('click',      (e) => e.stopPropagation());
  wrap.addEventListener('mousedown',  (e) => e.stopPropagation());

  // Cmd+Shift+Space global hotkey
  document.addEventListener('keydown', (e) => {
    if (e.metaKey && e.shiftKey && e.code === 'Space') {
      e.preventDefault();
      toggle();
    }
  });

  return { get isOpen() { return isOpen; }, reposition, toggle, open, close };
})();