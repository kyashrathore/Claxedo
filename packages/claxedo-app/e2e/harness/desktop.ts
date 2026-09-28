import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { releaseAcpHold, writeAcpScript, type AcpScript } from "../../../harness/e2e/harness/acp/script"
import { ClaxedoApi } from "./api"
import { serveConnectionSink, type ConnectionSink } from "./connection-sink"
import { DESKTOP_DIR, DESKTOP_MAIN } from "./desktop-build"
import { daemonExited, desktopDaemonPid } from "./desktop-daemon"
import { serveRenderer, type DesktopRenderer, type RendererServer } from "./desktop-renderer"
import { startEgressGuard, type EgressGuard } from "../../../harness/e2e/harness/egress-guard"
import type { TlsTrust } from "./tls-front"
import { isolatedEnv } from "../../../harness/e2e/harness/isolated-env"
import { APP_AGENT_ENV } from "./agent-env"
import { writeScriptedModelCatalog } from "../../../harness/e2e/harness/model-catalog"
import { releasePort, reservePort } from "../../../harness/e2e/harness/ports"
import { startScriptedModelServer, type ScriptedModelServer } from "../../../harness/e2e/harness/scripted-model-server"
import { prepareScriptedServer } from "./scripted-world"
import { safeLabel } from "./stack"
import type { HttpTransport } from "../../../harness/e2e/harness/transport"
import { pageTransport } from "./page-transport"
import { makeWorkspace, type Workspace } from "../../../harness/e2e/harness/workspaces"

const SHELL_DOCUMENT = /index\.local\.html$/

export type Desktop = {
  electron: ElectronApplication
  window: Page
  url: string
  api: ClaxedoApi
  dataDir: string
  scripted: ScriptedModelServer
  egress: EgressGuard
  acp: { scriptDir: string; write(name: string, script: AcpScript): Promise<void>; release(name: string): Promise<void> }
  makeWorkspace(name: string, projectName?: string): Promise<Workspace>
  connectionSink(): Promise<ConnectionSink>
  log(): string
  close(): Promise<void>
}

type DesktopWorld = {
  dataDir: string
  serverPort: number
  egress: EgressGuard
  scripted: ScriptedModelServer
  acpScriptDir: string
  rendererUrl: string | undefined
  close(): Promise<void>
}

async function startRendererServer(renderer: DesktopRenderer, ports: number[]): Promise<RendererServer | undefined> {
  if (renderer === "file") return undefined
  const port = await reservePort()
  ports.push(port)
  return serveRenderer(port)
}

async function startWorld(label: string, renderer: DesktopRenderer): Promise<DesktopWorld> {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-e2e-desktop-${safeLabel(label)}-`)))
  const ports = [await reservePort(), await reservePort(), await reservePort()]
  const release = async () => {
    for (const port of ports) releasePort(port)
    if (process.env.CLAXEDO_E2E_KEEP_DATA !== "1") await fs.rm(dataDir, { recursive: true, force: true })
  }
  const egress = await startEgressGuard(ports[0])
  let scripted: ScriptedModelServer
  let rendererServer: RendererServer | undefined
  try {
    scripted = await startScriptedModelServer({ port: ports[1] })
  } catch (error) {
    await egress.close()
    await release()
    throw error
  }
  try {
    rendererServer = await startRendererServer(renderer, ports)
  } catch (error) {
    await scripted.close()
    await egress.close()
    await release()
    throw error
  }
  const acpScriptDir = path.join(dataDir, "acp-scripts")
  await fs.mkdir(acpScriptDir, { recursive: true })
  const close = async () => {
    await rendererServer?.close()
    await scripted.close()
    await egress.close()
    await release()
  }
  return { dataDir, serverPort: ports[2], egress, scripted, acpScriptDir, rendererUrl: rendererServer?.url, close }
}

function serverDataDir(world: DesktopWorld) {
  return path.join(world.dataDir, "server-data")
}

export type DesktopAccount = { coreOrigin: string; trust: TlsTrust }

async function desktopEnv(world: DesktopWorld, account: DesktopAccount | undefined) {
  const zdotdir = path.join(world.dataDir, "zdotdir")
  await fs.mkdir(zdotdir, { recursive: true })
  const entries = {
    ...(await isolatedEnv(world.dataDir, world.egress.url, APP_AGENT_ENV)),
    CLAXEDO_OPENCODE_CATALOG_CACHE: await writeScriptedModelCatalog(world.dataDir),
    CLAXEDO_DESKTOP_USER_DATA_DIR: path.join(world.dataDir, "user-data"),
    CLAXEDO_DATA_DIR: serverDataDir(world),
    CLAXEDO_SERVER_PORT: String(world.serverPort),
    ZDOTDIR: zdotdir,
    ELECTRON_RENDERER_URL: world.rendererUrl,
    ...(account ? { CLAXEDO_CORE_ORIGIN: account.coreOrigin, NODE_EXTRA_CA_CERTS: account.trust.caPath } : {}),
  }
  return Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

const MOCK_KEYCHAIN = "use-mock-keychain"

async function refuseRealKeychain(app: ElectronApplication) {
  if (process.platform !== "darwin") return
  const cut = await app.evaluate(({ app: main }, name) => main.commandLine.hasSwitch(name), MOCK_KEYCHAIN)
  if (!cut) throw new Error(`a signed desktop runs only with --${MOCK_KEYCHAIN}: without it safeStorage writes this Mac's login keychain`)
}

async function launchElectron(world: DesktopWorld, account: DesktopAccount | undefined) {
  const trust = account ? [`--ignore-certificate-errors-spki-list=${account.trust.spki}`] : []
  const keychain = process.platform === "darwin" ? [`--${MOCK_KEYCHAIN}`] : []
  return electron.launch({
    args: [DESKTOP_MAIN, `--user-data-dir=${path.join(world.dataDir, "chromium")}`, ...keychain, ...trust],
    cwd: DESKTOP_DIR,
    env: await desktopEnv(world, account),
    timeout: 60_000,
  })
}

async function shellWindow(app: ElectronApplication): Promise<Page> {
  for (;;) {
    const shell = app.windows().find((page) => SHELL_DOCUMENT.test(page.url()))
    if (shell) return shell
    const next = await Promise.race([
      app.waitForEvent("window", { timeout: 60_000 }),
      ...app.windows().map((page) => page.waitForURL(SHELL_DOCUMENT, { timeout: 60_000 }).then(() => page)),
    ])
    if (SHELL_DOCUMENT.test(next.url())) return next
  }
}

type PreloadBridge = { awaitInitialization(onStep: () => void): Promise<unknown> }

async function serverPublished(window: Page) {
  await window.evaluate(async () => {
    const bridge = (globalThis as { api?: PreloadBridge }).api
    if (!bridge) throw new Error("the desktop window has no preload bridge")
    await bridge.awaitInitialization(() => undefined)
  })
}

function captureOutput(app: ElectronApplication) {
  const output: string[] = []
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()))
  app.process().stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()))
  return () => output.join("")
}

type DesktopParts = {
  app: ElectronApplication
  window: Page
  transport: HttpTransport
  connectionSink: () => Promise<ConnectionSink>
  log: () => string
  close: () => Promise<void>
}

function desktopHandle(world: DesktopWorld, parts: DesktopParts): Desktop {
  const url = `http://127.0.0.1:${world.serverPort}`
  return {
    electron: parts.app,
    window: parts.window,
    url,
    api: new ClaxedoApi(url, parts.transport),
    dataDir: world.dataDir,
    scripted: world.scripted,
    egress: world.egress,
    acp: {
      scriptDir: world.acpScriptDir,
      write: (name, script) => writeAcpScript(world.acpScriptDir, name, script),
      release: (name) => releaseAcpHold(world.acpScriptDir, name),
    },
    makeWorkspace: (name, projectName) => makeWorkspace(parts.transport, url, path.join(world.dataDir, "workspaces"), name, projectName),
    connectionSink: parts.connectionSink,
    log: parts.log,
    close: parts.close,
  }
}

export async function launchDesktop(input: { label: string; red: boolean; renderer: DesktopRenderer; account?: DesktopAccount }): Promise<Desktop> {
  const world = await startWorld(input.label, input.renderer)
  let app: ElectronApplication
  try {
    app = await launchElectron(world, input.account)
  } catch (error) {
    await world.close()
    throw error
  }
  const log = captureOutput(app)
  const sinks: ConnectionSink[] = []
  const connectionSink = async () => {
    const port = await reservePort()
    try {
      const sink = await serveConnectionSink(port)
      sinks.push(sink)
      return sink
    } catch (error) {
      releasePort(port)
      throw error
    }
  }
  const close = async () => {
    for (const sink of sinks) {
      await sink.close()
      releasePort(sink.port)
    }
    const daemon = await desktopDaemonPid(serverDataDir(world))
    await app.close()
    if (daemon !== undefined) await daemonExited(daemon)
    await world.close()
  }
  const url = `http://127.0.0.1:${world.serverPort}`
  try {
    if (input.account) await refuseRealKeychain(app)
    const window = await shellWindow(app)
    await serverPublished(window)
    const transport = pageTransport(window)
    await prepareScriptedServer(transport, url, { scripted: world.scripted, acpScriptDir: world.acpScriptDir, red: input.red })
    await window.reload()
    return desktopHandle(world, { app, window, transport, connectionSink, log, close })
  } catch (error) {
    const failure = new Error(`the desktop did not start:\n${log().split("\n").slice(-40).join("\n")}`, { cause: error })
    try {
      await close()
    } catch (closing) {
      console.error("closing a desktop that did not start failed too", closing)
    }
    throw failure
  }
}
