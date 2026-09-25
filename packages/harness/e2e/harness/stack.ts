import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { dropRecoveryContext, releaseAcpHold, writeAcpScript, type AcpScript } from "./acp/script"
import { refuseGoalStart } from "./acp/goals"
import { startDaemon, type Daemon } from "./daemon"
import { startEgressGuard, type EgressGuard } from "./egress-guard"
import { claimPort, fixedDaemonPort, portFreed, portIsLeased, releasePort, reservePort } from "./ports"
import { startScriptedModelServer, type ScriptedModelServer } from "./scripted-model-server"
import { openEventStream, type EventStream, type EventStreamOptions } from "./stream"

export type Stack = {
  url: string
  dataDir: string
  daemon: Daemon
  scripted: ScriptedModelServer
  egress: EgressGuard
  acp: {
    scriptDir: string
    write(name: string, script: AcpScript): Promise<void>
    release(name: string): Promise<void>
    refuseGoalStart(): void
    dropRecoveryContext(): void
  }
  events(directory: string, options?: EventStreamOptions): Promise<EventStream>
  close(): Promise<void>
}

export type StackInput = { label: string; red?: boolean }

export function safeLabel(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "flow"
}

export async function startStack(input: StackInput): Promise<Stack> {
  const red = input.red ?? process.env.CLAXEDO_E2E_RED === "1"
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-e2e-${safeLabel(input.label)}-`))
  const fixed = fixedDaemonPort()
  const daemonPort = fixed !== undefined && !portIsLeased(fixed) ? await claimPort(fixed) : await reservePort()
  const modelPort = await reservePort()
  const guardPort = await reservePort()
  const keepData = process.env.CLAXEDO_E2E_KEEP_DATA === "1"
  const cleanup = async () => {
    releasePort(guardPort)
    releasePort(modelPort)
    if (!(await portFreed(daemonPort, 10_000))) throw new Error(`Daemon port ${daemonPort} stayed occupied`)
    releasePort(daemonPort)
    if (!keepData) await fs.rm(dataDir, { recursive: true, force: true })
  }
  const egress = await startEgressGuard(guardPort)
  let scripted: ScriptedModelServer
  try {
    scripted = await startScriptedModelServer({ port: modelPort, red })
  } catch (error) {
    await egress.close()
    await cleanup()
    throw error
  }
  let daemon: Daemon
  try {
    daemon = await startDaemon({ dataDir, scripted, guardUrl: egress.url, port: daemonPort, red })
  } catch (error) {
    await egress.close()
    await scripted.close()
    await cleanup()
    throw error
  }
  const streams: EventStream[] = []
  return {
    url: daemon.url,
    dataDir,
    daemon,
    scripted,
    egress,
    acp: {
      scriptDir: daemon.acpScriptDir,
      write: (name, script) => writeAcpScript(daemon.acpScriptDir, name, script),
      release: (name) => releaseAcpHold(daemon.acpScriptDir, name),
      refuseGoalStart: () => refuseGoalStart(daemon.acpScriptDir),
      dropRecoveryContext: () => dropRecoveryContext(daemon.acpScriptDir),
    },
    events: async (directory, options) => {
      const stream = await openEventStream(daemon.url, directory, options)
      streams.push(stream)
      return stream
    },
    close: async () => {
      for (const stream of streams) stream.close()
      await daemon.close()
      await scripted.close()
      await egress.close()
      await cleanup()
    },
  }
}
