// ============================================================
// MR. MINUTES — Listener v12
//
// Fixes:
// - Replaces flat user-done gap with adaptive utterance timing
// - Waits longer for dangling/incomplete endings like
//   "save it as", "called", "under", "named", etc.
// - Uses Deepgram utterance_end_ms as an extra boundary hint
// - Adds a minimum merge-hold window to prevent one command
//   from being split into two final chunks
// - Keeps long-lived socket design
// - Still pauses mic during TTS and drops transcripts on echoLock
// ============================================================

"use strict";

const { ipcMain } = require("electron");
const WebSocket = require("ws");
const mic = require("mic");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

// ── KEYS ─────────────────────────────────────────────────────
function loadKeys() {
  return [
    process.env.DEEPGRAM_API_KEY,
    process.env.DEEPGRAM_API_KEY_2,
  ].filter((k) => typeof k === "string" && k.trim().length > 0);
}

let DEEPGRAM_KEYS = [];
let currentKeyIndex = 0;

function getActiveKey() {
  return DEEPGRAM_KEYS[currentKeyIndex];
}

function switchKey(reason) {
  if (DEEPGRAM_KEYS.length < 2) {
    console.warn("⚠️ Only one Deepgram key available:", reason);
    return;
  }
  const prev = currentKeyIndex + 1;
  currentKeyIndex = (currentKeyIndex + 1) % DEEPGRAM_KEYS.length;
  console.log(`🔑 Switched Key ${prev} → ${currentKeyIndex + 1} (${reason})`);
}

// ── STATE ─────────────────────────────────────────────────────
let mainWindow = null;
let ws = null;
let micInstance = null;
let micStream = null;
let reconnectTimer = null;
let isPaused = false;
let echoLock = false;
let ipcWired = false;
let isConnecting = false;
let intentionalClose = false;
let consecutiveErrors = 0;

const MAX_ERRORS_BEFORE_SWITCH = 3;

const FAST_GAP_MS = 1400;
const SLOW_GAP_MS = 3200;
const MIN_MERGE_HOLD_MS = 900;
const BLOCKED_RETRY_MS = 250;
const ECHO_RELEASE_FLUSH_MS = 80;
const UTTERANCE_END_FLUSH_MS = 250;
const DEEPGRAM_UTTERANCE_END_MS = 1800;
const DUPLICATE_SUPPRESS_WINDOW_MS = 4000;

const DEEPGRAM_URL =
  "wss://api.deepgram.com/v1/listen" +
  "?model=nova-2&language=en&encoding=linear16" +
  "&sample_rate=16000&channels=1" +
  "&interim_results=true&smart_format=true" +
  `&utterance_end_ms=${DEEPGRAM_UTTERANCE_END_MS}`;

const JUNK_TRANSCRIPTS = new Set([
  "hm", "hmm", "uh", "um", "mm", "mhm", "ah", "oh"
]);

let pendingTranscript = "";
let pendingTranscriptTimer = null;
let pendingFlushReason = "gap";
let lastFinalChunkAt = 0;
let lastEmittedTranscript = "";
let lastEmittedAt = 0;

// ── HELPERS ───────────────────────────────────────────────────
function sendToRenderer(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("voice-command", payload);
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearPendingTranscriptTimer() {
  if (pendingTranscriptTimer) {
    clearTimeout(pendingTranscriptTimer);
    pendingTranscriptTimer = null;
  }
}

function normalizeSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function mergeTranscript(prev, next) {
  const a = normalizeSpaces(prev);
  const b = normalizeSpaces(next);

  if (!a) return b;
  if (!b) return a;

  const al = a.toLowerCase();
  const bl = b.toLowerCase();

  if (bl === al) return b;
  if (bl.startsWith(al)) return b;
  if (al.startsWith(bl)) return a;
  if (bl.includes(al)) return b;
  if (al.includes(bl)) return a;

  const aWords = al.split(/\s+/);
  const bWords = bl.split(/\s+/);

  let bestOverlap = 0;
  const maxOverlap = Math.min(8, aWords.length, bWords.length);

  for (let size = maxOverlap; size >= 1; size--) {
    const aTail = aWords.slice(-size).join(" ");
    const bHead = bWords.slice(0, size).join(" ");
    if (aTail === bHead) {
      bestOverlap = size;
      break;
    }
  }

  if (bestOverlap > 0) {
    return normalizeSpaces([
      a,
      bWords.slice(bestOverlap).join(" "),
    ].join(" "));
  }

  return normalizeSpaces(`${a} ${b}`);
}

function stripTrailingPunctuation(text) {
  return normalizeSpaces(text).replace(/[.,!?;:]+$/g, "").trim();
}

function endsWithStrongCompletion(text) {
  return /[.!?]$/.test(normalizeSpaces(text));
}

function getLastWords(text, count = 4) {
  return normalizeSpaces(text)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(-count);
}

function looksIncompleteUtterance(text) {
  const clean = stripTrailingPunctuation(text).toLowerCase();
  if (!clean) return false;

  const lastWords = getLastWords(clean, 4);
  const joined = lastWords.join(" ");

  const danglingSingleWords = new Set([
    "a", "an", "the", "to", "for", "from", "with", "into", "onto",
    "on", "in", "at", "of", "by", "and", "or", "but", "if", "then",
    "than", "that", "this", "these", "those", "my", "your", "our",
    "his", "her", "their", "under", "over", "inside", "outside",
    "called", "named", "titled", "about", "regarding", "make",
    "open", "write", "create", "save", "as"
  ]);

  const danglingPhrases = [
    "save it",
    "save as",
    "save it as",
    "call it",
    "name it",
    "title it",
    "write about",
    "make it",
    "put it",
    "send it",
    "open the",
    "open microsoft",
    "create a",
    "create an",
    "called",
    "named",
    "under the",
    "under",
    "into the",
    "in the",
    "in microsoft",
    "into microsoft",
    "save under"
  ];

  const lastWord = lastWords[lastWords.length - 1] || "";

  if (danglingSingleWords.has(lastWord)) return true;
  if (danglingPhrases.some((phrase) => clean.endsWith(phrase) || joined.endsWith(phrase))) return true;

  if (/^(write|create|open|save|send|put|make)\b/.test(clean) && clean.split(/\s+/).length <= 2) {
    return true;
  }

  return false;
}

function chooseGapMs(transcript) {
  const clean = normalizeSpaces(transcript);
  if (!clean) return FAST_GAP_MS;
  if (looksIncompleteUtterance(clean)) return SLOW_GAP_MS;
  if (endsWithStrongCompletion(clean)) return FAST_GAP_MS;
  return FAST_GAP_MS;
}

function isNearDuplicateTranscript(transcript) {
  const now = Date.now();
  const clean = normalizeSpaces(transcript).toLowerCase();
  if (!clean) return false;

  if (
    clean === lastEmittedTranscript &&
    (now - lastEmittedAt) < DUPLICATE_SUPPRESS_WINDOW_MS
  ) {
    return true;
  }

  return false;
}

function schedulePendingFlush(reason = "gap", delayMs = null) {
  if (!pendingTranscript) return;

  clearPendingTranscriptTimer();
  pendingFlushReason = reason;

  const heuristicDelay =
    typeof delayMs === "number" ? delayMs : chooseGapMs(pendingTranscript);

  const sinceLastChunk = Date.now() - lastFinalChunkAt;
  const mergeHoldRemaining = Math.max(0, MIN_MERGE_HOLD_MS - sinceLastChunk);
  const finalDelay = Math.max(heuristicDelay, mergeHoldRemaining);

  console.log(`🕒 Pending flush in ${finalDelay}ms (${reason})`);
  pendingTranscriptTimer = setTimeout(flushPendingTranscript, finalDelay);
}

function flushPendingTranscript() {
  if (!pendingTranscript) return;

  if (isPaused || echoLock) {
    clearPendingTranscriptTimer();
    pendingTranscriptTimer = setTimeout(flushPendingTranscript, BLOCKED_RETRY_MS);
    return;
  }

  const transcript = normalizeSpaces(pendingTranscript);
  pendingTranscript = "";
  clearPendingTranscriptTimer();

  if (!transcript) return;

  const cleaned = transcript.toLowerCase().trim();
  if (!cleaned || JUNK_TRANSCRIPTS.has(cleaned)) return;
  if (isNearDuplicateTranscript(cleaned)) {
    console.log("🪵 Duplicate transcript suppressed:", cleaned);
    return;
  }

  lastEmittedTranscript = cleaned;
  lastEmittedAt = Date.now();

  console.log(`🗣 Heard (${pendingFlushReason}):`, transcript);
  sendToRenderer({ heard: cleaned });
}

function queueFinalTranscript(transcript) {
  const clean = normalizeSpaces(transcript);
  if (!clean) return;

  lastFinalChunkAt = Date.now();
  pendingTranscript = mergeTranscript(pendingTranscript, clean);

  const preferredDelay = looksIncompleteUtterance(pendingTranscript)
    ? SLOW_GAP_MS
    : FAST_GAP_MS;

  schedulePendingFlush("final_chunk", preferredDelay);
}

// ── MIC LIFECYCLE ─────────────────────────────────────────────
function stopMic() {
  try { micStream?.removeAllListeners(); } catch (_) {}
  try { micInstance?.stop(); } catch (_) {}
  micInstance = null;
  micStream = null;
  console.log("🎙 Mic stopped");
}

function startMic() {
  if (isPaused) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log("⚠️ Cannot start mic — socket not open");
    return;
  }

  if (micInstance) {
    console.log("⚠️ Mic already active");
    return;
  }

  console.log("🎙 Starting microphone...");

  micInstance = mic({
    rate: "16000",
    channels: "1",
    bitwidth: "16",
    encoding: "signed-integer",
    endian: "little",
    fileType: "raw",
    debug: false,
    exitOnSilence: 0,
  });

  micStream = micInstance.getAudioStream();

  let chunks = 0;

  micStream.on("data", (chunk) => {
    if (isPaused || !ws || ws.readyState !== WebSocket.OPEN) return;
    chunks++;
    if (chunks % 120 === 0) console.log("🎤 Streaming audio...");
    try {
      ws.send(chunk);
    } catch (err) {
      console.error("❌ Failed sending audio:", err.message);
    }
  });

  micStream.on("error", (err) => {
    console.error("🎙 Mic stream error:", err.message);
    stopMic();
    if (!isPaused) scheduleReconnect(2500);
  });

  micStream.on("startComplete", () => {
    console.log("✅ Mic capture started");
  });

  micInstance.start();
  console.log("🎙 Mic streaming PCM16 @ 16kHz");
}

// ── SOCKET LIFECYCLE ──────────────────────────────────────────
function stopSocket() {
  if (!ws) return;
  try {
    ws.removeAllListeners();
    intentionalClose = true;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch (_) {}
  try { ws.terminate(); } catch (_) {}
  ws = null;
}

function scheduleReconnect(delay = 3000) {
  if (isPaused) return;
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!isPaused) {
      console.log("🔄 Reconnecting...");
      startListening();
    }
  }, delay);
}

function startListening() {
  if (isPaused) {
    console.log("⏸ Listener paused — skipping connect");
    return;
  }

  if (isConnecting) {
    console.log("⚠️ Already connecting");
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log("⚠️ Socket already active");
    return;
  }

  DEEPGRAM_KEYS = loadKeys();
  if (DEEPGRAM_KEYS.length === 0) {
    console.error("❌ No Deepgram API keys found");
    return;
  }
  if (currentKeyIndex >= DEEPGRAM_KEYS.length) currentKeyIndex = 0;

  clearReconnectTimer();
  intentionalClose = false;
  isConnecting = true;

  const apiKey = getActiveKey();
  console.log(`🎙 Connecting to Deepgram (Key ${currentKeyIndex + 1}/${DEEPGRAM_KEYS.length})`);
  console.log("🔑 Using key:", apiKey.slice(0, 8));

  const socket = new WebSocket(DEEPGRAM_URL, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  ws = socket;

  socket.on("open", () => {
    console.log("✅ Deepgram connected");
    isConnecting = false;
    consecutiveErrors = 0;

    setTimeout(() => {
      if (!isPaused && ws === socket && socket.readyState === WebSocket.OPEN) {
        startMic();
      }
    }, 500);
  });

  socket.on("message", (raw) => {
    if (echoLock) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return;
    }

    if (data?.type === "UtteranceEnd") {
      if (pendingTranscript && !looksIncompleteUtterance(pendingTranscript)) {
        console.log("📨 Deepgram: UtteranceEnd");
        schedulePendingFlush("utterance_end", UTTERANCE_END_FLUSH_MS);
      } else if (pendingTranscript) {
        console.log("📨 Deepgram: UtteranceEnd ignored — transcript still looks incomplete");
      }
      return;
    }

    if (data?.type !== "Results") {
      if (data?.type) console.log("📨 Deepgram:", data.type);
      return;
    }

    const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript || !data.is_final) return;

    queueFinalTranscript(transcript);
  });

  socket.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
    isConnecting = false;
    consecutiveErrors++;

    if (consecutiveErrors >= MAX_ERRORS_BEFORE_SWITCH) {
      switchKey("too many errors");
      consecutiveErrors = 0;
    }

    stopMic();
    if (!intentionalClose) scheduleReconnect(3000);
  });

  socket.on("close", (code, reasonBuffer) => {
    isConnecting = false;
    const reason = reasonBuffer ? reasonBuffer.toString() : "";
    console.log(`🔌 Closed — code: ${code}, reason: ${reason}`);
    stopMic();
    ws = null;

    if (intentionalClose) {
      intentionalClose = false;
      return;
    }

    if (code === 1008 || code === 1011 || code === 401) {
      console.log("🔑 Deepgram rejected session — switching key");
      switchKey("auth/session rejected");
    }

    if (!isPaused) scheduleReconnect(3000);
  });
}

// ── IPC ───────────────────────────────────────────────────────
function wireIPC() {
  if (ipcWired) return;
  ipcWired = true;

  ipcMain.on("pause-listener", () => {
    console.log("⏸ pause-listener received");
    isPaused = true;
    clearReconnectTimer();
    clearPendingTranscriptTimer();
    stopMic();
  });

  ipcMain.on("resume-listener", () => {
    console.log("▶️ resume-listener received");
    if (!isPaused) return;

    isPaused = false;
    clearReconnectTimer();

    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!micInstance) startMic();
      if (pendingTranscript) schedulePendingFlush("resume", 200);
    } else {
      console.log("🔄 Socket died during pause — reconnecting");
      startListening();
    }
  });

  ipcMain.on("speech-state", (_event, state) => {
    if (typeof state?.echoLock === "boolean") {
      echoLock = state.echoLock;
      console.log(`🔒 echoLock: ${echoLock}`);
      if (!echoLock && !isPaused && pendingTranscript) {
        schedulePendingFlush("echo_released", ECHO_RELEASE_FLUSH_MS);
      }
    }
  });
}

// ── INIT ──────────────────────────────────────────────────────
function init(win) {
  mainWindow = win;
  DEEPGRAM_KEYS = loadKeys();
  wireIPC();

  console.log("👂 Mr. Minutes ears online — v12");
  console.log(`🔑 Keys loaded: ${DEEPGRAM_KEYS.length}`);
  console.log(`🕒 Fast gap: ${FAST_GAP_MS}ms`);
  console.log(`🕒 Slow gap: ${SLOW_GAP_MS}ms`);
  console.log(`🕒 Merge hold: ${MIN_MERGE_HOLD_MS}ms`);
  console.log(`🕒 Deepgram utterance_end_ms: ${DEEPGRAM_UTTERANCE_END_MS}`);
  console.log("KEY1:", DEEPGRAM_KEYS[0]?.slice(0, 8));
  if (DEEPGRAM_KEYS[1]) console.log("KEY2:", DEEPGRAM_KEYS[1]?.slice(0, 8));

  startListening();
}

module.exports = { init };