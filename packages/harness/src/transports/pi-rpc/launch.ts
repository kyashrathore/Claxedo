import fs from "node:fs/promises"
import path from "node:path"
import { errorMessage } from "@claxedo/helpers"
import { deadlineAfter, type Deadline, type HarnessServices, type SessionBroker, type StartInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { piEnvironment, piProjectionArgs, preparePiProfile, type PiProfile, type PiProfileOptions } from "../../profiles/pi"
import { PiRpc } from "./rpc"
import { installPiTitleExtension } from "./title"
import { connectPiMcp, installPiMcpExtension } from "./mcp"
import type { UnsettledPiLaunches } from "./retirements"

export type PiRpcOptions = PiProfileOptions & { binary: string; runtime: string; args?: readonly string[]; env: NodeJS.ProcessEnv }

export type PiLaunch = { role: "harness"; resume?: string } | { role: "probe" }

export type PiLaunchHost = {
  readonly services: HarnessServices
  readonly options: PiRpcOptions
  readonly signal: AbortSignal
  readonly unsettled: UnsettledPiLaunches
  disposed(): boolean
}

export const piDeadline = (clock: HarnessServices["clock"]): Deadline => deadlineAfter(clock, 15_000)

export async function retiringOnFailure<T>(host: PiLaunchHost, rpc: PiRpc, work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) { await host.unsettled.retire(rpc); throw error }
}

async function harnessArgs(host: PiLaunchHost, launch: Extract<PiLaunch, { role: "harness" }>, mcp: boolean): Promise<string[]> {
  return ["-e", await installPiTitleExtension(host.options.stateRoot),
    ...(mcp ? ["-e", await installPiMcpExtension(host.options.stateRoot)] : []),
    ...(launch.resume ? ["--session", launch.resume] : [])]
}

export async function launchPi(host: PiLaunchHost, input: StartInput, profile: PiProfile, broker: SessionBroker | undefined, launch: PiLaunch): Promise<PiRpc> {
  if (host.disposed()) throw new TransportError("pi", "process", "Pi transport disposed")
  host.unsettled.retryHeld()
  await preparePiProfile(profile, input.model)
  const mcp = launch.role === "harness" ? host.services.firstPartyMcp(input.sessionId, input.locality) : undefined
  const args = ["--mode", "rpc", ...(launch.role === "probe" ? ["--no-session"] : ["--session-dir", profile.sessionDir]),
    ...piProjectionArgs(input.projection), ...host.options.args ?? [],
    ...(launch.role === "harness" ? await harnessArgs(host, launch, mcp !== undefined) : [])]
  const binary = host.options.binary
  const command = /\.[cm]?js$/.test(binary) ? { file: host.options.runtime, args: [binary, ...args] } : { file: binary, args }
  const owned = await host.services.spawn({ ...command, cwd: input.directory, env: piEnvironment(profile, host.options.env) },
    { role: launch.role, label: "Pi RPC", sessionId: input.sessionId, signal: host.signal })
  const rpc = new PiRpc(owned, host.services.clock, (event) => {
    if (broker) void broker.publish(event).catch((error: unknown) =>
      host.services.log.error("Pi RPC diagnostic publication failed", { error: errorMessage(error) }))
    else host.services.log.warn(event.diagnostic.message, { code: event.diagnostic.code, raw: event.diagnostic.raw })
  })
  await retiringOnFailure(host, rpc, async () => {
    await rpc.request("get_state")
    if (mcp) await connectPiMcp(rpc, host.services.clock, host.options.stateRoot, mcp)
  })
  return rpc
}

export function piUpstreamOf(host: PiLaunchHost, rpc: PiRpc): Promise<string> {
  return retiringOnFailure(host, rpc, async () => {
    const state = await rpc.request("get_state")
    if (state && typeof state === "object" && "sessionId" in state && typeof state.sessionId === "string") return state.sessionId
    throw new TransportError("pi", "protocol", "Pi did not return a session id")
  })
}

export async function resumePi(host: PiLaunchHost, input: StartInput, profile: PiProfile, broker: SessionBroker, upstreamSessionId: string): Promise<PiRpc> {
  const rpc = await launchPi(host, input, profile, broker, { role: "harness", resume: await piSessionFile(profile, upstreamSessionId) })
  if (await piUpstreamOf(host, rpc) === upstreamSessionId) return rpc
  await host.unsettled.retire(rpc)
  throw new TransportError("pi", "session", "Pi resumed a different session")
}

async function piSessionFile(profile: PiProfile, upstreamSessionId: string): Promise<string> {
  const files = await fs.readdir(profile.sessionDir)
  const file = files.find((name) => name.endsWith(`_${upstreamSessionId}.jsonl`))
  if (!file) throw new TransportError("pi", "session", "Pi session file is missing")
  return path.join(profile.sessionDir, file)
}
