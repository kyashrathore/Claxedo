import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { extname, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, ipcMain, dialog, shell, clipboard, nativeImage, Notification, BrowserWindow, nativeTheme, Menu } from "electron";
import pkg from "electron-updater";
import { execFileSync, spawn, execFile } from "node:child_process";
import readline from "node:readline";
import treeKill from "tree-kill";
import Store from "electron-store";
import log from "electron-log/main.js";
import { marked } from "marked";
import windowState from "electron-window-state";
function checkAppExists(appName) {
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return true;
  return checkMacosApp(appName);
}
function resolveAppPath(appName) {
  if (process.platform !== "win32") return appName;
  return resolveWindowsAppPath(appName);
}
function wslPath(path, mode) {
  if (process.platform !== "win32") return path;
  const flag = mode === "windows" ? "-w" : "-u";
  try {
    if (path.startsWith("~")) {
      const suffix = path.slice(1);
      const cmd = `wslpath ${flag} "$HOME${suffix.replace(/\"/g, '\\"')}"`;
      const output2 = execFileSync("wsl", ["-e", "sh", "-lc", cmd]);
      return output2.toString().trim();
    }
    const output = execFileSync("wsl", ["-e", "wslpath", flag, path]);
    return output.toString().trim();
  } catch (error) {
    throw new Error(`Failed to run wslpath: ${String(error)}`);
  }
}
function checkMacosApp(appName) {
  const locations = [`/Applications/${appName}.app`, `/System/Applications/${appName}.app`];
  const home = process.env.HOME;
  if (home) locations.push(`${home}/Applications/${appName}.app`);
  if (locations.some((location) => existsSync(location))) return true;
  try {
    execFileSync("which", [appName]);
    return true;
  } catch {
    return false;
  }
}
function resolveWindowsAppPath(appName) {
  let output;
  try {
    output = execFileSync("where", [appName]).toString();
  } catch {
    return null;
  }
  const paths = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const hasExt = (path, ext) => extname(path).toLowerCase() === `.${ext}`;
  const exe = paths.find((path) => hasExt(path, "exe"));
  if (exe) return exe;
  const resolveCmd = (path) => {
    const content = readFileSync(path, "utf8");
    for (const token of content.split('"').map((value) => value.trim())) {
      const lower = token.toLowerCase();
      if (!lower.includes(".exe")) continue;
      const index = lower.indexOf("%~dp0");
      if (index >= 0) {
        const base = dirname(path);
        const suffix = token.slice(index + 5);
        const resolved = suffix.replace(/\//g, "\\").split("\\").filter((part) => part && part !== ".").reduce((current, part) => {
          if (part === "..") return dirname(current);
          return join(current, part);
        }, base);
        if (existsSync(resolved)) return resolved;
      }
      if (existsSync(token)) return token;
    }
    return null;
  };
  for (const path of paths) {
    if (hasExt(path, "cmd") || hasExt(path, "bat")) {
      const resolved = resolveCmd(path);
      if (resolved) return resolved;
    }
    if (!extname(path)) {
      const cmd = `${path}.cmd`;
      if (existsSync(cmd)) {
        const resolved = resolveCmd(cmd);
        if (resolved) return resolved;
      }
      const bat = `${path}.bat`;
      if (existsSync(bat)) {
        const resolved = resolveCmd(bat);
        if (resolved) return resolved;
      }
    }
  }
  const key = appName.split("").filter((value) => /[a-z0-9]/i.test(value)).map((value) => value.toLowerCase()).join("");
  if (key) {
    for (const path of paths) {
      const dirs = [dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))];
      for (const dir of dirs) {
        try {
          for (const entry of readdirSync(dir)) {
            const candidate = join(dir, entry);
            if (!hasExt(candidate, "exe")) continue;
            const stem = entry.replace(/\.exe$/i, "");
            const name = stem.split("").filter((value) => /[a-z0-9]/i.test(value)).map((value) => value.toLowerCase()).join("");
            if (name.includes(key) || key.includes(name)) return candidate;
          }
        } catch {
          continue;
        }
      }
    }
  }
  return paths[0] ?? null;
}
const raw = "dev";
const CHANNEL = raw;
const SETTINGS_STORE = "claxedo.settings";
const DEFAULT_SERVER_URL_KEY = "defaultServerUrl";
const WSL_ENABLED_KEY = "wslEnabled";
const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev";
const cache = /* @__PURE__ */ new Map();
function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name);
  if (cached) return cached;
  const next = new Store({ name });
  cache.set(name, next);
  return next;
}
const store = getStore(SETTINGS_STORE);
const CLI_INSTALL_DIR = ".opencode/bin";
const CLI_BINARY_NAME = "opencode";
const root$1 = dirname(fileURLToPath(import.meta.url));
function getSidecarPath() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const path = app.isPackaged ? join(process.resourcesPath, `opencode-cli${suffix}`) : join(root$1, "../../resources", `opencode-cli${suffix}`);
  console.log(`[cli] Sidecar path resolved: ${path} (isPackaged: ${app.isPackaged})`);
  return path;
}
async function getConfig() {
  const { events } = spawnCommand("debug config", {});
  let output = "";
  await new Promise((resolve) => {
    events.on("stdout", (line) => {
      output += line;
    });
    events.on("stderr", (line) => {
      output += line;
    });
    events.on("terminated", () => resolve());
    events.on("error", () => resolve());
  });
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}
async function installCli() {
  if (process.platform === "win32") {
    throw new Error("CLI installation is only supported on macOS & Linux");
  }
  const sidecar2 = getSidecarPath();
  const scriptPath = join(app.getAppPath(), "install");
  const script = readFileSync(scriptPath, "utf8");
  const tempScript = join(tmpdir(), "opencode-install.sh");
  writeFileSync(tempScript, script, "utf8");
  chmodSync(tempScript, 493);
  const cmd = spawn(tempScript, ["--binary", sidecar2], { stdio: "pipe" });
  return await new Promise((resolve, reject) => {
    cmd.on("exit", (code) => {
      try {
        unlinkSync(tempScript);
      } catch {
      }
      if (code === 0) {
        const installPath = getCliInstallPath();
        if (installPath) return resolve(installPath);
        return reject(new Error("Could not determine install path"));
      }
      reject(new Error("Install script failed"));
    });
  });
}
function syncCli() {
  if (!app.isPackaged) return;
  const installPath = getCliInstallPath();
  if (!installPath) return;
  let version = "";
  try {
    version = execFileSync(installPath, ["--version"]).toString().trim();
  } catch {
    return;
  }
  const cli = parseVersion(version);
  const appVersion = parseVersion(app.getVersion());
  if (!cli || !appVersion) return;
  if (compareVersions(cli, appVersion) >= 0) return;
  void installCli().catch(() => void 0);
}
function serve(hostname, port, password) {
  const args = `--print-logs --log-level WARN serve --hostname ${hostname} --port ${port}`;
  const env = {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password
  };
  return spawnCommand(args, env);
}
function spawnCommand(args, extraEnv) {
  console.log(`[cli] Spawning command with args: ${args}`);
  const base = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string")
  );
  const envs = {
    ...base,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: app.getPath("userData"),
    ...extraEnv
  };
  const { cmd, cmdArgs } = buildCommand(args, envs);
  console.log(`[cli] Executing: ${cmd} ${cmdArgs.join(" ")}`);
  const child = spawn(cmd, cmdArgs, {
    env: envs,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  console.log(`[cli] Spawned process with PID: ${child.pid}`);
  const events = new EventEmitter();
  const exit = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      console.log(`[cli] Process exited with code: ${code}, signal: ${signal}`);
      resolve({ code: code ?? null, signal: null });
    });
    child.on("error", (error) => {
      console.error(`[cli] Process error: ${error.message}`);
      events.emit("error", error.message);
    });
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout) {
    readline.createInterface({ input: stdout }).on("line", (line) => {
      if (handleSqliteProgress(events, line)) return;
      events.emit("stdout", `${line}
`);
    });
  }
  if (stderr) {
    readline.createInterface({ input: stderr }).on("line", (line) => {
      if (handleSqliteProgress(events, line)) return;
      events.emit("stderr", `${line}
`);
    });
  }
  exit.then((payload) => {
    events.emit("terminated", payload);
  });
  const kill = () => {
    if (!child.pid) return;
    treeKill(child.pid);
  };
  return { events, child: { kill }, exit };
}
function handleSqliteProgress(events, line) {
  const stripped = line.startsWith("sqlite-migration:") ? line.slice("sqlite-migration:".length).trim() : null;
  if (!stripped) return false;
  if (stripped === "done") {
    events.emit("sqlite", { type: "Done" });
    return true;
  }
  const value = Number.parseInt(stripped, 10);
  if (!Number.isNaN(value)) {
    events.emit("sqlite", { type: "InProgress", value });
    return true;
  }
  return false;
}
function buildCommand(args, env) {
  if (process.platform === "win32" && isWslEnabled()) {
    console.log(`[cli] Using WSL mode`);
    const version = app.getVersion();
    const script = [
      "set -e",
      'BIN="$HOME/.opencode/bin/opencode"',
      'if [ ! -x "$BIN" ]; then',
      `  curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)} --no-modify-path`,
      "fi",
      `${envPrefix(env)} exec "$BIN" ${args}`
    ].join("\n");
    return { cmd: "wsl", cmdArgs: ["-e", "bash", "-lc", script] };
  }
  if (process.platform === "win32") {
    const sidecar22 = getSidecarPath();
    console.log(`[cli] Windows direct mode, sidecar: ${sidecar22}`);
    return { cmd: sidecar22, cmdArgs: args.split(" ") };
  }
  const sidecar2 = getSidecarPath();
  const shell2 = process.env.SHELL || "/bin/sh";
  const line = shell2.endsWith("/nu") ? `^"${sidecar2}" ${args}` : `exec "${sidecar2}" ${args}`;
  console.log(`[cli] Unix mode, shell: ${shell2}, command: ${line}`);
  return { cmd: shell2, cmdArgs: ["-l", "-c", line] };
}
function envPrefix(env) {
  const entries = Object.entries(env).map(([key, value]) => `${key}=${shellEscape(value)}`);
  return entries.join(" ");
}
function shellEscape(input) {
  if (!input) return "''";
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}
function getCliInstallPath() {
  const home = process.env.HOME;
  if (!home) return null;
  return join(home, CLI_INSTALL_DIR, CLI_BINARY_NAME);
}
function isWslEnabled() {
  return store.get(WSL_ENABLED_KEY) === true;
}
function parseVersion(value) {
  const parts = value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return null;
  return parts;
}
function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function registerIpcHandlers(deps) {
  ipcMain.handle("kill-sidecar", () => deps.killSidecar());
  ipcMain.handle("install-cli", () => deps.installCli());
  ipcMain.handle("await-initialization", (event) => {
    const send = (step) => event.sender.send("init-step", step);
    return deps.awaitInitialization(send);
  });
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl());
  ipcMain.handle(
    "set-default-server-url",
    (_event, url) => deps.setDefaultServerUrl(url)
  );
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig());
  ipcMain.handle("set-wsl-config", (_event, config) => deps.setWslConfig(config));
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend());
  ipcMain.handle(
    "set-display-backend",
    (_event, backend) => deps.setDisplayBackend(backend)
  );
  ipcMain.handle("parse-markdown", (_event, markdown) => deps.parseMarkdown(markdown));
  ipcMain.handle("check-app-exists", (_event, appName) => deps.checkAppExists(appName));
  ipcMain.handle(
    "wsl-path",
    (_event, path, mode) => deps.wslPath(path, mode)
  );
  ipcMain.handle("resolve-app-path", (_event, appName) => deps.resolveAppPath(appName));
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete());
  ipcMain.handle("run-updater", (_event, alertOnFail) => deps.runUpdater(alertOnFail));
  ipcMain.handle("check-update", () => deps.checkUpdate());
  ipcMain.handle("install-update", () => deps.installUpdate());
  ipcMain.handle("store-get", (_event, name, key) => {
    const store2 = getStore(name);
    const value = store2.get(key);
    if (value === void 0 || value === null) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  ipcMain.handle("store-set", (_event, name, key, value) => {
    getStore(name).set(key, value);
  });
  ipcMain.handle("store-delete", (_event, name, key) => {
    getStore(name).delete(key);
  });
  ipcMain.handle("store-clear", (_event, name) => {
    getStore(name).clear();
  });
  ipcMain.handle("store-keys", (_event, name) => {
    const store2 = getStore(name);
    return Object.keys(store2.store);
  });
  ipcMain.handle("store-length", (_event, name) => {
    const store2 = getStore(name);
    return Object.keys(store2.store).length;
  });
  ipcMain.handle(
    "open-directory-picker",
    async (_event, opts) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...opts?.multiple ? ["multiSelections"] : []],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath
      });
      if (result.canceled) return null;
      return opts?.multiple ? result.filePaths : result.filePaths[0];
    }
  );
  ipcMain.handle(
    "open-file-picker",
    async (_event, opts) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...opts?.multiple ? ["multiSelections"] : []],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath
      });
      if (result.canceled) return null;
      return opts?.multiple ? result.filePaths : result.filePaths[0];
    }
  );
  ipcMain.handle(
    "save-file-picker",
    async (_event, opts) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath
      });
      if (result.canceled) return null;
      return result.filePath ?? null;
    }
  );
  ipcMain.on("open-link", (_event, url) => {
    void shell.openExternal(url);
  });
  ipcMain.handle("open-path", async (_event, path, app2) => {
    if (!app2) return shell.openPath(path);
    await new Promise((resolve, reject) => {
      const [cmd, args] = process.platform === "darwin" ? ["open", ["-a", app2, path]] : [app2, [path]];
      execFile(cmd, args, (err) => err ? reject(err) : resolve());
    });
  });
  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const buffer = image.toPNG().buffer;
    const size = image.getSize();
    return { buffer, width: size.width, height: size.height };
  });
  ipcMain.handle("write-clipboard-image", (_event, buffer) => {
    const image = nativeImage.createFromBuffer(Buffer.from(buffer));
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });
  ipcMain.on("show-notification", (_event, title, body) => {
    new Notification({ title, body }).show();
  });
  ipcMain.handle("get-window-focused", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isFocused() ?? false;
  });
  ipcMain.handle("get-window-fullscreen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isFullScreen() ?? false;
  });
  ipcMain.handle("set-window-focus", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.focus();
  });
  ipcMain.handle("show-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.show();
  });
  ipcMain.on("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.on("quit", () => {
    app.quit();
  });
  ipcMain.handle("get-zoom-factor", (event) => event.sender.getZoomFactor());
  ipcMain.handle("set-zoom-factor", (event, factor) => event.sender.setZoomFactor(factor));
  ipcMain.on("set-native-theme", (_event, theme) => {
    nativeTheme.themeSource = theme;
  });
}
function sendSqliteMigrationProgress(win, progress) {
  win.webContents.send("sqlite-migration-progress", progress);
}
function sendMenuCommand(win, id) {
  win.webContents.send("menu-command", id);
}
function sendDeepLinks(win, urls) {
  win.webContents.send("deep-link", urls);
}
function wireFullscreenEvents(win) {
  const send = (fs) => {
    if (!win.isDestroyed()) win.webContents.send("fullscreen-change", fs);
  };
  win.on("enter-full-screen", () => send(true));
  win.on("leave-full-screen", () => send(false));
}
const MAX_LOG_AGE_DAYS = 7;
function initLogging() {
  log.transports.file.maxSize = 5 * 1024 * 1024;
  cleanup();
  return log;
}
function cleanup() {
  const path = log.transports.file.getFile().path;
  const dir = dirname(path);
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1e3;
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    try {
      const info = statSync(file);
      if (!info.isFile()) continue;
      if (info.mtimeMs < cutoff) unlinkSync(file);
    } catch {
      continue;
    }
  }
}
const renderer = new marked.Renderer();
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : "";
  return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`;
};
function parseMarkdown(input) {
  return marked(input, {
    renderer,
    breaks: false,
    gfm: true
  });
}
function createMenu(deps) {
  if (process.platform !== "darwin") return;
  const template = [
    {
      label: "Claxedo",
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          enabled: UPDATER_ENABLED,
          click: () => deps.checkForUpdates()
        },
        {
          label: "Install CLI...",
          click: () => deps.installCli()
        },
        {
          label: "Reload Webview",
          click: () => deps.reload()
        },
        {
          label: "Restart",
          click: () => deps.relaunch()
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "File",
      submenu: [
        { label: "New Session", accelerator: "Shift+Cmd+S", click: () => deps.trigger("session.new") },
        { label: "Open Project...", accelerator: "Cmd+O", click: () => deps.trigger("project.open") },
        { type: "separator" },
        { label: "Toggle Split View", accelerator: "Cmd+\\", click: () => deps.trigger("claxedo.split.toggle") },
        { label: "Close Tab", accelerator: "Cmd+W", click: () => deps.trigger("claxedo.tab.close") },
        { type: "separator" },
        { label: "Close Window", click: () => BrowserWindow.getFocusedWindow()?.close() }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Sidebar", accelerator: "Cmd+B", click: () => deps.trigger("sidebar.toggle") },
        { label: "Toggle Terminal", accelerator: "Ctrl+`", click: () => deps.trigger("terminal.toggle") },
        { label: "Toggle File Tree", click: () => deps.trigger("fileTree.toggle") },
        { type: "separator" },
        { label: "Back", click: () => deps.trigger("common.goBack") },
        { label: "Forward", click: () => deps.trigger("common.goForward") },
        { type: "separator" },
        {
          label: "Previous Session",
          accelerator: "Option+ArrowUp",
          click: () => deps.trigger("session.previous")
        },
        {
          label: "Next Session",
          accelerator: "Option+ArrowDown",
          click: () => deps.trigger("session.next")
        },
        { type: "separator" },
        {
          label: "Toggle Developer Tools",
          accelerator: "Alt+Cmd+I",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools()
        }
      ]
    },
    {
      label: "Help",
      submenu: [
        { label: "Claxedo Documentation", click: () => shell.openExternal("https://claxedo.ai/docs") },
        { type: "separator" },
        {
          label: "Share Feedback",
          click: () => shell.openExternal("https://github.com/kyashrathore/Claxedo/issues/new")
        },
        {
          label: "Report a Bug",
          click: () => shell.openExternal("https://github.com/kyashrathore/Claxedo/issues/new")
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function getDefaultServerUrl() {
  const value = store.get(DEFAULT_SERVER_URL_KEY);
  return typeof value === "string" ? value : null;
}
function setDefaultServerUrl(url) {
  if (url) {
    store.set(DEFAULT_SERVER_URL_KEY, url);
    return;
  }
  store.delete(DEFAULT_SERVER_URL_KEY);
}
function getWslConfig() {
  const value = store.get(WSL_ENABLED_KEY);
  return { enabled: typeof value === "boolean" ? value : false };
}
function setWslConfig(config) {
  store.set(WSL_ENABLED_KEY, config.enabled);
}
async function getSavedServerUrl() {
  const direct = getDefaultServerUrl();
  if (direct) return direct;
  const config = await getConfig().catch(() => null);
  if (!config) return null;
  return getServerUrlFromConfig(config);
}
function spawnLocalServer(hostname, port, password) {
  const { child, exit, events } = serve(hostname, port, password);
  const wait = (async () => {
    const url = `http://${hostname}:${port}`;
    const ready = async () => {
      let attempts = 0;
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
        const ok = await checkHealth(url, password);
        if (attempts <= 3 || attempts % 50 === 0) {
          console.log(`[health] attempt=${attempts} url=${url} ok=${ok} hasPassword=${!!password}`);
        }
        if (ok) return;
      }
    };
    const terminated = async () => {
      const payload = await exit;
      throw new Error(
        `Sidecar terminated before becoming healthy (code=${payload.code ?? "unknown"} signal=${payload.signal ?? "unknown"})`
      );
    };
    await Promise.race([ready(), terminated()]);
  })();
  return { child, health: { wait }, events };
}
async function checkHealth(url, password) {
  let healthUrl;
  try {
    healthUrl = new URL("/global/health", url);
  } catch {
    return false;
  }
  const headers = new Headers();
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64");
    headers.set("authorization", `Basic ${auth}`);
  }
  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3e3)
    });
    if (!res.ok) {
      console.log(`[checkHealth] ${healthUrl} status=${res.status} hasAuth=${headers.has("authorization")}`);
    }
    return res.ok;
  } catch (err) {
    console.log(`[checkHealth] ${healthUrl} error=${err.message?.slice(0, 80)}`);
    return false;
  }
}
async function checkHealthOrAskRetry(url) {
  while (true) {
    if (await checkHealth(url)) return true;
    const result = await dialog.showMessageBox({
      type: "warning",
      message: `Could not connect to configured server:
${url}

Would you like to retry or start a local server instead?`,
      title: "Connection Failed",
      buttons: ["Retry", "Start Local"],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0) continue;
    return false;
  }
}
function normalizeHostnameForUrl(hostname) {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  if (hostname.includes(":") && !hostname.startsWith("[")) return `[${hostname}]`;
  return hostname;
}
function getServerUrlFromConfig(config) {
  const server = config.server;
  if (!server?.port) return null;
  const host = server.hostname ? normalizeHostnameForUrl(server.hostname) : "127.0.0.1";
  return `http://${host}:${server.port}`;
}
const root = dirname(fileURLToPath(import.meta.url));
function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons");
}
function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png";
  return join(iconsDir(), `icon.${ext}`);
}
function setDockIcon() {
  if (process.platform !== "darwin") return;
  app.dock?.setIcon(nativeImage.createFromPath(join(iconsDir(), "128x128@2x.png")));
}
function createMainWindow(globals) {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800
  });
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: true,
    title: "Claxedo",
    icon: iconPath(),
    ...process.platform === "darwin" ? {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 12, y: 12 }
    } : {},
    ...process.platform === "win32" ? {
      frame: false,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "transparent",
        symbolColor: "#999",
        height: 40
      }
    } : {},
    webPreferences: {
      preload: join(root, "../preload/index.mjs"),
      sandbox: false
    }
  });
  state.manage(win);
  loadWindow(win, "index.html");
  wireZoom(win);
  injectGlobals(win, globals);
  devtools(win);
  return win;
}
function createLoadingWindow(globals) {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    center: true,
    show: true,
    icon: iconPath(),
    ...process.platform === "darwin" ? { titleBarStyle: "hidden" } : {},
    ...process.platform === "win32" ? {
      frame: false,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "transparent",
        symbolColor: "#999",
        height: 40
      }
    } : {},
    webPreferences: {
      preload: join(root, "../preload/index.mjs"),
      sandbox: false
    }
  });
  loadWindow(win, "loading.html");
  injectGlobals(win, globals);
  return win;
}
function loadWindow(win, html) {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    const url = new URL(html, devUrl);
    void win.loadURL(url.toString());
    return;
  }
  void win.loadFile(join(root, `../renderer/${html}`));
}
function devtools(win) {
  if (!process.env.ELECTRON_RENDERER_URL) return;
  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.webContents.openDevTools({ mode: "undocked" });
  });
}
function injectGlobals(win, globals) {
  win.webContents.on("dom-ready", () => {
    const deepLinks = globals.deepLinks ?? [];
    const data = {
      updaterEnabled: globals.updaterEnabled,
      wsl: globals.wsl,
      deepLinks: Array.isArray(deepLinks) ? deepLinks.splice(0) : deepLinks
    };
    void win.webContents.executeJavaScript(
      `window.__OPENCODE__ = Object.assign(window.__OPENCODE__ ?? {}, ${JSON.stringify(data)})`
    );
  });
}
function wireZoom(win) {
  win.webContents.setZoomFactor(1);
  win.webContents.on("zoom-changed", () => {
    win.webContents.setZoomFactor(1);
  });
}
const APP_NAMES = {
  dev: "Claxedo Dev",
  beta: "Claxedo Beta",
  prod: "Claxedo"
};
const APP_IDS = {
  dev: "ai.claxedo.desktop.dev",
  beta: "ai.claxedo.desktop.beta",
  prod: "ai.claxedo.desktop"
};
app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Claxedo Dev");
app.setPath("userData", join(app.getPath("appData"), app.isPackaged ? APP_IDS[CHANNEL] : "ai.claxedo.desktop.dev"));
const { autoUpdater } = pkg;
const initEmitter = new EventEmitter();
let initStep = { phase: "server_waiting" };
let mainWindow = null;
let sidecar = null;
let claxedoServerHandle = null;
let local = null;
let quitting = false;
const loadingComplete = defer();
const pendingDeepLinks = [];
const serverReady = defer();
const logger = initLogging();
logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged
});
setupApp();
function setupApp() {
  ensureLoopbackNoProxy();
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>");
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", (_event, argv) => {
    const urls = argv.filter((arg) => arg.startsWith("claxedo://"));
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls });
      emitDeepLinks(urls);
    }
    focusMainWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    logger.log("deep link received via open-url", { url });
    emitDeepLinks([url]);
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => app.quit());
  });
  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("claxedo");
    setDockIcon();
    syncCli();
    await initialize();
  });
}
function emitDeepLinks(urls) {
  if (urls.length === 0) return;
  pendingDeepLinks.push(...urls);
  if (mainWindow) sendDeepLinks(mainWindow, urls);
}
function focusMainWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}
function setInitStep(step) {
  initStep = step;
  logger.log("init step", { step });
  initEmitter.emit("step", step);
}
const MAIN_DIR = import.meta.dirname;
function getClaxedoServerPath() {
  return app.isPackaged ? join(MAIN_DIR, "claxedo-server.js") : join(MAIN_DIR, "../../resources/claxedo-server.js");
}
async function startClaxedoServer(opencodeUrl, opencodePassword) {
  const claxedoPort = await getFreePort();
  const serverPath = getClaxedoServerPath();
  logger.log("starting claxedo-server", { serverPath, claxedoPort, opencodeUrl });
  if (!existsSync(serverPath)) {
    logger.warn("claxedo-server.js not found, skipping", { serverPath });
    return { url: opencodeUrl };
  }
  const acpDir = app.isPackaged ? join(process.resourcesPath, "acp") : join(MAIN_DIR, "../../resources/acp");
  if (existsSync(acpDir)) {
    process.env.CLAXEDO_ACP_DIR = acpDir;
    if (!process.env.CLAUDE_CODE_EXECUTABLE) {
      const cliPath = join(acpDir, "claude-cli.js");
      if (existsSync(cliPath)) {
        process.env.CLAUDE_CODE_EXECUTABLE = cliPath;
      }
    }
  }
  try {
    const module = await import(pathToFileURL(serverPath).href);
    claxedoServerHandle = module.startServer(claxedoPort, opencodeUrl, opencodePassword);
    const claxedoUrl = `http://127.0.0.1:${claxedoPort}`;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch(`${claxedoUrl}/api/claxedo/health`, { signal: AbortSignal.timeout(1e3) });
        if (res.ok) {
          logger.log("claxedo-server healthy", { url: claxedoUrl });
          return { url: claxedoUrl };
        }
      } catch {
      }
    }
    logger.warn("claxedo-server health check timed out, falling back to opencode");
    return { url: opencodeUrl };
  } catch (err) {
    logger.error("claxedo-server failed to start", { error: String(err) });
    return { url: opencodeUrl };
  }
}
async function setupServerConnection() {
  if (!app.isPackaged) {
    const candidates = [process.env.CLAXEDO_SERVER_URL, "http://127.0.0.1:3001"].filter(Boolean);
    const results = await Promise.all(candidates.map(async (url) => ({ url, ok: await checkHealth(url) })));
    const hit = results.find((r) => r.ok);
    if (hit) {
      logger.log("dev: using claxedo-server", { url: hit.url });
      local = null;
      serverReady.resolve({ url: hit.url, password: null });
      return { variant: "existing", url: hit.url };
    }
    logger.log("dev: claxedo-server not found, falling back to sidecar");
  }
  const customUrl = await getSavedServerUrl();
  if (customUrl && await checkHealthOrAskRetry(customUrl)) {
    local = null;
    serverReady.resolve({ url: customUrl, password: null });
    return { variant: "existing", url: customUrl };
  }
  const port = await getSidecarPort();
  const hostname = "127.0.0.1";
  const localUrl = `http://${hostname}:${port}`;
  if (await checkHealth(localUrl)) {
    local = null;
    serverReady.resolve({ url: localUrl, password: null });
    return { variant: "existing", url: localUrl };
  }
  const password = randomUUID();
  const { child, health, events } = spawnLocalServer(hostname, port, password);
  sidecar = child;
  local = { url: localUrl, password };
  return {
    variant: "cli",
    url: localUrl,
    password,
    health,
    events
  };
}
async function initialize() {
  const needsMigration = !sqliteFileExists();
  const sqliteDone = needsMigration ? defer() : void 0;
  const loadingTask = (async () => {
    logger.log("setting up server connection");
    const serverConnection = await setupServerConnection();
    logger.log("server connection ready", {
      variant: serverConnection.variant,
      url: serverConnection.url
    });
    if (serverConnection.variant === "cli") {
      const { events, health } = serverConnection;
      events.on("sqlite", (progress) => {
        setInitStep({ phase: "sqlite_waiting" });
        if (loadingWindow2) sendSqliteMigrationProgress(loadingWindow2, progress);
        if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress);
        if (progress.type === "Done") sqliteDone?.resolve();
      });
      logger.log("server connection started");
      const healthDone = health.wait.then(
        async () => {
          sqliteDone?.resolve();
          const { url: claxedoUrl } = await startClaxedoServer(serverConnection.url, serverConnection.password);
          serverReady.resolve({
            url: claxedoUrl,
            password: serverConnection.password
          });
        },
        (err) => {
          sqliteDone?.reject(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      );
      if (needsMigration) await sqliteDone?.promise;
      await healthDone;
    } else {
      logger.log("server connection started");
      serverReady.resolve({ url: serverConnection.url, password: null });
    }
    logger.log("loading task finished");
  })();
  const globals = {
    updaterEnabled: UPDATER_ENABLED,
    wsl: getWslConfig().enabled,
    deepLinks: pendingDeepLinks
  };
  const loadingWindow2 = await (async () => {
    if (needsMigration) {
      const loadingWindow3 = createLoadingWindow(globals);
      await delay(1e3);
      return loadingWindow3;
    } else {
      logger.log("showing main window without loading window");
      mainWindow = createMainWindow(globals);
      wireFullscreenEvents(mainWindow);
      wireMenu();
    }
  })();
  await loadingTask;
  setInitStep({ phase: "done" });
  if (loadingWindow2) {
    await loadingComplete.promise;
  }
  if (!mainWindow) {
    mainWindow = createMainWindow(globals);
    wireFullscreenEvents(mainWindow);
    wireMenu();
  }
  loadingWindow2?.close();
}
function wireMenu() {
  if (!mainWindow) return;
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    installCli: () => {
      void installCli();
    },
    checkForUpdates: () => {
      void checkForUpdates();
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      app.relaunch();
      app.quit();
    }
  });
}
registerIpcHandlers({
  killSidecar: () => killSidecar(),
  installCli: async () => installCli(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep);
    const listener = (step) => sendStep(step);
    initEmitter.on("step", listener);
    try {
      logger.log("awaiting server ready");
      const res = await serverReady.promise;
      logger.log("server ready", { url: res.url });
      return res;
    } finally {
      initEmitter.off("step", listener);
    }
  },
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config) => setWslConfig(config),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => void 0,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate()
});
function killSidecar() {
  if (!sidecar) return;
  sidecar.kill();
  sidecar = null;
  local = null;
}
async function shutdown() {
  await disposeSidecar();
  killSidecar();
  if (claxedoServerHandle) {
    claxedoServerHandle.close();
    claxedoServerHandle = null;
  }
}
async function disposeSidecar() {
  if (!sidecar || !local) return;
  const headers = new Headers();
  const auth = Buffer.from(`opencode:${local.password}`).toString("base64");
  headers.set("authorization", `Basic ${auth}`);
  try {
    await fetch(new URL("/global/dispose", local.url), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(1500)
    });
  } catch (err) {
    logger.warn("failed to dispose sidecar before quit", { error: err });
  }
}
function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"];
  const upsert = (key) => {
    const items = (process.env[key] ?? "").split(",").map((value) => value.trim()).filter((value) => Boolean(value));
    for (const host of loopback) {
      if (items.some((value) => value.toLowerCase() === host)) continue;
      items.push(host);
    }
    process.env[key] = items.join(",");
  };
  upsert("NO_PROXY");
  upsert("no_proxy");
}
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close();
        reject(new Error("Failed to get port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close();
        reject(new Error("Failed to get port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return existsSync(join(base, "opencode", "opencode.db"));
}
async function checkUpdate() {
  return { updateAvailable: false };
}
async function installUpdate() {
  return;
}
async function checkForUpdates(alertOnFail) {
  return;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
