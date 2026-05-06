// ============================================================
//  MR. MINUTES — Local Whisper Listener v2
//  Records mic via Sox → Whisper CLI transcribes → sends to renderer
// ============================================================

const { ipcMain, app } = require("electron");
const record = require("node-record-lpcm16");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── paths ─────────────────────────────────────────────────────
const WHISPER_BIN = path.join(
  __dirname,
  "node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/whisper-cli"
);
const WHISPER_MODEL = path.join(
  __dirname,
  "node_modules/nodejs-whisper/cpp/whisper.cpp/models/ggml-tiny.en.bin"
);

// Sox path — try both Homebrew locations
const SOX_PATH = fs.existsSync("/usr/local/bin/sox")
  ? "/usr/local/bin/sox"
  : "/opt/homebrew/bin/sox";

let mainWindow = null;
let isRecording = false;

function sendToRenderer(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("voice-command", command);
  }
}

async function transcribeAudio(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) { resolve(); return; }

    const stats = fs.statSync(filePath);
    if (stats.size < 10000) {
      fs.unlink(filePath, () => {});
      resolve();
      return;
    }

    const outBase = filePath.replace(".wav", "");
    const cmd = `"${WHISPER_BIN}" -m "${WHISPER_MODEL}" -f "${filePath}" -otxt -of "${outBase}" -l en`;

    exec(cmd, (err, stdout, stderr) => {
      fs.unlink(filePath, () => {});
      const txtFile = outBase + ".txt";

      if (fs.existsSync(txtFile)) {
        let text = fs.readFileSync(txtFile, "utf8")
          .trim()
          .toLowerCase()
          .replace(/\[.*?\]/g, "") // remove [BLANK_AUDIO] etc
          .trim();

        fs.unlink(txtFile, () => {});

        if (text && text.length > 1 && !text.includes("thank you")) {
          console.log("🗣 Whisper heard:", text);
          sendToRenderer(text);
        }
      }

      resolve();
    });
  });
}

function recordChunk() {
  if (isRecording) return;
  isRecording = true;

  const tmpFile = path.join(os.tmpdir(), `mrminutes_${Date.now()}.wav`);
  const fileStream = fs.createWriteStream(tmpFile);

  const mic = record.record({
    sampleRate: 16000,
    channels: 1,
    audioType: "wav",
    recorder: "sox",
    recordProgram: SOX_PATH,
    silence: "1.5",
    threshold: 0.5,
    endOnSilence: true,
  });

  mic.stream().on("error", (err) => {
    console.error("🎙 Mic error:", err.message);
    isRecording = false;
    setTimeout(recordChunk, 2000);
  });

  mic.stream().pipe(fileStream);

  fileStream.on("finish", async () => {
    isRecording = false;
    await transcribeAudio(tmpFile);
    setTimeout(recordChunk, 300);
  });

  // max 8 seconds per chunk
  setTimeout(() => {
    try { mic.stop(); } catch(e) {}
  }, 8000);
}

function init(win) {
  mainWindow = win;
  console.log("👂 Mr. Minutes is listening via Whisper...");
  console.log("📍 Sox path:", SOX_PATH);
  console.log("📍 Whisper bin:", WHISPER_BIN);
  console.log("📍 Model:", WHISPER_MODEL);
  console.log("🧪 Whisper result:", text);

  // verify everything exists
  if (!fs.existsSync(SOX_PATH)) {
    console.error("❌ Sox not found at", SOX_PATH);
    return;
  }
  if (!fs.existsSync(WHISPER_BIN)) {
    console.error("❌ Whisper binary not found at", WHISPER_BIN);
    return;
  }
  if (!fs.existsSync(WHISPER_MODEL)) {
    console.error("❌ Whisper model not found at", WHISPER_MODEL);
    return;
  }

  console.log("✅ All components found — starting listener");
  recordChunk();
}

module.exports = { init };