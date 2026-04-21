import { contextBridge, ipcRenderer, webUtils } from "electron"
import type {
  BrowserBridge,
  BrowserConsoleEntry,
  BrowserConsoleQuery,
  BrowserEvaluateResult,
  BrowserNodeSelectedPayload,
  BrowserRegisterResult,
  BrowserResult,
  BrowserScreenshotClip,
  BrowserScreenshotResult,
  ElectronAPI,
  InitStep,
  SqliteMigrationProgress,
} from "./types"

const browserBridge: BrowserBridge = {
  enabled: () => ipcRenderer.invoke("browser:enabled") as Promise<boolean>,
  register: (paneId, webContentsId) =>
    ipcRenderer.invoke("browser:register", paneId, webContentsId) as Promise<BrowserRegisterResult>,
  unregister: (paneId) => ipcRenderer.invoke("browser:unregister", paneId) as Promise<BrowserResult>,
  navigate: (paneId, url) =>
    ipcRenderer.invoke("browser:navigate", paneId, url) as Promise<BrowserResult>,
  getConsoleLogs: (paneId, q?: BrowserConsoleQuery) =>
    ipcRenderer.invoke("browser:getConsoleLogs", paneId, q ?? {}) as Promise<BrowserConsoleEntry[]>,
  onConsoleEntry: (paneId, cb) => {
    const channel = `browser:onConsoleEntry:${paneId}`
    const handler = (_: unknown, entry: BrowserConsoleEntry) => cb(entry)
    ipcRenderer.on(channel, handler)
    // Tell main to start pushing events for this paneId. Idempotent.
    void ipcRenderer.invoke("browser:subscribeConsole", paneId)
    return () => {
      ipcRenderer.removeListener(channel, handler)
      void ipcRenderer.invoke("browser:unsubscribeConsole", paneId).catch(() => {})
    }
  },
  captureScreenshot: (paneId, opts?: { clip?: BrowserScreenshotClip }) =>
    ipcRenderer.invoke("browser:captureScreenshot", paneId, opts ?? {}) as Promise<BrowserScreenshotResult>,
  evaluate: (paneId, expression) =>
    ipcRenderer.invoke("browser:evaluate", paneId, expression) as Promise<BrowserEvaluateResult>,
  setAgentAllowed: (paneId, allowed) =>
    ipcRenderer.invoke("browser:setAgentAllowed", paneId, Boolean(allowed)) as Promise<BrowserResult>,
  setInspectMode: (paneId, enabled) =>
    ipcRenderer.invoke("browser:setInspectMode", paneId, Boolean(enabled)) as Promise<BrowserResult>,
  onNodeSelected: (paneId, cb) => {
    const channel = `browser:onNodeSelected:${paneId}`
    const handler = (_: unknown, payload: BrowserNodeSelectedPayload) => cb(payload)
    ipcRenderer.on(channel, handler)
    void ipcRenderer.invoke("browser:subscribeNodeSelected", paneId)
    return () => {
      ipcRenderer.removeListener(channel, handler)
      void ipcRenderer.invoke("browser:unsubscribeNodeSelected", paneId).catch(() => {})
    }
  },
}

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: (onStep) => {
    const handler = (_: unknown, step: InitStep) => onStep(step)
    ipcRenderer.on("init-step", handler)
    return ipcRenderer.invoke("await-initialization").finally(() => {
      ipcRenderer.removeListener("init-step", handler)
    })
  },
  getDefaultServer: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServer: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getWslConfig: () => ipcRenderer.invoke("get-wsl-config"),
  setWslConfig: (config) => ipcRenderer.invoke("set-wsl-config", config),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  wslPath: (path, mode) => ipcRenderer.invoke("wsl-path", path, mode),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),

  onSqliteMigrationProgress: (cb) => {
    const handler = (_: unknown, progress: SqliteMigrationProgress) => cb(progress)
    ipcRenderer.on("sqlite-migration-progress", handler)
    return () => ipcRenderer.removeListener("sqlite-migration-progress", handler)
  },
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },
  onFullscreenChange: (cb) => {
    const handler = (_: unknown, isFullscreen: boolean) => cb(isFullscreen)
    ipcRenderer.on("fullscreen-change", handler)
    return () => ipcRenderer.removeListener("fullscreen-change", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  writeClipboardImage: (buffer) => ipcRenderer.invoke("write-clipboard-image", buffer),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  getWindowFullscreen: () => ipcRenderer.invoke("get-window-fullscreen"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  quit: () => ipcRenderer.send("quit"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  loadingWindowComplete: () => ipcRenderer.send("loading-window-complete"),
  runUpdater: (alertOnFail) => ipcRenderer.invoke("run-updater", alertOnFail),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  setNativeTheme: (theme) => ipcRenderer.send("set-native-theme", theme),
  getDroppedFilePaths: (files) => files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  browser: browserBridge,
}

contextBridge.exposeInMainWorld("api", api)
