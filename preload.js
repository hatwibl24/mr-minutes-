// ============================================================
// MR. MINUTES — Preload (Secure IPC Bridge) v3
// ============================================================

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("electronAPI", {
  // Voice
  onVoiceCommand: (callback) => on("voice-command", callback),

  // General agent events
  onAgentEvent: (callback) => on("agent-event", callback),

  // Brain
  brainCommand: (heard) => ipcRenderer.invoke("brain-command", heard),
  brainCommandLegacy: (heard) => ipcRenderer.invoke("brain-command-legacy", heard),

  // Basic OS app open
  openApp: (appName) => ipcRenderer.invoke("open-app", appName),

  // Listener control
  pauseListener: () => ipcRenderer.send("pause-listener"),
  resumeListener: () => ipcRenderer.send("resume-listener"),
  setSpeechState: (state) => ipcRenderer.send("speech-state", state),

  // Mouse hit-test toggle for overlay click-through
  setIgnoreMouse: (ignore) => ipcRenderer.send("set-ignore-mouse", ignore),

  // System ops
  systemAction: (op, payload = {}) => ipcRenderer.invoke("system-action", op, payload),

  // Computer use tasks
  computerUse: (payload) => ipcRenderer.invoke("computer-use", payload),
  cancelComputerUse: (taskId) => ipcRenderer.invoke("computer-use-cancel", taskId),
  getComputerUseState: () => ipcRenderer.invoke("computer-use-state"),

  // Controller task helpers
  resumeTask: (taskId) => ipcRenderer.invoke("resume-task", taskId),

  // World / state queries
  getWorldState: () => ipcRenderer.invoke("get-world-state"),
  getHealthState: () => ipcRenderer.invoke("get-health-state"),
  getMemoryLessons: () => ipcRenderer.invoke("get-memory-lessons"),
  getTaskHistory: () => ipcRenderer.invoke("get-task-history"),
  getActiveGoal: () => ipcRenderer.invoke("get-active-goal"),
  getGoalQueue: () => ipcRenderer.invoke("get-goal-queue"),

  // Vision
  describeCurrentScreen: (options = {}) =>
    ipcRenderer.invoke("describe-current-screen", options),

  isVisionAvailable: () =>
    ipcRenderer.invoke("is-vision-available"),

  // Generic hands bridge
  handsAction: (action, payload = {}) =>
    ipcRenderer.invoke("hands-action", action, payload),

  // Convenience hands helpers
  handsFindText: (text, region) =>
    ipcRenderer.invoke("hands-find-text", text, region),

  handsClick: (x, y) =>
    ipcRenderer.invoke("hands-click", x, y),

  handsType: (text) =>
    ipcRenderer.invoke("hands-type", text),

  handsKey: (combo) =>
    ipcRenderer.invoke("hands-key", combo),

  handsWaitFor: (text, options = {}) =>
    ipcRenderer.invoke("hands-action", "wait_for", { text, ...options }),

  handsWaitForAny: (texts, options = {}) =>
    ipcRenderer.invoke("hands-action", "wait_for_any", { texts, ...options }),

  handsWaitAndClick: (text, options = {}) =>
    ipcRenderer.invoke("hands-action", "wait_and_click", { text, ...options }),

  handsFindAndClick: (text, options = {}) =>
    ipcRenderer.invoke("hands-action", "click", { target: text, ...options }),

  handsFocusApp: (app, options = {}) =>
    ipcRenderer.invoke("hands-action", "focus_app", { app, ...options }),

  handsEnsureFocus: (app, options = {}) =>
    ipcRenderer.invoke("hands-action", "ensure_focus", { app, ...options }),

  handsWaitForAppReady: (app, readyTexts = [], options = {}) =>
    ipcRenderer.invoke("hands-action", "wait_for_app_ready", {
      app,
      readyTexts,
      ...options,
    }),

  handsFocusAndType: (app, text, options = {}) =>
    ipcRenderer.invoke("hands-action", "focus_and_type", {
      app,
      text,
      ...options,
    }),

  handsTypeSmart: (text, options = {}) =>
    ipcRenderer.invoke("hands-action", "type_smart", {
      text,
      ...options,
    }),

  handsClearAndType: (text, options = {}) =>
    ipcRenderer.invoke("hands-action", "clear_and_type", {
      text,
      ...options,
    }),

  handsPressSequence: (keys, options = {}) =>
    ipcRenderer.invoke("hands-action", "press_sequence", {
      keys,
      ...options,
    }),

  handsPressUntil: (key, texts, options = {}) =>
    ipcRenderer.invoke("hands-action", "press_until", {
      key,
      texts,
      ...options,
    }),

  handsScrollUntil: (text, options = {}) =>
    ipcRenderer.invoke("hands-action", "scroll_until", {
      text,
      ...options,
    }),

  handsScreenshot: (path = null) =>
    ipcRenderer.invoke("hands-action", "screenshot", { path }),

  // Task + execution events
  onExecutionProgress: (callback) => on("execution-progress", callback),
  onTaskState: (callback) => on("task-state", callback),
});