import { contextBridge, ipcRenderer, webUtils } from "electron"
import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import { applyDiagnosticsSnapshotUpdate } from "../shared/diagnostics-snapshot-update"
import type {
  BrowserBridge,
  BrowserConsoleEntry,
  BrowserConsoleQuery,
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
  ServerReadyData,
} from "./types"

/**
 * The one seam where main's reply type is named.
 *
 * `ipcRenderer.invoke` resolves to `any`; each call below names the type its
 * main-process handler returns, and the `any` stops at this line rather than
 * being asserted away at every member. Replies whose shape actually needs
 * verifying are parsed by the caller (see `processDiagnosticsBridge`, which
 * runs every reply through its `LocalDiagnostics` schema).
 */
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args)

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
  enabled: () => invoke<boolean>("browser:enabled"),
  register: (paneId, webContentsId) =>
    invoke<BrowserRegisterResult>("browser:register", paneId, webContentsId),
  unregister: (paneId) => invoke<BrowserResult>("browser:unregister", paneId),
  navigate: (paneId, url) => invoke<BrowserResult>("browser:navigate", paneId, url),
  getConsoleLogs: (paneId, q?: BrowserConsoleQuery) =>
    invoke<BrowserConsoleEntry[]>("browser:getConsoleLogs", paneId, q ?? {}),
  onConsoleEntry: (paneId, cb) => {
    const channel = `browser:onConsoleEntry:${paneId}`
    const handler = (_: unknown, entry: BrowserConsoleEntry) => cb(entry)
    ipcRenderer.on(channel, handler)
    void invoke<unknown>("browser:subscribeConsole", paneId)
    return () => {
      ipcRenderer.removeListener(channel, handler)
      void invoke<unknown>("browser:unsubscribeConsole", paneId).catch(() => {})
    }
  },
  captureScreenshot: (paneId, opts?: { clip?: BrowserScreenshotClip }) =>
    invoke<BrowserScreenshotResult>("browser:captureScreenshot", paneId, opts ?? {}),
  setInspectMode: (paneId, enabled) =>
    invoke<BrowserResult>("browser:setInspectMode", paneId, enabled),
  onNodeSelected: (paneId, cb) => {
    const channel = `browser:onNodeSelected:${paneId}`
    const handler = (_: unknown, payload: BrowserNodeSelectedPayload) => cb(payload)
    ipcRenderer.on(channel, handler)
    void invoke<unknown>("browser:subscribeNodeSelected", paneId)
    return () => {
      ipcRenderer.removeListener(channel, handler)
      void invoke<unknown>("browser:unsubscribeNodeSelected", paneId).catch(() => {})
    }
  },
  getNavigationState: (paneId) =>
    invoke<BrowserNavigationState>("browser:getNavigationState", paneId),
  goBack: (paneId) => invoke<BrowserResult>("browser:goBack", paneId),
  goForward: (paneId) => invoke<BrowserResult>("browser:goForward", paneId),
  reload: (paneId, hard?: boolean) =>
    invoke<BrowserResult>("browser:reload", paneId, Boolean(hard)),
  openDevTools: (paneId) => invoke<BrowserResult>("browser:openDevTools", paneId),
  clearStorage: (paneId, storages?: BrowserStorageKey[]) =>
    invoke<BrowserResult>("browser:clearStorage", paneId, storages),
}

const processDiagnosticsBridge: ProcessDiagnosticsBridge = {
  getSnapshot: async () =>
    LocalDiagnostics.RetainedSnapshot.parse(await invoke("process-diagnostics:get-snapshot")),
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
      void invoke("process-diagnostics:get-snapshot")
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
    void invoke("process-diagnostics:subscribe")
      .then(accept)
      .catch(() => {
        ipcRenderer.removeListener("process-diagnostics:snapshot", handler)
      })
    return () => {
      ipcRenderer.removeListener("process-diagnostics:snapshot", handler)
      void invoke("process-diagnostics:unsubscribe").catch(() => {})
    }
  },
  recordContext: async (context) => {
    await invoke("process-diagnostics:context", LocalDiagnostics.SetContextRequest.parse(context))
  },
  scanSessionMemory: async (request) =>
    LocalDiagnostics.SessionMemoryScanResult.parse(
      await invoke(
        "process-diagnostics:scan-session-memory",
        LocalDiagnostics.SessionMemoryScanRequest.parse(request),
      ),
    ),
  stop: async (request) =>
    LocalDiagnostics.ActionResult.parse(
      await invoke("process-diagnostics:stop", LocalDiagnostics.StopRequest.parse(request)),
    ),
  kill: async (request) =>
    LocalDiagnostics.ActionResult.parse(
      await invoke("process-diagnostics:kill", LocalDiagnostics.KillRequest.parse(request)),
    ),
}

const api: ElectronAPI = {
  optionalFeatures: {
    nativeMarkdown: Boolean(
      process.env.CLAXEDO_MARKDOWN_RENDERER_PATH ?? process.env.CLAXEDO_RICH_CONTENT_RENDERER_PATH,
    ),
    nativeMermaid: Boolean(
      process.env.CLAXEDO_MERMAID_RENDERER_PATH ?? process.env.CLAXEDO_RICH_CONTENT_RENDERER_PATH,
    ),
  },
  parseMarkdown: (source) => invoke("parse-markdown", source),
  renderMermaid: (source, theme) => invoke("render-mermaid", source, theme),
  awaitInitialization: (onStep) => {
    const handler = (_: unknown, step: InitStep) => onStep(step)
    ipcRenderer.on("init-step", handler)
    return invoke<ServerReadyData>("await-initialization").finally(() => {
      ipcRenderer.removeListener("init-step", handler)
    })
  },
  getDefaultServer: () => invoke("get-default-server-url"),
  setDefaultServer: (url) => invoke("set-default-server-url", url),
  getWslConfig: () => invoke("get-wsl-config"),
  setWslConfig: (config) => invoke("set-wsl-config", config),
  getDisplayBackend: () => invoke("get-display-backend"),
  setDisplayBackend: (backend) => invoke("set-display-backend", backend),
  checkAppExists: (appName) => invoke("check-app-exists", appName),
  wslPath: (path, mode) => invoke("wsl-path", path, mode),
  resolveAppPath: (appName) => invoke("resolve-app-path", appName),
  storeGet: (name, key) => invoke("store-get", name, key),
  storeSet: (name, key, value) => invoke("store-set", name, key, value),
  storeDelete: (name, key) => invoke("store-delete", name, key),
  storeClear: (name) => invoke("store-clear", name),
  storeKeys: (name) => invoke("store-keys", name),
  storeLength: (name) => invoke("store-length", name),

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

  openDirectoryPicker: (opts) => invoke("open-directory-picker", opts),
  openFilePicker: (opts) => invoke("open-file-picker", opts),
  saveFilePicker: (opts) => invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => invoke("open-path", path, app),
  showItemInFolder: (path) => invoke("show-item-in-folder", path),
  readClipboardImage: () => invoke("read-clipboard-image"),
  writeClipboardImage: (buffer) => invoke("write-clipboard-image", buffer),
  getWindowFocused: () => invoke("get-window-focused"),
  getWindowFullscreen: () => invoke("get-window-fullscreen"),
  setWindowFocus: () => invoke("set-window-focus"),
  showWindow: () => invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  quit: () => ipcRenderer.send("quit"),
  setZoomFactor: (factor) => invoke("set-zoom-factor", factor),
  loadingWindowComplete: () => ipcRenderer.send("loading-window-complete"),
  runUpdater: (alertOnFail) => invoke("run-updater", alertOnFail),
  checkUpdate: () => invoke("check-update"),
  installUpdate: () => invoke("install-update"),
  getStartAtLogin: () => invoke("get-start-at-login"),
  setStartAtLogin: (enabled) => invoke("set-start-at-login", enabled),
  setNativeTheme: (theme) => ipcRenderer.send("set-native-theme", theme),
  getDroppedFilePaths: (files) => files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  processDiagnostics: processDiagnosticsBridge,
  browser: browserBridge,
  /**
   * Machine remote access, entirely by name.
   *
   * Seven operations. `status`, `start`, `pause` and `revoke` take nothing;
   * `share`, `unshare` and `rename` carry data the user chose — a workspace id,
   * a label, a name — and nothing that could describe a request. Main holds
   * the account bearer and a machine signing key that does not expire, so a
   * message may pick which fixed operation happens and, at most, which of this
   * machine's own workspaces it happens to; never a url, a path, a method or a
   * machine.
   *
   * `status` reads. `start` publishes this machine and is the one place the
   * enrollment handshake can begin, which is why the desktop enrolls nothing at
   * launch: the user presses a button, or nothing happens.
   *
   * `onStatus` is the other direction — a heartbeat rejected, an enrollment
   * expired, a revocation — which no invoke could deliver because nobody would
   * be asking at the moment it happened.
   */
  hostConnector: {
    status: () => invoke("claxedo.hostConnector.status"),
    start: () => invoke("claxedo.hostConnector.start"),
    pause: () => invoke("claxedo.hostConnector.pause"),
    revoke: () => invoke("claxedo.hostConnector.revoke"),
    share: (input: { workspaceId: string; displayName?: string }) =>
      invoke("claxedo.hostConnector.share", input),
    unshare: (input: { workspaceId: string }) =>
      invoke("claxedo.hostConnector.unshare", input),
    rename: (input: { displayName: string }) =>
      invoke("claxedo.hostConnector.rename", input),
    onStatus: (listener: (status: unknown) => void) => {
      const handler = (_event: unknown, status: unknown) => listener(status)
      ipcRenderer.on("claxedo.hostConnector.status", handler)
      return () => ipcRenderer.removeListener("claxedo.hostConnector.status", handler)
    },
  },
  /**
   * The account, entirely by name.
   *
   * No method here takes a url, a path, or headers — `run` takes an operation
   * name from a fixed set and main decides the request. That is what lets the
   * credential live in main: this bridge cannot be used to spend it on a
   * route nobody wrote down.
   */
  account: {
    state: () => invoke("claxedo.account.state"),
    onState: (listener: (state: unknown) => void) => {
      const handler = (_event: unknown, state: unknown) => listener(state)
      ipcRenderer.on("claxedo.account.stateChanged", handler)
      return () => ipcRenderer.removeListener("claxedo.account.stateChanged", handler)
    },
    signIn: () => invoke("claxedo.account.signIn"),
    signOut: () => invoke("claxedo.account.signOut"),
    run: (operation: string, input?: Record<string, unknown>) =>
      invoke(`claxedo.account.operation:${operation}`, input),
    streamOpen: (operation: string, input?: Record<string, unknown>) =>
      invoke("claxedo.account.stream.open", { operation, input }),
    streamStart: (streamId: string) =>
      invoke("claxedo.account.stream.start", { streamId }),
    streamClose: (streamId: string) =>
      invoke("claxedo.account.stream.close", { streamId }),
    onStreamChunk: (listener: (payload: { streamId: string; text: string }) => void) => {
      const handler = (_event: unknown, payload: { streamId: string; text: string }) => listener(payload)
      ipcRenderer.on("claxedo.account.stream.chunk", handler)
      return () => ipcRenderer.removeListener("claxedo.account.stream.chunk", handler)
    },
    onStreamEnd: (listener: (payload: { streamId: string }) => void) => {
      const handler = (_event: unknown, payload: { streamId: string }) => listener(payload)
      ipcRenderer.on("claxedo.account.stream.end", handler)
      return () => ipcRenderer.removeListener("claxedo.account.stream.end", handler)
    },
    onStreamError: (listener: (payload: { streamId: string; message: string }) => void) => {
      const handler = (_event: unknown, payload: { streamId: string; message: string }) => listener(payload)
      ipcRenderer.on("claxedo.account.stream.error", handler)
      return () => ipcRenderer.removeListener("claxedo.account.stream.error", handler)
    },
  },
}

contextBridge.exposeInMainWorld("api", api)
