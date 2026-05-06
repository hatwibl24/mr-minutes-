const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onVoiceCommand: (callback) => {
    ipcRenderer.on("voice-command", (event, command) => callback(command));
  },
  openApp: (appName) => {
    ipcRenderer.send("open-app", appName);
  }
});