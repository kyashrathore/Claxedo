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
 * Exposed at `window.api.browser`. Only populated in builds / launches where
 * `CLAXEDO_ENABLE_BROWSER_TAB=1` is set on the main process — renderers must
 * treat `window.api.browser` as potentially undefined and fall back to the
 * "requires desktop" placeholder when it is absent.
 *
 * Streams follow the repo's callback+unsubscribe pattern (mirror
 * `onSqliteMigrationProgress`); Unit 3 adds `onConsoleEntry` with this shape.
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

/**
 * Payload forwarded to the renderer when the user clicks an element with
 * inspect mode on. Mirrors the main-process `NodeSelectedPayload` — the
 * renderer must handle both the success and failure variants.
 */
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
    }
  | {
      ok: false
      error: "shadow-root-closed" | "element-not-found" | "not-attached" | "generic" | "timeout"
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

export type BrowserBridge = {
  /** Whether the main-process bridge is live (feature flag set). */
  enabled: () => Promise<boolean>
  /** Register a pane with the webContents id returned by `(webview).getWebContentsId()`. */
  register: (paneId: string, webContentsId: number) => Promise<BrowserRegisterResult>
  /** Unregister a pane. Safe to call for an unknown pane. */
  unregister: (paneId: string) => Promise<BrowserResult>
  /** Navigate a registered pane to a new URL (http/https only). */
  navigate: (paneId: string, url: string) => Promise<BrowserResult>
  /** Pull-read console log entries from the pane's ring buffer. */
  getConsoleLogs: (paneId: string, q?: BrowserConsoleQuery) => Promise<BrowserConsoleEntry[]>
  /** Subscribe to live console entries for the pane. Returns unsubscribe. */
  onConsoleEntry: (paneId: string, cb: (entry: BrowserConsoleEntry) => void) => () => void
  /** Capture a screenshot of the pane (PNG, or JPEG if re-encoded for size). */
  captureScreenshot: (
    paneId: string,
    opts?: { clip?: BrowserScreenshotClip },
  ) => Promise<BrowserScreenshotResult>
  /** Run JS in the pane (refused unless per-tab agentAllowed flag is on). */
  evaluate: (paneId: string, expression: string) => Promise<BrowserEvaluateResult>
  /** Per-tab opt-in gate for agent-side `evaluate`. Defaults to false. */
  setAgentAllowed: (paneId: string, allowed: boolean) => Promise<BrowserResult>
  /** Toggle the Chromium native element-picker overlay on the pane. */
  setInspectMode: (paneId: string, enabled: boolean) => Promise<BrowserResult>
  /** Subscribe to node-selected events. Returns unsubscribe. */
  onNodeSelected: (
    paneId: string,
    cb: (payload: BrowserNodeSelectedPayload) => void,
  ) => () => void
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getDefaultServer: () => Promise<string | null>
  setDefaultServer: (url: string | null) => Promise<void>
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
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
  setNativeTheme: (theme: "light" | "dark" | "system") => void
  getDroppedFilePaths: (files: File[]) => string[]
  browser: BrowserBridge
}
