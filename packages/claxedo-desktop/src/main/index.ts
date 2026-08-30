import { EventEmitter } from "node:events"
import { fork, spawn } from "node:child_process"
import { existsSync, renameSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Event, IpcMainInvokeEvent, MessageBoxOptions } from "electron"
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, utilityProcess } from "electron"
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
import {
  CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME,
  OPENCODE_COMPILE_CACHE_DIR_NAME,
} from "../shared/opencode-compile-cache"
import type { DiagnosticsWebContents } from "./diagnostics/ipc"
import { createElectronSource } from "./diagnostics/electron-source"
import { createProcessMetricsSource } from "./diagnostics/process-metrics-source"
import { claxedoServerForkOptions } from "./server-child-process"
import {
  CLAXEDO_DAEMON_PROTOCOL,
  claxedoDaemonDiscoveryPath,
  readClaxedoDaemonDiscovery,
  verifyClaxedoDaemonDiscovery,
  type ClaxedoDaemonDiscovery,
} from "./server-daemon-discovery"
import { holdClaxedoDaemonLease } from "./server-daemon-lease"
import { createDaemonExitLifecycle } from "./daemon-exit-lifecycle"
import { embeddedServerReadiness } from "./server-readiness"
import { recordStartupClock } from "../shared/startup-clock-probe"
import { createProfiler } from "./diagnostics/profiler"
import { createSessionMemoryScanner } from "./diagnostics/session-memory-worker"
import { createOwnerOperationBridge } from "./diagnostics/owner-operation-bridge"
import { createWindowsWslCollector, createWslSource } from "./diagnostics/wsl-source"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, wireFullscreenEvents } from "./ipc"
import { installIpcCallerGuard, mainIpcCallerGuard } from "./ipc-caller-guard"
import { setupLazyAccount } from "./account/lazy-account"
import { ACCOUNT_STATE_CHANGED_CHANNEL } from "./account/account-ipc"
import { accountConfigEnvironment } from "./account/public-config"
import { machineDisplayName, setupElectronHostConnector } from "./host-connector/electron-child"
import { registerHostConnectorIpc } from "./host-connector/ipc"
import { publishHostConnectorStatus } from "./host-connector/status-channel"
import { initLogging } from "./logging"
import { createMenu } from "./menu"
import { createNativeMarkdownRenderer } from "./native-markdown"
import { createNativeMermaidRenderer } from "./native-mermaid"
import { resolveRichContentRendererPath } from "./rich-content-renderer-path"
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
import { parseClaxedoServerReadyMessage } from "../shared/claxedo-server-lifecycle"

type ServerConnection =
  | { variant: "existing"; url: string }
  | { variant: "daemon"; url: string; discovery: ClaxedoDaemonDiscovery }

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let quitting = false
const daemonExitLifecycle = createDaemonExitLifecycle()
let daemonLease: Awaited<ReturnType<typeof holdClaxedoDaemonLease>> | undefined
const loadingComplete = defer<void>()

const browserTabSetup = setupBrowserTab()
const browserRegistry: BrowserRegistry | undefined = browserTabSetup?.registry
const browserBridgePromise = browserTabSetup?.bridge

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const logger = initLogging()
const richContentRendererPath = resolveRichContentRendererPath({
  packaged: IS_PACKAGED,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  override: process.env.CLAXEDO_RICH_CONTENT_RENDERER_PATH,
})
if (richContentRendererPath) process.env.CLAXEDO_RICH_CONTENT_RENDERER_PATH = richContentRendererPath
const startAtLogin = createStartAtLogin(app)
const electronDiagnosticsSource = createElectronSource({
  process,
  isReady: () => app.isReady(),
  getAppMetrics: () => app.getAppMetrics(),
  getWindows: () => BrowserWindow.getAllWindows(),
})
const diagnosticsSource = createProcessMetricsSource({
  electron: electronDiagnosticsSource,
  hostCollection: "on-demand",
  workerPath: join(import.meta.dirname, "process-metrics-worker.js"),
  ...(process.platform === "darwin"
    ? {
        memoryHelperPath: join(
          IS_PACKAGED ? process.resourcesPath : app.getAppPath(),
          IS_PACKAGED ? "diagnostics/macos-memory-impact" : "resources/diagnostics/macos-memory-impact",
        ),
      }
    : {}),
  wsl: createWslSource({
    enabled: process.platform === "win32" && getWslConfig().enabled,
    ...(process.platform === "win32" ? { collect: createWindowsWslCollector() } : {}),
  }),
})
const diagnosticsProfiler = createProfiler({ source: diagnosticsSource })
const scanSessionMemory = createSessionMemoryScanner({
  workerPath: join(import.meta.dirname, "session-memory-worker.js"),
  paths: {
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
    await account.ready
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

// The prebuilt V8 compile cache for that artifact, generated at build time by
// scripts/build-opencode-compile-cache.ts and shipped as an extraResources
// sibling of the engine. The utility process seeds it into the running user's
// own cache directory before the first engine import; see
// src/shared/opencode-compile-cache.ts for why it cannot simply be copied.
// Absent (a build that skipped generation) is not an error: the engine compiles
// as it always did.
function getOpenCodeCompileCachePath(): string {
  return IS_PACKAGED
    ? join(process.resourcesPath, OPENCODE_COMPILE_CACHE_DIR_NAME)
    : join(MAIN_DIR, "../../resources", OPENCODE_COMPILE_CACHE_DIR_NAME)
}

// The same, for the server bundle's OWN 9.11 MB static closure. It is a second
// shipped set rather than more entries in the engine's, because the two are
// generated from different artifacts and their manifests are relative to
// different roots — the engine's directory and the server bundle's directory.
function getClaxedoServerCompileCachePath(): string {
  return IS_PACKAGED
    ? join(process.resourcesPath, CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME)
    : join(MAIN_DIR, "../../resources", CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME)
}

function desktopServerDataDir() {
  return resolveDesktopServerDataDir({
    channel: CHANNEL,
    home: app.getPath("home"),
    configured: process.env.CLAXEDO_DATA_DIR,
  })
}

async function startClaxedoServer(serverDataDir: string): Promise<{ url: string; discovery: ClaxedoDaemonDiscovery }> {
  const claxedoPort = await findFreePort(resolveBaseServerPort())
  const serverPath = getClaxedoServerPath()
  const openCodeEmbedPath = getOpenCodeEmbedPath()
  const openCodeCompileCachePath = getOpenCodeCompileCachePath()
  const claxedoServerCompileCachePath = getClaxedoServerCompileCachePath()
  // No worker path: the desktop runs the engine IN-PROCESS in the server child,
  // deliberately. Splitting it into a forked worker was implemented and
  // measured — six runs against a v5 control — and it regressed three gates:
  // cold ready 1,875 -> 2,004 ms, peak family RSS ~1,930 -> 2,060 MiB, and
  // quiescent CPU failed its 5% budget in two of six runs. The engine did move
  // as designed (server child 374.6 -> ~190 MiB) but the worker costs 310 MiB,
  // so one process became two for +125 MiB net. And the idle-exit that was
  // supposed to repay it never fires: the worker was alive in all 18 process
  // snapshots of a run, including the quiescent window. `peak_process_family_
  // rss_mib` is a PEAK, so a process that exits later cannot reduce it even in
  // principle. The worker transport itself is correct and stays — self-hosted
  // uses it (`deployments/self-hosted-node/app.ts` calls
  // `configureOpenCodeWorkerPath`). This product opts out.
  logger.log("starting claxedo-server with in-process OpenCode", { serverPath, claxedoPort, openCodeEmbedPath })

  if (!existsSync(serverPath)) {
    throw new Error(`Claxedo server bundle was not found at ${serverPath}. Rebuild the desktop app and try again.`)
  }
  if (!existsSync(openCodeEmbedPath)) {
    throw new Error(`OpenCode engine artifact was not found at ${openCodeEmbedPath}. Rebuild the desktop app and try again.`)
  }

  // The native SDK harness spawns the user's installed Claude Code CLI. Resolve
  // it once here so a GUI-trimmed PATH still finds a standard install.
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

  try {
    const serverLaunchId = `claxedo-server-${crypto.randomUUID()}`
    const serverGeneration = `server-generation-${crypto.randomUUID()}`
    const daemonToken = crypto.randomUUID()
    const daemonDiscovery = claxedoDaemonDiscoveryPath(serverDataDir)
    const child = fork(
      serverPath,
      [],
      claxedoServerForkOptions({
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        CLAXEDO_CHILD_PORT: String(claxedoPort),
        CLAXEDO_DATA_DIR: serverDataDir,
        CLAXEDO_DAEMON_PROTOCOL: String(CLAXEDO_DAEMON_PROTOCOL),
        CLAXEDO_DAEMON_TOKEN: daemonToken,
        CLAXEDO_DAEMON_GENERATION: serverGeneration,
        CLAXEDO_DAEMON_DISCOVERY_PATH: daemonDiscovery,
        CLAXEDO_CHILD_OPENCODE_EMBED_PATH: openCodeEmbedPath,
        ...(existsSync(openCodeCompileCachePath)
          ? { CLAXEDO_CHILD_OPENCODE_COMPILE_CACHE_DIR: openCodeCompileCachePath }
          : {}),
        ...(existsSync(claxedoServerCompileCachePath)
          ? { CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: claxedoServerCompileCachePath }
          : {}),
        CLAXEDO_DIAGNOSTICS_LAUNCH_ID: serverLaunchId,
        CLAXEDO_DIAGNOSTICS_GENERATION: serverGeneration,
      }),
    )
    const listening = defer<void>()
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
            if (!child.connected) return false
            return child.send(message)
          },
        })
    }
    child.on("spawn", connectOwnerBridge)
    recordStartupClock("main-server-forked", { pid: child.pid ?? 0 })
    child.on("message", (input) => {
      const ready = parseClaxedoServerReadyMessage(input)
      if (ready) {
        recordStartupClock("main-server-ready-message", { port: ready.port })
        if (ready.port === claxedoPort) listening.resolve()
        else {
          logger.warn("claxedo-server reported an unexpected port", {
            expected: claxedoPort,
            actual: ready.port,
          })
        }
        return
      }
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
    const exited = defer<number | null>()
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
    child.on("error", (error) => {
      listening.reject(error)
      logger.error("claxedo-server child process failed", { error: String(error) })
    })
    child.once("exit", (code) => {
      ownerBridge?.dispose()
      exited.resolve(code)
      listening.reject(new Error(`claxedo-server exited before listening (code ${String(code)})`))
      if (!quitting && code !== 0) logger.error("claxedo-server child process exited", { code })
    })

    const claxedoUrl = `http://127.0.0.1:${claxedoPort}`
    const readiness = embeddedServerReadiness({ healthUrl: `${claxedoUrl}/api/claxedo/health` })
    try {
      // Paid HERE, while this process has nothing to do but wait for the child.
      // The same request costs ~11 ms more the first time any fetch is made,
      // and left to `verify()` that cost lands after the child reports
      // listening and before the renderer is unblocked. See
      // `server-readiness.ts`. Inside the try so that even an impossible
      // failure takes the same close-the-child path as every other one.
      readiness.prepare()
      await Promise.race([
        listening.promise,
        delay(30_000).then(() => {
          throw new Error("The embedded Claxedo server did not report that it was listening in time.")
        }),
      ])
      await readiness.verify()
      const published = readClaxedoDaemonDiscovery(daemonDiscovery)
      const adopted = published && await verifyClaxedoDaemonDiscovery(published)
      if (!published || adopted !== claxedoUrl || published.generation !== serverGeneration || published.token !== daemonToken) {
        throw new Error("The local Claxedo daemon did not publish its authenticated identity.")
      }
      recordStartupClock("main-server-health-verified")
      logger.log("claxedo-server healthy", { url: claxedoUrl })
      diagnosticsProfiler.recordLifecycle({
        event: "server-ready",
        ownerId: "owner-claxedo-server",
      })
      ownerBridge?.dispose()
      ownerBridge = undefined
      if (child.connected) child.disconnect()
      child.unref()
      return { url: claxedoUrl, discovery: published }
    } catch (error) {
      logger.warn("embedded server readiness check failed", { error: String(error) })
      await handle.close()
      throw error
    }
  } catch (err) {
    logger.error("claxedo-server failed to start", { error: String(err) })
    throw err
  }
}

async function setupServerConnection(): Promise<ServerConnection> {
  const explicitDevelopmentUrl = !IS_PACKAGED ? process.env.CLAXEDO_SERVER_URL?.trim() : undefined
  if (explicitDevelopmentUrl && await checkHealth(explicitDevelopmentUrl)) {
    logger.log("dev: using explicitly configured claxedo-server", { url: explicitDevelopmentUrl })
    return { variant: "existing", url: explicitDevelopmentUrl }
  }

  const customUrl = await getSavedServerUrl()

  if (customUrl && (await checkHealthOrAskRetry(customUrl))) {
    return { variant: "existing", url: customUrl }
  }

  const serverDataDir = desktopServerDataDir()
  const discovery = readClaxedoDaemonDiscovery(claxedoDaemonDiscoveryPath(serverDataDir))
  const daemonUrl = discovery && await verifyClaxedoDaemonDiscovery(discovery)
  if (daemonUrl) {
    logger.log("adopted existing claxedo daemon", {
      url: daemonUrl,
      pid: discovery.pid,
      generation: discovery.generation,
    })
    return { variant: "daemon", url: daemonUrl, discovery }
  }

  logger.log("claxedo daemon not found, starting it")
  return { variant: "daemon", ...(await startClaxedoServer(serverDataDir)) }
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
      if (serverConnection.variant === "daemon") {
        daemonLease = await holdClaxedoDaemonLease(serverConnection.discovery, {
          onError: (error) => logger.warn("daemon lease renewal failed", { error: String(error) }),
        })
      }

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
      // Stamped after the publish, never before it: this is the instant the
      // renderer's pending `awaitInitialization` can learn the server URL, and
      // therefore the earliest instant any renderer request can exist.
      recordStartupClock("main-server-ready-published")

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

  // The renderer's initialization IPC already waits for `serverReady`, so its
  // module graph can load alongside the sidecar without opening a socket early.
  // Keeping those independent cold paths serial added the whole renderer load
  // after server readiness. A first-run migration retains the progress window
  // because it owns a separate, potentially long-lived user-visible flow.
  const startupWindow = needsMigration ? createLoadingWindow(globals) : undefined
  if (startupWindow) {
    await delay(1000)
  } else {
    logger.log("loading main window alongside embedded server")
    mainWindow = createMainWindow(globals)
    registerDiagnosticsWindow(mainWindow)
    wireFullscreenEvents(mainWindow)
    wireMenu()
  }

  try {
    await loadingTask
  } catch (error) {
    logger.error("embedded server initialization failed", { error: String(error) })
    setInitStep({ phase: "done" })
    if (startupWindow) {
      showMainWindow(globals)
      startupWindow.close()
    }
    return
  }
  setInitStep({ phase: "done" })

  if (startupWindow) {
    await loadingComplete.promise
    showMainWindow(globals)
    startupWindow.close()
  }
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
        relaunch: () => {
          daemonExitLifecycle.handoff()
          app.relaunch()
        },
        quit: () => app.quit(),
        reload: () => mainWindow?.webContents.reloadIgnoringCache(),
      }),
  })
}

// Installed BEFORE any handler registers, because it works by wrapping
// `ipcMain.handle`/`ipcMain.on` — anything registered earlier would be
// permanently unguarded. `ipc-caller-guard.wiring.test.ts` pins that ordering.
installIpcCallerGuard({
  ipcMain,
  guard: mainIpcCallerGuard(),
  readCaller: (event) => {
    const ipc = event as IpcMainInvokeEvent
    return {
      senderId: ipc.sender.id,
      // Null when the frame is already gone, which is not a top frame and so
      // fails closed.
      isMainFrame: ipc.senderFrame !== null && ipc.senderFrame === ipc.sender.mainFrame,
    }
  },
  onRejected: (channel, reason) => logger.warn(`[security] ${reason} (channel ${channel})`),
})

// After the guard above, like every other registration — these channels spend
// an account credential, so an unguarded one would be the worst of the sixty to
// leave open.
const bakedAccountConfig = import.meta.env as Record<string, string | undefined>
let hostConnector: ReturnType<typeof setupElectronHostConnector> | undefined
const account = setupLazyAccount({
  ipcMain,
  userDataDir: app.getPath("userData"),
  adapterReady: app.whenReady(),
  env: accountConfigEnvironment(process.env, bakedAccountConfig),
  onError: (stage, error) => logger.warn(`[account] ${stage}: ${String(error)}`),
  onStateChange: (next, previous) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ACCOUNT_STATE_CHANGED_CHANNEL, next)
    if (previous.status === "signed" && next.status !== "signed") hostConnector?.stop()
  },
})

/**
 * Machine remote access, constructed but NOT started.
 *
 * Constructing mints no key, writes nothing and sends no traffic — that all
 * happens in `start()`. So an unsigned launch, which is most launches, enrolls
 * nothing and leaves no machine identity on disk.
 *
 * This file still never calls `start()`, and that is the point rather than an
 * omission: enrolling because an account happens to be signed in would be the
 * desktop deciding to publish the user's laptop for them. The trigger now
 * exists, and it is `registerHostConnectorIpc` below — one named operation that
 * only runs when the user presses Enable in the Remote Access surface.
 * `ipc-caller-guard.wiring.test.ts` holds the entry to that: it asserts this
 * file contains no `.start(` call at all.
 *
 * The machine's label is chosen HERE, not sent from the renderer. It is main
 * that signs the enrollment, so main names the thing it is signing for — and a
 * platform word rather than `os.hostname()`, because a hostname is the laptop's
 * identity on its network and `identity-store.ts` explains at length why that
 * must not travel to the control plane.
 */
hostConnector = setupElectronHostConnector({
  runAccountOperation: (name, params) => account.run(name as never, params),
  safeStorage,
  userDataDir: app.getPath("userData"),
  fork: utilityProcess.fork,
  packaged: IS_PACKAGED,
  mainDir: MAIN_DIR,
  resourcesPath: process.resourcesPath,
  displayName: machineDisplayName(process.platform),
  ...(Number.isFinite(Number(process.env.CLAXEDO_HOST_CONNECTOR_HEARTBEAT_INTERVAL_MS)) &&
  Number(process.env.CLAXEDO_HOST_CONNECTOR_HEARTBEAT_INTERVAL_MS) > 0
    ? { heartbeatIntervalMs: Number(process.env.CLAXEDO_HOST_CONNECTOR_HEARTBEAT_INTERVAL_MS) }
    : {}),
  onError: (stage, error) => logger.warn(`[host-connector] ${stage}: ${String(error)}`),
  // The panel shows state the user did not cause — an expiry, a rejected
  // beat, a revocation — so every transition is pushed rather than waited
  // for. `status-channel.ts` skips a window that has gone, which matters
  // because this fires from a heartbeat timer.
  onStatusChange: (state) =>
    publishHostConnectorStatus(mainWindow ?? undefined, state, hostConnectorContext()),
})

/** The two facts the connector's own state cannot carry. See `status-channel.ts`. */
function hostConnectorContext() {
  return {
    available: hostConnector !== undefined,
    signedIn: account.state().status === "signed",
  }
}

// Registered whether or not the connector exists: an absent channel would leave
// `window.api.hostConnector` half-built, the renderer would read the bridge as
// missing, and the desktop would fall back to an HTTP call its own sidecar does
// not serve. Answering `available: false` is the honest version of that.
//
// After `installIpcCallerGuard`, like every other registration.
registerHostConnectorIpc({
  ipcMain,
  connector: hostConnector,
  signedIn: () => hostConnectorContext().signedIn,
  onError: (stage, error) => logger.warn(`[host-connector] ${stage}: ${String(error)}`),
})
logger.log("host connector", { available: true, state: hostConnector.status().status })

const diagnosticsIpc = registerIpcHandlers({
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
  parseMarkdown: createNativeMarkdownRenderer(process.env.CLAXEDO_MARKDOWN_RENDERER_PATH ?? richContentRendererPath),
  renderMermaid: createNativeMermaidRenderer(process.env.CLAXEDO_MERMAID_RENDERER_PATH ?? richContentRendererPath),
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

async function shutdown() {
  const lease = daemonLease
  daemonLease = undefined
  await daemonExitLifecycle.release(lease)
  hostConnector?.dispose()
  diagnosticsSmokeFixtures.dispose()
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
  return existsSync(join(desktopServerDataDir(), "opencode-engine", "opencode.db"))
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
  daemonExitLifecycle.handoff()
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
