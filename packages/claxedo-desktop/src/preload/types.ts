import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

export type InitStep = { phase: "server_waiting" } | { phase: "sqlite_waiting" } | { phase: "done" }

export type ServerReadyData = {
  url: string
  password: string | null
}

export type SqliteMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

export type WslConfig = { enabled: boolean }

export type LinuxDisplayBackend = "wayland" | "auto"

/**
 * Agentic browser-tab preload bridge.
 *
 * Exposed at `window.api.browser` in the desktop renderer. The main process
 * reports whether the capability is available, including the diagnostic
 * `CLAXEDO_ENABLE_BROWSER_TAB=0` opt-out.
 */
export type BrowserRegisterResult =
  | { ok: true; webContentsId: number }
  | { ok: false; error: string }

export type BrowserResult = { ok: true } | { ok: false; error: string }

export type BrowserConsoleLevel = "log" | "warn" | "error" | "debug" | "info"

export type BrowserConsoleStackFrame = {
  url?: string
  function?: string
  line?: number
  column?: number
}

export type BrowserConsoleEntry = {
  id: number
  time: number
  level: BrowserConsoleLevel
  args: string[]
  stack?: BrowserConsoleStackFrame[]
  source: "console" | "exception" | "log"
  sessionId?: string
}

export type BrowserConsoleQuery = {
  since?: number
  level?: BrowserConsoleLevel
  limit?: number
}

export type BrowserScreenshotClip = {
  x: number
  y: number
  width: number
  height: number
  scale?: number
}

export type BrowserScreenshotResult =
  | { ok: true; dataUrl: string; mimeType: "image/png" | "image/jpeg" }
  | { ok: false; error: { code: "no-page" | "not-attached" | "cdp-error" | "no-pane"; message?: string } }

export type BrowserNodeSelectedPayload =
  | {
      ok: true
      selector: string
      shadow?: { host: string; inner: string }
      frameUrl: string
      boundingBox?: { x: number; y: number; width: number; height: number }
      outerHTML?: string
      tagName: string
      screenshotDataUrl?: string
      computedStyles?: {
        color?: string
        backgroundColor?: string
        fontFamily?: string
        fontSize?: string
        display?: string
      }
    }
  | {
      ok: false
      error: "shadow-root-closed" | "element-not-found" | "not-attached" | "generic" | "timeout" | "canceled"
      message?: string
      frameUrl?: string
    }

export type BrowserEvaluateResult =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: {
        code: "eval-denied" | "not-attached" | "cdp-error" | "script-error" | "no-pane"
        message?: string
        stack?: string
      }
    }

export type BrowserNavigationState =
  | { ok: true; url: string; canGoBack: boolean; canGoForward: boolean }
  | { ok: false; error: string }

export type BrowserStorageKey =
  | "cookies"
  | "localstorage"
  | "indexdb"
  | "cachestorage"
  | "serviceworkers"

export type BrowserBridge = {
  enabled: () => Promise<boolean>
  register: (paneId: string, webContentsId: number) => Promise<BrowserRegisterResult>
  unregister: (paneId: string) => Promise<BrowserResult>
  navigate: (paneId: string, url: string) => Promise<BrowserResult>
  getConsoleLogs: (paneId: string, q?: BrowserConsoleQuery) => Promise<BrowserConsoleEntry[]>
  onConsoleEntry: (paneId: string, cb: (entry: BrowserConsoleEntry) => void) => () => void
  captureScreenshot: (
    paneId: string,
    opts?: { clip?: BrowserScreenshotClip },
  ) => Promise<BrowserScreenshotResult>
  evaluate: (paneId: string, expression: string) => Promise<BrowserEvaluateResult>
  setAgentAllowed: (paneId: string, allowed: boolean) => Promise<BrowserResult>
  setInspectMode: (paneId: string, enabled: boolean) => Promise<BrowserResult>
  onNodeSelected: (
    paneId: string,
    cb: (payload: BrowserNodeSelectedPayload) => void,
  ) => () => void
  getNavigationState: (paneId: string) => Promise<BrowserNavigationState>
  goBack: (paneId: string) => Promise<BrowserResult>
  goForward: (paneId: string) => Promise<BrowserResult>
  reload: (paneId: string, hard?: boolean) => Promise<BrowserResult>
  openDevTools: (paneId: string) => Promise<BrowserResult>
  clearStorage: (paneId: string, storages?: BrowserStorageKey[]) => Promise<BrowserResult>
}

export type ProcessDiagnosticsBridge = LocalDiagnostics.Capability

export type ElectronAPI = {
  optionalFeatures: Readonly<{
    nativeMarkdown: boolean
    nativeMermaid: boolean
  }>
  parseMarkdown: (source: string) => Promise<string>
  renderMermaid: (source: string, theme?: Record<string, string>) => Promise<string>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getDefaultServer: () => Promise<string | null>
  setDefaultServer: (url: string | null) => Promise<void>
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  checkAppExists: (appName: string) => Promise<boolean>
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  onSqliteMigrationProgress: (cb: (progress: SqliteMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void
  onFullscreenChange: (cb: (isFullscreen: boolean) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  showItemInFolder: (path: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  writeClipboardImage: (buffer: ArrayBuffer) => Promise<boolean>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  getWindowFullscreen: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  quit: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void>
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void>
  getStartAtLogin: () => Promise<boolean>
  setStartAtLogin: (enabled: boolean) => Promise<void>
  setNativeTheme: (theme: "light" | "dark" | "system") => void
  getDroppedFilePaths: (files: File[]) => string[]
  processDiagnostics: ProcessDiagnosticsBridge
  browser: BrowserBridge
  /**
   * The account, by named operation only.
   *
   * `run` deliberately takes a name and parameters rather than a request: the
   * credential lives in main, and a bridge that could describe a request would
   * make main a confused deputy. The names come from
   * `docs/tech-docs/desktop-hosted-operation-matrix.md`.
   */
  /**
   * Machine remote access, by named operation only.
   *
   * Four operations and a status subscription. None of them takes an argument,
   * which is stronger than the account bridge below and deliberately so: main
   * holds the account bearer AND a machine signing key that never expires, so
   * there must be nothing in a message for a handler to act on. A message picks
   * which of four things happens; it cannot describe one.
   *
   * `main/host-connector/ipc.ts` is the closed set, and
   * `main/host-connector/ipc.test.ts` asserts this bridge names exactly it.
   */
  hostConnector: {
    status: () => Promise<unknown>
    start: () => Promise<unknown>
    pause: () => Promise<unknown>
    revoke: () => Promise<unknown>
    /** Push, for the transitions the user did not cause. Returns an unsubscribe. */
    onStatus: (listener: (status: unknown) => void) => () => void
  }
  account: {
    state: () => Promise<unknown>
    /** Pushes authoritative main-process transitions, including passive revocation. */
    onState: (listener: (state: unknown) => void) => () => void
    signIn: () => Promise<unknown>
    signOut: () => Promise<unknown>
    run: (operation: string, input?: Record<string, unknown>) => Promise<unknown>
    streamOpen: (operation: string, input?: Record<string, unknown>) => Promise<{ streamId: string }>
    streamStart: (streamId: string) => Promise<void>
    streamClose: (streamId: string) => Promise<void>
    onStreamChunk: (listener: (payload: { streamId: string; text: string }) => void) => () => void
    onStreamEnd: (listener: (payload: { streamId: string }) => void) => () => void
    onStreamError: (listener: (payload: { streamId: string; message: string }) => void) => () => void
  }
}
