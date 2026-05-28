"use strict";

const hands = require("./Hands");
const bodyOS = require("./bodyOS");
const sysEnv = require("./Systemenvironment");

const cancelledTasks = new Set();

const ACTION_ALIASES = {
  focusapp: "focus_app",
  focus_app: "focus_app",
  ensureapp: "ensure_app",
  ensure_app: "ensure_app",
  opennewdoc: "open_new_doc",
  open_new_doc: "open_new_doc",
  openapp: "launch_app",
  launchapp: "launch_app",
  launch_app: "launch_app",
  focusandtype: "focus_and_type",
  focus_and_type: "focus_and_type",
  findtext: "find_text",
  find_text: "find_text",
  findtextany: "find_text_any",
  find_text_any: "find_text_any",
  findandclick: "find_and_click",
  find_and_click: "find_and_click",
  retryclick: "retry_click",
  retry_click: "retry_click",
  doubleclick: "double_click",
  double_click: "double_click",
  rightclick: "right_click",
  right_click: "right_click",
  waitfor: "wait_for",
  wait_for: "wait_for",
  waitforany: "wait_for_any",
  wait_for_any: "wait_for_any",
  waitforgone: "wait_for_gone",
  wait_for_gone: "wait_for_gone",
  waitandclick: "wait_and_click",
  wait_and_click: "wait_and_click",
  waitforappready: "wait_for_app_ready",
  wait_for_app_ready: "wait_for_app_ready",
  presssequence: "press_sequence",
  press_sequence: "press_sequence",
  pressuntil: "press_until",
  press_until: "press_until",
  clearandtype: "clear_and_type",
  clear_and_type: "clear_and_type",
  typesmart: "type_smart",
  type_smart: "type_smart",
  scrolldown: "scroll_down",
  scroll_down: "scroll_down",
  scrollup: "scroll_up",
  scroll_up: "scroll_up",
  scrollleft: "scroll_left",
  scroll_left: "scroll_left",
  scrollright: "scroll_right",
  scroll_right: "scroll_right",
  scrolluntil: "scroll_until",
  scroll_until: "scroll_until",
  scrollandfind: "scroll_and_find",
  scroll_and_find: "scroll_and_find",
  runosascript: "osascript",
  run_osascript: "osascript",
  runcommand: "run_command",
  run_command: "run_command",
  stopcommand: "stop_command",
  stop_command: "stop_command",
  waitforserver: "wait_for_server",
  wait_for_server: "wait_for_server",
  createfolder: "create_folder",
  create_folder: "create_folder",
  createfile: "create_file",
  create_file: "create_file",
  writefile: "write_file",
  write_file: "write_file",
  appendfile: "append_file",
  append_file: "append_file",
  readfile: "read_file",
  read_file: "read_file",
  pathexists: "path_exists",
  path_exists: "path_exists",
  openeditor: "open_editor",
  open_editor: "open_editor",
  openbrowser: "open_browser",
  open_browser: "open_browser",
  openterminal: "open_terminal",
  open_terminal: "open_terminal",
  openproject: "open_project",
  open_project: "open_project",
  openpreview: "open_preview",
  open_preview: "open_preview",
  openurl: "open_url",
  open_url: "open_url",
  pushrepo: "push_repo",
  push_repo: "push_repo",
  deployproject: "deploy_project",
  deploy_project: "deploy_project",
  setdomain: "set_domain",
  set_domain: "set_domain",
  moveby: "move_by",
  move_by: "move_by",
  movesmooth: "move_smooth",
  move_smooth: "move_smooth",
  nudgemouse: "nudge_mouse",
  nudge_mouse: "nudge_mouse",
  dragby: "drag_by",
  drag_by: "drag_by",
  dragpath: "drag_path",
  drag_path: "drag_path",
  mousehold: "mouse_hold",
  mouse_hold: "mouse_hold",
  mouserelease: "mouse_release",
  mouse_release: "mouse_release",
  savepoint: "save_point",
  save_point: "save_point",
  saveregion: "save_region",
  save_region: "save_region",
  clickpoint: "click_point",
  click_point: "click_point",
  dragpoints: "drag_points",
  drag_points: "drag_points",
  findimage: "find_image",
  find_image: "find_image",
  findimageany: "find_image_any",
  find_image_any: "find_image_any",
  clickimage: "click_image",
  click_image: "click_image",
  waitforimage: "wait_for_image",
  wait_for_image: "wait_for_image",
  waitforimagegone: "wait_for_image_gone",
  wait_for_image_gone: "wait_for_image_gone",
  findcolor: "find_color",
  find_color: "find_color",
  snapshotregion: "snapshot_region",
  snapshot_region: "snapshot_region",
  comparesnapshot: "compare_snapshot",
  compare_snapshot: "compare_snapshot",
  verifychanged: "verify_changed",
  verify_changed: "verify_changed",
  verifyunchanged: "verify_unchanged",
  verify_unchanged: "verify_unchanged",
  searchgrid: "search_grid",
  search_grid: "search_grid",
  searchspiral: "search_spiral",
  search_spiral: "search_spiral",
  clicknear: "click_near",
  click_near: "click_near",
  microadjust: "micro_adjust",
  micro_adjust: "micro_adjust",
  refineclick: "refine_click",
  refine_click: "refine_click",
};

function normalizeAction(action = "") {
  const key = String(action).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ACTION_ALIASES[key] || key;
}

// If Groq puts the app name inside the action string (e.g. "opennewdoc microsoft word"),
// extract it to step.app so the case handler can find it via resolveAppName
function extractAppFromAction(rawStep = {}) {
  const raw = String(rawStep.action || rawStep.verb || "").trim();
  const PREFIXES = ["opennewdoc", "open_new_doc", "ensureapp", "ensure_app", "launchapp", "launch_app"];
  for (const prefix of PREFIXES) {
    if (raw.toLowerCase().startsWith(prefix) && raw.length > prefix.length) {
      const appPart = raw.slice(prefix.length).replace(/^[\s_]+/, "").trim();
      if (appPart && !rawStep.app && !rawStep.target) {
        return { ...rawStep, action: prefix, app: appPart };
      }
    }
  }
  return rawStep;
}

function emit(onProgress, payload) {
  if (typeof onProgress === "function") onProgress(payload);
}

function emitTelemetry(onProgress, taskId, type, extra = {}) {
  emit(onProgress, { type, taskId, ...extra });
}

function isCancelled(taskId) {
  return !!taskId && cancelledTasks.has(taskId);
}

function resolveStep(rawStep = {}, context = {}) {
  const fixed = extractAppFromAction(rawStep);
  const resolved = bodyOS.resolveTemplate({ ...fixed }, context);
  resolved.action = normalizeAction(fixed.action || fixed.verb || "verb");
  return resolved;
}

function pickStoredValue(result) {
  if (!result || !result.ok) return undefined;
  if (result.url) return result.url;
  if (result.path) return result.path;
  if (typeof result.stdout === "string" && result.stdout.trim()) return result.stdout.trim();
  if (typeof result.text === "string") return result.text;
  if (typeof result.value !== "undefined") return result.value;
  if (typeof result.exists !== "undefined") return result.exists;
  if (typeof result.pid !== "undefined") return result.pid;
  return true;
}

function storeStepOutput(step, result, context) {
  context.lastResult = result;
  if (!result?.ok) return;

  if (step.storeAs) context.vars[step.storeAs] = pickStoredValue(result);
  if (result.path) context.vars.lastPath = result.path;
  if (result.url) context.vars.lastUrl = result.url;
  if (typeof result.pid !== "undefined") context.vars.lastPid = result.pid;
  if (typeof result.text === "string") context.vars.lastText = result.text;
  if (typeof result.stdout === "string") context.vars.lastStdout = result.stdout;
  if (typeof result.x !== "undefined") context.vars.lastX = result.x;
  if (typeof result.y !== "undefined") context.vars.lastY = result.y;
}

function shouldSkipStep(step, context) {
  if (step.ifVar && !context.vars?.[step.ifVar]) return { skip: true, reason: `ifVar ${step.ifVar} is falsy` };
  if (step.unlessVar && context.vars?.[step.unlessVar]) return { skip: true, reason: `unlessVar ${step.unlessVar} is truthy` };
  return { skip: false };
}

function resolveAppName(step = {}, context = {}) {
  const raw =
    step.app ||
    step.appName ||
    step.application ||
    step.targetApp ||
    step.name ||
    context?.vars?.targetApp ||
    context?.vars?.app ||
    context?.task?.app ||
    context?.task?.targetApp ||
    context?.task?.context?.vars?.targetApp ||
    (Array.isArray(context?.task?.context?.apps) ? context.task.context.apps[0] : null) ||
    (Array.isArray(context?.task?.apps) ? context.task.apps[0] : null) ||
    "";

  if (!raw) return "";

  // Run through sysEnv alias map: resolves "file manager" → "Finder",
  // "visual studio" → "Visual Studio Code", etc.
  // If the resolved app isn't installed, sysEnv.resolveApp returns null —
  // in that case fall back to the raw name so the error surfaces clearly.
  const resolved = sysEnv.resolveApp(raw);
  if (resolved) return resolved;

  // Check the alias map even if not installed (covers Finder which always exists)
  const key = String(raw).toLowerCase().trim();
  const aliased = sysEnv.APP_ALIASES[key];
  return aliased || raw;
}

function normalizeKeysInput(step = {}) {
  const raw = step.keys ?? step.key ?? step.sequence ?? step.shortcut ?? [];
  if (Array.isArray(raw)) {
    return raw.map((k) => String(k).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[\s,+]+/)
      .map((k) => String(k).trim())
      .filter(Boolean);
  }
  return [];
}

async function safeEnsureAppFocused(step = {}, context = {}) {
  const app = resolveAppName(step, context);
  if (!app) return { ok: false, error: "focus/ensure requires app" };

  if (step.launch !== false) {
    const launched = await bodyOS.launchApp(app);
    if (!launched.ok && step.requireLaunch) return launched;
  }

  const focusResult = typeof hands.ensureFocus === "function"
    ? await hands.ensureFocus(app, step.focusRetries ?? 3, step.settleMs ?? 800)
    : await hands.focusApp(app);

  if (!focusResult.ok) return focusResult;

  const pauseMs = step.pauseAfter ?? step.settleMs ?? 800;
  if (pauseMs > 0) await hands.sleep(pauseMs);

  return { ok: true, app, waitedMs: pauseMs };
}

async function runVerification(verifyConfig, context) {
  if (!verifyConfig) return { ok: true };
  const list = Array.isArray(verifyConfig) ? verifyConfig : [verifyConfig];

  for (const rawVerify of list) {
    const verify = resolveStep(typeof rawVerify === "string" ? { action: "wait_for", target: rawVerify } : rawVerify, context);
    const type = normalizeAction(verify.type || verify.action);
    let result;

    switch (type) {
      case "wait_for":
        result = await hands.waitFor(verify.target || verify.text || "", verify.timeout || 10000, verify.interval || 500, verify.region || null);
        break;
      case "wait_for_any":
        result = await hands.waitForAny(verify.targets || verify.texts || [], verify.timeout || 10000, verify.interval || 500, verify.region || null);
        break;
      case "wait_for_gone":
        result = await hands.waitForGone(verify.target || verify.text || "", verify.timeout || 10000, verify.interval || 500, verify.region || null);
        break;
      case "wait_for_server":
        result = await bodyOS.waitForServer(verify, context);
        break;
      case "path_exists":
        result = await bodyOS.pathExists(verify, context);
        break;
      case "read_file": {
        result = await bodyOS.readFile(verify, context);
        if (!result.ok) break;
        if (verify.includes && !result.text.includes(String(verify.includes))) result = { ok: false, error: "verification failed: file does not include expected text" };
        if (verify.notIncludes && result.ok && result.text.includes(String(verify.notIncludes))) result = { ok: false, error: "verification failed: file includes forbidden text" };
        break;
      }
      case "wait_for_app_ready":
        result = await hands.waitForAppReady(resolveAppName(verify, context), verify.readyTexts || verify.texts || verify.readyText || [], {
          settleMs: verify.settleMs ?? 500,
          focusRetries: verify.focusRetries ?? 3,
          timeout: verify.timeout ?? 12000,
          interval: verify.interval ?? 500,
          region: verify.region || null,
        });
        break;
      case "wait_for_image":
        result = typeof hands.waitForImage === "function"
          ? await hands.waitForImage(verify.image || verify.target || verify.path || "", verify)
          : { ok: false, error: "waitForImage unavailable in Hands" };
        break;
      case "wait_for_image_gone":
        result = typeof hands.waitForImageGone === "function"
          ? await hands.waitForImageGone(verify.image || verify.target || verify.path || "", verify)
          : { ok: false, error: "waitForImageGone unavailable in Hands" };
        break;
      case "verify_changed":
        result = typeof hands.verifyChanged === "function"
          ? await hands.verifyChanged(verify.region || verify.target, verify)
          : { ok: false, error: "verifyChanged unavailable in Hands" };
        break;
      case "verify_unchanged":
        result = typeof hands.verifyUnchanged === "function"
          ? await hands.verifyUnchanged(verify.region || verify.target, verify)
          : { ok: false, error: "verifyUnchanged unavailable in Hands" };
        break;
      case "compare_snapshot":
        result = typeof hands.compareSnapshot === "function"
          ? await hands.compareSnapshot(verify.before || verify.left, verify.after || verify.right, verify)
          : { ok: false, error: "compareSnapshot unavailable in Hands" };
        if (result.ok && verify.expectChanged === true && !result.changed) result = { ok: false, error: "verification failed: expected change", ...result };
        if (result.ok && verify.expectChanged === false && result.changed) result = { ok: false, error: "verification failed: unexpected change", ...result };
        break;
      default:
        result = { ok: false, error: `unknown verify type: ${type}` };
        break;
    }

    if (!result.ok) return result;
  }

  return { ok: true };
}

async function buildRefineVerifier(step, context) {
  if (!step.verify) return null;
  return async () => runVerification(step.verify, context);
}

async function runPrimitiveStep(step, context) {
  const action = normalizeAction(step.action);

  switch (action) {
    case "focus_app": {
      const app = resolveAppName(step, context);
      if (!app) return { ok: false, error: "focus_app requires app" };
      return hands.focusApp(app);
    }

    case "ensure_app": {
      const app = resolveAppName(step, context);
      if (!app) return { ok: false, error: "ensure_app requires app" };

      if (step.launch !== false) {
        const launched = await bodyOS.launchApp(app);
        if (!launched.ok && step.requireLaunch) return launched;
      }

      const rawReady = step.readyTexts || step.texts || step.readyText;
      const isWindowTitle = (t) => {
        const s = String(t);
        return / - [A-Z]/.test(s) || s.toLowerCase().includes("untitled") || s.length > 30;
      };
      const safeReady = rawReady ? [].concat(rawReady).filter((t) => !isWindowTitle(t)) : [];

      if (safeReady.length > 0 && typeof hands.waitForAppReady === "function") {
        return hands.waitForAppReady(app, safeReady, {
          settleMs: step.settleMs ?? 500,
          focusRetries: step.focusRetries ?? 3,
          timeout: step.timeout ?? 12000,
          interval: step.interval ?? 500,
          region: step.region || null,
        });
      }

      const focusResult = typeof hands.ensureFocus === "function"
        ? await hands.ensureFocus(app, step.focusRetries ?? 3, step.settleMs ?? 800)
        : await hands.focusApp(app);

      if (!focusResult.ok) return focusResult;
      const pauseMs = step.pauseAfter ?? step.settleMs ?? 1500;
      await hands.sleep(pauseMs);
      return { ok: true, app, waitedMs: pauseMs };
    }

    case "launch_app": {
      const app = resolveAppName(step, context);
      if (!app) return { ok: false, error: "launch_app requires app" };

      const launchResult = await bodyOS.launchApp(app);
      if (launchResult.ok) {
        const waitMs = step.waitMs ?? step.wait_ms ?? 3000;
        console.log(`[executer] launch_app "${app}" — waiting ${waitMs}ms for app to open`);
        await hands.sleep(waitMs);
      }
      return launchResult;
    }

    case "open_new_doc": {
      const app = resolveAppName(step, context);
      if (!app) return { ok: false, error: "open_new_doc requires app" };

      const SCRIPTS = {
        "microsoft word": 'tell application "Microsoft Word" to make new document',
        "word":           'tell application "Microsoft Word" to make new document',
        "microsoft excel":'tell application "Microsoft Excel" to make new document',
        "excel":          'tell application "Microsoft Excel" to make new document',
        "pages":          'tell application "Pages" to make new document',
        "numbers":        'tell application "Numbers" to make new document',
        "keynote":        'tell application "Keynote" to make new document',
      };

      const script = SCRIPTS[app.toLowerCase()];
      if (!script) {
        console.log(`[executer] open_new_doc: no AppleScript for "${app}", falling back to ensure_app`);
        return runPrimitiveStep({ ...step, action: "ensure_app" }, context);
      }

      console.log(`[executer] open_new_doc "${app}" via AppleScript`);
      const result = await hands.runOsascript(script);
      if (!result.ok) {
        console.log(`[executer] open_new_doc AppleScript failed: ${result.error} — falling back to ensure_app`);
        return runPrimitiveStep({ ...step, action: "ensure_app" }, context);
      }
      await hands.sleep(step.settleMs ?? 1800);
      return { ok: true, app, method: "appleScript" };
    }

    case "focus_and_type": {
      const app = resolveAppName(step, context);
      const text = step.text || "";

      if (!text) return { ok: false, error: "focus_and_type requires text" };

      if (step.target) {
        return hands.focusAndType(app || "", text, {
          target: step.target || null,
          clearFirst: !!step.clearFirst,
          threshold: step.pasteThreshold ?? step.threshold ?? 80,
          region: step.region || null,
          waitForTarget: !!step.waitForTarget,
          targetTimeout: step.targetTimeout ?? 10000,
          readyTexts: step.readyTexts || step.texts || [],
          readyTimeout: step.readyTimeout ?? 10000,
        });
      }

      if (app) {
        const focused = await safeEnsureAppFocused({ ...step, app, launch: step.launch !== false }, context);
        if (!focused.ok) return focused;
      }

      if (step.clearFirst) {
        return hands.clearAndType(text, { threshold: step.pasteThreshold ?? step.threshold ?? 80 });
      }

      return hands.typeSmart(text, step.pasteThreshold ?? step.threshold ?? 80);
    }

    case "find_text":
      return hands.findText(step.target || step.text || "", step.region || null);

    case "find_text_any":
      return hands.findTextAny(step.targets || step.texts || [], step.region || null);

    case "find_and_click":
      return hands.findAndClick(step.target || step.text || "", step.region || null);

    case "retry_click":
      if (step.target || step.text) {
        return hands.retryFindAndClick(
          step.target || step.text || "",
          step.region || null,
          step.attempts ?? step.retries ?? 3,
          step.delayMs ?? step.retryDelay ?? 400
        );
      }
      if (step.x !== undefined && step.y !== undefined) {
        return hands.retry(() => hands.click(step.x, step.y, step.button || "left"), {
          attempts: step.attempts ?? step.retries ?? 3,
          delayMs: step.delayMs ?? step.retryDelay ?? 250,
          backoff: 1.2,
        });
      }
      return { ok: false, error: "retry_click needs target or x,y" };

    case "click":
      if (step.x !== undefined && step.y !== undefined) return hands.click(step.x, step.y, step.button || "left");
      if (step.target || step.text) return hands.findAndClick(step.target || step.text || "", step.region || null);
      return { ok: false, error: "click needs x,y or target" };

    case "right_click":
      if (step.x !== undefined && step.y !== undefined) return hands.rightClick(step.x, step.y);
      if (step.target || step.text) {
        const found = await hands.findText(step.target || step.text || "", step.region || null);
        if (!found.ok) return found;
        return hands.rightClick(found.x, found.y);
      }
      return { ok: false, error: "right_click needs x,y or target" };

    case "double_click":
      if (step.x !== undefined && step.y !== undefined) return hands.doubleClick(step.x, step.y);
      if (step.target || step.text) {
        const found = await hands.findText(step.target || step.text || "", step.region || null);
        if (!found.ok) return found;
        return hands.doubleClick(found.x, found.y);
      }
      return { ok: false, error: "double_click needs x,y or target" };

    case "drag": {
      let fromX = step.fromX;
      let fromY = step.fromY;
      let toX = step.toX;
      let toY = step.toY;

      if ((fromX === undefined || fromY === undefined) && step.fromTarget) {
        const from = await hands.findText(step.fromTarget, step.fromRegion || step.region || null);
        if (!from.ok) return from;
        fromX = from.x;
        fromY = from.y;
      }

      if ((toX === undefined || toY === undefined) && step.toTarget) {
        const to = await hands.findText(step.toTarget, step.toRegion || step.region || null);
        if (!to.ok) return to;
        toX = to.x;
        toY = to.y;
      }

      if ([fromX, fromY, toX, toY].some((v) => v === undefined)) {
        return { ok: false, error: "drag needs fromX/fromY/toX/toY or fromTarget/toTarget" };
      }
      return hands.drag(fromX, fromY, toX, toY, step.button || "left");
    }

    case "move_by":
      return typeof hands.moveBy === "function" ? hands.moveBy(step.dx ?? 0, step.dy ?? 0, step) : { ok: false, error: "moveBy unavailable in Hands" };

    case "move_smooth":
      return typeof hands.moveSmooth === "function" ? hands.moveSmooth(step.x, step.y, step) : { ok: false, error: "moveSmooth unavailable in Hands" };

    case "nudge_mouse":
      return typeof hands.nudgeMouse === "function" ? hands.nudgeMouse(step.direction || step.target, step.pixels ?? step.amount ?? 1, step) : { ok: false, error: "nudgeMouse unavailable in Hands" };

    case "drag_by":
      return typeof hands.dragBy === "function" ? hands.dragBy(step.dx ?? 0, step.dy ?? 0, step) : { ok: false, error: "dragBy unavailable in Hands" };

    case "drag_path":
      return typeof hands.dragPath === "function" ? hands.dragPath(step.points || [], step) : { ok: false, error: "dragPath unavailable in Hands" };

    case "mouse_hold":
      return typeof hands.mouseHold === "function" ? hands.mouseHold(step.button || "left") : hands.mouseDown(step.button || "left");

    case "mouse_release":
      return typeof hands.mouseRelease === "function" ? hands.mouseRelease(step.button || "left") : hands.mouseUp(step.button || "left");

    case "type":
      return hands.type(step.text || "");

    case "paste":
      return hands.paste(step.text || "");

    case "type_smart":
      return hands.typeSmart(step.text || "", step.pasteThreshold ?? step.threshold ?? 80);

    case "clear_and_type":
      return hands.clearAndType(step.text || "", { threshold: step.pasteThreshold ?? step.threshold ?? 80 });

    case "key":
      return hands.pressKey(step.key || "");

    case "key_down":
      return typeof hands.pressKeyDown === "function" ? hands.pressKeyDown(step.key || "") : { ok: false, error: "pressKeyDown unavailable in Hands" };

    case "key_up":
      return typeof hands.pressKeyUp === "function" ? hands.pressKeyUp(step.key || "") : { ok: false, error: "pressKeyUp unavailable in Hands" };

    case "press_sequence": {
      const keys = normalizeKeysInput(step);
      if (!keys.length) return { ok: false, error: "pressSequence needs a non-empty keys array" };
      return hands.pressSequence(keys, step.pause ?? 120);
    }

    case "press_until":
      return hands.pressUntil(step.key || "", step.targets || step.texts || step.target || step.text, {
        repeats: step.repeats ?? 8,
        pauseMs: step.pauseMs ?? 250,
        region: step.region || null,
      });

    case "wait_for":
      return hands.waitFor(step.target || step.text || "", step.timeout || 10000, step.interval || 500, step.region || null);

    case "wait_for_any":
      return hands.waitForAny(step.targets || step.texts || [], step.timeout || 10000, step.interval || 500, step.region || null);

    case "wait_for_gone":
      return hands.waitForGone(step.target || step.text || "", step.timeout || 10000, step.interval || 500, step.region || null);

    case "wait_and_click":
      return hands.waitAndClick(step.target || step.text || "", step.timeout || 10000, step.region || null);

    case "scroll_down":
      return hands.scroll("down", step.amount || 3);

    case "scroll_up":
      return hands.scroll("up", step.amount || 3);

    case "scroll_left":
      return hands.scroll("left", step.amount || 3);

    case "scroll_right":
      return hands.scroll("right", step.amount || 3);

    case "scroll_and_find":
      return hands.scrollAndFind(step.target || step.text || "", step.direction || "down", step.maxScrolls ?? 8, step.amount ?? 3, step.region || null);

    case "scroll_until":
      return hands.scrollUntil(step.target || step.text || "", step.direction || "down", step.maxScrolls ?? 8, step.amount ?? 3, step.region || null);

    case "save_point":
      return typeof hands.savePoint === "function" ? hands.savePoint(step.name || step.storeAs || step.target, step.point || step.from || null) : { ok: false, error: "savePoint unavailable in Hands" };

    case "save_region":
      return typeof hands.saveRegion === "function" ? hands.saveRegion(step.name || step.storeAs || step.target, step.region || step.value || step.bounds) : { ok: false, error: "saveRegion unavailable in Hands" };

    case "click_point":
      return typeof hands.clickPoint === "function" ? hands.clickPoint(step.name || step.target, step) : { ok: false, error: "clickPoint unavailable in Hands" };

    case "drag_points":
      return typeof hands.dragPoints === "function" ? hands.dragPoints(step.from || step.fromName, step.to || step.toName, step) : { ok: false, error: "dragPoints unavailable in Hands" };

    case "find_image":
      return typeof hands.findImage === "function" ? hands.findImage(step.image || step.target || step.path || "", step) : { ok: false, error: "findImage unavailable in Hands" };

    case "find_image_any":
      return typeof hands.findAnyImage === "function" ? hands.findAnyImage(step.images || step.targets || [], step) : { ok: false, error: "findAnyImage unavailable in Hands" };

    case "click_image":
      return typeof hands.clickImage === "function" ? hands.clickImage(step.image || step.target || step.path || "", step) : { ok: false, error: "clickImage unavailable in Hands" };

    case "wait_for_image":
      return typeof hands.waitForImage === "function" ? hands.waitForImage(step.image || step.target || step.path || "", step) : { ok: false, error: "waitForImage unavailable in Hands" };

    case "wait_for_image_gone":
      return typeof hands.waitForImageGone === "function" ? hands.waitForImageGone(step.image || step.target || step.path || "", step) : { ok: false, error: "waitForImageGone unavailable in Hands" };

    case "find_color":
      return typeof hands.findColor === "function" ? hands.findColor(step.color || step.target, step) : { ok: false, error: "findColor unavailable in Hands" };

    case "snapshot_region":
      return typeof hands.snapshotRegion === "function" ? hands.snapshotRegion(step.region || step.target, step) : { ok: false, error: "snapshotRegion unavailable in Hands" };

    case "compare_snapshot":
      return typeof hands.compareSnapshot === "function" ? hands.compareSnapshot(step.before || step.left, step.after || step.right, step) : { ok: false, error: "compareSnapshot unavailable in Hands" };

    case "verify_changed":
      return typeof hands.verifyChanged === "function" ? hands.verifyChanged(step.region || step.target, step) : { ok: false, error: "verifyChanged unavailable in Hands" };

    case "verify_unchanged":
      return typeof hands.verifyUnchanged === "function" ? hands.verifyUnchanged(step.region || step.target, step) : { ok: false, error: "verifyUnchanged unavailable in Hands" };

    case "search_grid":
      return typeof hands.searchGrid === "function" ? hands.searchGrid(step.region || step.target, step) : { ok: false, error: "searchGrid unavailable in Hands" };

    case "search_spiral":
      return typeof hands.searchSpiral === "function" ? hands.searchSpiral(step.center || step.target, step) : { ok: false, error: "searchSpiral unavailable in Hands" };

    case "click_near":
      return typeof hands.clickNear === "function" ? hands.clickNear(step.target || step.name, step) : { ok: false, error: "clickNear unavailable in Hands" };

    case "micro_adjust":
      return typeof hands.microAdjust === "function" ? hands.microAdjust(step.target || step.name, step) : { ok: false, error: "microAdjust unavailable in Hands" };

    case "refine_click": {
      const verifier = await buildRefineVerifier(step, context);
      const target = step.targetPoint || step.point || step.target || step.name;
      return typeof hands.refineClick === "function" ? hands.refineClick(target, verifier, step) : { ok: false, error: "refineClick unavailable in Hands" };
    }

    case "sleep":
      await hands.sleep(step.ms ?? 500);
      return { ok: true, sleptMs: step.ms ?? 500 };

    case "screenshot":
      return hands.takeSystemScreenshot(step.path || null);

    case "osascript":
      return hands.runOsascript(step.script || "");

    case "create_folder":
      return bodyOS.createFolder(step, context);

    case "create_file":
      return bodyOS.createFile(step, context);

    case "write_file":
      return bodyOS.writeFile(step, context);

    case "append_file":
      return bodyOS.appendFile(step, context);

    case "read_file":
      return bodyOS.readFile(step, context);

    case "path_exists":
      return bodyOS.pathExists(step, context);

    case "run_command":
      return bodyOS.runCommand(step, context);

    case "stop_command":
      return bodyOS.stopCommand(step, context);

    case "wait_for_server":
      return bodyOS.waitForServer(step, context);

    default:
      return { ok: false, error: `Unknown step action: "${action}"` };
  }
}

async function runExpandedSteps(steps, context, onProgress, taskMeta) {
  const results = [];
  for (const rawStep of steps) {
    const result = await executeStepWithPolicy(rawStep, context, onProgress, taskMeta);
    results.push(result);
    if (!result.ok && !rawStep.continueOnFail) {
      return { ok: false, error: result.error, results };
    }
  }
  return { ok: true, results };
}

async function executeSingleAttempt(rawStep, context, onProgress, taskMeta) {
  const step = resolveStep(rawStep, context);
  const guard = shouldSkipStep(step, context);
  if (guard.skip) return { ok: true, skipped: true, reason: guard.reason };

  const expanded = bodyOS.expandVerb(step, context);
  if (expanded) return runExpandedSteps(expanded, context, onProgress, taskMeta);

  const result = await runPrimitiveStep(step, context);
  if (!result.ok) return result;

  if (step.action !== "refine_click") {
    const verified = await runVerification(step.verify, context);
    if (!verified.ok) {
      return { ok: false, error: verified.error || "verification failed", verification: verified };
    }
  }

  return result;
}

async function executeStepWithPolicy(rawStep, context, onProgress, taskMeta) {
  const baseStep = resolveStep(rawStep, context);
  const retries = Number.isFinite(baseStep.retries) ? baseStep.retries : 0;
  const retryDelay = baseStep.retryDelay || 700;
  let attempt = 0;
  let lastResult = null;

  while (attempt <= retries) {
    if (isCancelled(taskMeta.taskId)) {
      emitTelemetry(onProgress, taskMeta.taskId, "task_cancelled", { reason: "step_loop_cancelled" });
      return { ok: false, cancelled: true, error: "task cancelled" };
    }

    attempt += 1;

    emit(onProgress, {
      type: "step",
      taskId: taskMeta.taskId,
      label: baseStep.label || baseStep.action,
      phase: baseStep.phase || null,
      stepIndex: taskMeta.stepIndex,
      totalSteps: taskMeta.totalSteps,
      action: baseStep.action,
      target: baseStep.target || null,
      animHint: baseStep.animHint || null,
      status: attempt === 1 ? "started" : "retrying",
      attempt,
      ok: null,
    });

    if (attempt > 1) {
      emitTelemetry(onProgress, taskMeta.taskId, "step_retry", {
        action: baseStep.action,
        phase: baseStep.phase || null,
        attempt,
      });
    }

    lastResult = await executeSingleAttempt(rawStep, context, onProgress, taskMeta);

    if (lastResult.ok) {
      storeStepOutput(baseStep, lastResult, context);

      emit(onProgress, {
        type: "step",
        taskId: taskMeta.taskId,
        label: baseStep.label || baseStep.action,
        phase: baseStep.phase || null,
        stepIndex: taskMeta.stepIndex,
        totalSteps: taskMeta.totalSteps,
        action: baseStep.action,
        target: baseStep.target || null,
        animHint: baseStep.animHint || null,
        status: "succeeded",
        attempt,
        ok: true,
      });

      emitTelemetry(onProgress, taskMeta.taskId, "step_succeeded", {
        action: baseStep.action,
        phase: baseStep.phase || null,
        attempt,
      });

      if (baseStep.pauseAfter !== 0) await hands.sleep(baseStep.pauseAfter || 200);
      return lastResult;
    }

    emit(onProgress, {
      type: "step",
      taskId: taskMeta.taskId,
      label: baseStep.label || baseStep.action,
      phase: baseStep.phase || null,
      stepIndex: taskMeta.stepIndex,
      totalSteps: taskMeta.totalSteps,
      action: baseStep.action,
      target: baseStep.target || null,
      animHint: baseStep.animHint || null,
      status: "failed",
      attempt,
      ok: false,
      error: lastResult.error || "step failed",
    });

    emitTelemetry(onProgress, taskMeta.taskId, "step_failed", {
      action: baseStep.action,
      phase: baseStep.phase || null,
      attempt,
      error: lastResult.error || "step failed",
    });

    if (/not found/i.test(String(lastResult.error || ""))) {
      emitTelemetry(onProgress, taskMeta.taskId, "ocr_miss", {
        action: baseStep.action,
        phase: baseStep.phase || null,
        attempt,
      });
    }

    if (attempt <= retries) await hands.sleep(retryDelay * attempt);
  }

  if (baseStep.fallback) {
    const fallbackSteps = Array.isArray(baseStep.fallback) ? baseStep.fallback : [baseStep.fallback];

    emit(onProgress, {
      type: "step",
      taskId: taskMeta.taskId,
      label: baseStep.label || baseStep.action,
      phase: baseStep.phase || null,
      stepIndex: taskMeta.stepIndex,
      totalSteps: taskMeta.totalSteps,
      action: baseStep.action,
      target: baseStep.target || null,
      animHint: baseStep.animHint || "thinking",
      status: "fallback",
      attempt: retries + 1,
      ok: false,
      error: lastResult?.error || "fallback triggered",
    });

    emitTelemetry(onProgress, taskMeta.taskId, "fallback_triggered", {
      action: baseStep.action,
      phase: baseStep.phase || null,
      error: lastResult?.error || "fallback triggered",
    });

    return runExpandedSteps(fallbackSteps, context, onProgress, taskMeta);
  }

  return lastResult || { ok: false, error: "step failed" };
}

async function runPhases(phases, context, onProgress, task) {
  const flatResults = [];

  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const phase = phases[phaseIndex] || {};
    const steps = Array.isArray(phase.steps) ? phase.steps : [];
    const phaseName = phase.name || `phase_${phaseIndex + 1}`;

    emit(onProgress, {
      type: "phase",
      taskId: task.taskId,
      label: phase.label || phaseName,
      phaseName,
      phaseIndex,
      totalPhases: phases.length,
      status: "started",
    });

    emitTelemetry(onProgress, task.taskId, "phase_started", {
      phaseName,
      phaseIndex,
      totalPhases: phases.length,
    });

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      if (isCancelled(task.taskId)) {
        emitTelemetry(onProgress, task.taskId, "task_cancelled", { reason: "phase_cancelled", phaseName });
        return {
          ok: false,
          cancelled: true,
          error: "task cancelled",
          failedStep: stepIndex + 1,
          phaseName,
          results: flatResults,
        };
      }

      const step = { ...steps[stepIndex], phase: steps[stepIndex]?.phase || phaseName };
      console.log(`[executer] step ${stepIndex + 1}/${steps.length} [${phaseName}] action="${step.action || step.verb || "?"}"`);

      const result = await executeStepWithPolicy(step, context, onProgress, {
        taskId: task.taskId,
        stepIndex,
        totalSteps: steps.length,
      });

      flatResults.push({
        phase: phaseName,
        step: stepIndex + 1,
        action: normalizeAction(step.action || step.verb),
        ...result,
      });

      console.log(`[executer] step ${stepIndex + 1} result: ${result.ok ? "✅" : "❌"} ${result.ok ? "" : (result.error || "no error msg")}`);

      if (!result.ok && !step.continueOnFail) {
        emit(onProgress, {
          type: "phase",
          taskId: task.taskId,
          label: phase.label || phaseName,
          phaseName,
          phaseIndex,
          totalPhases: phases.length,
          status: result.cancelled ? "cancelled" : "failed",
          error: result.error || null,
        });

        emitTelemetry(onProgress, task.taskId, "phase_failed", {
          phaseName,
          phaseIndex,
          error: result.error || "phase failed",
        });

        return {
          ok: false,
          error: result.error,
          failedStep: stepIndex + 1,
          phaseName,
          results: flatResults,
          cancelled: !!result.cancelled,
        };
      }
    }

    emit(onProgress, {
      type: "phase_complete",
      taskId: task.taskId,
      label: phase.label || phaseName,
      phaseName,
      phaseIndex,
      totalPhases: phases.length,
      status: "completed",
    });

    emitTelemetry(onProgress, task.taskId, "phase_completed", {
      phaseName,
      phaseIndex,
      totalPhases: phases.length,
    });
  }

  return { ok: true, results: flatResults };
}

async function run(payloadOrSteps, onProgress = null) {
  const task = bodyOS.normalizeTaskPayload(payloadOrSteps);
  const context = bodyOS.createContext({
    ...task.contextSeed,
    task: {
      taskId: task.taskId,
      label: task.label,
      context: task.context || {},
      apps: task.context?.apps || [],
      app: Array.isArray(task.context?.apps) ? task.context.apps[0] : null,
      targetApp: task.context?.vars?.targetApp || null,
    },
  });

  console.log(`[executer] ▶ run "${task.label}" — ${task.steps.length} steps, ${Array.isArray(payloadOrSteps?.phases) ? payloadOrSteps.phases.length : 0} phases`);

  emit(onProgress, {
    type: "task",
    taskId: task.taskId,
    label: task.label,
    status: "started",
    totalSteps: task.steps.length,
    totalPhases: Array.isArray(payloadOrSteps?.phases) ? payloadOrSteps.phases.length : 0,
  });

  emitTelemetry(onProgress, task.taskId, "task_started", { label: task.label });

  let outcome;
  if (Array.isArray(payloadOrSteps?.phases) && payloadOrSteps.phases.length) {
    outcome = await runPhases(payloadOrSteps.phases, context, onProgress, task);
  } else {
    const results = [];
    for (let i = 0; i < task.steps.length; i++) {
      if (isCancelled(task.taskId)) {
        emit(onProgress, {
          type: "task",
          taskId: task.taskId,
          label: task.label,
          status: "cancelled",
          totalSteps: task.steps.length,
        });
        emitTelemetry(onProgress, task.taskId, "task_cancelled", { reason: "main_loop_cancelled" });
        cancelledTasks.delete(task.taskId);
        return {
          ok: false,
          cancelled: true,
          error: "task cancelled",
          failedStep: i + 1,
          results,
          taskId: task.taskId,
          context,
        };
      }

      const step = task.steps[i];
      const result = await executeStepWithPolicy(step, context, onProgress, {
        taskId: task.taskId,
        stepIndex: i,
        totalSteps: task.steps.length,
      });

      results.push({
        step: i + 1,
        action: normalizeAction(step.action || step.verb),
        ...result,
      });

      if (!result.ok && !step.continueOnFail) {
        emit(onProgress, {
          type: "task",
          taskId: task.taskId,
          label: task.label,
          status: result.cancelled ? "cancelled" : "failed",
          totalSteps: task.steps.length,
          error: result.error,
        });

        emitTelemetry(onProgress, task.taskId, result.cancelled ? "task_cancelled" : "task_failed", {
          error: result.error || null,
          failedStep: i + 1,
        });

        cancelledTasks.delete(task.taskId);
        return {
          ok: false,
          error: result.error,
          failedStep: i + 1,
          results,
          taskId: task.taskId,
          context,
          cancelled: !!result.cancelled,
        };
      }
    }
    outcome = { ok: true, results };
  }

  if (!outcome.ok) {
    emit(onProgress, {
      type: "task",
      taskId: task.taskId,
      label: task.label,
      status: outcome.cancelled ? "cancelled" : "failed",
      totalSteps: task.steps.length,
      error: outcome.error || null,
    });

    emitTelemetry(onProgress, task.taskId, outcome.cancelled ? "task_cancelled" : "task_failed", {
      error: outcome.error || null,
      failedStep: outcome.failedStep || null,
      phaseName: outcome.phaseName || null,
    });

    cancelledTasks.delete(task.taskId);
    return { ok: false, ...outcome, taskId: task.taskId, context };
  }

  emit(onProgress, {
    type: "task",
    taskId: task.taskId,
    label: task.label,
    status: "completed",
    totalSteps: task.steps.length,
  });

  emitTelemetry(onProgress, task.taskId, "task_succeeded", { label: task.label });
  cancelledTasks.delete(task.taskId);

  return {
    ok: true,
    results: outcome.results || [],
    taskId: task.taskId,
    context,
  };
}

async function runStep(step, context = {}) {
  const ctx = bodyOS.createContext(context);
  return executeSingleAttempt(step, ctx, null, { taskId: "adhoc", stepIndex: 0, totalSteps: 1 });
}

function cancelTask(taskId) {
  if (!taskId) return { ok: false, error: "taskId required" };
  cancelledTasks.add(taskId);
  return { ok: true, taskId };
}

module.exports = {
  run,
  runStep,
  cancelTask,
  normalizeAction,
};