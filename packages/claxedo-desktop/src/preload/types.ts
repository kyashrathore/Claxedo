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

export type BrowserBridge = {
  /** Whether the main-process bridge is live (feature flag set). */
  enabled: () => Promise<boolean>
  /** Register a pane with the webContents id returned by `(webview).getWebContentsId()`. */
  register: (paneId: string, webContentsId: number) => Promise<BrowserRegisterResult>
  /** Unregister a pane. Safe to call for an unknown pane. */
  unregister: (paneId: string) => Promise<BrowserResult>
  /** Navigate a registered pane to a new URL (http/https only). */
  navigate: (paneId: string, url: string) => Promise<BrowserResult>
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
