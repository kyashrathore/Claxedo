import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Event } from "electron"
import { app, type BrowserWindow, dialog } from "electron"
import pkg from "electron-updater"

const APP_NAMES: Record<string, string> = {
  dev: "Claxedo Dev",
  beta: "Claxedo Beta",
  prod: "Claxedo",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.claxedo.desktop.dev",
  beta: "ai.claxedo.desktop.beta",
  prod: "ai.claxedo.desktop",
}
app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Claxedo Dev")
app.setPath(
  "userData",
  process.env.CLAXEDO_DESKTOP_USER_DATA_DIR ??
    join(app.getPath("appData"), app.isPackaged ? APP_IDS[CHANNEL] : "ai.claxedo.desktop.dev"),
)
const { autoUpdater } = pkg

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import type { BrowserRegistry } from "./browser/registry"
import { setupBrowserTab } from "./browser/setup"
import type { CommandChild } from "./cli"
import { installCli, syncCli } from "./cli"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress, wireFullscreenEvents } from "./ipc"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  checkHealth,
  checkHealthOrAskRetry,
  getDefaultServerUrl,
  getSavedServerUrl,
  getWslConfig,
  setDefaultServerUrl,
  setWslConfig,
  spawnLocalServer,
} from "./server"
import { createLoadingWindow, createMainWindow, setDockIcon } from "./windows"

type ServerConnection =
  | { variant: "existing"; url: string }
  | {
      variant: "cli"
      url: string
      password: null | string
      health: {
        wait: Promise<void>
      }
      events: any
    }

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
const loadingWindow: BrowserWindow | null = null
let sidecar: CommandChild | null = null
let claxedoServerHandle: { close: () => void } | null = null
let local: { url: string; password: string } | null = null
let quitting = false
const loadingComplete = defer<void>()

const browserTabSetup = setupBrowserTab()
const browserRegistry: BrowserRegistry | undefined = browserTabSetup?.registry
const browserBridgePromise = browserTabSetup?.bridge

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const logger = initLogging()

logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
})

setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("claxedo://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", (event: Event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void shutdown().finally(() => app.quit())
  })

  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("claxedo")
    setDockIcon()
    setupAutoUpdater()
    syncCli()
    await initialize()
  })
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function focusMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

/** Directory containing the compiled main process JS (out/main/ or asar equivalent). */
const MAIN_DIR = import.meta.dirname

function getClaxedoServerPath(): string {
  return app.isPackaged
    ? join(MAIN_DIR, "claxedo-server.js")
    : join(MAIN_DIR, "../../resources/claxedo-server.js")
}

async function startClaxedoServer(opencodeUrl: string, opencodePassword?: string | null): Promise<{ url: string }> {
  const claxedoPort = await getFreePort()
  const serverPath = getClaxedoServerPath()
  logger.log("starting claxedo-server", { serverPath, claxedoPort, opencodeUrl })

  if (!existsSync(serverPath)) {
    logger.warn("claxedo-server.js not found, skipping", { serverPath })
    return { url: opencodeUrl }
  }

  const acpDir = app.isPackaged
    ? join(process.resourcesPath, "acp")
    : join(MAIN_DIR, "../../resources/acp")

  if (existsSync(acpDir)) {
    process.env.CLAXEDO_ACP_DIR = acpDir

    // claude-agent-acp spawns a Claude Code CLI subprocess for queries
    if (!process.env.CLAUDE_CODE_EXECUTABLE) {
      const cliPath = join(acpDir, "claude-cli.js")
      if (existsSync(cliPath)) {
        process.env.CLAUDE_CODE_EXECUTABLE = cliPath
      }
    }
  }

  try {
    const module = await import(pathToFileURL(serverPath).href)
    claxedoServerHandle = module.startServer(claxedoPort, opencodeUrl, opencodePassword)

    const claxedoUrl = `http://127.0.0.1:${claxedoPort}`
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        const res = await fetch(`${claxedoUrl}/api/claxedo/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) {
          logger.log("claxedo-server healthy", { url: claxedoUrl })
          return { url: claxedoUrl }
        }
      } catch {}
    }

    logger.warn("claxedo-server health check timed out, falling back to opencode")
    return { url: opencodeUrl }
  } catch (err) {
    logger.error("claxedo-server failed to start", { error: String(err) })
    return { url: opencodeUrl }
  }
}

async function setupServerConnection(): Promise<ServerConnection> {
  if (!app.isPackaged) {
    const candidates = [process.env.CLAXEDO_SERVER_URL, "http://127.0.0.1:3001"].filter(Boolean) as string[]
    const results = await Promise.all(candidates.map(async (url) => ({ url, ok: await checkHealth(url) })))
    const hit = results.find((r) => r.ok)
    if (hit) {
      logger.log("dev: using claxedo-server", { url: hit.url })
      local = null
      serverReady.resolve({ url: hit.url, password: null })
      return { variant: "existing", url: hit.url }
    }
    logger.log("dev: claxedo-server not found, falling back to sidecar")
  }

  const customUrl = await getSavedServerUrl()

  if (customUrl && (await checkHealthOrAskRetry(customUrl))) {
    local = null
    serverReady.resolve({ url: customUrl, password: null })
    return { variant: "existing", url: customUrl }
  }

  const port = await getSidecarPort()
  const hostname = "127.0.0.1"
  const localUrl = `http://${hostname}:${port}`

  if (await checkHealth(localUrl)) {
    local = null
    serverReady.resolve({ url: localUrl, password: null })
    return { variant: "existing", url: localUrl }
  }

  const password = randomUUID()
  const { child, health, events } = spawnLocalServer(hostname, port, password)
  sidecar = child
  local = { url: localUrl, password }

  return {
    variant: "cli",
    url: localUrl,
    password,
    health,
    events,
  }
}

async function initialize() {
  const needsMigration = !sqliteFileExists()
  const sqliteDone = needsMigration ? defer<void>() : undefined

  const loadingTask = (async () => {
    logger.log("setting up server connection")
    const serverConnection = await setupServerConnection()
    logger.log("server connection ready", {
      variant: serverConnection.variant,
      url: serverConnection.url,
    })

    if (serverConnection.variant === "cli") {
      const { events, health } = serverConnection

      // Register sqlite listener BEFORE awaiting to avoid deadlock
      events.on("sqlite", (progress: SqliteMigrationProgress) => {
        setInitStep({ phase: "sqlite_waiting" })
        if (loadingWindow) sendSqliteMigrationProgress(loadingWindow, progress)
        if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
        if (progress.type === "Done") sqliteDone?.resolve()
      })

      logger.log("server connection started")

      // Server becoming healthy also means migration is complete (or wasn't needed)
      const healthDone = health.wait.then(
        async () => {
          sqliteDone?.resolve()
          // Start claxedo-server on top of the healthy opencode sidecar
          const { url: claxedoUrl } = await startClaxedoServer(serverConnection.url, serverConnection.password)
          serverReady.resolve({
            url: claxedoUrl,
            password: serverConnection.password,
          })
        },
        (err) => {
          sqliteDone?.reject(err instanceof Error ? err : new Error(String(err)))
          throw err
        },
      )

      if (needsMigration) await sqliteDone?.promise
      await healthDone
    } else {
      logger.log("server connection started")
      serverReady.resolve({ url: serverConnection.url, password: null })
    }

    logger.log("loading task finished")
  })()

  const globals = {
    updaterEnabled: UPDATER_ENABLED,
    wsl: getWslConfig().enabled,
    deepLinks: pendingDeepLinks,
  }

  const loadingWindow = await (async () => {
    if (needsMigration) {
      const loadingWindow = createLoadingWindow(globals)
      await delay(1000)
      return loadingWindow
    } else {
      logger.log("showing main window without loading window")
      mainWindow = createMainWindow(globals)
      wireFullscreenEvents(mainWindow)
      wireMenu()
    }
  })()

  await loadingTask
  setInitStep({ phase: "done" })

  if (loadingWindow) {
    await loadingComplete.promise
  }

  if (!mainWindow) {
    mainWindow = createMainWindow(globals)
    wireFullscreenEvents(mainWindow)
    wireMenu()
  }

  loadingWindow?.close()
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    installCli: () => {
      void installCli()
    },
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      app.relaunch()
      app.quit()
    },
  })
}

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  installCli: async () => installCli(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const res = await serverReady.promise
      logger.log("server ready", { url: res.url })
      return res
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config: WslConfig) => setWslConfig(config),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  browser: browserRegistry,
})

if (browserTabSetup) {
  logger.log("browser-tab feature enabled", { partition: browserTabSetup.partition })
}

function killSidecar() {
  if (!sidecar) return
  sidecar.kill()
  sidecar = null
  local = null
}

async function shutdown() {
  await disposeSidecar()
  killSidecar()
  if (claxedoServerHandle) {
    claxedoServerHandle.close()
    claxedoServerHandle = null
  }
  if (browserBridgePromise) {
    try {
      const bridge = await browserBridgePromise
      await bridge.close()
    } catch (err) {
      logger.warn("failed to close browser bridge on shutdown", { error: err })
    }
  }
}

async function disposeSidecar() {
  if (!sidecar || !local) return
  const headers = new Headers()
  const auth = Buffer.from(`opencode:${local.password}`).toString("base64")
  headers.set("authorization", `Basic ${auth}`)
  try {
    await fetch(new URL("/global/dispose", local.url), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(1500),
    })
  } catch (err) {
    logger.warn("failed to dispose sidecar before quit", { error: err })
  }
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

async function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", "opencode.db"))
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })
}

let updateReady = false

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  updateReady = false
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
  })
  try {
    const result = await autoUpdater.checkForUpdates()
    const updateInfo = result?.updateInfo
    logger.log("update metadata fetched", {
      releaseVersion: updateInfo?.version ?? null,
      releaseDate: updateInfo?.releaseDate ?? null,
      releaseName: updateInfo?.releaseName ?? null,
      files: updateInfo?.files?.map((file) => file.url) ?? [],
    })
    const version = result?.updateInfo?.version
    if (result?.isUpdateAvailable === false || !version) {
      logger.log("no update available", {
        reason: "provider returned no newer version",
      })
      return { updateAvailable: false }
    }
    logger.log("update available", { version })
    await autoUpdater.downloadUpdate()
    logger.log("update download completed", { version })
    updateReady = true
    return { updateAvailable: true, version }
  } catch (error) {
    logger.error("update check failed", error)
    return { updateAvailable: false, failed: true }
  }
}

async function installUpdate() {
  if (!updateReady) return
  killSidecar()
  autoUpdater.quitAndInstall()
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate()
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
