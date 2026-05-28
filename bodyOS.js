// ============================================================
// MR. MINUTES — Body OS v3
//
// High-level body verbs and direct system capabilities.
// Sits ABOVE Hands.js and BELOW brain.js.
// ============================================================

"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { exec, spawn } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

const IS_MAC = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";

const backgroundProcesses = new Map();

// ── UTILS ─────────────────────────────────────────────────────
function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function makeTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePath(inputPath) {
  if (!inputPath) return inputPath;
  const raw = String(inputPath).trim();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  if (raw === "~") return os.homedir();
  return path.resolve(raw);
}

function resolveTemplate(value, context = {}) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key) => {
      const k = String(key).trim();
      if (context.vars && context.vars[k] !== undefined) return String(context.vars[k]);
      if (context[k] !== undefined) return String(context[k]);
      return "";
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplate(item, context));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveTemplate(v, context);
    }
    return out;
  }

  return value;
}

function createContext(seed = {}) {
  return {
    vars: { ...(seed.vars || {}) },
    processes: { ...(seed.processes || {}) },
    cwd: seed.cwd || process.cwd(),
    task: seed.task || null,
    meta: seed.meta || {},
    lastResult: null,
  };
}

function normalizeTaskPayload(payload = {}) {
  if (Array.isArray(payload)) payload = { steps: payload };

  const taskId = payload.taskId || makeTaskId();
  let steps = [];

  if (Array.isArray(payload.steps)) {
    steps = payload.steps;
  } else if (Array.isArray(payload.phases)) {
    steps = payload.phases.flatMap((phase, phaseIndex) =>
      (phase.steps || []).map((step, stepIndex) => ({
        ...step,
        phase: step.phase || phase.name || `phase_${phaseIndex + 1}`,
        phaseIndex,
        stepIndexInPhase: stepIndex,
      }))
    );
  }

  return {
    taskId,
    label: payload.label || "Computer Use Task",
    steps,
    contextSeed: payload.context || payload.contextSeed || {},
    meta: payload.meta || {},
  };
}

function platformShortcut(name) {
  const shortcuts = {
    new_tab: IS_MAC ? "cmd+t" : "ctrl+t",
    focus_location: IS_MAC ? "cmd+l" : "ctrl+l",
    select_all: IS_MAC ? "cmd+a" : "ctrl+a",
    save: IS_MAC ? "cmd+s" : "ctrl+s",
    find: IS_MAC ? "cmd+f" : "ctrl+f",
    close_tab: IS_MAC ? "cmd+w" : "ctrl+w",
    copy: IS_MAC ? "cmd+c" : "ctrl+c",
    paste: IS_MAC ? "cmd+v" : "ctrl+v",
    cut: IS_MAC ? "cmd+x" : "ctrl+x",
    undo: IS_MAC ? "cmd+z" : "ctrl+z",
    redo: IS_MAC ? "cmd+shift+z" : "ctrl+y",
  };

  return shortcuts[name] || name;
}

function deriveEditorOpenCommand(appName, targetPath) {
  const app = String(appName || "").toLowerCase();

  if (app.includes("cursor")) return `cursor ${shellQuote(targetPath)}`;
  if (app.includes("visual studio code") || app === "code" || app.includes("vscode")) {
    return `code ${shellQuote(targetPath)}`;
  }

  if (IS_MAC) return `open -a ${shellQuote(appName)} ${shellQuote(targetPath)}`;
  if (IS_WINDOWS) return `start "" ${shellQuote(appName)} ${shellQuote(targetPath)}`;

  return `xdg-open ${shellQuote(targetPath)}`;
}

// ── APP / FILE OPS ────────────────────────────────────────────
async function launchApp(appName) {
  if (!appName) return { ok: false, error: "app name required" };

  try {
    if (IS_MAC) {
      await execAsync(`open -a ${shellQuote(appName)}`);
    } else if (IS_WINDOWS) {
      try {
        await execAsync(`start "" ${shellQuote(appName)}`, { shell: "cmd.exe" });
      } catch {
        await execAsync(shellQuote(appName), { shell: true });
      }
    } else {
      await execAsync(`xdg-open ${shellQuote(appName)}`);
    }

    return { ok: true, app: appName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function createFolder(input, context) {
  const folderPath = normalizePath(resolveTemplate(input.path || input.target, context));
  if (!folderPath) return { ok: false, error: "path required" };

  try {
    await fs.mkdir(folderPath, { recursive: true });
    return { ok: true, path: folderPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function createFile(input, context) {
  const filePath = normalizePath(resolveTemplate(input.path || input.target, context));
  if (!filePath) return { ok: false, error: "path required" };

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (input.overwrite === false) {
      try {
        await fs.access(filePath);
        return { ok: true, path: filePath, skipped: true };
      } catch {}
    }

    await fs.writeFile(filePath, resolveTemplate(input.text || "", context), "utf8");
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function writeFile(input, context) {
  const filePath = normalizePath(resolveTemplate(input.path || input.target, context));
  const text = resolveTemplate(input.text || "", context);
  if (!filePath) return { ok: false, error: "path required" };

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, "utf8");
    return { ok: true, path: filePath, bytes: Buffer.byteLength(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function appendFile(input, context) {
  const filePath = normalizePath(resolveTemplate(input.path || input.target, context));
  const text = resolveTemplate(input.text || "", context);
  if (!filePath) return { ok: false, error: "path required" };

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, text, "utf8");
    return { ok: true, path: filePath, bytes: Buffer.byteLength(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function readFile(input, context) {
  const filePath = normalizePath(resolveTemplate(input.path || input.target, context));
  if (!filePath) return { ok: false, error: "path required" };

  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, path: filePath, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pathExists(input, context) {
  const targetPath = normalizePath(resolveTemplate(input.path || input.target, context));
  if (!targetPath) return { ok: false, error: "path required" };

  try {
    await fs.access(targetPath);
    return { ok: true, path: targetPath, exists: true };
  } catch {
    return { ok: false, path: targetPath, exists: false, error: "path not found" };
  }
}

// ── PROCESS OPS ───────────────────────────────────────────────
async function runCommand(input, context) {
  const command = resolveTemplate(input.command || input.text || "", context);
  const cwd = normalizePath(resolveTemplate(input.cwd || context.vars.projectPath || context.cwd, context));
  const env = { ...process.env, ...(input.env || {}) };

  if (!command) return { ok: false, error: "command required" };

  if (input.background) {
    try {
      const child = spawn(command, {
        cwd,
        env,
        shell: true,
        detached: !!input.detached,
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

      const ref = String(input.name || child.pid);
      backgroundProcesses.set(ref, {
        child,
        command,
        cwd,
        getStdout: () => stdout,
        getStderr: () => stderr,
      });

      context.processes[ref] = { pid: child.pid, name: ref, command, cwd };

      if (input.storePidAs) context.vars[input.storePidAs] = child.pid;
      if (input.storeProcessAs) context.vars[input.storeProcessAs] = ref;

      return { ok: true, pid: child.pid, name: ref, command, cwd };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  try {
    const result = await execAsync(command, {
      cwd,
      env,
      timeout: input.timeout || 0,
      maxBuffer: 10 * 1024 * 1024,
    });

    const stdout = result.stdout || "";
    const stderr = result.stderr || "";

    if (input.storeStdoutAs) context.vars[input.storeStdoutAs] = stdout.trim();
    if (input.storeStderrAs) context.vars[input.storeStderrAs] = stderr.trim();

    return { ok: true, command, cwd, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      command,
      cwd,
      error: err.message,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      code: err.code,
    };
  }
}

async function stopCommand(input, context) {
  const ref = String(resolveTemplate(input.name || input.pid || "", context));
  if (!ref) return { ok: false, error: "process name or pid required" };

  const record = backgroundProcesses.get(ref);
  if (!record?.child) return { ok: false, error: `process "${ref}" not found` };

  try {
    if (IS_WINDOWS) {
      await execAsync(`taskkill /PID ${record.child.pid} /T /F`, { shell: "cmd.exe" });
    } else {
      record.child.kill("SIGTERM");
    }

    backgroundProcesses.delete(ref);
    delete context.processes[ref];

    return { ok: true, name: ref };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── NETWORK / SERVER WAIT ─────────────────────────────────────
function probeUrl(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === "https:" ? https : http;

      const req = client.request(
        parsed,
        { method: "GET", timeout: timeoutMs },
        (res) => {
          res.resume();
          resolve({ ok: true, status: res.statusCode || 0 });
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });

      req.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });

      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

async function waitForServer(input, context) {
  const url = resolveTemplate(input.url || input.target || context.vars.localUrl || "", context);
  const timeoutMs = input.timeout || 60000;
  const intervalMs = input.interval || 1500;
  const requestTimeout = input.requestTimeout || 2500;
  const started = Date.now();

  if (!url) return { ok: false, error: "url required" };

  while (Date.now() - started < timeoutMs) {
    const probe = await probeUrl(url, requestTimeout);
    if (probe.ok) {
      context.vars.localUrl = url;
      return { ok: true, url, status: probe.status };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { ok: false, error: `server not ready: ${url}` };
}

// ── HIGH-LEVEL VERBS ──────────────────────────────────────────
function expandVerb(step, context) {
  const action = String(step.action || step.verb || "").toLowerCase().replace(/[\s-]+/g, "_");

  const defaultEditor = step.app || context.vars.editorApp || "Visual Studio Code";
  const defaultBrowser = step.app || context.vars.browserApp || "Google Chrome";
  const defaultTerminal = step.app || context.vars.terminalApp || "Terminal";

  switch (action) {
    case "open_editor":
      return [
        { action: "ensure_app", app: defaultEditor, settleMs: step.settleMs ?? 600, animHint: "pointing" },
      ];

    case "open_terminal":
      return [
        { action: "ensure_app", app: defaultTerminal, settleMs: step.settleMs ?? 600, animHint: "pointing" },
      ];

    case "open_browser":
      return [
        { action: "ensure_app", app: defaultBrowser, settleMs: step.settleMs ?? 700, animHint: "pointing" },
      ];

    case "open_url":
      return [
        { action: "ensure_app", app: defaultBrowser, settleMs: 700, animHint: "pointing" },
        { action: "key", key: platformShortcut("focus_location"), pauseAfter: 150, animHint: "tap" },
        { action: "clear_and_type", text: step.url || step.target || "", pauseAfter: 120, animHint: "thinking" },
        { action: "key", key: "enter", pauseAfter: step.pauseAfter ?? 1800, animHint: "tap" },
      ];

    case "open_preview":
      return [
        { action: "wait_for_server", url: step.url || "{{localUrl}}", timeout: step.timeout || 60000, animHint: "thinking" },
        { action: "open_url", app: defaultBrowser, url: step.url || "{{localUrl}}", pauseAfter: step.pauseAfter ?? 1500 },
      ];

    case "open_project": {
      const targetPath = step.path || step.projectPath || "{{projectPath}}";
      const command = step.command || deriveEditorOpenCommand(defaultEditor, resolveTemplate(targetPath, context));

      return [
        { action: "create_folder", path: targetPath, continueOnFail: true },
        { action: "ensure_app", app: defaultEditor, settleMs: 700, animHint: "pointing" },
        {
          action: "run_command",
          command,
          continueOnFail: !!step.continueOnFail || true,
          pauseAfter: step.pauseAfter ?? 500,
          animHint: "thinking",
        },
      ];
    }

    case "push_repo": {
      const branch = step.branch || "main";
      const commitMessage = step.message || "chore: automated update";
      const cwd = step.cwd || "{{projectPath}}";
      const out = [];

      if (step.init !== false) {
        out.push({ action: "run_command", cwd, command: "git init", continueOnFail: true });
      }

      out.push({ action: "run_command", cwd, command: "git add -A" });
      out.push({ action: "run_command", cwd, command: `git commit -m ${shellQuote(commitMessage)}`, continueOnFail: true });
      out.push({ action: "run_command", cwd, command: `git branch -M ${branch}`, continueOnFail: true });

      if (step.remote) {
        out.push({ action: "run_command", cwd, command: "git remote remove origin", continueOnFail: true });
        out.push({ action: "run_command", cwd, command: `git remote add origin ${step.remote}` });
        out.push({ action: "run_command", cwd, command: `git push -u origin ${branch}` });
      }

      return out;
    }

    case "deploy_project":
      return [
        {
          action: "run_command",
          cwd: step.cwd || "{{projectPath}}",
          command: step.command || "vercel --prod",
          timeout: step.timeout || 10 * 60 * 1000,
          storeStdoutAs: step.storeStdoutAs || "deployOutput",
        },
      ];

    case "set_domain":
      return [
        {
          action: "run_command",
          cwd: step.cwd || "{{projectPath}}",
          command: step.command || `vercel domains add ${step.domain}${step.project ? ` ${step.project}` : ""}`,
          timeout: step.timeout || 2 * 60 * 1000,
        },
      ];

    default:
      return null;
  }
}

module.exports = {
  createContext,
  normalizeTaskPayload,
  resolveTemplate,
  normalizePath,
  platformShortcut,
  launchApp,
  createFolder,
  createFile,
  writeFile,
  appendFile,
  readFile,
  pathExists,
  runCommand,
  stopCommand,
  waitForServer,
  expandVerb,
};