// InkOS V2 desktop shell.
// Ported from D:\inkos\desktop\main.cjs (V1) — differences:
//   * serves the MONOREPO build output (resources/inkos/studio + core),
//     never a copy of a patched global npm install;
//   * config stored under %APPDATA%\inkos-v2-desktop (V1 config untouched);
//   * BOM-tolerant config reads (V1 lesson: PowerShell Set-Content writes BOM).
const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_DIR = path.join(app.getPath("appData"), "inkos-v2-desktop");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const LOG_PATH = path.join(CONFIG_DIR, "studio.log");

let mainWindow = null;
let serverChild = null;
let serverPort = 0;
let quitting = false;

// --- config ------------------------------------------------------------

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function isValidProjectRoot(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

async function pickProjectRoot(currentRoot) {
  const result = await dialog.showOpenDialog({
    title: "选择 InkOS 书库目录",
    defaultPath: currentRoot && isValidProjectRoot(currentRoot) ? currentRoot : undefined,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "使用此目录",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

// --- server ------------------------------------------------------------

function findStudioEntry() {
  const candidates = [
    // packaged: resources/inkos/studio/dist/api/index.js
    path.join(process.resourcesPath || "", "inkos", "studio", "dist", "api", "index.js"),
    // dev run from the monorepo: apps/desktop → packages/studio
    path.join(__dirname, "..", "..", "packages", "studio", "dist", "api", "index.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function startServer(projectRoot, port) {
  const entry = findStudioEntry();
  if (!entry) {
    dialog.showErrorBox("InkOS V2", "找不到 Studio 服务端。请先运行 pnpm -r build（或 scripts/build-desktop.ps1）。");
    app.quit();
    return null;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  logStream.write(`\n===== ${new Date().toISOString()} start port=${port} root=${projectRoot} entry=${entry}\n`);
  const child = spawn(process.execPath, [entry, projectRoot], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      INKOS_STUDIO_PORT: String(port),
      INKOS_PROJECT_ROOT: projectRoot,
      INKOS_V2_ENABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.on("exit", (code) => {
    logStream.write(`===== server exited code=${code}\n`);
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox("InkOS V2", `Studio 服务意外退出（code=${code}）。查看日志：${LOG_PATH}`);
    }
  });
  return child;
}

async function waitForServer(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // V2 health first (SQLite migrations etc.), fallback to V1 books.
      const res = await fetch(`http://127.0.0.1:${port}/api/v2/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
      const v1 = await fetch(`http://127.0.0.1:${port}/api/v1/books`, { signal: AbortSignal.timeout(2000) });
      if (v1.ok) return true;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function stopServer() {
  if (serverChild && !serverChild.killed) {
    try {
      serverChild.kill();
    } catch {
      // already gone
    }
  }
  serverChild = null;
}

// --- window ------------------------------------------------------------

function createWindow(config) {
  const bounds = config.windowBounds || { width: 1600, height: 940 };
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    title: "InkOS V2",
    autoHideMenuBar: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on("close", () => {
    try {
      const b = mainWindow.getBounds();
      const cfg = loadConfig();
      cfg.windowBounds = b;
      saveConfig(cfg);
    } catch {
      // best effort
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.includes(`127.0.0.1:${serverPort}`)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  return mainWindow;
}

async function switchProjectRoot() {
  const cfg = loadConfig();
  const picked = await pickProjectRoot(cfg.projectRoot);
  if (!picked) return;
  cfg.projectRoot = picked;
  saveConfig(cfg);
  await restartServer();
}

async function restartServer() {
  const cfg = loadConfig();
  stopServer();
  serverPort = await findFreePort();
  serverChild = startServer(cfg.projectRoot, serverPort);
  if (!serverChild) return;
  const ok = await waitForServer(serverPort);
  if (!ok) {
    dialog.showErrorBox("InkOS V2", `Studio 服务启动超时。查看日志：${LOG_PATH}`);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  }
}

function buildMenu() {
  const template = [
    {
      label: "InkOS V2",
      submenu: [
        { label: "切换书库目录…", click: () => switchProjectRoot() },
        { label: "重启服务", click: () => restartServer() },
        { label: "打开日志", click: () => shell.openPath(LOG_PATH) },
        {
          label: "打开书库文件夹",
          click: () => {
            const cfg = loadConfig();
            if (cfg.projectRoot) shell.openPath(cfg.projectRoot);
          },
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "刷新" },
        { role: "forceReload", label: "强制刷新" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- app lifecycle -------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    const cfg = loadConfig();
    if (!cfg.projectRoot || !isValidProjectRoot(cfg.projectRoot)) {
      const picked = await pickProjectRoot(cfg.projectRoot);
      if (!picked) {
        app.quit();
        return;
      }
      cfg.projectRoot = picked;
      saveConfig(cfg);
    }
    createWindow(cfg);
    mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        '<body style="background:#0b1220;color:#e5e7eb;font:16px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">InkOS V2 正在启动…</body>',
      )}`,
    );
    serverPort = await findFreePort();
    serverChild = startServer(cfg.projectRoot, serverPort);
    if (!serverChild) return;
    const ok = await waitForServer(serverPort);
    if (!ok) {
      dialog.showErrorBox("InkOS V2", `Studio 服务启动超时。查看日志：${LOG_PATH}`);
      return;
    }
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  });

  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
