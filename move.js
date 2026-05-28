// ============================================================
// MR. MINUTES — Renderer / Move System v3
//
// Fixes:
// - Real speech queue: no dropped replies while already speaking
// - Idle chatter blocked during active conversations
// - Keeps current brain/main/preload integration intact
// ============================================================

const mascot = document.getElementById("mascot");
const stage = document.getElementById("stage");
const bubble = document.getElementById("bubble");

let W = window.innerWidth;
let H = window.innerHeight;

const BASE_SIZE = 220;
const CONVERSATION_IDLE_BLOCK_MS = 20000;

const APP_POSITIONS = {
  "Google Chrome": () => ({ x: 200, y: H - 80 }),
  "Safari": () => ({ x: 260, y: H - 80 }),
  "Firefox": () => ({ x: 320, y: H - 80 }),
  "Microsoft Edge": () => ({ x: 380, y: H - 80 }),
  "Finder": () => ({ x: 80, y: H - 80 }),
  "Mail": () => ({ x: 440, y: H - 80 }),
  "Messages": () => ({ x: 500, y: H - 80 }),
  "Spotify": () => ({ x: 560, y: H - 80 }),
  "Discord": () => ({ x: 620, y: H - 80 }),
  "Slack": () => ({ x: 680, y: H - 80 }),
  "Notion": () => ({ x: 740, y: H - 80 }),
  "Zoom": () => ({ x: 800, y: H - 80 }),
  "Figma": () => ({ x: 860, y: H - 80 }),
  "Visual Studio Code": () => ({ x: 920, y: H - 80 }),
  "Cursor": () => ({ x: 980, y: H - 80 }),
  "Terminal": () => ({ x: 1040, y: H - 80 }),
  "Notes": () => ({ x: 1100, y: H - 80 }),
  "Calendar": () => ({ x: 1160, y: H - 80 }),
  "Calculator": () => ({ x: 1220, y: H - 80 }),
  "Microsoft Word": () => ({ x: 1280, y: H - 80 }),
  "Microsoft Excel": () => ({ x: 1340, y: H - 80 }),
  "Microsoft PowerPoint": () => ({ x: 1400, y: H - 80 }),
};

function getAppPosition(appName) {
  const getter = APP_POSITIONS[appName];
  if (getter) return getter();
  return { x: W * 0.5, y: H - 80 };
}

let x = W / 2 - BASE_SIZE / 2;
let y = H - BASE_SIZE - 20;
let facingRight = true;
let isMoving = false;
let onScreen = true;
let isMuted = false;
let isExecutingOSCommand = false;
let awaitingBrain = false;
let conversationUntil = 0;

let startupProtection = true;
setTimeout(() => {
  startupProtection = false;
  console.log("✅ Startup protection off");
}, 5000);

const ANIMS = {
  idle: "./idle.webm",
  walk: "./walk.webm",
  tipHat: "./tip-hat.webm",
  waveHello: "./wave-hello.webm",
  waveGoodbye: "./wave-goodbye.webm",
  thinking: "./thinking.webm",
  celebrate: "./celebrate.webm",
  talking: "./talking.webm",
  pointing: "./pointing.webm",
  tap: "./tap.webm",
};

let animLocked = false;

function playAnim(name, loop = true, onEnd = null) {
  if (!ANIMS[name]) return;
  mascot.src = ANIMS[name];
  mascot.loop = loop;
  mascot.play();
  mascot.onended = onEnd
    ? () => {
        mascot.onended = null;
        onEnd();
      }
    : null;
}

function playOnce(name, then = "idle", hold = 0) {
  animLocked = true;
  playAnim(name, false, () => {
    if (hold > 0) {
      setTimeout(() => {
        animLocked = false;
        playAnim(then, true);
      }, hold);
    } else {
      animLocked = false;
      playAnim(then, true);
    }
  });
}

// ── SPEECH / CONVERSATION STATE ──────────────────────────────
let isSpeaking = false;
let speechCycleActive = false;
let speechQueue = [];

function setSpeechState(state) {
  window.electronAPI?.setSpeechState(state);
}

function markConversation(ms = CONVERSATION_IDLE_BLOCK_MS) {
  conversationUntil = Math.max(conversationUntil, Date.now() + ms);
}

function isConversationActive() {
  return (
    awaitingBrain ||
    isSpeaking ||
    speechCycleActive ||
    speechQueue.length > 0 ||
    Date.now() < conversationUntil
  );
}

function sanitizeSpeechText(text) {
  return String(text || "")
    .replace(/[*_#`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clearSpeechQueue() {
  speechQueue = [];
}

function enqueueSpeech(text, then = "idle", options = {}) {
  const clean = sanitizeSpeechText(text);
  if (!clean || isMuted) return;

  const item = {
    text: clean,
    then,
    priority: options.priority || "normal",
  };

  if (item.priority === "high") {
    speechQueue.unshift(item);
  } else {
    speechQueue.push(item);
  }

  markConversation();
  maybeStartNextSpeech();
}

function maybeStartNextSpeech() {
  if (isMuted || isSpeaking || speechCycleActive) return;
  const next = speechQueue.shift();
  if (!next) return;
  startSpeech(next.text, next.then);
}

function finishSpeech(returnAnim = "idle", shouldResume = false, continueQueue = false) {
  isSpeaking = false;
  speechCycleActive = false;
  animLocked = false;

  if (returnAnim) playAnim(returnAnim, true);

  if (continueQueue) {
    setSpeechState({ isSpeaking: false, echoLock: true });
    setTimeout(() => {
      maybeStartNextSpeech();
    }, 100);
    return;
  }

  setSpeechState({ isSpeaking: false, echoLock: true });

  if (shouldResume) {
    setTimeout(() => {
      console.log("▶️ Resuming listener after TTS");
      window.electronAPI?.resumeListener();
      setTimeout(() => {
        setSpeechState({ isSpeaking: false, echoLock: false });
        console.log("🔓 Echo lock released");
      }, 800);
    }, 1500);
  } else {
    setTimeout(() => {
      setSpeechState({ isSpeaking: false, echoLock: false });
      console.log("🔓 Echo lock released (no resume)");
    }, 800);
  }
}

function startSpeech(text, then = "idle") {
  if (isMuted) return;
  if (!text || !text.trim()) return;

  speechCycleActive = true;
  isSpeaking = true;
  markConversation();

  console.log("🗣 Mr. Minutes:", text);

  const shouldPause = !startupProtection;
  const speakFn = window.mrMinutesSpeak;

  if (!speakFn) {
    finishSpeech(then, false, false);
    return;
  }

  speakFn(text, {
    onStart() {
      animLocked = true;
      setSpeechState({ isSpeaking: true, echoLock: true });
      playAnim("talking", true);

      if (shouldPause) {
        console.log("⏸ Pausing listener — speech started");
        window.electronAPI?.pauseListener();
      }
    },

    onWord(progressiveText) {
      if (bubble) {
        bubble.textContent = progressiveText;
        bubble.classList.add("show");
      }
    },

    onEnd() {
      hideBubbleAfterDelay(1200);
      const continueQueue = speechQueue.length > 0;
      finishSpeech(then, shouldPause && !continueQueue, continueQueue);
    },

    onError(err) {
      console.error("❌ Speech error in talkAndSay:", err?.message || err);
      hideBubble();
      const continueQueue = speechQueue.length > 0;
      finishSpeech(then, shouldPause && !continueQueue, continueQueue);
    },
  });
}

function talkAndSay(text, then = "idle", options = {}) {
  enqueueSpeech(text, then, options);
}

function hardStopSpeech() {
  try { window.mrMinutesCancel?.(); } catch (_) {}
  clearSpeechQueue();
  hideBubble();
  isSpeaking = false;
  speechCycleActive = false;
  animLocked = false;
  setSpeechState({ isSpeaking: false, echoLock: false });
  playAnim("idle", true);
}

// ── SPEECH BUBBLE ─────────────────────────────────────────────
let bubbleTimer = null;

function showBubble(text) {
  if (!bubble) return;
  bubble.textContent = text || "";
  bubble.classList.add("show");
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove("show"), 4000);
}

function hideBubble() {
  if (!bubble) return;
  if (bubbleTimer) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  bubble.classList.remove("show");
}

function hideBubbleAfterDelay(ms) {
  if (!bubble) return;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.classList.remove("show");
    bubbleTimer = null;
  }, ms);
}

function positionBubble() {
  if (!bubble) return;
  bubble.style.left = `${x + BASE_SIZE / 2}px`;
  bubble.style.top = `${y - 18}px`;
  bubble.style.transform = "translate(-50%, -100%)";
}

// ── DEPTH & TRANSFORM ─────────────────────────────────────────
function applyDepthScale() {
  const minScale = 0.55;
  const maxScale = 1.2;
  const ratio = (y - H * 0.1) / (H * 0.9);
  const scale = minScale + (maxScale - minScale) * Math.max(0, Math.min(1, ratio));
  const size = BASE_SIZE * scale;
  mascot.style.width = `${size}px`;
  mascot.style.height = `${size}px`;
}

function applyTransform() {
  mascot.style.transform = `translate(${x}px, ${y}px) scaleX(${facingRight ? 1 : -1})`;
  positionBubble();
  // keep the text input box above the mascot wherever he is
  if (window.mrMinutesTextInput?.isOpen) {
    const renderedW = parseFloat(mascot.style.width) || BASE_SIZE;
    window.mrMinutesTextInput.reposition(x, y, renderedW);
  }
}

// ── MOVEMENT ──────────────────────────────────────────────────
function moveTo(tx, ty, onArrival = null) {
  if (animLocked) return;

  isMoving = true;
  facingRight = tx > x;
  playAnim("walk", true);

  const interval = setInterval(() => {
    const dx = tx - x;
    const dy = ty - y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 5) {
      x = tx;
      y = ty;
      isMoving = false;
      clearInterval(interval);
      applyDepthScale();
      applyTransform();
      if (!animLocked) playAnim("idle", true);
      if (onArrival) onArrival();
    } else {
      x += (dx / dist) * 4;
      y += (dy / dist) * 4;
      facingRight = dx > 0;
      applyDepthScale();
      applyTransform();
    }
  }, 16);
}

function wanderRandomly() {
  if (animLocked || isMoving || !onScreen) return;
  moveTo(
    randomBetween(40, W - BASE_SIZE - 40),
    randomBetween(H * 0.15, H - BASE_SIZE - 20)
  );
}

// ── GO AWAY / COME BACK ───────────────────────────────────────
function goAway() {
  if (!onScreen) return;
  onScreen = false;
  talkAndSay("I'll be right here if you need me!");

  setTimeout(() => {
    facingRight = false;
    playAnim("walk", true);

    const t = setInterval(() => {
      x -= 8;
      applyTransform();

      if (x < -BASE_SIZE - 20) {
        clearInterval(t);
        mascot.style.display = "none";
        playAnim("idle", true);
      }
    }, 16);
  }, 2500);
}

function comeBack() {
  if (onScreen) return;
  onScreen = true;
  mascot.style.display = "block";
  x = -BASE_SIZE;
  y = H - BASE_SIZE - 20;
  facingRight = true;
  playAnim("walk", true);
  applyDepthScale();
  applyTransform();

  const t = setInterval(() => {
    x += 6;
    applyTransform();

    if (x >= W / 2 - BASE_SIZE / 2) {
      clearInterval(t);
      x = W / 2 - BASE_SIZE / 2;
      playOnce("waveHello", "idle");
      setTimeout(() => talkAndSay("I'm back! What do we need?"), 1500);
    }
  }, 16);
}

function tapTarget(tx, ty, times = 1, onDone = null) {
  moveTo(tx - BASE_SIZE / 2, ty - BASE_SIZE, () => {
    let count = 0;

    function doTap() {
      if (count >= times) {
        if (onDone) onDone();
        return;
      }
      count++;
      playOnce("tap", "idle");
      setTimeout(doTap, 800);
    }

    doTap();
  });
}

// ── GREETING ──────────────────────────────────────────────────
function getTimeGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good morning! Ready to make today count?";
  if (h >= 12 && h < 17) return "Good afternoon! Hope the day's treating you well!";
  if (h >= 17 && h < 21) return "Good evening! Still at it I see!";
  return "Burning the midnight oil are we? I'm here with you!";
}

// ── STARTUP ───────────────────────────────────────────────────
function startup() {
  x = W / 2 - BASE_SIZE / 2;
  y = H + BASE_SIZE;
  applyDepthScale();
  applyTransform();
  mascot.style.display = "block";
  playAnim("walk", true);

  const t = setInterval(() => {
    y -= 6;
    applyDepthScale();
    applyTransform();

    if (y <= H - BASE_SIZE - 20) {
      clearInterval(t);
      y = H - BASE_SIZE - 20;
      setTimeout(() => {
        playOnce("tipHat", "idle");
        setTimeout(() => talkAndSay(getTimeGreeting()), 1200);
      }, 300);
    }
  }, 16);
}

// ── ACTION EXECUTOR ───────────────────────────────────────────
function executeBrainAction(action) {
  if (!action) return;

  const { type, reply, animation, app: appName } = action;

  switch (type) {
    case "open_app":
      if (appName) window.electronAPI?.openApp(appName);
      if (!animLocked) playOnce("tipHat", "idle");
      if (reply) setTimeout(() => talkAndSay(reply), 400);
      break;

    case "system_action":
      isExecutingOSCommand = true;
      markConversation();
      window.electronAPI?.systemAction(action.op)
        .then(() => {
          isExecutingOSCommand = false;
          if (reply) talkAndSay(reply);
        })
        .catch((err) => {
          isExecutingOSCommand = false;
          console.error("❌ System action failed:", err);
          talkAndSay("Something went wrong with that.");
        });
      break;

    case "computer_use":
      markConversation();
      if (reply) talkAndSay(reply);
      window.electronAPI?.computerUse(action);
      break;

    case "go_away":
      goAway();
      break;

    case "come_back":
      comeBack();
      break;

    case "mute":
      isMuted = true;
      hardStopSpeech();
      playAnim("idle", true);
      break;

    case "unmute":
      isMuted = false;
      hardStopSpeech();
      if (reply) setTimeout(() => talkAndSay(reply), 100);
      break;

    case "celebrate":
      playOnce("celebrate", "idle", 2500);
      if (reply) setTimeout(() => talkAndSay(reply), 1200);
      break;

    case "greeting":
      playOnce("waveHello", "idle");
      if (reply) talkAndSay(reply);
      break;

    case "farewell":
      playOnce("waveGoodbye", "idle");
      if (reply) talkAndSay(reply);
      break;

    case "info":
      if (animation && !animLocked) playOnce(animation, "idle");
      if (reply) talkAndSay(reply);
      break;

    case "ai_response":
    default:
      markConversation();
      if (!animLocked) playOnce(animation || "thinking", "idle");
      if (reply) talkAndSay(reply);
      break;
  }
}

// ── EXECUTION PROGRESS ────────────────────────────────────────
if (window.electronAPI?.onExecutionProgress) {
  window.electronAPI.onExecutionProgress((progress) => {
    const { type, status, action, ok, animHint } = progress || {};

    if (type === "task") {
      if (status === "started") {
        showBubble("On it.");
        if (!animLocked) playOnce("thinking", "idle");
        return;
      }

      if (status === "completed") {
        showBubble("Done.");
        if (!animLocked) playOnce("celebrate", "idle", 1200);
        return;
      }

      if (status === "failed" || status === "cancelled") {
        showBubble(progress.error || "Something went wrong.");
        if (!animLocked) playOnce("thinking", "idle");
        return;
      }

      return;
    }

    if (status === "retrying" || status === "fallback") {
      if (!animLocked) playOnce("thinking", "idle");
      return;
    }

    if (status === "failed" || ok === false) {
      if (!animLocked) playOnce("thinking", "idle");
      return;
    }

    if (status !== "started" && status !== "succeeded" && status !== "success" && ok == null) {
      return;
    }

    if (animHint) {
      if (!animLocked) playOnce(animHint, "idle");
      return;
    }

    switch (action) {
      case "type":
      case "paste":
      case "type_smart":
      case "clear_and_type":
      case "run_command":
      case "write_file":
      case "append_file":
      case "read_file":
      case "wait_for_server":
        if (!animLocked) playOnce("thinking", "idle");
        break;

      case "find_and_click":
      case "wait_and_click":
      case "click":
      case "double_click":
      case "key":
        if (!animLocked) playOnce("tap", "idle");
        break;

      case "focus_app":
      case "launch_app":
      case "open_editor":
      case "open_browser":
      case "open_terminal":
      case "open_project":
      case "open_preview":
      case "open_url":
        if (!animLocked) playOnce("pointing", "idle");
        break;

      case "scroll_down":
      case "scroll_up":
        if (!animLocked) playAnim("walk", true);
        break;

      default:
        break;
    }
  });
}

// ── TASK STATE ────────────────────────────────────────────────
if (window.electronAPI?.onTaskState) {
  window.electronAPI.onTaskState((state) => {
    const { status, error } = state || {};

    switch (status) {
      case "started":
        showBubble("Working...");
        break;
      case "cancelling":
        showBubble("Stopping...");
        break;
      case "completed":
        showBubble("Finished.");
        break;
      case "failed":
        showBubble(error || "Task failed.");
        break;
      case "cancelled":
        showBubble("Stopped.");
        break;
      default:
        break;
    }
  });
}

// ── VOICE COMMAND RECEIVER ────────────────────────────────────
if (window.electronAPI?.onVoiceCommand) {
  window.electronAPI.onVoiceCommand(async (payload) => {
    const heard = (
      typeof payload === "string" ? payload : (payload?.heard || "")
    ).toLowerCase().trim();

    if (!heard) return;

    console.log("📩 Heard:", heard);
    awaitingBrain = true;
    markConversation();

    let action;
    try {
      action = await window.electronAPI.brainCommand(heard);
    } catch (err) {
      console.error("❌ brainCommand failed:", err);
      action = { type: "ai_response", reply: "I didn't catch that.", animation: "thinking" };
    } finally {
      awaitingBrain = false;
      markConversation();
    }

    console.log("🧠 Action:", action?.type);
    executeBrainAction(action);
  });
}

// ── RANDOM IDLE BEHAVIOUR ─────────────────────────────────────
const IDLE_PHRASES = [
  "Tick tock! Time waits for no one.",
  "Need a hand with anything?",
  "Right on time, as always.",
  "What are we working on today?",
  "You're doing great — keep it up.",
  "At your service.",
];

function randomBehaviour() {
  if (animLocked || isMoving || !onScreen || isMuted || isExecutingOSCommand) return;
  if (isConversationActive()) return;

  const roll = Math.random();
  if (roll < 0.35) wanderRandomly();
  else if (roll < 0.55) talkAndSay(IDLE_PHRASES[Math.floor(Math.random() * IDLE_PHRASES.length)]);
  else if (roll < 0.65) playOnce("tipHat", "idle");
  else if (roll < 0.75) playOnce("thinking", "idle");
}

// ── RENDER LOOP ───────────────────────────────────────────────
function loop() {
  applyTransform();
  requestAnimationFrame(loop);
}

// ── CLICK ─────────────────────────────────────────────────────
// Single click → random phrase (existing behaviour)
// Double click → toggle text input box
let lastClickTime = 0;

mascot.addEventListener("click", (e) => {
  const now = Date.now();
  const isDouble = (now - lastClickTime) < 350;
  lastClickTime = now;

  if (isDouble) {
    // double-click: open/close keyboard input box
    window.mrMinutesTextInput?.toggle();
    return;
  }

  // single click — run after short delay so double-click can cancel it
  setTimeout(() => {
    if (Date.now() - lastClickTime < 350) return; // was actually a double-click
    if (animLocked) return;
    const phrases = [
      "Right on time!",
      "Something I can help with?",
      "Always here.",
      "Tick tock!",
    ];
    talkAndSay(phrases[Math.floor(Math.random() * phrases.length)]);
    markConversation();
  }, 360);
});

// ── RESIZE ────────────────────────────────────────────────────
window.addEventListener("resize", () => {
  W = window.innerWidth;
  H = window.innerHeight;
  x = Math.min(x, W - BASE_SIZE);
  y = Math.min(y, H - BASE_SIZE - 20);
});

// ── HELPERS ───────────────────────────────────────────────────
function randomBetween(a, b) {
  return a + Math.random() * (b - a);
}

// ── BOOT ──────────────────────────────────────────────────────
window.addEventListener("load", () => {
  setTimeout(startup, 500);
  setInterval(randomBehaviour, 12000);
  loop();
});
// expose so speak.js text-input can fire actions after brainCommand
window.mrMinutesExecuteAction = executeBrainAction;

// ── MOUSE HIT-TEST (overlay click-through) ───────────────────
// The Electron window is invisible to mouse events by default so
// the user can click through to Chrome/Word/etc underneath.
// We track mousemove and re-enable mouse events only when the
// cursor is physically over Mr. Minutes or over the text input
// box — so double-click, single-click, and text input all work
// without the user having to find the hidden window first.

(function initHitTest() {
  let currentlyIgnoring = true;

  function isOverMascot(mx, my) {
    // mascot top-left is (x, y), size is current rendered width/height
    const w = parseFloat(mascot.style.width)  || BASE_SIZE;
    const h = parseFloat(mascot.style.height) || BASE_SIZE;
    return mx >= x && mx <= x + w && my >= y && my <= y + h;
  }

  function isOverTextBox(mx, my) {
    const wrap = document.getElementById('text-input-wrap');
    if (!wrap || wrap.style.display === 'none') return false;
    const r = wrap.getBoundingClientRect();
    return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
  }

  document.addEventListener('mousemove', (e) => {
    const over = isOverMascot(e.clientX, e.clientY) || isOverTextBox(e.clientX, e.clientY);
    if (over === currentlyIgnoring) {
      // need to flip
      currentlyIgnoring = !over;
      window.electronAPI?.setIgnoreMouse(!over);
    }
  });
})();