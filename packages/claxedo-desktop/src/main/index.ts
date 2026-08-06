import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import { existsSync, renameSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Event, MessageBoxOptions } from "electron"
import { app, BrowserWindow, dialog, session, utilityProcess } from "electron"
import { trustMainRendererOrigin } from "./renderer-origin"
import pkg from "electron-updater"
import treeKill from "tree-kill"
import { installDesktopTelemetry } from "./telemetry"
import { reportInstall } from "./install-telemetry"

// Registered before every other line in this file (including the app.setName
// / app.setPath calls immediately below): once a listener exists here,
// Electron/Node's default uncaughtException behavior is disabled, so this
// module's handler becomes the only thing standing between a thrown error
// and a desktop app that hangs instead of failing fast.
const telemetryClient = installDesktopTelemetry()

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
app.setName(IS_PACKAGED ? APP_NAMES[CHANNEL] : "Claxedo Dev")
app.setPath(
  "userData",
  process.env.CLAXEDO_DESKTOP_USER_DATA_DIR ??
    join(app.getPath("appData"), IS_PACKAGED ? APP_IDS[CHANNEL] : "ai.claxedo.desktop.dev"),
)
// Deliberately AFTER app.setPath("userData", …) above: the once-only marker
// lives in userData, so reporting any earlier would write it to Electron's
// default path and re-report on the next launch from the real one. Not awaited
// — startup never blocks on telemetry, and reportInstall swallows its own
// failures.
void reportInstall(telemetryClient, {
  userDataDir: app.getPath("userData"),
  appVersion: app.getVersion(),
  channel: CHANNEL,
})

const { autoUpdater } = pkg

import type { InitStep, ServerReadyData, WslConfig } from "../preload/types"
import { ensureAgentPath } from "./agent-path"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { resolveSystemClaude } from "./claude-executable"
import { loadServerEnvForDevelopment, resolveDesktopServerDataDir } from "./server-env"
import type { BrowserRegistry } from "./browser/registry"
import { setupBrowserTab } from "./browser/setup"
import { CHANNEL, IS_PACKAGED, UPDATER_ENABLED } from "./constants"
import { findFreePort, resolveBaseServerPort } from "./server-port"
import { runRestart } from "../shared/restart-policy"
import type { DiagnosticsWebContents } from "./diagnostics/ipc"
import { createElectronSource } from "./diagnostics/electron-source"
import { createProcessMetricsSource } from "./diagnostics/process-metrics-source"
import { createProfiler } from "./diagnostics/profiler"
import { createSessionMemoryScanner } from "./diagnostics/session-memory-worker"
import { createOwnerOperationBridge } from "./diagnostics/owner-operation-bridge"
import { createWindowsWslCollector, createWslSource } from "./diagnostics/wsl-source"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, wireFullscreenEvents } from "./ipc"
import { initLogging } from "./logging"
import { createMenu } from "./menu"
import {
  checkHealth,
  checkHealthOrAskRetry,
  getDefaultServerUrl,
  getSavedServerUrl,
  getWslConfig,
  setDefaultServerUrl,
  setWslConfig,
} from "./server"
import {
  createLoadingWindow,
  createMainWindow,
  isTrustedMainRendererUrl,
  loadMainWindow,
  setDockIcon,
} from "./windows"
import { createStartAtLogin } from "./start-at-login"
import {
  matchesDiagnosticsBinding,
  parseDiagnosticsTransportMessage,
} from "../shared/diagnostics-transport"

type ServerConnection =
  | { variant: "existing"; url: string }
  | { variant: "embedded"; url: string }

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let claxedoServerHandle: { close: () => Promise<void> } | null = null
let quitting = false
const loadingComplete = defer<void>()

const browserTabSetup = setupBrowserTab()
const browserRegistry: BrowserRegistry | undefined = browserTabSetup?.registry
const browserBridgePromise = browserTabSetup?.bridge

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const logger = initLogging()
const startAtLogin = createStartAtLogin(app)
const electronDiagnosticsSource = createElectronSource({
  process,
  isReady: () => app.isReady(),
  getAppMetrics: () => app.getAppMetrics(),
  getWindows: () => BrowserWindow.getAllWindows(),
})
const diagnosticsSource = createProcessMetricsSource({
  electron: electronDiagnosticsSource,
  workerPath: join(import.meta.dirname, "process-metrics-worker.js"),
  wsl: createWslSource({
    enabled: process.platform === "win32" && getWslConfig().enabled,
    ...(process.platform === "win32" ? { collect: createWindowsWslCollector() } : {}),
  }),
})
const diagnosticsProfiler = createProfiler({ source: diagnosticsSource })
const scanSessionMemory = createSessionMemoryScanner({
  workerPath: join(import.meta.dirname, "session-memory-worker.js"),
  paths: {
    codexHome: process.env.CODEX_HOME ?? join(app.getPath("home"), ".codex"),
    claudeHome: process.env.CLAUDE_CONFIG_DIR ?? join(app.getPath("home"), ".claude"),
    databases: [
      ...(["prod", "beta", "dev"] as const).map((channel) => ({
        path: join(resolveDesktopServerDataDir({ channel, home: app.getPath("home") }), "opencode-engine", "opencode.db"),
        profile: channel,
      })),
      ...(process.env.CLAXEDO_DATA_DIR
        ? [{ path: join(process.env.CLAXEDO_DATA_DIR, "opencode-engine", "opencode.db"), profile: "configured" }]
        : []),
    ].filter((database, index, all) => all.findIndex((candidate) => candidate.path === database.path) === index),
  },
})
const diagnosticsSmokeFixtures = createPackagedDiagnosticsFixtures()

logger.log("app starting", {
  version: app.getVersion(),
  packaged: IS_PACKAGED,
})
watchProcessMainLoopPerformance()

setupApp()

function watchProcessMainLoopPerformance() {
  if (!process.env.CLAXEDO_PERF_READY_SELECTOR) return

  const intervalMs = 16
  let previous = performance.now()
  setInterval(() => {
    const now = performance.now()
    const gap = Math.round(now - previous - intervalMs)
    previous = now
    if (gap < 100) return
    logger.warn(`[startup-perf] main-loop gap=${String(gap)}ms`)
  }, intervalMs).unref()
}

function setupApp() {
  ensureLoopbackNoProxy()
  ensureAgentPath()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  if (!IS_PACKAGED) app.commandLine.appendSwitch("disable-http-cache")
  process.once("SIGINT", () => app.quit())
  process.once("SIGTERM", () => app.quit())

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  cleanupLegacyDevCaches()

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
    diagnosticsProfiler.requestSample("lifecycle")
    app.setAsDefaultProtocolClient("claxedo")
    setDockIcon()
    setupAutoUpdater()
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
  return IS_PACKAGED
    ? join(MAIN_DIR, "claxedo-server/index.js")
    : join(MAIN_DIR, "../../resources/claxedo-server/index.js")
}

// The claxedo-server bundle externalizes `opencode/node-embed` (see
// scripts/bundle-claxedo-server.ts), and the bundled chunk cannot resolve the
// bare "opencode" specifier from its resources/ location — no node_modules up
// that tree is guaranteed to contain it. Hand the artifact location to the
// utility process explicitly.
function getOpenCodeEmbedPath(): string {
  return IS_PACKAGED
    ? join(process.resourcesPath, "opencode-engine", "node.js")
    : join(MAIN_DIR, "../../../opencode/dist/node/node.js")
}

async function startClaxedoServer(): Promise<{ url: string }> {
  const claxedoPort = await findFreePort(resolveBaseServerPort())
  const serverPath = getClaxedoServerPath()
  const openCodeEmbedPath = getOpenCodeEmbedPath()
  logger.log("starting claxedo-server with embedded OpenCode", { serverPath, claxedoPort, openCodeEmbedPath })

  if (!existsSync(serverPath)) {
    throw new Error(`Claxedo server bundle was not found at ${serverPath}. Rebuild the desktop app and try again.`)
  }
  if (!existsSync(openCodeEmbedPath)) {
    throw new Error(`OpenCode engine artifact was not found at ${openCodeEmbedPath}. Rebuild the desktop app and try again.`)
  }

  const acpDir = IS_PACKAGED
    ? join(process.resourcesPath, "acp")
    : join(MAIN_DIR, "../../resources/acp")

  // Development resolves the workspace's live ACP package dependencies. Only
  // packaged builds need the copied, self-contained adapter resources.
  if (IS_PACKAGED && existsSync(acpDir)) {
    process.env.CLAXEDO_ACP_DIR = acpDir
  }

  // Both Claude paths spawn the user's installed Claude Code CLI, never a
  // bundled binary: the native SDK harness via pathToClaudeCodeExecutable and
  // the ACP adapter via CLAUDE_CODE_EXECUTABLE. Resolve it once here so a
  // GUI-trimmed PATH still finds a standard install.
  if (!process.env.CLAUDE_CODE_EXECUTABLE) {
    const claude = resolveSystemClaude()
    if (claude) process.env.CLAUDE_CODE_EXECUTABLE = claude
    else logger.warn("Claude Code CLI not found; Claude harnesses need `claude` installed and on PATH")
  }

  if (!IS_PACKAGED) {
    try {
      loadServerEnvForDevelopment({
        repoRoot: join(MAIN_DIR, "../../../.."),
        log: (message) => logger.log(`server env: ${message}`),
      })
    } catch (err) {
      logger.warn("failed to load the server .env", { error: String(err) })
    }
  }

  const serverDataDir = resolveDesktopServerDataDir({
    channel: CHANNEL,
    home: app.getPath("home"),
    configured: process.env.CLAXEDO_DATA_DIR,
  })

  try {
    const serverLaunchId = `claxedo-server-${crypto.randomUUID()}`
    const serverGeneration = `server-generation-${crypto.randomUUID()}`
    const child = utilityProcess.fork(serverPath, [], {
      execArgv: ["--expose-gc"],
      stdio: "inherit",
      serviceName: "Claxedo Server",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        CLAXEDO_CHILD_PORT: String(claxedoPort),
        CLAXEDO_DATA_DIR: serverDataDir,
        CLAXEDO_DESKTOP_PARENT_PID: String(process.pid),
        CLAXEDO_CHILD_OPENCODE_EMBED_PATH: openCodeEmbedPath,
        CLAXEDO_DIAGNOSTICS_LAUNCH_ID: serverLaunchId,
        CLAXEDO_DIAGNOSTICS_GENERATION: serverGeneration,
      },
    })
    let ownerBridge: ReturnType<typeof createOwnerOperationBridge> | undefined
    const connectOwnerBridge = () => {
      if (!child.pid || ownerBridge) return
      ownerBridge = createOwnerOperationBridge({
          binding: {
            pid: child.pid,
            launchId: serverLaunchId,
            generation: serverGeneration,
          },
          send: (message) => {
            child.postMessage(message)
            return true
          },
        })
    }
    child.on("spawn", connectOwnerBridge)
    child.on("message", (input) => {
      connectOwnerBridge()
      if (!child.pid || !ownerBridge) return
      const binding = {
        pid: child.pid,
        launchId: serverLaunchId,
        generation: serverGeneration,
      }
      if (ownerBridge.onMessage(input)) return
      const parsed = parseDiagnosticsTransportMessage(input)
      if (!parsed.success || !matchesDiagnosticsBinding(parsed.data.binding, binding)) return
      if (
        parsed.data.type !== "owner-registered" &&
        parsed.data.type !== "owner-updated" &&
        parsed.data.type !== "owner-exited"
      ) return
      diagnosticsProfiler.recordOwnerEvent(
        parsed.data,
        parsed.data.type === "owner-registered"
          ? ownerBridge.operationFor(parsed.data.descriptor)
          : undefined,
      )
    })
    connectOwnerBridge()
    diagnosticsProfiler.registerUtilityProcess(child, {
      launchId: serverLaunchId,
      ownerId: "owner-claxedo-server",
      ownerKind: "server",
      role: "server",
      label: "Claxedo server",
    })
    const exited = defer<number>()
    const handle = {
      close: async () => {
        if (!child.pid) return
        child.kill()
        const stopped = await Promise.race([
          exited.promise.then(() => true),
          delay(2_000).then(() => false),
        ])
        if (stopped) return
        if (child.pid) await killProcessTree(child.pid, "SIGKILL")
        await Promise.race([exited.promise, delay(500)])
      },
    }
    claxedoServerHandle = handle
    child.once("exit", (code) => {
      ownerBridge?.dispose()
      exited.resolve(code)
      if (claxedoServerHandle === handle) claxedoServerHandle = null
      if (!quitting && code !== 0) logger.error("claxedo-server utility process exited", { code })
    })

    const claxedoUrl = `http://127.0.0.1:${claxedoPort}`
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        const res = await fetch(`${claxedoUrl}/api/claxedo/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) {
          logger.log("claxedo-server healthy", { url: claxedoUrl })
          diagnosticsProfiler.recordLifecycle({
            event: "server-ready",
            ownerId: "owner-claxedo-server",
          })
          return { url: claxedoUrl }
        }
      } catch {}
    }

    logger.warn("embedded server readiness check failed")
    await handle.close()
    throw new Error("The embedded Claxedo server did not become healthy in time.")
  } catch (err) {
    logger.error("claxedo-server failed to start", { error: String(err) })
    throw err
  }
}

async function setupServerConnection(): Promise<ServerConnection> {
  if (!IS_PACKAGED) {
    // Probe the SAME port the embedded server would claim. This was hardcoded
    // to 3001 while `startClaxedoServer` honours CLAXEDO_SERVER_PORT, so the
    // env var moved the embedded server but not the probe — leaving no way to
    // run an isolated dev server. Two checkouts of the repo (say a worktree and
    // the main tree) both defaulted to the same base port, so whichever started
    // second silently attached to the FIRST one's server: its PTYs, its
    // workspace-runtime code. A renderer change appears to work while the
    // server half of the same change never runs, and quitting one app leaves
    // the other's PTYs alive. Set CLAXEDO_SERVER_PORT to get a private server.
    //
    // This probe is also why the base port must not be a popular default: a hit
    // here is adopted as "our server", so any unrelated project listening on it
    // would be handed the session. See DEFAULT_CLAXEDO_SERVER_PORT.
    const devPort = resolveBaseServerPort()
    const candidates = [process.env.CLAXEDO_SERVER_URL, `http://127.0.0.1:${devPort}`].filter(Boolean) as string[]
    const results = await Promise.all(candidates.map(async (url) => ({ url, ok: await checkHealth(url) })))
    const hit = results.find((r) => r.ok)
    if (hit) {
      logger.log("dev: using claxedo-server", { url: hit.url })
      return { variant: "existing", url: hit.url }
    }
    logger.log("dev: claxedo-server not found, starting the embedded server")
  }

  const customUrl = await getSavedServerUrl()

  if (customUrl && (await checkHealthOrAskRetry(customUrl))) {
    return { variant: "existing", url: customUrl }
  }

  return { variant: "embedded", ...(await startClaxedoServer()) }
}

async function initialize() {
  const needsMigration = !sqliteFileExists()

  const loadingTask = (async () => {
    try {
      logger.log("setting up server connection")
      const serverConnection = await setupServerConnection()
      logger.log("server connection ready", {
        variant: serverConnection.variant,
        url: serverConnection.url,
      })

      // Must run before the renderer opens any socket to this server: the
      // file:// document sends `Origin: file://` on every WebSocket handshake,
      // which the server's loopback gate rejects with 403. See renderer-origin.ts.
      trustMainRendererOrigin({
        serverUrl: serverConnection.url,
        onBeforeSendHeaders: (filter, listener) =>
          session.defaultSession.webRequest.onBeforeSendHeaders(filter, listener),
      })

      logger.log("server connection started")
      serverReady.resolve({ url: serverConnection.url, password: null })

      logger.log("loading task finished")
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      serverReady.reject(error)
      throw error
    }
  })()

  const globals = {
    updaterEnabled: UPDATER_ENABLED,
    packaged: IS_PACKAGED,
    wsl: getWslConfig().enabled,
    deepLinks: pendingDeepLinks,
    ...(process.env.CLAXEDO_PERF_STAGE ? { startupIsolationStage: process.env.CLAXEDO_PERF_STAGE } : {}),
  }

  // Keep renderer compilation out of the embedded-server startup window.
  // A deferred, native-backed window stays responsive without booting another
  // renderer; migrations retain the progress UI because they can take longer.
  const startupWindow = needsMigration ? createLoadingWindow(globals) : undefined
  if (startupWindow) {
    await delay(1000)
  } else {
    logger.log("showing deferred main window")
    mainWindow = createMainWindow(globals, { deferLoad: true })
    registerDiagnosticsWindow(mainWindow)
    wireFullscreenEvents(mainWindow)
    wireMenu()
  }

  try {
    await loadingTask
  } catch (error) {
    logger.error("embedded server initialization failed", { error: String(error) })
    setInitStep({ phase: "done" })
    showMainWindow(globals)
    startupWindow?.close()
    return
  }
  setInitStep({ phase: "done" })

  if (startupWindow) await loadingComplete.promise

  showMainWindow(globals)
  startupWindow?.close()
}

function showMainWindow(globals: Parameters<typeof createMainWindow>[0]) {
  if (mainWindow) {
    loadMainWindow(mainWindow)
    return
  }
  mainWindow = createMainWindow(globals)
  registerDiagnosticsWindow(mainWindow)
  wireFullscreenEvents(mainWindow)
  wireMenu()
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    restart: () =>
      runRestart({
        packaged: IS_PACKAGED,
        relaunch: () => app.relaunch(),
        quit: () => app.quit(),
        reload: () => mainWindow?.webContents.reloadIgnoringCache(),
      }),
  })
}

const diagnosticsIpc = registerIpcHandlers({
  killSidecar: () => stopLocalServer(),
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
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  getStartAtLogin: () => startAtLogin.get(),
  setStartAtLogin: (enabled) => startAtLogin.set(enabled),
  browser: browserRegistry,
  processDiagnostics: {
    profiler: diagnosticsProfiler,
    scanSessionMemory,
    isAllowedUrl: isTrustedMainRendererUrl,
    async confirmAction(input) {
      if (process.env.CLAXEDO_DIAGNOSTICS_PACKAGED_SMOKE === "1") return true
      const owner = BrowserWindow.fromWebContents(
        input.webContents as Parameters<typeof BrowserWindow.fromWebContents>[0],
      )
      const destructive = input.action === "kill"
      const options: MessageBoxOptions = {
        type: destructive ? "warning" : "question",
        title: destructive ? "Kill local process?" : "Stop local process?",
        message: `${destructive ? "Kill" : "Stop"} ${input.ownerLabel}?`,
        detail: destructive
          ? "Kill ends the owned process tree immediately. Unsaved work in that process may be lost."
          : "Stop asks the registered owner to shut down gracefully. It does not escalate to Kill.",
        buttons: [destructive ? "Kill" : "Stop", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }
      const result = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options)
      return result.response === 0
    },
  },
})

if (browserTabSetup) {
  logger.log("browser-tab feature enabled", { partition: browserTabSetup.partition })
}

async function stopLocalServer() {
  if (!claxedoServerHandle) return
  const handle = claxedoServerHandle
  claxedoServerHandle = null
  await handle.close()
}

async function shutdown() {
  diagnosticsSmokeFixtures.dispose()
  await stopLocalServer()
  if (browserBridgePromise) {
    try {
      const bridge = await browserBridgePromise
      await bridge.close()
    } catch (err) {
      logger.warn("failed to close browser bridge on shutdown", { error: err })
    }
  }
  diagnosticsIpc.dispose()
  diagnosticsProfiler.dispose()
}

function createPackagedDiagnosticsFixtures() {
  if (process.env.CLAXEDO_DIAGNOSTICS_PACKAGED_SMOKE !== "1") {
    return { dispose() {} }
  }
  const fixtures = [
    {
      ownerId: "diagnostics-packaged-stop",
      label: "Diagnostics growing CLI fixture",
      action: "stop" as const,
      script: "const held=[];setInterval(()=>held.push(Buffer.alloc(262144)),100)",
    },
    {
      ownerId: "diagnostics-packaged-kill",
      label: "Diagnostics kill CLI fixture",
      action: "kill" as const,
      script: "setInterval(()=>{},1000)",
    },
  ].map((fixture) => {
    const child = spawn(process.execPath, ["-e", fixture.script], {
      cwd: tmpdir(),
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PATH: process.env.PATH ?? "",
      },
      stdio: "ignore",
      windowsHide: true,
    })
    if (!child.pid) throw new Error("Could not start packaged diagnostics fixture")
    const registeredAt = Date.now()
    const descriptor = {
      ownerId: fixture.ownerId,
      ownerGeneration: crypto.randomUUID(),
      ownerOperationId: crypto.randomUUID(),
      launchId: crypto.randomUUID(),
      kind: "cli" as const,
      role: "cli" as const,
      label: fixture.label,
      pid: child.pid,
      capabilities: {
        stopGracefully: fixture.action === "stop",
        killOwnedTree: fixture.action === "kill",
      },
    }
    diagnosticsProfiler.recordOwnerEvent({
      type: "owner-registered",
      at: registeredAt,
      binding: { pid: process.pid, launchId: "desktop-main", generation: "desktop-main" },
      descriptor,
    }, async (request) => {
      if (request.action !== fixture.action) return "operation-unavailable"
      await killProcessTree(child.pid!, request.action === "stop" ? "SIGTERM" : "SIGKILL")
      return "completed"
    })
    let active = true
    child.once("exit", (code) => {
      if (!active) return
      active = false
      diagnosticsProfiler.recordOwnerEvent({
        type: "owner-exited",
        at: Date.now(),
        binding: { pid: process.pid, launchId: "desktop-main", generation: "desktop-main" },
        ownerId: descriptor.ownerId,
        ownerGeneration: descriptor.ownerGeneration,
        reason: "exited",
        ...(code === null ? {} : { exitCode: code }),
        observedLifetimeMs: Math.max(0, Date.now() - registeredAt),
      })
    })
    return child
  })
  const churn = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: tmpdir(),
    env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" },
    stdio: "ignore",
    windowsHide: true,
  })
  const churnGeneration = crypto.randomUUID()
  diagnosticsProfiler.recordOwnerEvent({
    type: "owner-registered",
    at: Date.now(),
    binding: { pid: process.pid, launchId: "desktop-main", generation: "desktop-main" },
    descriptor: {
      ownerId: "diagnostics-packaged-churn",
      ownerGeneration: churnGeneration,
      ownerOperationId: crypto.randomUUID(),
      launchId: crypto.randomUUID(),
      kind: "cli",
      role: "cli",
      label: "Diagnostics sub-cadence CLI fixture",
      capabilities: { stopGracefully: false, killOwnedTree: false },
    },
  })
  diagnosticsProfiler.recordOwnerEvent({
    type: "owner-exited",
    at: Date.now(),
    binding: { pid: process.pid, launchId: "desktop-main", generation: "desktop-main" },
    ownerId: "diagnostics-packaged-churn",
    ownerGeneration: churnGeneration,
    reason: "exited",
    observedLifetimeMs: 0,
  })
  churn.kill()
  return {
    dispose() {
      fixtures.forEach((child) => {
        if (child.exitCode === null) child.kill()
      })
      if (churn.exitCode === null) churn.kill()
    },
  }
}

function registerDiagnosticsWindow(window: BrowserWindow) {
  diagnosticsIpc.registerWebContents(window.webContents as unknown as DiagnosticsWebContents)
  diagnosticsProfiler.requestSample("lifecycle")
  window.once("ready-to-show", () => diagnosticsProfiler.markInteractive())
  window.once("closed", () => diagnosticsProfiler.requestSample("lifecycle"))
  window.webContents.on("render-process-gone", () => diagnosticsProfiler.requestSample("lifecycle"))
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

function cleanupLegacyDevCaches() {
  if (IS_PACKAGED) return
  const marker = join(app.getPath("userData"), ".legacy-cache-cleaned-v1")
  if (existsSync(marker)) return
  const stale = ["Cache", "Code Cache"].flatMap((name) => {
    const source = join(app.getPath("userData"), name)
    if (!existsSync(source)) return []
    const target = join(app.getPath("userData"), `.stale-${name.replaceAll(" ", "-")}-${String(process.pid)}`)
    try {
      renameSync(source, target)
      return [target]
    } catch (error) {
      logger.warn("failed to detach legacy development cache", { source, error: String(error) })
      return []
    }
  })
  stale.forEach((target) => {
    void rm(target, { recursive: true, force: true }).catch((error) => {
      logger.warn("failed to remove legacy development cache", { target, error: String(error) })
    })
  })
  try {
    writeFileSync(marker, "")
  } catch (error) {
    logger.warn("failed to record legacy development cache cleanup", { marker, error: String(error) })
  }
}

function sqliteFileExists() {
  const base = resolveDesktopServerDataDir({
    channel: CHANNEL,
    home: app.getPath("home"),
    configured: process.env.CLAXEDO_DATA_DIR,
  })
  return existsSync(join(base, "opencode-engine", "opencode.db"))
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
  await stopLocalServer()
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

function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL") {
  return new Promise<void>((resolve) => {
    treeKill(pid, signal, () => resolve())
  })
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
