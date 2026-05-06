// ============================================================
//  MR. MINUTES — Full Body System v4
//  Whisper hearing + ElevenLabs voice + full screen movement
// ============================================================

const mascot = document.getElementById("mascot");
const stage  = document.getElementById("stage");

// ── receive voice commands from Whisper via IPC ───────────────
if (window.electronAPI && window.electronAPI.onVoiceCommand) {
  window.electronAPI.onVoiceCommand((command) => {
    console.log("📩 IPC command received:", command);
    handleCommand(command);
  });
}

// ── screen dimensions ────────────────────────────────────────
let W = window.innerWidth;
let H = window.innerHeight;
const BASE_SIZE = 220;

// ── position ─────────────────────────────────────────────────
let x = W / 2 - BASE_SIZE / 2;
let y = H - BASE_SIZE - 20;
let facingRight = true;
let isMoving = false;
let onScreen = true;
let isMuted = false;

// ── animations ───────────────────────────────────────────────
const ANIMS = {
  idle:        "./idle.webm",
  walk:        "./walk.webm",
  tipHat:      "./tip-hat.webm",
  waveHello:   "./wave-hello.webm",
  waveGoodbye: "./wave-goodbye.webm",
  thinking:    "./thinking.webm",
  celebrate:   "./celebrate.webm",
  talking:     "./talking.webm",
  pointing:    "./pointing.webm",
  tap:         "./tap.webm",
};

let animLocked = false;

function playAnim(name, loop = true, onEnd = null) {
  if (!ANIMS[name]) return;
  mascot.src = ANIMS[name];
  mascot.loop = loop;
  mascot.play();
  mascot.onended = onEnd ? () => { mascot.onended = null; onEnd(); } : null;
}

function playOnce(name, then = "idle") {
  animLocked = true;
  playAnim(name, false, () => {
    animLocked = false;
    playAnim(then, true);
  });
}

// ── voice ─────────────────────────────────────────────────────
function talkAndSay(text, then = "idle") {
  if (isMuted) return;
  animLocked = true;
  playAnim("talking", true);
  elevenSpeak(text, () => {
    animLocked = false;
    playAnim(then, true);
  });
}

// ── depth scale ───────────────────────────────────────────────
function applyDepthScale() {
  const minScale = 0.55;
  const maxScale = 1.2;
  const ratio = (y - H * 0.1) / (H * 0.9);
  const scale = minScale + (maxScale - minScale) * Math.max(0, Math.min(1, ratio));
  const size = BASE_SIZE * scale;
  mascot.style.width  = size + "px";
  mascot.style.height = size + "px";
}

// ── transform ─────────────────────────────────────────────────
function applyTransform() {
  mascot.style.transform = `translate(${x}px, ${y}px) scaleX(${facingRight ? 1 : -1})`;
}

// ── movement ──────────────────────────────────────────────────
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
      x = tx; y = ty;
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

// ── go away / come back ───────────────────────────────────────
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

// ── tap action ────────────────────────────────────────────────
function tapTarget(tx, ty, times = 1, onDone = null) {
  moveTo(tx - BASE_SIZE / 2, ty - BASE_SIZE, () => {
    let count = 0;
    function doTap() {
      if (count >= times) { if (onDone) onDone(); return; }
      count++;
      playOnce("tap", "idle");
      setTimeout(doTap, 800);
    }
    doTap();
  });
}

// ── greeting ──────────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h >= 5  && h < 12) return "Good morning! Ready to make today count?";
  if (h >= 12 && h < 17) return "Good afternoon! Hope the day's treating you well!";
  if (h >= 17 && h < 21) return "Good evening! Still at it I see!";
  return "Burning the midnight oil are we? I'm here with you!";
}

// ── startup ───────────────────────────────────────────────────
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
        setTimeout(() => talkAndSay(getGreeting()), 1200);
      }, 300);
    }
  }, 16);
}

// ── command handler ───────────────────────────────────────────
function handleCommand(command) {
  console.log("🎯 Handling command:", command);

  if (command.includes("keep quiet") || command.includes("shut up") || command.includes("be quiet")) {
    isMuted = true; playAnim("idle", true); return;
  }
  if (command.includes("speak") || command.includes("unmute")) {
    isMuted = false; talkAndSay("I'm back! What do you need?"); return;
  }
  if (command.includes("go away") || command.includes("leave") || command.includes("hide")) {
    goAway(); return;
  }
  if (command.includes("come back") || command.includes("come here") || command.includes("show")) {
    comeBack(); return;
  }
  if (command.includes("hello") || command.includes("hey minutes") || command.includes("hi")) {
    playOnce("waveHello", "idle");
    talkAndSay("Well hello there! Good to see you!"); return;
  }
  if (command.includes("bye") || command.includes("goodbye")) {
    playOnce("waveGoodbye", "idle");
    talkAndSay("See you later! Don't work too hard!"); return;
  }
  if (command.includes("celebrate") || command.includes("lets go")) {
    playOnce("celebrate", "idle");
    talkAndSay("Woohoo! That's what I'm talking about!"); return;
  }
  if (command.includes("think") || command.includes("hmm")) {
    playOnce("thinking", "idle");
    talkAndSay("Let me think about that..."); return;
  }
  if (command.includes("point") || command.includes("look")) {
    playOnce("pointing", "idle");
    talkAndSay("Right there! You see it?"); return;
  }
  if (command.includes("time") || command.includes("what time")) {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    playOnce("tipHat", "idle");
    talkAndSay(`It's ${time}. Right on time as always!`); return;
  }
  if (command.includes("open")) {
    const apps = {
      "chrome": "Google Chrome", "safari": "Safari",
      "vs code": "Visual Studio Code", "vscode": "Visual Studio Code",
      "spotify": "Spotify", "finder": "Finder",
      "terminal": "Terminal", "notes": "Notes",
      "word": "Microsoft Word", "excel": "Microsoft Excel",
    };
    for (const [keyword, appName] of Object.entries(apps)) {
      if (command.includes(keyword)) {
        talkAndSay(`Opening ${appName} right away!`);
        if (window.electronAPI && window.electronAPI.openApp) {
          window.electronAPI.openApp(appName);
        }
        return;
      }
    }
  }
}

// ── random behaviour ──────────────────────────────────────────
const idlePhrases = [
  "Tick tock! Time waits for no one!",
  "Need a hand with anything?",
  "I'm always right on time!",
  "What are we working on today?",
  "You're doing great, keep it up!",
  "At your service, as always!",
];

function randomBehaviour() {
  if (animLocked || isMoving || !onScreen || isMuted) return;
  const roll = Math.random();
  if (roll < 0.35) wanderRandomly();
  else if (roll < 0.55) talkAndSay(idlePhrases[Math.floor(Math.random() * idlePhrases.length)]);
  else if (roll < 0.65) playOnce("tipHat", "idle");
  else if (roll < 0.75) playOnce("thinking", "idle");
}

// ── render loop ───────────────────────────────────────────────
function loop() { applyTransform(); requestAnimationFrame(loop); }

// ── resize ────────────────────────────────────────────────────
window.addEventListener("resize", () => {
  W = window.innerWidth; H = window.innerHeight;
  x = Math.min(x, W - BASE_SIZE);
  y = Math.min(y, H - BASE_SIZE - 20);
});

// ── click ─────────────────────────────────────────────────────
mascot.addEventListener("click", () => {
  if (animLocked) return;
  const r = ["Right on time!", "Something I can help with?", "Always here!", "Tick tock!"];
  talkAndSay(r[Math.floor(Math.random() * r.length)]);
});

// ── helpers ───────────────────────────────────────────────────
function randomBetween(a, b) { return a + Math.random() * (b - a); }

// ── start ─────────────────────────────────────────────────────
window.addEventListener("load", () => {
  setTimeout(startup, 500);
  setInterval(randomBehaviour, 12000);
  loop();
});