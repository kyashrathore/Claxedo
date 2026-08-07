import { contextBridge, ipcRenderer, webUtils } from "electron"
import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import { applyDiagnosticsSnapshotUpdate } from "../shared/diagnostics-snapshot-update"
import type {
  BrowserBridge,
  BrowserConsoleEntry,
  BrowserConsoleQuery,
  BrowserEvaluateResult,
  BrowserNavigationState,
  BrowserNodeSelectedPayload,
  BrowserRegisterResult,
  BrowserResult,
  BrowserScreenshotClip,
  BrowserScreenshotResult,
  BrowserStorageKey,
  ElectronAPI,
  InitStep,
  ProcessDiagnosticsBridge,
  SqliteMigrationProgress,
} from "./types"

if (process.env.CLAXEDO_PERF_READY_SELECTOR) {
  let previous = performance.now()
  const frame = (now: number) => {
    const gap = Math.round(now - previous)
    previous = now
    if (gap >= 100) console.warn(`[startup-perf] renderer-loop gap=${String(gap)}ms`)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

const browserBridge: BrowserBridge = {
  enabled: () => ipcRenderer.invoke("browser:enabled") as Promise<boolean>,
  register: (paneId, webContentsId) =>
    ipcRenderer.invoke("browser:register", paneId, webContentsId) as Promise<BrowserRegisterResult>,
  unregister: (paneId) => ipcRenderer.invoke("browser:unregister", paneId) as Promise<BrowserResult>,
  navigate: (paneId, url) => ipcRenderer.invoke("browser:navigate", paneId, url) as Promise<BrowserResult>,
  getConsoleLogs: (paneId, q?: BrowserConsoleQuery) =>
    ipcRenderer.invoke("browser:getConsoleLogs", paneId, q ?? {}) as Promise<BrowserConsoleEntry[]>,
  onConsoleEntry: (paneId, cb) => {
    const channel = `browser:onConsoleEntry:${paneId}`
    const handler = (_: unknown, entry: BrowserConsoleEntry) => cb(entry)
    ipcRenderer.on(channel, handler)
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
  getNavigationState: (paneId) =>
    ipcRenderer.invoke("browser:getNavigationState", paneId) as Promise<BrowserNavigationState>,
  goBack: (paneId) => ipcRenderer.invoke("browser:goBack", paneId) as Promise<BrowserResult>,
  goForward: (paneId) => ipcRenderer.invoke("browser:goForward", paneId) as Promise<BrowserResult>,
  reload: (paneId, hard?: boolean) =>
    ipcRenderer.invoke("browser:reload", paneId, Boolean(hard)) as Promise<BrowserResult>,
  openDevTools: (paneId) => ipcRenderer.invoke("browser:openDevTools", paneId) as Promise<BrowserResult>,
  clearStorage: (paneId, storages?: BrowserStorageKey[]) =>
    ipcRenderer.invoke("browser:clearStorage", paneId, storages) as Promise<BrowserResult>,
}

const processDiagnosticsBridge: ProcessDiagnosticsBridge = {
  getSnapshot: async () =>
    LocalDiagnostics.RetainedSnapshot.parse(await ipcRenderer.invoke("process-diagnostics:get-snapshot")),
  subscribe: (listener) => {
    let current: LocalDiagnostics.RetainedSnapshot | undefined
    let resyncing = false
    const accept = (input: unknown) => {
      const next = applyDiagnosticsSnapshotUpdate(current, input)
      if (next) {
        current = next
        listener(next)
        return
      }
      if (resyncing) return
      resyncing = true
      void ipcRenderer.invoke("process-diagnostics:get-snapshot")
        .then((snapshot) => {
          current = LocalDiagnostics.RetainedSnapshot.parse(snapshot)
          listener(current)
        })
        .catch(() => undefined)
        .finally(() => {
          resyncing = false
        })
    }
    const handler = (_: unknown, input: unknown) => {
      accept(input)
    }
    ipcRenderer.on("process-diagnostics:snapshot", handler)
    void ipcRenderer.invoke("process-diagnostics:subscribe")
      .then(accept)
      .catch(() => {
        ipcRenderer.removeListener("process-diagnostics:snapshot", handler)
      })
    return () => {
      ipcRenderer.removeListener("process-diagnostics:snapshot", handler)
      void ipcRenderer.invoke("process-diagnostics:unsubscribe").catch(() => {})
    }
  },
  recordContext: async (context) => {
    await ipcRenderer.invoke("process-diagnostics:context", LocalDiagnostics.SetContextRequest.parse(context))
  },
  scanSessionMemory: async (request) =>
    LocalDiagnostics.SessionMemoryScanResult.parse(
      await ipcRenderer.invoke(
        "process-diagnostics:scan-session-memory",
        LocalDiagnostics.SessionMemoryScanRequest.parse(request),
      ),
    ),
  stop: async (request) =>
    LocalDiagnostics.ActionResult.parse(
      await ipcRenderer.invoke("process-diagnostics:stop", LocalDiagnostics.StopRequest.parse(request)),
    ),
  kill: async (request) =>
    LocalDiagnostics.ActionResult.parse(
      await ipcRenderer.invoke("process-diagnostics:kill", LocalDiagnostics.KillRequest.parse(request)),
    ),
}

const api: ElectronAPI = {
  optionalFeatures: {
    documents: process.env.CLAXEDO_ENABLE_DOCUMENTS === "1",
    workgraph: process.env.CLAXEDO_ENABLE_WORKGRAPH === "1",
  },
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
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
  showItemInFolder: (path) => ipcRenderer.invoke("show-item-in-folder", path),
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
  getStartAtLogin: () => ipcRenderer.invoke("get-start-at-login"),
  setStartAtLogin: (enabled) => ipcRenderer.invoke("set-start-at-login", enabled),
  setNativeTheme: (theme) => ipcRenderer.send("set-native-theme", theme),
  getDroppedFilePaths: (files) => files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  processDiagnostics: processDiagnosticsBridge,
  browser: browserBridge,
}

contextBridge.exposeInMainWorld("api", api)
