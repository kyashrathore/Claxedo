import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { releaseAcpHold, writeAcpScript, type AcpScript } from "./acp/script"
import { appChoice, appDistDir, type AppChoice } from "./app"
import { startDaemon, type Daemon } from "./daemon"
import { startEgressGuard, type EgressGuard } from "./egress-guard"
import { serveGitRemote, type GitRemote } from "./git-remote"
import { serveLocalPages, type LocalPages } from "./local-pages"
import { serveConnectionSink, type ConnectionSink } from "./connection-sink"
import { claimPort, fixedDaemonPort, portFreed, portIsLeased, releasePort, reservePort } from "./ports"
import { startScriptedModelServer, type ScriptedModelServer } from "./scripted-model-server"
import { openEventStream, type EventStream, type EventStreamOptions } from "./stream"

export type Stack = {
  app: AppChoice
  url: string
  dataDir: string
  daemon: Daemon
  scripted: ScriptedModelServer
  egress: EgressGuard
  acp: {
    scriptDir: string
    write(name: string, script: AcpScript): Promise<void>
    release(name: string): Promise<void>
  }
  events(directory: string, options?: EventStreamOptions): Promise<EventStream>
  gitRemote(name: string): Promise<GitRemote>
  localPages(pages: Readonly<Record<string, string>>): Promise<LocalPages>
  connectionSink(): Promise<ConnectionSink>
  close(): Promise<void>
}

export type StackInput = { label: string; red?: boolean }

export function safeLabel(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "spec"
}

export function redRun() {
  return process.env.CLAXEDO_E2E_RED === "1"
}

export async function startStack(input: StackInput): Promise<Stack> {
  const app = appChoice()
  const distDir = appDistDir(app)
  if (!existsSync(path.join(distDir, "index.html"))) {
    throw new Error(`${app} is not built at ${distDir}; run the suite through e2e/run.ts so global setup builds it`)
  }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-e2e-${safeLabel(input.label)}-`))
  const fixed = fixedDaemonPort()
  const daemonPort = fixed !== undefined && !portIsLeased(fixed) ? await claimPort(fixed) : await reservePort()
  const modelPort = await reservePort()
  const guardPort = await reservePort()
  const keepData = process.env.CLAXEDO_E2E_KEEP_DATA === "1"
  const cleanup = async () => {
    releasePort(guardPort)
    releasePort(modelPort)
    await portFreed(daemonPort, 10_000)
    releasePort(daemonPort)
    if (!keepData) await fs.rm(dataDir, { recursive: true, force: true })
  }
  const egress = await startEgressGuard(guardPort)
  let scripted: ScriptedModelServer
  try {
    scripted = await startScriptedModelServer({ port: modelPort })
  } catch (error) {
    await egress.close()
    await cleanup()
    throw error
  }
  let daemon: Daemon
  try {
    daemon = await startDaemon({ dataDir, distDir, scripted, guardUrl: egress.url, port: daemonPort, red: input.red ?? redRun() })
  } catch (error) {
    await egress.close()
    await scripted.close()
    await cleanup()
    throw error
  }
  const streams: EventStream[] = []
  const sideServers: { server: { close(): Promise<void> }; port: number }[] = []
  const startSideServer = async <T extends { close(): Promise<void> }>(start: (port: number) => Promise<T>) => {
    const port = await reservePort()
    try {
      const server = await start(port)
      sideServers.push({ server, port })
      return server
    } catch (error) {
      releasePort(port)
      throw error
    }
  }
  return {
    app,
    url: daemon.url,
    dataDir,
    daemon,
    scripted,
    egress,
    acp: {
      scriptDir: daemon.acpScriptDir,
      write: (name, script) => writeAcpScript(daemon.acpScriptDir, name, script),
      release: (name) => releaseAcpHold(daemon.acpScriptDir, name),
    },
    events: async (directory, options) => {
      const stream = await openEventStream(daemon.url, directory, options)
      streams.push(stream)
      return stream
    },
    gitRemote: (name) => startSideServer((port) => serveGitRemote({ root: path.join(dataDir, "git-remotes"), name, port })),
    localPages: (pages) => startSideServer((port) => serveLocalPages({ pages, port })),
    connectionSink: () => startSideServer((port) => serveConnectionSink(port)),
    close: async () => {
      for (const stream of streams) stream.close()
      for (const { server, port } of sideServers) {
        await server.close()
        releasePort(port)
      }
      await daemon.close()
      await scripted.close()
      await egress.close()
      await cleanup()
    },
  }
}
