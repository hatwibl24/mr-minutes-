const { app, BrowserWindow, globalShortcut, screen, ipcMain } = require("electron");
const path = require("path");
const listener = require("./listener");
let mainWindow = null;

app.commandLine.appendSwitch("enable-features", "WebRTC");
app.commandLine.appendSwitch("ignore-certificate-errors");
app.commandLine.appendSwitch("disable-web-security");
app.commandLine.appendSwitch("allow-running-insecure-content");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, movable: true, hasShadow: false,
    fullscreenable: false, skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      preload: path.join(__dirname, "preload.js"),
      partition: "persist:mrminutes",
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.webContents.session.setPermissionRequestHandler(
    (wc, permission, callback) => callback(["media","microphone","audioCapture"].includes(permission))
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (wc, permission) => ["media","microphone","audioCapture"].includes(permission)
  );

  mainWindow.webContents.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.webContents.on("did-finish-load", () => {
    listener.init(mainWindow);
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => globalShortcut.unregisterAll());