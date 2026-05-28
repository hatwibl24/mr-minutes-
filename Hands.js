"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

const ISMAC = process.platform === "darwin";
const ISWINDOWS = process.platform === "win32";
const ISLINUX = process.platform === "linux";

let mouse, keyboard, screen, Button, Key, straightTo, centerOf, Region;
let nutLoaded = false;
let pngjs = null;

const runtimeState = {
  points: Object.create(null),
  regions: Object.create(null),
  snapshots: Object.create(null),
  lastVisualMatch: null,
  activeWindow: null,
  lastScreenshot: null,
  lastOpenedUrl: null,
  lastLaunchedApp: null,
};

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function tempPngPath(prefix = "mr-minutes-shot") {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `${prefix}-${stamp}.png`);
}

function appleQuote(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function psSingleQuote(text) {
  return String(text).replace(/'/g, "''");
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function normalizeTexts(input) {
  if (Array.isArray(input)) return input.map((x) => String(x).trim()).filter(Boolean);
  const one = String(input ?? "").trim();
  return one ? [one] : [];
}
function isGenericUiWord(value) {
    const v = String(value ?? "").trim().toLowerCase();
    return [
      "document",
      "page",
      "window",
      "screen",
      "app",
      "application",
      "file",
      "text",
      "editor",
      "content",
      "area",
      "field",
      "box",
      "input",
      "workspace",
      "canvas",
    ].includes(v);
  }
  
  function sanitizeReadyTexts(input) {
    return normalizeTexts(input).filter((text) => {
      const v = String(text ?? "").trim();
      if (!v) return false;
      if (v.length < 2) return false;
      if (isGenericUiWord(v)) return false;
      return true;
    });
  }
  
  function sanitizeVisualTarget(target) {
    if (typeof target !== "string") return null;
    const v = target.trim();
    if (!v) return null;
    if (v.length < 2) return null;
    if (isGenericUiWord(v)) return null;
    return v;
  }
  
  function sanitizeReadyTexts(input) {
    return normalizeTexts(input).filter((text) => {
      const v = String(text ?? "").trim();
      if (!v) return false;
      if (v.length < 2) return false;
      if (isGenericUiWord(v)) return false;
      return true;
    });
  }
  
  function sanitizeVisualTarget(target) {
    if (typeof target !== "string") return null;
    const v = target.trim();
    if (!v) return null;
    if (v.length < 2) return null;
    if (isGenericUiWord(v)) return null;
    return v;
  }

function roundPoint(point) {
  return {
    x: Math.round(Number(point?.x) || 0),
    y: Math.round(Number(point?.y) || 0),
  };
}

function normalizePoint(point) {
  if (!point || typeof point !== "object") return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function normalizeRegion(region) {
  if (!region) return null;
  if (!Region) return null;
  if (region instanceof Region) return region;
  if (typeof region === "string" && runtimeState.regions[region]) region = runtimeState.regions[region];
  const x = Number(region?.x);
  const y = Number(region?.y);
  const width = Number(region?.width);
  const height = Number(region?.height);
  if ([x, y, width, height].some((n) => Number.isNaN(n))) return null;
  return new Region(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}

function regionToPlain(region) {
  if (!region) return null;
  if (typeof region.left === "number") {
    return {
      x: Math.round(region.left),
      y: Math.round(region.top),
      width: Math.round(region.width),
      height: Math.round(region.height),
    };
  }
  return {
    x: Math.round(Number(region.x) || 0),
    y: Math.round(Number(region.y) || 0),
    width: Math.round(Number(region.width) || 0),
    height: Math.round(Number(region.height) || 0),
  };
}

async function ensurePng() {
  if (pngjs) return pngjs;
  try {
    pngjs = require("pngjs");
    return pngjs;
  } catch {
    return null;
  }
}

async function ensureNut() {
  if (nutLoaded) return true;
  try {
    const nut = require("@nut-tree-fork/nut-js");
    mouse = nut.mouse;
    keyboard = nut.keyboard;
    screen = nut.screen;
    Button = nut.Button;
    Key = nut.Key;
    straightTo = nut.straightTo;
    centerOf = nut.centerOf;
    Region = nut.Region;

    mouse.config.mouseSpeed = 1500;
    mouse.config.autoDelayMs = 40;
    keyboard.config.autoDelayMs = 8;

    nutLoaded = true;
    console.log("✅ nut-js loaded");
    return true;
  } catch (err) {
    console.error("❌ nut-js unavailable:", err.message);
    return false;
  }
}

async function retry(fn, attemptsOrOptions = 3, delayMs = 250) {
  const options =
    typeof attemptsOrOptions === "object" && attemptsOrOptions !== null
      ? attemptsOrOptions
      : { attempts: attemptsOrOptions, delayMs };

  const attempts = Math.max(1, Number(options.attempts ?? 1));
  const baseDelay = Math.max(0, Number(options.delayMs ?? 0));
  const backoff = Math.max(1, Number(options.backoff ?? 1));

  let lastResult = { ok: false, error: "unknown failure" };

  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn(i);
      if (result?.ok) return { ...result, attemptsUsed: i + 1 };
      lastResult = result || { ok: false, error: "unknown failure" };
    } catch (err) {
      lastResult = { ok: false, error: err.message || String(err) };
    }

    if (i < attempts - 1 && baseDelay > 0) {
      const waitMs = Math.round(baseDelay * Math.pow(backoff, i));
      await sleep(waitMs);
    }
  }

  return lastResult;
}

async function getMousePosition() {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    const pos = await mouse.getPosition();
    return { ok: true, x: Math.round(pos.x), y: Math.round(pos.y) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function launchApp(appName) {
  if (!appName) return { ok: false, error: "launchApp needs an appName" };
  try {
    if (ISMAC) {
      await execAsync(`open -a ${shellQuote(appName)}`);
    } else if (ISWINDOWS) {
      await execAsync(`start "" ${shellQuote(appName)}`, { shell: "cmd.exe" });
    } else if (ISLINUX) {
      await execAsync(`bash -lc ${shellQuote(`${appName} >/dev/null 2>&1 &`)}`);
    } else {
      return { ok: false, error: `Unsupported launch platform ${process.platform}` };
    }

    runtimeState.lastLaunchedApp = { app: appName, timestamp: Date.now() };
    await sleep(500);
    return { ok: true, app: appName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function focusApp(appName) {
  if (!appName) return { ok: false, error: "focusApp needs an appName" };
  try {
    if (ISMAC) {
      await execAsync(`osascript -e 'tell application ${appleQuote(appName)} to activate'`);
    } else if (ISWINDOWS) {
      const ps = [
        `$name='${psSingleQuote(appName)}'`,
        `$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$name*" -or $_.ProcessName -like "*$name*" } | Select-Object -First 1`,
        `if (-not $p) { exit 1 }`,
        `Add-Type -AssemblyName Microsoft.VisualBasic`,
        `[Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) | Out-Null`,
      ].join("; ");
      await execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { shell: "powershell.exe" });
    } else if (ISLINUX) {
      await execAsync(`bash -lc 'command -v wmctrl >/dev/null 2>&1 && wmctrl -xa ${shellQuote(appName)}'`);
    } else {
      return { ok: false, error: `Unsupported focus platform ${process.platform}` };
    }

    runtimeState.activeWindow = { app: appName, timestamp: Date.now() };
    await sleep(300);
    return { ok: true, app: appName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function focusAndWait(appName, ms = 500) {
  const focused = await focusApp(appName);
  if (!focused.ok) return focused;
  await sleep(ms);
  return { ok: true, app: appName, waitedMs: ms };
}

async function ensureFocus(appName, retries = 3, settleMs = 500) {
  return retry(() => focusAndWait(appName, settleMs), {
    attempts: retries,
    delayMs: settleMs,
    backoff: 1,
  });
}

async function waitForAppReady(appName, readyTexts = [], options = {}) {
  const settleMs = options.settleMs ?? 500;
  const focusRetries = options.focusRetries ?? 3;
  const timeoutMs = options.timeout ?? 12000;
  const intervalMs = options.interval ?? 500;
  const searchRegion = options.region ?? null;

  const focused = await ensureFocus(appName, focusRetries, settleMs);
  if (!focused.ok) return focused;

  const texts = sanitizeReadyTexts(readyTexts);
  if (!texts.length) {
    await sleep(settleMs);
    return { ok: true, app: appName, waitedMs: settleMs };
  }

  const found =
    texts.length === 1
      ? await waitFor(texts[0], timeoutMs, intervalMs, searchRegion)
      : await waitForAny(texts, timeoutMs, intervalMs, searchRegion);

  if (!found.ok) return found;
  return {
    ok: true,
    app: appName,
    readyText: found.text || texts[0],
    x: found.x,
    y: found.y,
  };
}

function toButton(button = "left") {
  return String(button).toLowerCase() === "right" ? Button.RIGHT : Button.LEFT;
}

async function moveMouse(x, y) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    const p = roundPoint({ x, y });
    await mouse.move(straightTo(p));
    return { ok: true, x: p.x, y: p.y };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function moveSmooth(x, y, options = {}) {
  const start = await getMousePosition();
  if (!start.ok) return start;

  const end = roundPoint({ x, y });
  const steps = Math.max(2, Number(options.steps ?? 8));
  const duration = Math.max(0, Number(options.durationMs ?? 180));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = Math.round(start.x + (end.x - start.x) * t);
    const py = Math.round(start.y + (end.y - start.y) * t);
    const moved = await moveMouse(px, py);
    if (!moved.ok) return moved;
    if (duration > 0) await sleep(Math.round(duration / steps));
  }

  return { ok: true, x: end.x, y: end.y, steps };
}

async function moveBy(dx, dy, options = {}) {
  const pos = await getMousePosition();
  if (!pos.ok) return pos;
  const next = {
    x: pos.x + Math.round(Number(dx) || 0),
    y: pos.y + Math.round(Number(dy) || 0),
  };
  return options.smooth ? moveSmooth(next.x, next.y, options) : moveMouse(next.x, next.y);
}

async function nudgeMouse(direction, pixels = 1, options = {}) {
  const n = Math.max(1, Number(pixels) || 1);
  const dir = String(direction || "").toLowerCase();
  if (dir === "up") return moveBy(0, -n, options);
  if (dir === "down") return moveBy(0, n, options);
  if (dir === "left") return moveBy(-n, 0, options);
  if (dir === "right") return moveBy(n, 0, options);
  return { ok: false, error: `Unsupported nudge direction ${direction}` };
}

async function click(x, y, button = "left") {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    const p = roundPoint({ x, y });
    await mouse.move(straightTo(p));
    await mouse.click(toButton(button));
    return { ok: true, x: p.x, y: p.y, button };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function rightClick(x, y) {
  return click(x, y, "right");
}

async function doubleClick(x, y) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    const p = roundPoint({ x, y });
    await mouse.move(straightTo(p));
    await mouse.doubleClick(Button.LEFT);
    return { ok: true, x: p.x, y: p.y };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function mouseDown(button = "left") {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    await mouse.pressButton(toButton(button));
    return { ok: true, button };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function mouseUp(button = "left") {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    await mouse.releaseButton(toButton(button));
    return { ok: true, button };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function mouseHold(button = "left") {
  return mouseDown(button);
}

async function mouseRelease(button = "left") {
  return mouseUp(button);
}

async function drag(fromX, fromY, toX, toY, button = "left") {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    await mouse.move(straightTo(roundPoint({ x: fromX, y: fromY })));
    await sleep(40);

    const down = await mouseDown(button);
    if (!down.ok) return down;

    await sleep(50);
    await mouse.move(straightTo(roundPoint({ x: toX, y: toY })));
    await sleep(50);

    const up = await mouseUp(button);
    if (!up.ok) return up;

    return {
      ok: true,
      fromX: Math.round(fromX),
      fromY: Math.round(fromY),
      toX: Math.round(toX),
      toY: Math.round(toY),
      button,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function dragBy(dx, dy, options = {}) {
  const pos = await getMousePosition();
  if (!pos.ok) return pos;
  return drag(pos.x, pos.y, pos.x + Math.round(Number(dx) || 0), pos.y + Math.round(Number(dy) || 0), options.button || "left");
}

async function dragPath(points, options = {}) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  if (!Array.isArray(points) || points.length < 2) return { ok: false, error: "dragPath needs at least two points" };

  const clean = points.map(normalizePoint).filter(Boolean);
  if (clean.length < 2) return { ok: false, error: "dragPath received invalid points" };

  try {
    await mouse.move(straightTo(clean[0]));
    await sleep(options.preDelayMs ?? 40);

    const down = await mouseDown(options.button || "left");
    if (!down.ok) return down;

    for (let i = 1; i < clean.length; i++) {
      await mouse.move(straightTo(clean[i]));
      if ((options.segmentPauseMs ?? 20) > 0) await sleep(options.segmentPauseMs ?? 20);
    }

    const up = await mouseUp(options.button || "left");
    if (!up.ok) return up;

    return { ok: true, count: clean.length, button: options.button || "left" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function chordDrag(keys = [], from, to, button = "left", settleMs = 40) {
  if (!Array.isArray(keys)) return { ok: false, error: "keys must be an array" };
  try {
    for (const k of keys) {
      const pressed = await pressKeyDown(k);
      if (!pressed.ok) return pressed;
    }
    const result = await drag(from.x, from.y, to.x, to.y, button);
    await sleep(settleMs);
    return result;
  } finally {
    for (const k of [...keys].reverse()) {
      await pressKeyUp(k);
    }
  }
}

async function scroll(direction = "down", amount = 3) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  const dir = String(direction).toLowerCase();
  const units = Math.max(1, Number(amount) || 1);

  try {
    if (dir === "down") await mouse.scrollDown(units);
    else if (dir === "up") await mouse.scrollUp(units);
    else if (dir === "left" && typeof mouse.scrollLeft === "function") await mouse.scrollLeft(units);
    else if (dir === "right" && typeof mouse.scrollRight === "function") await mouse.scrollRight(units);
    else return { ok: false, error: `Unsupported scroll direction ${direction}` };

    return { ok: true, direction: dir, amount: units };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function keyMap() {
  return {
    enter: Key.Return,
    return: Key.Return,
    tab: Key.Tab,
    escape: Key.Escape,
    esc: Key.Escape,
    space: Key.Space,
    backspace: Key.Backspace,
    delete: Key.Delete,
    del: Key.Delete,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    home: Key.Home,
    end: Key.End,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
    cmd: Key.LeftSuper,
    command: Key.LeftSuper,
    meta: Key.LeftSuper,
    ctrl: Key.LeftControl,
    control: Key.LeftControl,
    shift: Key.LeftShift,
    alt: Key.LeftAlt,
    option: Key.LeftAlt,
    f1: Key.F1,
    f2: Key.F2,
    f3: Key.F3,
    f4: Key.F4,
    f5: Key.F5,
    f6: Key.F6,
    f7: Key.F7,
    f8: Key.F8,
    f9: Key.F9,
    f10: Key.F10,
    f11: Key.F11,
    f12: Key.F12,
    a: Key.A,
    b: Key.B,
    c: Key.C,
    d: Key.D,
    e: Key.E,
    f: Key.F,
    g: Key.G,
    h: Key.H,
    i: Key.I,
    j: Key.J,
    k: Key.K,
    l: Key.L,
    m: Key.M,
    n: Key.N,
    o: Key.O,
    p: Key.P,
    q: Key.Q,
    r: Key.R,
    s: Key.S,
    t: Key.T,
    u: Key.U,
    v: Key.V,
    w: Key.W,
    x: Key.X,
    y: Key.Y,
    z: Key.Z,
    0: Key.Num0,
    1: Key.Num1,
    2: Key.Num2,
    3: Key.Num3,
    4: Key.Num4,
    5: Key.Num5,
    6: Key.Num6,
    7: Key.Num7,
    8: Key.Num8,
    9: Key.Num9,
  };
}

function mapComboToKeys(keyCombo) {
  const parts = String(keyCombo ?? "")
    .toLowerCase()
    .split(/[+\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);

  if (!parts.length) return { ok: false, error: "key combo required" };

  const map = keyMap();
  const keys = [];
  for (const part of parts) {
    const mapped = map[part];
    if (!mapped) return { ok: false, error: `Unknown key part in combo ${keyCombo}` };
    keys.push(mapped);
  }
  return { ok: true, keys };
}

async function pressKey(keyCombo) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    const parsed = mapComboToKeys(keyCombo);
    if (!parsed.ok) return parsed;

    if (parsed.keys.length === 1) {
      await keyboard.pressKey(parsed.keys[0]);
      await keyboard.releaseKey(parsed.keys[0]);
    } else {
      await keyboard.pressKey(...parsed.keys);
      await keyboard.releaseKey(...parsed.keys);
    }

    return { ok: true, key: keyCombo };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pressKeyDown(keyCombo) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    const parsed = mapComboToKeys(keyCombo);
    if (!parsed.ok) return parsed;
    await keyboard.pressKey(...parsed.keys);
    return { ok: true, key: keyCombo };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pressKeyUp(keyCombo) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    const parsed = mapComboToKeys(keyCombo);
    if (!parsed.ok) return parsed;
    await keyboard.releaseKey(...parsed.keys);
    return { ok: true, key: keyCombo };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function type(text) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };
  try {
    const value = String(text ?? "");
    await keyboard.type(value);
    return { ok: true, length: value.length, method: "type" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function paste(text) {
  try {
    const { clipboard } = require("electron");
    const value = String(text ?? "");
    const previous = clipboard.readText();

    clipboard.writeText(value);
    await sleep(70);

    if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };

    const modifier = ISMAC ? Key.LeftSuper : Key.LeftControl;
    await keyboard.pressKey(modifier, Key.V);
    await keyboard.releaseKey(modifier, Key.V);

    await sleep(90);
    clipboard.writeText(previous);

    return { ok: true, length: value.length, method: "paste" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pressSequence(keys, pause = 120) {
  let list = keys;
  if (typeof list === "string") list = [list];
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: "pressSequence needs a non-empty keys array" };
  }

  for (const combo of list) {
    const pressed = await pressKey(combo);
    if (!pressed.ok) return pressed;
    if (pause > 0) await sleep(pause);
  }

  return { ok: true, count: list.length };
}

async function selectAll() {
  return pressKey(ISMAC ? "cmd+a" : "ctrl+a");
}

async function typeSmart(text, threshold = 80) {
  const value = String(text ?? "");
  if (value.length <= Math.max(1, Number(threshold) || 80)) return type(value);
  return paste(value);
}

async function clearAndType(text, options = {}) {
  const threshold = options.threshold ?? 80;
  const selected = await selectAll();
  if (!selected.ok) return selected;

  await sleep(60);

  let cleared = await pressKey("backspace");
  if (!cleared.ok) cleared = await pressKey("delete");
  if (!cleared.ok) return cleared;

  await sleep(80);
  return typeSmart(String(text ?? ""), threshold);
}

async function pressUntil(keyCombo, targetTexts, options = {}) {
  const texts = normalizeTexts(targetTexts);
  if (!texts.length) return { ok: false, error: "pressUntil needs target texts" };

  const repeats = Math.max(1, Number(options.repeats ?? 8));
  const pauseMs = Math.max(0, Number(options.pauseMs ?? 250));
  const region = options.region ?? null;

  for (let i = 0; i <= repeats; i++) {
    const found = texts.length === 1 ? await findText(texts[0], region) : await findTextAny(texts, region);
    if (found.ok) return { ok: true, key: keyCombo, attemptsUsed: i, ...found };
    if (i === repeats) break;

    const pressed = await pressKey(keyCombo);
    if (!pressed.ok) return pressed;
    await sleep(pauseMs);
  }

  return { ok: false, error: `Target never appeared after pressing ${keyCombo}` };
}

async function focusAndType(appName, text, options = {}) {
    const value = String(text ?? "");
    if (!value) return { ok: false, error: "focusAndType needs text" };
  
    const safeReadyTexts = sanitizeReadyTexts(options.readyTexts || []);
    const safeTarget = sanitizeVisualTarget(options.target);
  
    if (appName) {
      const ready = await waitForAppReady(appName, safeReadyTexts, {
        settleMs: options.settleMs ?? 450,
        focusRetries: options.focusRetries ?? 3,
        timeout: options.readyTimeout ?? 10000,
        interval: options.readyInterval ?? 400,
        region: options.region ?? null,
      });
      if (!ready.ok) return ready;
    }
  
    if (safeTarget) {
      const clickRes = options.waitForTarget
        ? await waitAndClick(safeTarget, options.targetTimeout ?? 10000, options.region ?? null)
        : await findAndClick(safeTarget, options.region ?? null);
  
      if (!clickRes.ok) return clickRes;
      await sleep(options.afterTargetPause ?? 120);
    } else {
      await sleep(options.afterTargetPause ?? 120);
    }
  
    if (options.clearFirst) {
      return clearAndType(value, { threshold: options.threshold ?? 80 });
    }
  
    return typeSmart(value, options.threshold ?? 80);
  }

async function takeSystemScreenshot(filePath = null) {
  const outPath = path.resolve(filePath || tempPngPath("mr-minutes-system"));

  try {
    if (ISMAC) {
      await execAsync(`screencapture -x ${shellQuote(outPath)}`);
    } else if (ISWINDOWS) {
      const ps = [
        `Add-Type -AssemblyName System.Windows.Forms`,
        `Add-Type -AssemblyName System.Drawing`,
        `$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen`,
        `$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height`,
        `$graphics = [System.Drawing.Graphics]::FromImage($bmp)`,
        `$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)`,
        `$bmp.Save('${psSingleQuote(outPath)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        `$graphics.Dispose()`,
        `$bmp.Dispose()`,
      ].join("; ");
      await execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { shell: "powershell.exe" });
    } else if (ISLINUX) {
      await execAsync(
        `bash -lc 'if command -v gnome-screenshot >/dev/null 2>&1; then gnome-screenshot -f ${shellQuote(outPath)}; elif command -v scrot >/dev/null 2>&1; then scrot ${shellQuote(outPath)}; else exit 1; fi'`
      );
    } else {
      return { ok: false, error: `Unsupported screenshot platform ${process.platform}` };
    }

    runtimeState.lastScreenshot = { path: outPath, timestamp: Date.now() };
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function saveRegionCapture(region, outPath = null) {
  const shot = await takeSystemScreenshot(outPath || tempPngPath("mr-minutes-capture"));
  if (!shot.ok) return shot;

  const cropped = await cropImageFile(shot.path, region, outPath || shot.path);
  if (!cropped.ok) return cropped;

  return { ok: true, path: cropped.path, region: cropped.region };
}

async function readPng(filePath) {
  const PNG = await ensurePng();
  if (!PNG?.PNG) return { ok: false, error: "pngjs unavailable" };

  try {
    const data = await fs.readFile(filePath);
    return { ok: true, png: PNG.PNG.sync.read(data) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function writePng(filePath, png) {
  const PNG = await ensurePng();
  if (!PNG?.PNG) return { ok: false, error: "pngjs unavailable" };

  try {
    const data = PNG.PNG.sync.write(png);
    await fs.writeFile(filePath, data);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cropImageFile(sourcePath, regionInput, outPath = null) {
  const decoded = await readPng(sourcePath);
  if (!decoded.ok) return decoded;

  const region = typeof regionInput === "string" ? runtimeState.regions[regionInput] : regionInput;
  if (!region) return { ok: false, error: "crop region not found" };

  const plain = regionToPlain(region);
  const x = clamp(plain.x, 0, Math.max(0, decoded.png.width - 1));
  const y = clamp(plain.y, 0, Math.max(0, decoded.png.height - 1));
  const width = clamp(plain.width, 1, decoded.png.width - x);
  const height = clamp(plain.height, 1, decoded.png.height - y);

  const PNG = await ensurePng();
  const cropped = new PNG.PNG({ width, height });

  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const srcIdx = ((decoded.png.width * (y + yy)) + (x + xx)) << 2;
      const dstIdx = ((width * yy) + xx) << 2;
      cropped.data[dstIdx] = decoded.png.data[srcIdx];
      cropped.data[dstIdx + 1] = decoded.png.data[srcIdx + 1];
      cropped.data[dstIdx + 2] = decoded.png.data[srcIdx + 2];
      cropped.data[dstIdx + 3] = decoded.png.data[srcIdx + 3];
    }
  }

  const target = outPath || tempPngPath("mr-minutes-crop");
  const written = await writePng(target, cropped);
  if (!written.ok) return written;

  return { ok: true, path: target, region: { x, y, width, height } };
}

async function findText(text, searchRegion = null) {
  if (!(await ensureNut())) return { ok: false, error: "nut-js unavailable" };

  const target = sanitizeVisualTarget(text);
if (!target) return { ok: false, error: "findText needs a specific visual text target" };

  try {
    const region = normalizeRegion(searchRegion);
    const matches = region ? await screen.findAll(target, { searchRegion: region }) : await screen.findAll(target);

    if (!matches || matches.length === 0) return { ok: false, error: "target not found on screen" };

    const centre = await centerOf(matches[0]);
    const result = {
      ok: true,
      text: target,
      x: Math.round(centre.x),
      y: Math.round(centre.y),
      match: matches[0],
      confidence: 1,
    };
    runtimeState.lastVisualMatch = result;
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function findTextAny(texts, searchRegion = null) {
  const list = normalizeTexts(texts);
  if (!list.length) return { ok: false, error: "findTextAny needs texts" };

  for (const text of list) {
    const found = await findText(text, searchRegion);
    if (found.ok) return found;
  }

  return { ok: false, error: `None of ${list.join(", ")} found on screen` };
}

async function findAndClick(text, searchRegion = null) {
  const found = await findText(text, searchRegion);
  if (!found.ok) return found;
  return click(found.x, found.y);
}

async function findAndClickAny(texts, searchRegion = null) {
  const found = await findTextAny(texts, searchRegion);
  if (!found.ok) return found;
  return click(found.x, found.y);
}

async function retryFindAndClick(text, searchRegion = null, attempts = 3, delayMs = 400) {
  return retry(() => findAndClick(text, searchRegion), {
    attempts,
    delayMs,
    backoff: 1.2,
  });
}

async function waitFor(text, timeoutMs = 10000, intervalMs = 500, searchRegion = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await findText(text, searchRegion);
    if (found.ok) return { ...found, foundAfterMs: Date.now() - started };
    await sleep(intervalMs);
  }
  return { ok: false, error: "Timeout text never appeared" };
}

async function waitForAny(texts, timeoutMs = 10000, intervalMs = 500, searchRegion = null) {
  const list = normalizeTexts(texts);
  if (!list.length) return { ok: false, error: "waitForAny needs texts" };

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await findTextAny(list, searchRegion);
    if (found.ok) return { ...found, foundAfterMs: Date.now() - started };
    await sleep(intervalMs);
  }
  return { ok: false, error: `Timeout none of ${list.join(", ")} appeared` };
}

async function waitForGone(text, timeoutMs = 10000, intervalMs = 500, searchRegion = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await findText(text, searchRegion);
    if (!found.ok) return { ok: true, text: String(text), goneAfterMs: Date.now() - started };
    await sleep(intervalMs);
  }
  return { ok: false, error: "Timeout text never disappeared" };
}

async function waitAndClick(text, timeoutMs = 10000, searchRegion = null) {
  const found = await waitFor(text, timeoutMs, 500, searchRegion);
  if (!found.ok) return found;
  return click(found.x, found.y);
}

async function scrollAndFind(text, direction = "down", maxScrolls = 8, amount = 3, searchRegion = null) {
  for (let i = 0; i <= maxScrolls; i++) {
    const found = await findText(text, searchRegion);
    if (found.ok) return { ...found, scrollsUsed: i };

    if (i < maxScrolls) {
      const scrolled = await scroll(direction, amount);
      if (!scrolled.ok) return scrolled;
      await sleep(350);
    }
  }

  return { ok: false, error: `text not found after ${maxScrolls} scrolls` };
}

async function scrollUntil(text, direction = "down", maxScrolls = 8, amount = 3, searchRegion = null) {
  const found = await scrollAndFind(text, direction, maxScrolls, amount, searchRegion);
  if (!found.ok) return found;
  return { ok: true, text, x: found.x, y: found.y, scrollsUsed: found.scrollsUsed };
}

async function savePoint(name, point = null) {
  if (!name) return { ok: false, error: "savePoint needs a name" };

  let resolved = point;
  if (typeof point === "string") resolved = runtimeState.points[point] || runtimeState.lastVisualMatch;

  if (!resolved) {
    const pos = await getMousePosition();
    if (!pos.ok) return pos;
    resolved = { x: pos.x, y: pos.y };
  }

  const clean = normalizePoint(resolved);
  if (!clean) return { ok: false, error: "invalid point" };

  runtimeState.points[name] = {
    ...clean,
    source: point ? "provided" : "mouse",
    timestamp: Date.now(),
  };

  return { ok: true, name, ...runtimeState.points[name] };
}

async function saveRegion(name, region) {
  if (!name) return { ok: false, error: "saveRegion needs a name" };

  const plain = regionToPlain(typeof region === "string" ? runtimeState.regions[region] : region);
  if (!plain) return { ok: false, error: "invalid region" };

  runtimeState.regions[name] = {
    ...plain,
    source: "provided",
    timestamp: Date.now(),
  };

  return { ok: true, name, ...runtimeState.regions[name] };
}

function getPoint(name) {
  const point = runtimeState.points[name];
  if (!point) return { ok: false, error: `point not found: ${name}` };
  return { ok: true, name, ...point };
}

function getRegion(name) {
  const region = runtimeState.regions[name];
  if (!region) return { ok: false, error: `region not found: ${name}` };
  return { ok: true, name, ...region };
}

function offsetPoint(name, dx = 0, dy = 0) {
  const point = runtimeState.points[name];
  if (!point) return { ok: false, error: `point not found: ${name}` };
  return {
    ok: true,
    x: point.x + Math.round(Number(dx) || 0),
    y: point.y + Math.round(Number(dy) || 0),
    anchor: name,
  };
}

async function clickPoint(name, options = {}) {
  const point = runtimeState.points[name];
  if (!point) return { ok: false, error: `point not found: ${name}` };
  const x = point.x + Math.round(Number(options.dx) || 0);
  const y = point.y + Math.round(Number(options.dy) || 0);
  return click(x, y, options.button || "left");
}

async function dragPoints(fromName, toName, options = {}) {
  const from = runtimeState.points[fromName];
  const to = runtimeState.points[toName];
  if (!from) return { ok: false, error: `point not found: ${fromName}` };
  if (!to) return { ok: false, error: `point not found: ${toName}` };
  return drag(from.x, from.y, to.x, to.y, options.button || "left");
}

async function snapshotRegion(nameOrRegion, options = {}) {
  const region = typeof nameOrRegion === "string" ? runtimeState.regions[nameOrRegion] : nameOrRegion;
  if (!region) return { ok: false, error: "snapshotRegion needs a valid region" };

  const name = typeof nameOrRegion === "string" ? nameOrRegion : options.name || `snapshot-${Date.now()}`;
  const saved = await saveRegion(name, region);
  if (!saved.ok) return saved;

  const capture = await saveRegionCapture(saved, options.path || tempPngPath(name));
  if (!capture.ok) return capture;

  runtimeState.snapshots[name] = {
    path: capture.path,
    region: saved,
    timestamp: Date.now(),
  };

  return { ok: true, name, path: capture.path, region: saved };
}

async function compareSnapshot(beforeInput, afterInput, options = {}) {
  const beforePath = runtimeState.snapshots[beforeInput]?.path || beforeInput;
  const afterPath = runtimeState.snapshots[afterInput]?.path || afterInput;

  const before = await readPng(beforePath);
  if (!before.ok) return before;

  const after = await readPng(afterPath);
  if (!after.ok) return after;

  if (before.png.width !== after.png.width || before.png.height !== after.png.height) {
    return { ok: false, error: "snapshot sizes differ" };
  }

  const totalPixels = before.png.width * before.png.height;
  let changed = 0;
  let sum = 0;
  const pixelThreshold = Math.max(0, Number(options.pixelThreshold ?? 18));

  for (let i = 0; i < before.png.data.length; i += 4) {
    const dr = Math.abs(before.png.data[i] - after.png.data[i]);
    const dg = Math.abs(before.png.data[i + 1] - after.png.data[i + 1]);
    const db = Math.abs(before.png.data[i + 2] - after.png.data[i + 2]);
    const diff = (dr + dg + db) / 3;
    sum += diff;
    if (diff >= pixelThreshold) changed += 1;
  }

  const changedRatio = totalPixels ? changed / totalPixels : 0;
  const avgDiff = totalPixels ? sum / totalPixels : 0;

  return {
    ok: true,
    changedPixels: changed,
    totalPixels,
    changedRatio,
    avgDiff,
    changed: changedRatio >= (options.threshold ?? 0.01),
  };
}

async function verifyChanged(region, options = {}) {
  const snap1 = await snapshotRegion(region, { name: options.beforeName || `before-${Date.now()}` });
  if (!snap1.ok) return snap1;

  await sleep(options.waitMs ?? 250);

  const snap2 = await snapshotRegion(typeof region === "string" ? region : snap1.region, { name: options.afterName || `after-${Date.now()}` });
  if (!snap2.ok) return snap2;

  const compared = await compareSnapshot(snap1.name, snap2.name, options);
  if (!compared.ok) return compared;
  if (!compared.changed) return { ok: false, error: "region did not change enough", ...compared };
  return { ok: true, ...compared };
}

async function verifyUnchanged(region, options = {}) {
  const snap1 = await snapshotRegion(region, { name: options.beforeName || `before-${Date.now()}` });
  if (!snap1.ok) return snap1;

  await sleep(options.waitMs ?? 250);

  const snap2 = await snapshotRegion(typeof region === "string" ? region : snap1.region, { name: options.afterName || `after-${Date.now()}` });
  if (!snap2.ok) return snap2;

  const compared = await compareSnapshot(snap1.name, snap2.name, options);
  if (!compared.ok) return compared;
  if (compared.changed) return { ok: false, error: "region changed", ...compared };
  return { ok: true, ...compared };
}

async function readImageMatchInputs(imagePath, region = null) {
  const screenshot = await takeSystemScreenshot();
  if (!screenshot.ok) return screenshot;

  let searchImagePath = screenshot.path;
  if (region) {
    const cropped = await cropImageFile(screenshot.path, region);
    if (!cropped.ok) return cropped;
    searchImagePath = cropped.path;
  }

  const source = await readPng(searchImagePath);
  if (!source.ok) return source;

  const template = await readPng(imagePath);
  if (!template.ok) return template;

  return {
    ok: true,
    searchPath: searchImagePath,
    source: source.png,
    template: template.png,
    region: region ? regionToPlain(region) : null,
  };
}

function templateMatch(source, template, minConfidence = 0.92, stride = 2) {
  if (template.width > source.width || template.height > source.height) return null;

  let best = null;
  const maxSamples = Math.max(1, Math.floor((template.width * template.height) / 120));
  const step = Math.max(1, Math.floor(Math.sqrt((template.width * template.height) / maxSamples)));

  for (let y = 0; y <= source.height - template.height; y += stride) {
    for (let x = 0; x <= source.width - template.width; x += stride) {
      let sum = 0;
      let count = 0;

      for (let ty = 0; ty < template.height; ty += step) {
        for (let tx = 0; tx < template.width; tx += step) {
          const sIdx = ((source.width * (y + ty)) + (x + tx)) << 2;
          const tIdx = ((template.width * ty) + tx) << 2;
          const dr = Math.abs(source.data[sIdx] - template.data[tIdx]);
          const dg = Math.abs(source.data[sIdx + 1] - template.data[tIdx + 1]);
          const db = Math.abs(source.data[sIdx + 2] - template.data[tIdx + 2]);
          sum += (dr + dg + db) / 3;
          count += 1;
        }
      }

      const avg = count ? sum / count : 255;
      const confidence = 1 - avg / 255;
      if (!best || confidence > best.confidence) best = { x, y, confidence };
    }
  }

  return best && best.confidence >= minConfidence ? best : null;
}

async function findImage(imagePath, options = {}) {
  if (!imagePath) return { ok: false, error: "findImage needs imagePath" };

  const region = options.region
    ? (typeof options.region === "string" ? runtimeState.regions[options.region] : options.region)
    : null;

  const prepared = await readImageMatchInputs(imagePath, region);
  if (!prepared.ok) return prepared;

  const match = templateMatch(
    prepared.source,
    prepared.template,
    options.minConfidence ?? 0.92,
    options.stride ?? 2
  );

  if (!match) return { ok: false, error: `image not found: ${imagePath}` };

  const offsetX = prepared.region ? prepared.region.x : 0;
  const offsetY = prepared.region ? prepared.region.y : 0;
  const x = offsetX + match.x + Math.round(prepared.template.width / 2);
  const y = offsetY + match.y + Math.round(prepared.template.height / 2);

  const result = {
    ok: true,
    image: imagePath,
    x,
    y,
    confidence: match.confidence,
    width: prepared.template.width,
    height: prepared.template.height,
    regionUsed: prepared.region || null,
  };

  runtimeState.lastVisualMatch = result;
  return result;
}

async function findAnyImage(imagePaths, options = {}) {
  if (!Array.isArray(imagePaths) || !imagePaths.length) return { ok: false, error: "findAnyImage needs imagePaths" };
  for (const imagePath of imagePaths) {
    const found = await findImage(imagePath, options);
    if (found.ok) return found;
  }
  return { ok: false, error: "none of the images matched" };
}

async function waitForImage(imagePath, options = {}) {
  const timeoutMs = options.timeout ?? 10000;
  const intervalMs = options.interval ?? 500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const found = await findImage(imagePath, options);
    if (found.ok) return { ...found, foundAfterMs: Date.now() - started };
    await sleep(intervalMs);
  }

  return { ok: false, error: `Timeout image never appeared: ${imagePath}` };
}

async function waitForImageGone(imagePath, options = {}) {
  const timeoutMs = options.timeout ?? 10000;
  const intervalMs = options.interval ?? 500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const found = await findImage(imagePath, options);
    if (!found.ok) return { ok: true, image: imagePath, goneAfterMs: Date.now() - started };
    await sleep(intervalMs);
  }

  return { ok: false, error: `Timeout image never disappeared: ${imagePath}` };
}

async function clickImage(imagePath, options = {}) {
  const found = options.wait ? await waitForImage(imagePath, options) : await findImage(imagePath, options);
  if (!found.ok) return found;

  return click(
    found.x + Math.round(Number(options.dx) || 0),
    found.y + Math.round(Number(options.dy) || 0),
    options.button || "left"
  );
}

async function findColor(targetColor, options = {}) {
  const region = options.region
    ? (typeof options.region === "string" ? runtimeState.regions[options.region] : options.region)
    : null;

  const shot = await takeSystemScreenshot();
  if (!shot.ok) return shot;

  let pathToUse = shot.path;
  if (region) {
    const cropped = await cropImageFile(shot.path, region);
    if (!cropped.ok) return cropped;
    pathToUse = cropped.path;
  }

  const decoded = await readPng(pathToUse);
  if (!decoded.ok) return decoded;

  const target = Array.isArray(targetColor)
    ? targetColor
    : String(targetColor).replace("#", "").match(/.{1,2}/g)?.map((v) => parseInt(v, 16));

  if (!target || target.length < 3) return { ok: false, error: "invalid targetColor" };

  const tolerance = Math.max(0, Number(options.tolerance ?? 18));

  for (let y = 0; y < decoded.png.height; y++) {
    for (let x = 0; x < decoded.png.width; x++) {
      const idx = ((decoded.png.width * y) + x) << 2;
      const dr = Math.abs(decoded.png.data[idx] - target[0]);
      const dg = Math.abs(decoded.png.data[idx + 1] - target[1]);
      const db = Math.abs(decoded.png.data[idx + 2] - target[2]);

      if (dr <= tolerance && dg <= tolerance && db <= tolerance) {
        const offset = region ? regionToPlain(region) : { x: 0, y: 0 };
        const result = {
          ok: true,
          x: offset.x + x,
          y: offset.y + y,
          color: target,
          tolerance,
        };
        runtimeState.lastVisualMatch = result;
        return result;
      }
    }
  }

  return { ok: false, error: "color not found" };
}

async function findDominantChange(region, options = {}) {
  const first = await snapshotRegion(region, { name: options.beforeName || `change-before-${Date.now()}` });
  if (!first.ok) return first;

  await sleep(options.waitMs ?? 300);

  const second = await snapshotRegion(typeof region === "string" ? region : first.region, {
    name: options.afterName || `change-after-${Date.now()}`,
  });
  if (!second.ok) return second;

  const compared = await compareSnapshot(first.name, second.name, options);
  if (!compared.ok) return compared;

  return { ok: true, region, ...compared };
}

async function searchGrid(regionInput, options = {}) {
  const region = typeof regionInput === "string" ? runtimeState.regions[regionInput] : regionInput;
  const plain = regionToPlain(region);
  if (!plain) return { ok: false, error: "searchGrid needs a valid region" };

  const cols = Math.max(1, Number(options.cols ?? 3));
  const rows = Math.max(1, Number(options.rows ?? 3));
  const points = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({
        x: Math.round(plain.x + ((c + 0.5) * plain.width) / cols),
        y: Math.round(plain.y + ((r + 0.5) * plain.height) / rows),
      });
    }
  }

  return { ok: true, region: plain, points, count: points.length };
}

async function searchSpiral(centerInput, options = {}) {
  const center = typeof centerInput === "string" ? runtimeState.points[centerInput] : centerInput;
  const p = normalizePoint(center);
  if (!p) return { ok: false, error: "searchSpiral needs a valid center point" };

  const radius = Math.max(4, Number(options.radius ?? 80));
  const step = Math.max(2, Number(options.step ?? 10));
  const points = [];

  for (let r = 0; r <= radius; r += step) {
    for (let a = 0; a < 360; a += 30) {
      const rad = (a * Math.PI) / 180;
      points.push({
        x: Math.round(p.x + r * Math.cos(rad)),
        y: Math.round(p.y + r * Math.sin(rad)),
      });
    }
  }

  return { ok: true, center: p, radius, step, points, count: points.length };
}

async function clickNear(targetInput, options = {}) {
  const target =
    typeof targetInput === "string"
      ? runtimeState.points[targetInput] || runtimeState.lastVisualMatch
      : targetInput;

  const p = normalizePoint(target);
  if (!p) return { ok: false, error: "clickNear needs a target point" };

  const x = p.x + Math.round(Number(options.dx) || 0);
  const y = p.y + Math.round(Number(options.dy) || 0);
  return click(x, y, options.button || "left");
}

async function microAdjust(targetInput, options = {}) {
  const target = typeof targetInput === "string" ? runtimeState.points[targetInput] : targetInput;
  const p = normalizePoint(target);
  if (!p) return { ok: false, error: "microAdjust needs a target point" };

  const pos = await getMousePosition();
  if (!pos.ok) return pos;

  const dx = p.x - pos.x;
  const dy = p.y - pos.y;
  const maxStep = Math.max(1, Number(options.maxStep ?? 6));

  const moveX = clamp(dx, -maxStep, maxStep);
  const moveY = clamp(dy, -maxStep, maxStep);

  return moveBy(moveX, moveY, { smooth: options.smooth ?? false });
}

async function refineClick(targetInput, verifyFn, options = {}) {
  const target =
    typeof targetInput === "string"
      ? runtimeState.points[targetInput] || runtimeState.lastVisualMatch
      : targetInput;

  const p = normalizePoint(target);
  if (!p) return { ok: false, error: "refineClick needs a target point" };

  const radius = Math.max(1, Number(options.radius ?? 8));
  const attempts = Math.max(1, Number(options.attempts ?? 8));
  const offsets = [{ dx: 0, dy: 0 }];

  for (let r = 1; r <= radius; r += 2) {
    offsets.push(
      { dx: r, dy: 0 },
      { dx: -r, dy: 0 },
      { dx: 0, dy: r },
      { dx: 0, dy: -r },
      { dx: r, dy: r },
      { dx: -r, dy: -r },
      { dx: r, dy: -r },
      { dx: -r, dy: r }
    );
  }

  let used = 0;
  for (const offset of offsets.slice(0, attempts)) {
    used += 1;
    const clicked = await click(p.x + offset.dx, p.y + offset.dy, options.button || "left");
    if (!clicked.ok) return clicked;

    if (typeof verifyFn === "function") {
      const verified = await verifyFn(used, offset);
      if (verified?.ok) return { ok: true, attemptsUsed: used, offset, verification: verified };
    } else {
      return { ok: true, attemptsUsed: used, offset };
    }

    await sleep(options.pauseMs ?? 120);
  }

  return { ok: false, error: "refineClick could not verify success" };
}

async function repeatUntilVerified(actionFn, verifyFn, options = {}) {
  const attempts = Math.max(1, Number(options.attempts ?? 3));
  const delayMs = Math.max(0, Number(options.delayMs ?? 250));

  let lastAction = null;
  let lastVerify = null;

  for (let i = 0; i < attempts; i++) {
    lastAction = typeof actionFn === "function" ? await actionFn(i) : { ok: false, error: "actionFn missing" };
    if (!lastAction?.ok) {
      if (i < attempts - 1) await sleep(delayMs);
      continue;
    }

    lastVerify = typeof verifyFn === "function" ? await verifyFn(i, lastAction) : { ok: true };
    if (lastVerify?.ok) return { ok: true, attemptsUsed: i + 1, action: lastAction, verification: lastVerify };

    if (i < attempts - 1) await sleep(delayMs);
  }

  return { ok: false, error: "repeatUntilVerified failed", lastAction, lastVerify };
}

async function runOsascript(script) {
  if (!ISMAC) return { ok: false, error: "osascript only supported on macOS" };
  if (!script) return { ok: false, error: "script required" };

  try {
    const { stdout, stderr } = await execAsync(`osascript -e ${shellQuote(script)}`);
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

async function setVolume(percent) {
  const value = clamp(Number(percent) || 0, 0, 100);
  try {
    if (ISMAC) {
      await execAsync(`osascript -e 'set volume output volume ${value}'`);
      return { ok: true, volume: value };
    }
    return { ok: false, error: "setVolume currently supported on macOS only" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function muteVolume() {
  try {
    if (ISMAC) {
      await execAsync(`osascript -e 'set volume with output muted'`);
      return { ok: true, muted: true };
    }
    return { ok: false, error: "muteVolume currently supported on macOS only" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function unmuteVolume() {
  try {
    if (ISMAC) {
      await execAsync(`osascript -e 'set volume without output muted'`);
      return { ok: true, muted: false };
    }
    return { ok: false, error: "unmuteVolume currently supported on macOS only" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function setBrightness(percent) {
  const value = clamp(Number(percent) || 0, 0, 100);
  try {
    if (ISMAC) {
      await execAsync(`bash -lc 'if command -v brightness >/dev/null 2>&1; then brightness ${value / 100}; else exit 1; fi'`);
      return { ok: true, brightness: value };
    }
    return { ok: false, error: "setBrightness currently supported on macOS with brightness CLI" };
  } catch (err) {
    return { ok: false, error: `${err.message} (brightness control failed)` };
  }
}

async function sleepSystem() {
  try {
    if (ISMAC) {
      await execAsync(`pmset sleepnow`);
      return { ok: true };
    }
    if (ISWINDOWS) {
      await execAsync(`rundll32.exe powrprof.dll,SetSuspendState Sleep`, { shell: "cmd.exe" });
      return { ok: true };
    }
    return { ok: false, error: `Unsupported sleep platform ${process.platform}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function restartSystem() {
  try {
    if (ISMAC) {
      await execAsync(`osascript -e 'tell application "System Events" to restart'`);
      return { ok: true };
    }
    if (ISWINDOWS) {
      await execAsync(`shutdown /r /t 0`, { shell: "cmd.exe" });
      return { ok: true };
    }
    return { ok: false, error: `Unsupported restart platform ${process.platform}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function shutdownSystem() {
  try {
    if (ISMAC) {
      await execAsync(`osascript -e 'tell application "System Events" to shut down'`);
      return { ok: true };
    }
    if (ISWINDOWS) {
      await execAsync(`shutdown /s /t 0`, { shell: "cmd.exe" });
      return { ok: true };
    }
    return { ok: false, error: `Unsupported shutdown platform ${process.platform}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function lockScreen() {
  try {
    if (ISMAC) {
      await execAsync(`/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend`);
      return { ok: true };
    }
    if (ISWINDOWS) {
      await execAsync(`rundll32.exe user32.dll,LockWorkStation`, { shell: "cmd.exe" });
      return { ok: true };
    }
    return { ok: false, error: `Unsupported lock platform ${process.platform}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function openBrowser(url, browserApp = null) {
  const targetUrl = String(url ?? "").trim();
  if (!targetUrl) return { ok: false, error: "openBrowser needs a url" };

  try {
    if (ISMAC) {
      if (browserApp) await execAsync(`open -a ${shellQuote(browserApp)} ${shellQuote(targetUrl)}`);
      else await execAsync(`open ${shellQuote(targetUrl)}`);
    } else if (ISWINDOWS) {
      await execAsync(`start "" ${shellQuote(targetUrl)}`, { shell: "cmd.exe" });
    } else if (ISLINUX) {
      await execAsync(`bash -lc 'xdg-open ${shellQuote(targetUrl)} >/dev/null 2>&1 &'`);
    } else {
      return { ok: false, error: `Unsupported browser platform ${process.platform}` };
    }

    runtimeState.lastOpenedUrl = {
      url: targetUrl,
      browserApp: browserApp || null,
      timestamp: Date.now(),
    };

    await sleep(600);
    return { ok: true, url: targetUrl, browserApp: browserApp || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function openUrl(url, browserApp = null) {
  return openBrowser(url, browserApp);
}

async function openEditor(appName = "Visual Studio Code") {
  return launchApp(appName);
}

async function openTerminal(appName = ISMAC ? "Terminal" : ISWINDOWS ? "Windows Terminal" : "x-terminal-emulator") {
  return launchApp(appName);
}

async function isTextVisible(text, region = null) {
  const found = await findText(text, region);
  if (!found.ok) return { ok: true, visible: false, text: String(text) };
  return { ok: true, visible: true, text: String(text), x: found.x, y: found.y };
}

async function isAnyTextVisible(texts, region = null) {
  const found = await findTextAny(texts, region);
  if (!found.ok) return { ok: true, visible: false, texts: normalizeTexts(texts) };
  return { ok: true, visible: true, text: found.text, x: found.x, y: found.y };
}

module.exports = {
  sleep,
  retry,
  getMousePosition,
  focusApp,
  focusAndWait,
  ensureFocus,
  waitForAppReady,
  focusAndType,
  moveMouse,
  moveSmooth,
  moveBy,
  nudgeMouse,
  click,
  rightClick,
  doubleClick,
  mouseDown,
  mouseUp,
  mouseHold,
  mouseRelease,
  drag,
  dragBy,
  dragPath,
  chordDrag,
  scroll,
  type,
  paste,
  pressKey,
  pressKeyDown,
  pressKeyUp,
  pressSequence,
  pressUntil,
  selectAll,
  typeSmart,
  clearAndType,
  takeSystemScreenshot,
  takeScreenshot: takeSystemScreenshot,
  findText,
  findTextAny,
  findAndClick,
  findAndClickAny,
  retryFindAndClick,
  waitFor,
  waitForAny,
  waitForGone,
  waitAndClick,
  scrollAndFind,
  scrollUntil,
  savePoint,
  saveRegion,
  getPoint,
  getRegion,
  offsetPoint,
  clickPoint,
  dragPoints,
  snapshotRegion,
  compareSnapshot,
  verifyChanged,
  verifyUnchanged,
  findImage,
  findAnyImage,
  waitForImage,
  waitForImageGone,
  clickImage,
  findColor,
  findDominantChange,
  searchGrid,
  searchSpiral,
  clickNear,
  microAdjust,
  refineClick,
  repeatUntilVerified,
  runOsascript,
  setVolume,
  muteVolume,
  unmuteVolume,
  setBrightness,
  sleepSystem,
  restartSystem,
  shutdownSystem,
  lockScreen,
  launchApp,
  openBrowser,
  openUrl,
  openEditor,
  openTerminal,
  isTextVisible,
  isAnyTextVisible,
  runtimeState,
};