import fs from "node:fs/promises"
import path from "node:path"
import { errorMessage } from "@claxedo/helpers"
import { deadlineAfter, harnessVersionStanding, type Deadline, type DraftProbeCache, type HarnessServices, type HarnessVersionGate,
  type SessionBroker, type SpawnCommand, type StartInput } from "../../contract/node"
import { TransportError } from "../../contract/errors"
import { piEnvironment, piProjectionArgs, preparePiProfile, type PiProfile, type PiProfileOptions } from "../../profiles/pi"
import { PiRpc } from "./rpc"
import { installPiTitleExtension } from "./title"
import { piMcpHandoff, type PiMcpHandoff } from "./mcp"
import type { UnsettledPiLaunches } from "./retirements"
import { PiSessionStream } from "./session-stream"
import { PI_RANGE, piReportedVersion } from "./version"

export type PiRpcOptions = PiProfileOptions & { binary: string; runtime: string; env: NodeJS.ProcessEnv }

export type PiResume = { file: string } | { id: string }

export type PiLaunch = { role: "harness"; resume?: PiResume } | { role: "probe" }

export type PiLaunchHost = {
  readonly services: HarnessServices
  readonly options: PiRpcOptions
  readonly signal: AbortSignal
  readonly unsettled: UnsettledPiLaunches
  readonly versions: HarnessVersionGate
  readonly versionReadings: DraftProbeCache<string>
  disposed(): boolean
}

export const piDeadline = (clock: HarnessServices["clock"]): Deadline => deadlineAfter(clock, 15_000)

export async function retiringOnFailure<T>(host: PiLaunchHost, rpc: PiRpc, work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) { await host.unsettled.retire(rpc); throw error }
}

async function harnessArgs(host: PiLaunchHost, launch: Extract<PiLaunch, { role: "harness" }>, mcp: PiMcpHandoff | undefined): Promise<string[]> {
  return ["-e", await installPiTitleExtension(host.options.stateRoot), ...mcp?.args ?? [],
    ...(!launch.resume ? [] : "file" in launch.resume ? ["--session", launch.resume.file] : ["--session-id", launch.resume.id])]
}

function piCommand(host: PiLaunchHost, input: StartInput, profile: PiProfile, args: readonly string[], env: Record<string, string> = {}): SpawnCommand {
  const binary = host.options.binary
  const command = /\.[cm]?js$/.test(binary) ? { file: host.options.runtime, args: [binary, ...args] } : { file: binary, args }
  return { ...command, cwd: input.directory, env: { ...piEnvironment(profile, host.options.env), ...env } }
}

async function admitPiVersion(host: PiLaunchHost, input: StartInput, profile: PiProfile, broker: SessionBroker | undefined,
  role: PiLaunch["role"]): Promise<void> {
  const read = async () => {
    const owned = await host.services.spawn(piCommand(host, input, profile, ["--version"]),
      { role, label: "Pi version", sessionId: input.sessionId, signal: host.signal })
    return piReportedVersion(owned, piDeadline(host.services.clock))
  }
  const { binary } = host.options
  const reported = path.isAbsolute(binary) ? await host.versionReadings.read(binary, { files: [binary] }, read) : await read()
  if (broker) await host.versions.admit(reported, "--version", broker)
  else harnessVersionStanding(PI_RANGE, reported)
}

async function spawnPi<T>(host: PiLaunchHost, input: StartInput, profile: PiProfile, broker: SessionBroker | undefined, launch: PiLaunch,
  observe: (rpc: PiRpc) => T): Promise<{ rpc: PiRpc; observed: T }> {
  if (host.disposed()) throw new TransportError("pi", "process", "Pi transport disposed")
  host.unsettled.retryHeld()
  await admitPiVersion(host, input, profile, broker, launch.role)
  await preparePiProfile(profile, input.model)
  const mcp = launch.role === "harness" ? await piMcpHandoff(host.options.stateRoot, input, host.services) : undefined
  try {
    const args = ["--mode", "rpc", ...(launch.role === "probe" ? ["--no-session"] : ["--session-dir", profile.sessionDir]),
      ...piProjectionArgs(input.projection), ...(launch.role === "harness" ? await harnessArgs(host, launch, mcp) : [])]
    const owned = await host.services.spawn(piCommand(host, input, profile, args, mcp?.env),
      { role: launch.role, label: "Pi RPC", sessionId: input.sessionId, signal: host.signal })
    const rpc = new PiRpc(owned, host.services.clock, (event) => {
      if (broker) void broker.publish(event).catch((error: unknown) =>
        host.services.log.error("Pi RPC diagnostic publication failed", { error: errorMessage(error) }))
      else host.services.log.warn(event.diagnostic.message, { code: event.diagnostic.code, raw: event.diagnostic.raw })
    })
    const observed = observe(rpc)
    await retiringOnFailure(host, rpc, async () => {
      await rpc.request("get_state")
      await mcp?.consumed()
    })
    return { rpc, observed }
  } finally { await mcp?.discard() }
}

export async function launchPiProbe(host: PiLaunchHost, input: StartInput, profile: PiProfile): Promise<PiRpc> {
  return (await spawnPi(host, input, profile, undefined, { role: "probe" }, () => undefined)).rpc
}

export type PiSessionLaunch = { rpc: PiRpc; stream: PiSessionStream }

export async function launchPiSession(host: PiLaunchHost, input: StartInput, profile: PiProfile, broker: SessionBroker,
  resume?: PiResume): Promise<PiSessionLaunch> {
  const { clock, log } = host.services
  const { rpc, observed } = await spawnPi(host, input, profile, broker, { role: "harness", ...(resume ? { resume } : {}) }, (rpc) =>
    new PiSessionStream({ sessionId: input.sessionId, rpc, broker, clock, log, stop: () => rpc.stop(piDeadline(clock)) }))
  return { rpc, stream: observed }
}

export function piUpstreamOf(host: PiLaunchHost, rpc: PiRpc): Promise<string> {
  return retiringOnFailure(host, rpc, async () => {
    const state = await rpc.request("get_state")
    if (state && typeof state === "object" && "sessionId" in state && typeof state.sessionId === "string") return state.sessionId
    throw new TransportError("pi", "protocol", "Pi did not return a session id")
  })
}

export async function resumePi(host: PiLaunchHost, input: StartInput, profile: PiProfile, broker: SessionBroker,
  upstreamSessionId: string, hasTurns: boolean): Promise<PiSessionLaunch> {
  const launched = await launchPiSession(host, input, profile, broker, await piResume(profile, upstreamSessionId, hasTurns))
  if (await piUpstreamOf(host, launched.rpc) === upstreamSessionId) return launched
  await host.unsettled.retire(launched.rpc)
  throw new TransportError("pi", "session", "Pi resumed a different session")
}

async function piResume(profile: PiProfile, upstreamSessionId: string, hasTurns: boolean): Promise<PiResume> {
  const files = await fs.readdir(profile.sessionDir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  })
  const file = files.find((name) => name.endsWith(`_${upstreamSessionId}.jsonl`))
  if (file) return { file: path.join(profile.sessionDir, file) }
  if (!hasTurns) return { id: upstreamSessionId }
  throw new TransportError("pi", "session", `Pi session ${upstreamSessionId} has had turns, but its session file is gone from ${profile.sessionDir}`,
    { retryable: false, detail: { upstreamSessionId, sessionDir: profile.sessionDir } })
}
