import { execFile } from "node:child_process"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import type {
  BrowserConsoleEntry,
  BrowserConsoleQuery,
  BrowserNodeSelectedPayload,
  BrowserScreenshotClip,
} from "../preload/types"
import type { BrowserRegistry } from "./browser/registry"
import { getStore } from "./store"

type Deps = {
  killSidecar: () => void
  installCli: () => Promise<string>
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  /** Optional; only provided when the browser-tab feature flag is set. */
  browser?: BrowserRegistry
}

export function registerIpcHandlers(deps: Deps) {
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("install-cli", () => deps.installCli())
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
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
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

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
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

  ipcMain.on("relaunch", () => {
    app.relaunch()
    app.exit(0)
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
}

function registerBrowserIpcHandlers(registry: BrowserRegistry | undefined) {
  // `browser:enabled` is safe to expose unconditionally — tells the renderer
  // whether the bridge will actually do anything.
  ipcMain.handle("browser:enabled", () => Boolean(registry))

  if (!registry) return

  ipcMain.handle(
    "browser:register",
    (_event: IpcMainInvokeEvent, paneId: string, webContentsId: number) => {
      try {
        const handle = registry.register(paneId, webContentsId)
        return { ok: true as const, webContentsId: handle.webContentsId }
      } catch (err) {
        return { ok: false as const, error: String(err instanceof Error ? err.message : err) }
      }
    },
  )

  ipcMain.handle("browser:unregister", (_event: IpcMainInvokeEvent, paneId: string) => {
    registry.unregister(paneId)
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

  // Per-renderer console subscriptions. Keyed on (paneId + sender.id) so
  // multiple windows / drawers can subscribe to the same pane independently.
  const consoleSubs = new Map<string, () => void>()
  const subKey = (paneId: string, senderId: number) => `${senderId}:${paneId}`

  ipcMain.handle(
    "browser:subscribeConsole",
    (event: IpcMainInvokeEvent, paneId: string) => {
      const handle = registry.get(paneId)
      if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
      const key = subKey(paneId, event.sender.id)
      const existing = consoleSubs.get(key)
      if (existing) return { ok: true as const }
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
          } catch {
            // ignore
          }
          consoleSubs.delete(key)
        }
      }
      event.sender.once("destroyed", cleanup)
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    "browser:unsubscribeConsole",
    (event: IpcMainInvokeEvent, paneId: string) => {
      const key = subKey(paneId, event.sender.id)
      const fn = consoleSubs.get(key)
      if (fn) {
        try {
          fn()
        } catch {
          // ignore
        }
        consoleSubs.delete(key)
      }
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    "browser:captureScreenshot",
    async (_event: IpcMainInvokeEvent, paneId: string, opts: { clip?: BrowserScreenshotClip } | undefined) => {
      const handle = registry.get(paneId)
      if (!handle) return { ok: false as const, error: { code: "no-pane" as const, message: `no browser pane registered for ${paneId}` } }
      return handle.screenshot(opts ?? {})
    },
  )

  ipcMain.handle(
    "browser:evaluate",
    async (_event: IpcMainInvokeEvent, paneId: string, expression: string) => {
      const handle = registry.get(paneId)
      if (!handle) return { ok: false as const, error: { code: "no-pane" as const, message: `no browser pane registered for ${paneId}` } }
      return handle.evaluate(expression)
    },
  )

  ipcMain.handle(
    "browser:setAgentAllowed",
    (_event: IpcMainInvokeEvent, paneId: string, allowed: boolean) => {
      const handle = registry.get(paneId)
      if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
      handle.setAgentAllowed(Boolean(allowed))
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    "browser:setInspectMode",
    async (_event: IpcMainInvokeEvent, paneId: string, enabled: boolean) => {
      const handle = registry.get(paneId)
      if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
      return handle.setInspectMode(Boolean(enabled))
    },
  )

  // Per-renderer node-selected subscriptions. Keyed on (paneId + sender.id)
  // so multiple listeners per pane per window don't clash.
  const nodeSubs = new Map<string, () => void>()
  const nodeKey = (paneId: string, senderId: number) => `${senderId}:${paneId}`

  ipcMain.handle(
    "browser:subscribeNodeSelected",
    (event: IpcMainInvokeEvent, paneId: string) => {
      const handle = registry.get(paneId)
      if (!handle) return { ok: false as const, error: `no browser pane registered for ${paneId}` }
      const key = nodeKey(paneId, event.sender.id)
      if (nodeSubs.has(key)) return { ok: true as const }
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
          } catch {
            // ignore
          }
          nodeSubs.delete(key)
        }
      }
      event.sender.once("destroyed", cleanup)
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    "browser:unsubscribeNodeSelected",
    (event: IpcMainInvokeEvent, paneId: string) => {
      const key = nodeKey(paneId, event.sender.id)
      const fn = nodeSubs.get(key)
      if (fn) {
        try {
          fn()
        } catch {
          // ignore
        }
        nodeSubs.delete(key)
      }
      return { ok: true as const }
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
