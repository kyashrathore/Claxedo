import { EventEmitter } from "node:events"
import { fork } from "node:child_process"
import { closeSync, existsSync, renameSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { Event, OnHeadersReceivedListenerDetails } from "electron"
import { app, BrowserWindow, ipcMain, powerMonitor, safeStorage, session, utilityProcess } from "electron"
import { daemonResponseListener, grantMainRendererDaemonAccess, HTTP_REQUEST_URLS, type DaemonResponseHeaders } from "./renderer-daemon-access"
import { createDaemonFetch, type DaemonEndpoint } from "./daemon-request"
import treeKill from "tree-kill"
import { installDesktopTelemetry } from "./telemetry"
import { reportInstall } from "./install-telemetry"

// Registered before every other line in this file (including the app.setName
// / app.setPath calls immediately below): once a listener exists here,
// Electron/Node's default uncaughtException behavior is disabled, so this
// module's handler becomes the only thing standing between a thrown error
// and a desktop app that hangs instead of failing fast.
const telemetryClient = installDesktopTelemetry()

const packagedProduct = desktopProduct(CHANNEL)
const devIdentity = resolveDevIdentity(IS_PACKAGED)
app.setName(IS_PACKAGED ? packagedProduct.productName : devIdentity.name)
// The userData suffix keeps each worktree's dev profile — and its
// single-instance lock — separate, so labeled dev apps run side by side.
app.setPath(
  "userData",
  process.env.CLAXEDO_DESKTOP_USER_DATA_DIR ??
    join(app.getPath("appData"), IS_PACKAGED ? packagedProduct.appId : `ai.claxedo.desktop.dev${devIdentity.userDataSuffix}`),
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

import type { InitStep, ServerReadyData, WslConfig } from "../preload/types"
import { ensureAgentPath } from "./agent-path"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { loadServerEnvForDevelopment, resolveDesktopServerDataDir } from "./server-env"
import type { BrowserRegistry } from "./browser/registry"
import { setupBrowserTab } from "./browser/setup"
import { CHANNEL, IS_PACKAGED, UPDATER_ENABLED } from "./constants"
import { createAutoUpdate } from "./auto-update"
import { createAppLifecycle, type ExitIntent } from "./app-lifecycle"
import { createAppTray, confirmQuitDialog } from "./lifecycle-ui"
import { runningWork, stopPublishedDaemon } from "./daemon-quit"
import { desktopProduct } from "../shared/desktop-product"
import { resolveDevIdentity } from "./dev-identity"
import { findFreePort, resolveBaseServerPort } from "./server-port"
import { restartBehavior, runRestart } from "../shared/restart-policy"
import { CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME } from "../shared/compile-cache"
import { readString } from "@claxedo/helpers/readers"
import { claxedoServerForkOptions } from "./server-child-process"
import { setupAgentPluginsSignedSync, type AgentPluginsSignedSync } from "./agent-plugins-signed-sync"
import { CLAXEDO_DAEMON_PROTOCOL } from "@claxedo/helpers/claxedo-daemon"
import {
  claxedoDaemonDiscoveryPath,
  readClaxedoDaemonDiscovery,
  verifyClaxedoDaemonDiscovery,
  type ClaxedoDaemonDiscovery,
} from "./server-daemon-discovery"
import {
  DAEMON_RECOVERY_CHANNELS,
  claxedoDaemonOwnershipPath,
  daemonRecoveryBridge,
  readDaemonOwnershipView,
  type DaemonRecoveryResult,
} from "./daemon-recovery"
import { publishedDaemonVerdict } from "./daemon-launch"
import { holdClaxedoDaemonLease } from "./server-daemon-lease"
import { createDaemonStatus, DAEMON_STATUS_CHANNELS, type DaemonExit } from "./daemon-status"
import { embeddedServerReadiness } from "./server-readiness"
import { recordStartupClock } from "../shared/startup-clock-probe"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, wireFullscreenEvents } from "./ipc"
import { installIpcCallerGuard, mainIpcCallerGuard } from "./ipc-caller-guard"
import { setupLazyAccount } from "./account/lazy-account"
import { readCliSignInMode } from "./account/cli-credential-file"
import { store } from "./store"
import { ACCOUNT_STATE_CHANGED_CHANNEL } from "./account/account-ipc"
import { accountConfigEnvironment } from "./account/public-config"
import { readAccountConfig } from "./account/account-config"
import { machineDisplayName } from "@claxedo/helpers/machine-name"
import { setupElectronHostConnector } from "./host-connector/electron-child"
import { remoteAccessFollow } from "./host-connector/account-follow"
import { describeLocalWorkspace } from "./host-connector/local-workspace-description"
import { registerHostConnectorIpc } from "./host-connector/ipc"
import type { HostConnectorServing } from "./host-connector/child-protocol"
import { setupHostServingPush } from "./host-connector/serving-push"
import { setupHostProviderConfigPush } from "./host-connector/provider-config-push"
import { publishHostConnectorStatus } from "./host-connector/status-channel"
import { initLogging, openServerLogFile } from "./logging"
import { createMenu } from "./menu"
import { createNativeMermaidRenderer } from "./native-mermaid"
import { resolveMermaidRendererPath } from "./mermaid-renderer-path"
import {
  checkHealth,
  checkHealthOrAskRetry,
  getDefaultServerUrl,
  getSavedServerUrl,
  getWslConfig,
  setDefaultServerUrl,
  setWslConfig,
} from "./server"
import { createMainWindow, isRendererDocumentUrl, isTrustedMainRendererUrl, rendererDocumentUrlPatterns, setDockIcon } from "./windows"
import { rendererContentSecurityListener } from "./renderer-content-security"
import { createStartAtLogin } from "./start-at-login"
import { claxedoServerExitedBeforeListening, parseClaxedoServerReadyMessage } from "../shared/claxedo-server-lifecycle"

type ServerConnection =
  /**
   * A server this process did not start and was not given an identity for: a
   * saved custom URL, or `CLAXEDO_SERVER_URL` in development. The capability is
   * whatever the launcher declared in `CLAXEDO_DAEMON_TOKEN`, and nothing when
   * it declared none — main then reaches that server's privileged routes not at
   * all, rather than reaching them on the strength of being on loopback.
   */
  | { variant: "existing"; url: string; capability: string | undefined }
  | { variant: "daemon"; url: string; discovery: ClaxedoDaemonDiscovery; childExit?: Promise<DaemonExit> }

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let daemonLease: Awaited<ReturnType<typeof holdClaxedoDaemonLease>> | undefined
/** Held for the recovery IPC while no server connection could be established. */
let unresolvedDaemon: { discovery: ClaxedoDaemonDiscovery; result: DaemonRecoveryResult } | undefined
const loadingComplete = defer<void>()

const browserTabSetup = setupBrowserTab()
const browserRegistry: BrowserRegistry | undefined = browserTabSetup?.registry

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
/**
 * The daemon this process talks to, and the capability it presents.
 *
 * Deliberately NOT part of `ServerReadyData`: that value is returned to the
 * renderer over IPC, and the capability is the one thing the renderer must
 * never hold. Main stamps it onto the renderer's requests instead — see
 * `renderer-daemon-access.ts`.
 */
const daemonEndpoint = defer<DaemonEndpoint>()
/**
 * The origin of the server this window will talk to, known as soon as main
 * picks the port or adopts a daemon: the renderer document's policy names it.
 */
const serverOrigin = defer<string>()
const daemon = createDaemonFetch({ endpoint: () => daemonEndpoint.promise })
const logger = initLogging()
const autoUpdate = createAutoUpdate({ logger, exitForInstall: (install) => lifecycle.requestExit("quit", install) })
/** The daemon this app holds a lease on, which a quit stops and a handoff leaves running. */
let leasedDaemon: ClaxedoDaemonDiscovery | undefined
const lifecycle = createAppLifecycle({
  app,
  platform: process.platform,
  window: () => mainWindow ?? undefined,
  ready: app.whenReady(),
  createTray: createAppTray,
  runningWork: async () => (leasedDaemon && daemonConnected ? runningWork(await recovery.inspect()) : undefined),
  confirmQuit: confirmQuitDialog,
  exit: exitApp,
  log: (message, fields) => logger.log(message, fields),
})
const mermaidRendererPath = resolveMermaidRendererPath({
  packaged: IS_PACKAGED,
  resourcesPath: process.resourcesPath,
  appPath: join(import.meta.dirname, "../.."),
  override: process.env.CLAXEDO_MERMAID_RENDERER_PATH,
})
const startAtLogin = createStartAtLogin(app)

logger.log("app starting", {
  version: app.getVersion(),
  packaged: IS_PACKAGED,
})
setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  ensureAgentPath()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  if (!IS_PACKAGED) app.commandLine.appendSwitch("disable-http-cache")
  process.once("SIGINT", () => void lifecycle.requestExit("stop", () => app.quit()))
  process.once("SIGTERM", () => void lifecycle.requestExit("stop", () => app.quit()))

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  cleanupLegacyDevCaches()
  // The server child needs nothing from app readiness, so it forks here rather
  // than after whenReady; initialize() awaits the connection and owns its
  // failure, and this catch only keeps the rejection from being reported as
  // unhandled before initialize() attaches.
  logger.log("setting up server connection")
  const serverConnection = setupServerConnection()
  serverConnection.catch((error: unknown) => serverOrigin.reject(error instanceof Error ? error : new Error(String(error))))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("claxedo://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    lifecycle.open()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  void app.whenReady().then(async () => {
    powerMonitor.on("suspend", () => logger.log("system suspending"))
    powerMonitor.on("resume", () => logger.log("system resumed"))
    app.setAsDefaultProtocolClient("claxedo")
    setDockIcon()
    autoUpdate.setup()
    // Account restoration is an optional hosted capability. In particular, a
    // persisted revocation intent may need a slow or unavailable network before
    // it can settle. That work must never sit in front of the local daemon or
    // the first desktop window: the renderer's AccountPort already starts in
    // `pending` and adopts the authoritative pushed state when restoration
    // finishes. Keep the rejection observed without making local startup wait.
    void account.ready.catch((error) => {
      logger.warn("account restore failed", { error: String(error) })
    })
    await initialize(serverConnection)
  })
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
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

// Shipped compile cache for the server bundle's own static closure.
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

async function startClaxedoServer(
  serverDataDir: string,
): Promise<{ url: string; discovery: ClaxedoDaemonDiscovery; childExit: Promise<DaemonExit> }> {
  const claxedoPort = await findFreePort(resolveBaseServerPort())
  serverOrigin.resolve(`http://127.0.0.1:${claxedoPort}`)
  const serverPath = getClaxedoServerPath()
  const claxedoServerCompileCachePath = getClaxedoServerCompileCachePath()
  logger.log("starting claxedo-server with embedded OpenCode SDK", { serverPath, claxedoPort })

  if (!existsSync(serverPath)) {
    throw new Error(`Claxedo server bundle was not found at ${serverPath}. Rebuild the desktop app and try again.`)
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
    const serverGeneration = `server-generation-${crypto.randomUUID()}`
    const daemonToken = crypto.randomUUID()
    const daemonDiscovery = claxedoDaemonDiscoveryPath(serverDataDir)
    const serverLog = openServerLogFile()
    logger.log("claxedo-server stdout and stderr are written to", { path: serverLog.path })
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
        CLAXEDO_DAEMON_BUILD: app.getVersion(),
        CLAXEDO_DAEMON_DISCOVERY_PATH: daemonDiscovery,
        ...(existsSync(claxedoServerCompileCachePath)
          ? { CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: claxedoServerCompileCachePath }
          : {}),
      }, serverLog.fd),
    )
    closeSync(serverLog.fd)
    const listening = defer<void>()
    recordStartupClock("main-server-forked", { pid: child.pid ?? 0 })
    child.on("message", (input) => {
      const ready = parseClaxedoServerReadyMessage(input)
      if (!ready) return
      recordStartupClock("main-server-ready-message", { port: ready.port })
      if (ready.port === claxedoPort) listening.resolve()
      else {
        logger.warn("claxedo-server reported an unexpected port", {
          expected: claxedoPort,
          actual: ready.port,
        })
      }
    })
    const exited = defer<DaemonExit>()
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
    child.once("exit", (code, signal) => {
      exited.resolve({ code, signal })
      listening.reject(new Error(claxedoServerExitedBeforeListening(code, serverLog.path)))
      const detail = { pid: child.pid, code, signal }
      if (lifecycle.quitting() || code === 0) logger.log("claxedo-server child process exited", detail)
      else logger.error("claxedo-server child process exited", detail)
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
      if (child.connected) child.disconnect()
      child.unref()
      return { url: claxedoUrl, discovery: published, childExit: exited.promise }
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

/**
 * The capability for a server this process did not start.
 *
 * The launcher that started that server chose its daemon token, so the launcher
 * is the only party that can tell this process what to present. Absent, main
 * holds none and the daemon refuses its privileged calls — which is the
 * reportable failure, not a reason to treat being on loopback as authority.
 */
function declaredDaemonCapability(): string | undefined {
  const declared = process.env.CLAXEDO_DAEMON_TOKEN?.trim()
  if (!declared) {
    logger.warn(
      "no CLAXEDO_DAEMON_TOKEN for this externally started server; main holds no daemon capability " +
        "and its machine-control calls will be refused",
    )
  }
  return declared || undefined
}

async function setupServerConnection(): Promise<ServerConnection> {
  const explicitDevelopmentUrl = !IS_PACKAGED ? process.env.CLAXEDO_SERVER_URL?.trim() : undefined
  if (explicitDevelopmentUrl && await checkHealth(explicitDevelopmentUrl)) {
    logger.log("dev: using explicitly configured claxedo-server", { url: explicitDevelopmentUrl })
    serverOrigin.resolve(new URL(explicitDevelopmentUrl).origin)
    return { variant: "existing", url: explicitDevelopmentUrl, capability: declaredDaemonCapability() }
  }

  const customUrl = getSavedServerUrl()

  if (customUrl && (await checkHealthOrAskRetry(customUrl))) {
    serverOrigin.resolve(new URL(customUrl).origin)
    return { variant: "existing", url: customUrl, capability: declaredDaemonCapability() }
  }

  const serverDataDir = desktopServerDataDir()
  const discovery = readClaxedoDaemonDiscovery(claxedoDaemonDiscoveryPath(serverDataDir))
  if (discovery) {
    const verdict = await publishedDaemonVerdict({
      discovery,
      build: app.getVersion(),
      snapshot: () => readDaemonOwnershipView(claxedoDaemonOwnershipPath(serverDataDir)),
    })
    if (verdict.kind === "adopt") {
      logger.log("adopted existing claxedo daemon", { url: verdict.url, pid: discovery.pid, generation: discovery.generation })
      serverOrigin.resolve(new URL(verdict.url).origin)
      return { variant: "daemon", url: verdict.url, discovery }
    }
    if (verdict.kind === "held") {
      unresolvedDaemon = { discovery, result: verdict.result }
      logger.warn("the published claxedo daemon is unresolved; no replacement was started", {
        pid: discovery.pid,
        port: discovery.port,
        build: discovery.build,
      })
      throw new DaemonUnresolvedError(verdict.message)
    }
    logger.log("the published claxedo daemon is gone or was of another build; starting a replacement", {
      pid: discovery.pid,
      build: discovery.build,
    })
  }

  logger.log("claxedo daemon not found, starting it")
  unresolvedDaemon = undefined
  return { variant: "daemon", ...(await startClaxedoServer(serverDataDir)) }
}

/**
 * The daemon this machine published is still there and nothing authorized
 * stopping it. Startup fails with this rather than starting a second writer
 * over the same data directory.
 */
class DaemonUnresolvedError extends Error {
  readonly code = "daemon_unresolved"

  constructor(message: string) {
    super(message)
    this.name = "DaemonUnresolvedError"
  }
}

async function initialize(serverConnectionStarted: Promise<ServerConnection>) {
  let daemonResponses: DaemonResponseHeaders | undefined
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [...rendererDocumentUrlPatterns(), ...HTTP_REQUEST_URLS] },
    daemonResponseListener<OnHeadersReceivedListenerDetails>({
      daemonResponses: () => daemonResponses,
      otherwise: rendererContentSecurityListener({
        serverOrigin: serverOrigin.promise,
        relayOrigins: accountConfig.configured ? accountConfig.relayOrigins ?? [] : [],
        isRendererDocument: isRendererDocumentUrl,
        devServerUrl: process.env.ELECTRON_RENDERER_URL,
      }),
    }),
  )
  const loadingTask = (async () => {
    try {
      const serverConnection = await serverConnectionStarted
      logger.log("server connection ready", {
        variant: serverConnection.variant,
        url: serverConnection.url,
      })
      if (serverConnection.variant === "daemon") {
        leasedDaemon = serverConnection.discovery
        daemonLease = await holdClaxedoDaemonLease(serverConnection.discovery, {
          onLost: () => {
            logger.warn("the daemon closed this app's lease")
            if (!lifecycle.quitting()) daemonStatus.leaseLost()
          },
          onError: (error) => logger.warn("daemon lease failed", { error: String(error) }),
        })
        void serverConnection.childExit?.then((exit) => {
          if (!lifecycle.quitting()) daemonStatus.exited(exit)
        })
      }

      // A daemon this process started published its own token; one it adopted
      // published the same field. Anything else holds only what the launcher
      // declared.
      const endpoint: DaemonEndpoint = {
        origin: serverConnection.url,
        capability: serverConnection.variant === "daemon"
          ? serverConnection.discovery.token
          : serverConnection.capability,
      }
      daemonEndpoint.resolve(endpoint)

      // Must run before the renderer makes any request to this server: it needs
      // the daemon capability to be admitted at all, and its file:// document
      // sends `Origin: file://` on every WebSocket handshake, which the loopback
      // gate rejects with 403. See renderer-daemon-access.ts.
      daemonResponses = grantMainRendererDaemonAccess({
        policy: {
          daemonOrigin: endpoint.origin,
          capability: endpoint.capability,
          // The same registry the IPC boundary trusts: a webContents this
          // process registered as bridge-carrying, never a URL a page controls.
          isBridgeCarryingWebContents: (webContentsId) =>
            mainIpcCallerGuard().check({ senderId: webContentsId, isMainFrame: true }).allowed,
          isTrustedDocumentUrl: isTrustedMainRendererUrl,
        },
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
      // Rejected too, so a serving push or a provider-config delivery waiting on
      // the daemon reports the startup failure instead of waiting forever.
      daemonEndpoint.reject(error)
      throw error
    }
  })()

  const globals = {
    updaterEnabled: UPDATER_ENABLED,
    packaged: IS_PACKAGED,
    wsl: getWslConfig().enabled,
    deepLinks: pendingDeepLinks,
  }

  logger.log("loading main window alongside embedded server")
  mainWindow = createMainWindow(globals)
  lifecycle.keepOnClose(mainWindow)
  wireFullscreenEvents(mainWindow)
  wireMenu()

  try {
    await loadingTask
  } catch (error) {
    logger.error("embedded server initialization failed", { error: String(error) })
    setInitStep({ phase: "done" })
    return
  }
  setInitStep({ phase: "done" })
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    checkForUpdates: () => {
      void autoUpdate.run(true)
    },
    reload: () => mainWindow?.reload(),
    restart: () =>
      runRestart({
        packaged: IS_PACKAGED,
        relaunch: () => app.relaunch(),
        quit: () => void lifecycle.requestExit("handoff", () => app.quit()),
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
  readCaller: (event) => ({
    senderId: event.sender.id,
    // Null when the frame is already gone, which is not a top frame and so
    // fails closed.
    isMainFrame: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
  }),
  onRejected: (channel, reason) => logger.warn(`[security] ${reason} (channel ${channel})`),
})

// After the guard above, like every other registration — these channels spend
// an account credential, so an unguarded one would be the worst of the sixty to
// leave open.
const bakedAccountConfig = import.meta.env as Record<string, string | undefined>
let hostConnector: ReturnType<typeof setupElectronHostConnector> | undefined
let agentPluginsSync: AgentPluginsSignedSync | undefined
const account = setupLazyAccount({
  ipcMain,
  userDataDir: app.getPath("userData"),
  adapterReady: app.whenReady(),
  env: accountConfigEnvironment(process.env, bakedAccountConfig),
  cliSignInMode: () => readCliSignInMode(store),
  onError: (stage, error) => logger.warn(`[account] ${stage}: ${String(error)}`),
  // An activation made from this machine is applied here at once rather than
  // at the next timed pull; the pull itself stays the only path to the daemon.
  onOperation: (name) => {
    if (name.startsWith("agentPlugins.") && name !== "agentPlugins.runtimeSelf") void agentPluginsSync?.refresh()
  },
  onStateChange: (next, previous) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ACCOUNT_STATE_CHANGED_CHANNEL, next)
    agentPluginsSync?.follow(next)
    // Remote access follows the account, in BOTH directions.
    //
    // Stopping on auth loss is the fail-closed half: the moment the account is
    // not signed, this machine stops beating with a credential the deployment
    // may have revoked.
    //
    // The other half covers a control-plane blip. A descriptor 503 of a couple
    // of seconds puts the account in `unavailable`, the connector stops, the
    // 60s enrollment lease expires, and every client is told this machine is
    // offline. `suspendForAuthLapse` records that the stop was not a decision
    // so the return trip can undo it, and only it: a user pause or revoke
    // clears that flag inside the supervisor, so "the user turned it off" is
    // never auto-undone by a later sign-in.
    const follow = remoteAccessFollow(previous, next)
    if (follow === "suspend") {
      if (hostConnector?.suspendForAuthLapse()) {
        logger.warn(
          `[host-connector] auth-lapse-suspend: account left "signed" (now "${next.status}") — remote access stopped; it will resume if the account returns`,
        )
      }
      return
    }
    if (follow === "resume") {
      void hostConnector
        ?.resumeAfterAuthLapse()
        .then((resumed) => {
          // `undefined` means the last stop was not a lapse — most often that
          // the connector was never running. Nothing happened, so nothing is
          // claimed.
          if (!resumed) return
          logger.log(
            `[host-connector] auth-lapse-resume: account is signed again — remote access restarted, state "${resumed.status}"`,
          )
        })
        .catch((error) => logger.warn(`[host-connector] auth-lapse-resume: ${String(error)}`))
    }
  },
})

/**
 * The last ack's serving facts, retained so a daemon that becomes ready AFTER
 * the first ack still starts serving immediately — with the addresses that ack
 * named, not just its credential.
 */
let lastServing: HostConnectorServing | undefined
const sendServing = setupHostServingPush({
  daemon,
  log: { info: (message) => logger.info(message), warn: (message) => logger.warn(message) },
})
const pushServing = async (serving: HostConnectorServing) => {
  lastServing = serving
  await sendServing(serving)
}
void daemonEndpoint.promise.then(
  () => {
    if (lastServing) void pushServing(lastServing)
  },
  // A daemon that never became reachable is already reported by the startup
  // path; this retry has nothing left to push and must not become an unhandled
  // rejection on the way to saying so.
  () => {},
)
/**
 * Recovery reaches a live daemon over the authenticated fetch main already
 * holds, and falls back to the launch result when there is no daemon to ask.
 * `daemonConnected` is the difference: an endpoint this process never resolved
 * has no capability to forward with.
 */
let daemonConnected = false
void daemonEndpoint.promise.then(
  () => { daemonConnected = true },
  () => {},
)
const recovery = daemonRecoveryBridge({
  daemon: () => (daemonConnected ? daemon : undefined),
  unresolved: () => unresolvedDaemon,
  ownershipView: () => readDaemonOwnershipView(claxedoDaemonOwnershipPath(desktopServerDataDir())),
  // A verified exit is the only thing that makes a replacement safe, and the
  // replacement is this app starting over: the daemon is launched from startup,
  // not from here.
  onRecovered: (result) => {
    if (!result.replacementAllowed) return
    unresolvedDaemon = undefined
    runRestart({
      packaged: IS_PACKAGED,
      relaunch: () => app.relaunch(),
      quit: () => void lifecycle.requestExit("handoff", () => app.quit()),
      reload: () => mainWindow?.webContents.reloadIgnoringCache(),
    })
  },
})
ipcMain.handle(DAEMON_RECOVERY_CHANNELS.inspect, () => recovery.inspect())
ipcMain.handle(DAEMON_RECOVERY_CHANNELS.submit, (_event, request: unknown) => recovery.submit(request))
ipcMain.handle(DAEMON_RECOVERY_CHANNELS.read, (_event, operationId: unknown) => recovery.read(operationId))

const daemonStatus = createDaemonStatus({ restart: restartBehavior(IS_PACKAGED), target: () => mainWindow ?? undefined })
ipcMain.handle(DAEMON_STATUS_CHANNELS.read, () => daemonStatus.current())

const providerConfigPush = setupHostProviderConfigPush({
  daemon,
  daemonReady: () => daemonEndpoint.promise,
  log: { info: (message) => logger.info(message), warn: (message) => logger.warn(message) },
})

// The signed Agent Plugins world follows the account the same way remote
// access does: main pulls it with the credential only main holds and the daemon
// materializes it. A daemon built without Agent Plugins answers 404 and the
// sync goes quiet; nothing here decides whether the feature exists.
agentPluginsSync = setupAgentPluginsSignedSync({
  enabled: true,
  runAccountOperation: (name, params) => account.run(name, params),
  daemon,
  log: { info: (message) => logger.log(message), warn: (message) => logger.warn(message) },
})
void account.ready.then(() => agentPluginsSync?.follow(account.state()))

const accountConfig = readAccountConfig(accountConfigEnvironment(process.env, bakedAccountConfig))

/**
 * Machine remote access, constructed but NOT started.
 *
 * Constructing mints no key, writes nothing and sends no traffic — that all
 * happens in `start()`. So an unsigned launch, which is most launches, enrolls
 * nothing and leaves no machine identity on disk.
 *
 * Nothing in this file calls `start()`: enrolling because an account happens
 * to be signed in would be the desktop deciding to publish the user's laptop
 * for them. The only trigger is `registerHostConnectorIpc` below — one named
 * operation that runs when the user presses Enable in the Remote Access
 * surface. `ipc-caller-guard.wiring.test.ts` asserts this file contains no
 * `.start(` call.
 *
 * The machine's label is chosen HERE, not sent from the renderer. It is main
 * that signs the enrollment, so main names the thing it is signing for, and a
 * renderer asked to name the machine can only describe the browser it is. The
 * derivation is `@claxedo/helpers/machine-name`, shared with `claxedo connect`
 * so one machine gets one name however it publishes itself. An owner's
 * rename outranks it and is what `electron-child.ts` stores. Neither is the
 * machine's identity, which is the key in `identity-store.ts`.
 */
hostConnector = setupElectronHostConnector({
  runAccountOperation: (name, params) => account.run(name, params),
  // The machine beats with its own key from the enrollment onward, so the
  // child needs the deployment by name. It is the account's own origin: a
  // credential is bound to one control plane, and the enrollment lives there.
  ...(accountConfig.configured ? { controlPlaneUrl: accountConfig.coreOrigin } : {}),
  describeWorkspace: (workspaceId) => describeLocalWorkspace(daemon, workspaceId),
  safeStorage,
  userDataDir: app.getPath("userData"),
  // Bound, not passed bare: `fork` is a method on Electron's utilityProcess
  // and needs its receiver.
  fork: utilityProcess.fork.bind(utilityProcess),
  packaged: IS_PACKAGED,
  mainDir: MAIN_DIR,
  resourcesPath: process.resourcesPath,
  derivedDisplayName: machineDisplayName(process.platform),
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
  onServing: (serving) => {
    void pushServing(serving)
    // Every serving beat is also when main re-checks that the daemon still
    // holds the pushed rows: it keeps them in memory alone, so a daemon that
    // restarted mid-session serves turns with no provider credentials while
    // the control plane still shows the revision acked.
    void providerConfigPush.reconcile()
  },
  onProviderConfig: (config) => void providerConfigPush.push(config),
  // The daemon composed this machine's workspace runtimes, so the daemon is
  // the only process that knows how they admit sessions. Read it from the
  // same loopback surface the serving credential is pushed to, and let the
  // connector declare it on every heartbeat: a client of this machine learns
  // from the declaration whether a session it creates here must be
  // registered with the control plane first (a client on the hosted plane
  // registers regardless of it).
  sessionAuthority: async () => {
    const response = await daemon("/api/claxedo/host-serving")
    if (!response.ok) throw new Error(`HOSTED_HTTP ${String(response.status)} ${(await response.text()).slice(0, 200)}`)
    const sessionAuthority = readString(await response.json(), "sessionAuthority")
    return sessionAuthority === "local" || sessionAuthority === "managed-private" ? sessionAuthority : undefined
  },
})

/** The facts the connector's own state cannot carry. See `status-channel.ts`. */
function hostConnectorContext() {
  return {
    available: hostConnector !== undefined,
    signedIn: account.state().status === "signed",
    ...(hostConnector ? { displayName: hostConnector.displayName() } : {}),
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
  context: hostConnectorContext,
  onError: (stage, error) => logger.warn(`[host-connector] ${stage}: ${String(error)}`),
})
logger.log("host connector", { available: true, state: hostConnector.status().status })

registerIpcHandlers({
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
  runUpdater: autoUpdate.run,
  checkUpdate: autoUpdate.check,
  installUpdate: autoUpdate.install,
  getStartAtLogin: () => startAtLogin.get(),
  setStartAtLogin: (enabled) => startAtLogin.set(enabled),
  renderMermaid: createNativeMermaidRenderer(mermaidRendererPath),
  browser: browserRegistry,
})

if (browserTabSetup) {
  logger.log("browser-tab feature enabled", { partition: browserTabSetup.partition })
}

async function exitApp(intent: ExitIntent) {
  const lease = daemonLease
  daemonLease = undefined
  await lease?.stop()
  hostConnector?.dispose()
  if (intent === "handoff" || !leasedDaemon || !daemonConnected) return
  await stopPublishedDaemon(leasedDaemon, recovery, (message, fields) => logger.warn(message, fields))
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
