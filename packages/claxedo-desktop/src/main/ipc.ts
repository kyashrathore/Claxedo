import { execFile } from "node:child_process"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import type {
  BrowserConsoleEntry,
  BrowserConsoleQuery,
  BrowserNodeSelectedPayload,
  BrowserScreenshotClip,
  InitStep,
  ServerReadyData,
  SqliteMigrationProgress,
  WslConfig,
} from "../preload/types"
import type { BrowserRegistry } from "./browser/registry"
import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import { IS_PACKAGED } from "./constants"
import { isSafeExternalUrl } from "./navigation-guard"
import { runRestart } from "../shared/restart-policy"
import {
  registerProcessDiagnosticsIpc,
  type DiagnosticsIpcRouter,
} from "./diagnostics/ipc"
import type { Profiler } from "./diagnostics/profiler"
import { getStore } from "./store"

type Deps = {
  killSidecar: () => Promise<void>
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  getStartAtLogin: () => boolean
  setStartAtLogin: (enabled: boolean) => void
  /** Optional; only provided when the browser-tab feature flag is set. */
  browser?: BrowserRegistry
  processDiagnostics: {
    profiler: Profiler
    scanSessionMemory(request: LocalDiagnostics.SessionMemoryScanRequest): Promise<LocalDiagnostics.SessionMemoryScanResult>
    isAllowedUrl(url: string): boolean
    confirmAction(input: {
      webContents: import("./diagnostics/ipc").DiagnosticsWebContents
      action: "stop" | "kill"
      ownerLabel: string
    }): Promise<boolean>
  }
}

export function registerIpcHandlers(deps: Deps) {
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig())
  ipcMain.handle("set-wsl-config", (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("get-start-at-login", () => deps.getStartAtLogin())
  ipcMain.handle("set-start-at-login", (_event: IpcMainInvokeEvent, enabled: boolean) =>
    deps.setStartAtLogin(Boolean(enabled)),
  )
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    const store = getStore(name)
    const value = store.get(key)
    if (value === undefined || value === null) return null
    return typeof value === "string" ? value : JSON.stringify(value)
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  // Scheme-gated: `shell.openExternal` hands the URL to the OS handler, and the
  // callers are untrusted content — rendered agent markdown and terminal
  // output-detected links both reach here. Without this an agent could get
  // `file:///…/Evil.app` (or any privileged platform scheme) launched by a click.
  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    if (!isSafeExternalUrl(url)) return
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("show-item-in-folder", async (_event: IpcMainInvokeEvent, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })
  ipcMain.handle("write-clipboard-image", (_event: IpcMainInvokeEvent, buffer: ArrayBuffer) => {
    const image = nativeImage.createFromBuffer(Buffer.from(buffer))
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("get-window-fullscreen", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFullScreen() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  // Every caller of this channel means "restart the app", so it gets the same
  // dev-aware treatment as the menu item: relaunching out of `electron-vite
  // dev` takes the renderer's dev server down with it. The reload targets the
  // window that asked, so a diagnostics window can't reload the main one.
  ipcMain.on("relaunch", (event: IpcMainEvent) => {
    runRestart({
      packaged: IS_PACKAGED,
      relaunch: () => app.relaunch(),
      quit: () => app.exit(0),
      reload: () => event.sender.reloadIgnoringCache(),
    })
  })

  ipcMain.on("quit", () => {
    app.quit()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => event.sender.setZoomFactor(factor))

  ipcMain.on("set-native-theme", (_event: IpcMainEvent, theme: "light" | "dark" | "system") => {
    nativeTheme.themeSource = theme
  })

  registerBrowserIpcHandlers(deps.browser)
  return registerProcessDiagnosticsIpc(ipcMain as unknown as DiagnosticsIpcRouter, deps.processDiagnostics)
}

function registerBrowserIpcHandlers(registry: BrowserRegistry | undefined) {
  ipcMain.handle("browser:enabled", () => Boolean(registry))

  if (!registry) return

  // Subscribers can arrive before `browser:register` (the renderer's
  // BrowserPaneProvider attaches stream listeners during mount, before the
  // webview's dom-ready fires register). Queue them per-paneId here and
  // drain inside the register handler so the first subscription doesn't
  // get dropped on the floor.
  const pendingAttach = new Map<string, Array<() => void>>()
  const queueAttach = (paneId: string, attach: () => void) => {
    if (!pendingAttach.has(paneId)) pendingAttach.set(paneId, [])
    pendingAttach.get(paneId)!.push(attach)
  }
  const drainPending = (paneId: string) => {
    const list = pendingAttach.get(paneId)
    if (!list) return
    pendingAttach.delete(paneId)
    for (const fn of list) {
      try {
        fn()
      } catch {
        // best-effort
      }
    }
  }

  ipcMain.handle(
    "browser:register",
    (_event: IpcMainInvokeEvent, paneId: string, webContentsId: number) => {
      try {
        const handle = registry.register(paneId, webContentsId)
        // Wire any subscribers that arrived before the register IPC.
        drainPending(paneId)
        return { ok: true as const, webContentsId: handle.webContentsId }
      } catch (err) {
        return { ok: false as const, error: String(err instanceof Error ? err.message : err) }
      }
    },
  )

  ipcMain.handle("browser:unregister", (_event: IpcMainInvokeEvent, paneId: string) => {
    registry.unregister(paneId)
    pendingAttach.delete(paneId)
    return { ok: true as const }
  })

  ipcMain.handle(
    "browser:navigate",
    async (_event: IpcMainInvokeEvent, paneId: string, url: string) => {
      const handle = registry.get(paneId)
      if (!handle) {
        return { ok: false as const, error: `no browser pane registered for ${paneId}` }
      }
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { ok: false as const, error: `scheme ${parsed.protocol} not allowed` }
        }
      } catch {
        return { ok: false as const, error: `invalid url: ${url}` }
      }
      try {
        await handle.navigate(url)
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, error: String(err instanceof Error ? err.message : err) }
      }
    },
  )

  ipcMain.handle(
    "browser:getConsoleLogs",
    (_event: IpcMainInvokeEvent, paneId: string, q: BrowserConsoleQuery | undefined) => {
      const handle = registry.get(paneId)
      if (!handle) return [] as BrowserConsoleEntry[]
      return handle.getConsoleLogs(q ?? {}) as BrowserConsoleEntry[]
    },
  )

  const consoleSubs = new Map<string, () => void>()
  const subKey = (paneId: string, senderId: number) => `${senderId}:${paneId}`

  const attachConsoleSubscriber = (event: IpcMainInvokeEvent, paneId: string) => {
    const handle = registry.get(paneId)
    if (!handle) return false
    const key = subKey(paneId, event.sender.id)
    if (consoleSubs.has(key)) return true
    const unsubscribe = handle.onConsoleEntry((entry) => {
      if (event.sender.isDestroyed()) return
      event.sender.send(`browser:onConsoleEntry:${paneId}`, entry)
    })
    consoleSubs.set(key, unsubscribe)
    const cleanup = () => {
      const fn = consoleSubs.get(key)
      if (fn) {
        try {
          fn()
        } catch {}
        consoleSubs.delete(key)
      }
    }
    event.sender.once("destroyed", cleanup)
    return true
  }

  ipcMain.handle("browser:subscribeConsole", (event: IpcMainInvokeEvent, paneId: string) => {
    if (attachConsoleSubscriber(event, paneId)) return { ok: true as const }
    // Handle isn't registered yet — defer until register IPC drains us.
    queueAttach(paneId, () => attachConsoleSubscriber(event, paneId))
    return { ok: true as const, deferred: true as const }
  })

  ipcMain.handle("browser:unsubscribeConsole", (event: IpcMainInvokeEvent, paneId: string) => {
    const key = subKey(paneId, event.sender.id)
    const fn = consoleSubs.get(key)
    if (fn) {
      try {
        fn()
      } catch {}
      consoleSubs.delete(key)
    }
    return { ok: true as const }
  })

  ipcMain.handle(
    "browser:captureScreenshot",
    async (_event: IpcMainInvokeEvent, paneId: string, opts: { clip?: BrowserScreenshotClip } | undefined) => {
      const handle = registry.get(paneId)
      if (!handle) return { ok: false as const, error: { code: "no-pane" as const, message: `no browser pane registered for ${paneId}` } }
      return handle.screenshot(opts ?? {})
    },
  )

  ipcMain.handle("browser:evaluate", async (_event: IpcMainInvokeEvent, paneId: string, expression: string) => {
    const handle = registry.get(paneId)
    if (!handle) return { ok: false as const, error: { code: "no-pane" as const, message: `no browser pane registered for ${paneId}` } }
    return handle.evaluate(expression)
  })

  ipcMain.handle("browser:setAgentAllowed", (_event: IpcMainInvokeEvent, paneId: string, allowed: boolean) => {
    const handle = registry.get(paneId)
    if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
    handle.setAgentAllowed(Boolean(allowed))
    return { ok: true as const }
  })

  ipcMain.handle("browser:setInspectMode", async (_event: IpcMainInvokeEvent, paneId: string, enabled: boolean) => {
    const handle = registry.get(paneId)
    if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
    return handle.setInspectMode(Boolean(enabled))
  })

  const nodeSubs = new Map<string, () => void>()
  const nodeKey = (paneId: string, senderId: number) => `${senderId}:${paneId}`

  const attachNodeSelectedSubscriber = (event: IpcMainInvokeEvent, paneId: string) => {
    const handle = registry.get(paneId)
    if (!handle) return false
    const key = nodeKey(paneId, event.sender.id)
    if (nodeSubs.has(key)) return true
    const unsubscribe = handle.onNodeSelected((payload) => {
      if (event.sender.isDestroyed()) return
      event.sender.send(`browser:onNodeSelected:${paneId}`, payload as BrowserNodeSelectedPayload)
    })
    nodeSubs.set(key, unsubscribe)
    const cleanup = () => {
      const fn = nodeSubs.get(key)
      if (fn) {
        try {
          fn()
        } catch {}
        nodeSubs.delete(key)
      }
    }
    event.sender.once("destroyed", cleanup)
    return true
  }

  ipcMain.handle("browser:subscribeNodeSelected", (event: IpcMainInvokeEvent, paneId: string) => {
    if (attachNodeSelectedSubscriber(event, paneId)) return { ok: true as const }
    queueAttach(paneId, () => attachNodeSelectedSubscriber(event, paneId))
    return { ok: true as const, deferred: true as const }
  })

  ipcMain.handle("browser:unsubscribeNodeSelected", (event: IpcMainInvokeEvent, paneId: string) => {
    const key = nodeKey(paneId, event.sender.id)
    const fn = nodeSubs.get(key)
    if (fn) {
      try {
        fn()
      } catch {}
      nodeSubs.delete(key)
    }
    return { ok: true as const }
  })

  ipcMain.handle("browser:getNavigationState", (_event: IpcMainInvokeEvent, paneId: string) => {
    const handle = registry.get(paneId)
    if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
    const state = handle.getNavigationState()
    return { ok: true as const, ...state }
  })

  ipcMain.handle("browser:goBack", (_event: IpcMainInvokeEvent, paneId: string) => {
    const handle = registry.get(paneId)
    if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
    return handle.goBack()
  })

  ipcMain.handle("browser:goForward", (_event: IpcMainInvokeEvent, paneId: string) => {
    const handle = registry.get(paneId)
    if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
    return handle.goForward()
  })

  ipcMain.handle("browser:reload", (_event: IpcMainInvokeEvent, paneId: string, hard?: boolean) => {
    const handle = registry.get(paneId)
    if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
    return handle.reload(Boolean(hard))
  })

  ipcMain.handle("browser:openDevTools", (_event: IpcMainInvokeEvent, paneId: string) => {
    const handle = registry.get(paneId)
    if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
    return handle.openDevTools("detach")
  })

  ipcMain.handle(
    "browser:clearStorage",
    async (
      _event: IpcMainInvokeEvent,
      paneId: string,
      storages?: Array<"cookies" | "localstorage" | "indexdb" | "cachestorage" | "serviceworkers">,
    ) => {
      const handle = registry.get(paneId)
      if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
      return handle.clearStorage(storages)
    },
  )
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}

export function wireFullscreenEvents(win: BrowserWindow) {
  const send = (fs: boolean) => {
    if (!win.isDestroyed()) win.webContents.send("fullscreen-change", fs)
  }
  win.on("enter-full-screen", () => send(true))
  win.on("leave-full-screen", () => send(false))
}
