import fs from "node:fs/promises"
import path from "node:path"
import { errorMessage } from "@claxedo/helpers"
import { deadlineAfter, type Deadline, type HarnessServices, type SessionBroker, type StartInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { piEnvironment, piProjectionArgs, preparePiProfile, type PiProfile, type PiProfileOptions } from "../../profiles/pi"
import { PiRpc } from "./rpc"
import { installPiTitleExtension } from "./title"

export type PiRpcOptions = PiProfileOptions & { binary: string; runtime: string; args?: readonly string[]; env: NodeJS.ProcessEnv }

export type PiLaunch = { role: "harness"; resume?: string } | { role: "probe" }

export type PiLaunchHost = {
  readonly services: HarnessServices
  readonly options: PiRpcOptions
  readonly signal: AbortSignal
  disposed(): boolean
}

export const piDeadline = (clock: HarnessServices["clock"]): Deadline => deadlineAfter(clock, 15_000)

export async function retiringOnFailure<T>(rpc: PiRpc, clock: HarnessServices["clock"], work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) { await rpc.retire(piDeadline(clock)); throw error }
}

export async function launchPi(host: PiLaunchHost, input: StartInput, profile: PiProfile, broker: SessionBroker | undefined, launch: PiLaunch): Promise<PiRpc> {
  if (host.disposed()) throw new TransportError("pi", "process", "Pi transport disposed")
  await preparePiProfile(profile, input.model)
  const args = ["--mode", "rpc", ...(launch.role === "probe" ? ["--no-session"] : ["--session-dir", profile.sessionDir]),
    ...piProjectionArgs(input.projection), ...host.options.args ?? []]
  if (launch.role === "harness") {
    args.push("-e", await installPiTitleExtension(host.options.stateRoot))
    if (launch.resume) args.push("--session", launch.resume)
  }
  const binary = host.options.binary
  const command = /\.[cm]?js$/.test(binary) ? { file: host.options.runtime, args: [binary, ...args] } : { file: binary, args }
  const owned = await host.services.spawn({ ...command, cwd: input.directory, env: piEnvironment(profile, host.options.env) },
    { role: launch.role, label: "Pi RPC", sessionId: input.sessionId, signal: host.signal })
  const rpc = new PiRpc(owned, host.services.clock, (event) => {
    if (broker) void broker.publish(event).catch((error: unknown) =>
      host.services.log.error("Pi RPC diagnostic publication failed", { error: errorMessage(error) }))
    else host.services.log.warn(event.diagnostic.message, { code: event.diagnostic.code, raw: event.diagnostic.raw })
  })
  await retiringOnFailure(rpc, host.services.clock, () => rpc.request("get_state"))
  return rpc
}

export function piUpstreamOf(rpc: PiRpc, clock: HarnessServices["clock"]): Promise<string> {
  return retiringOnFailure(rpc, clock, async () => {
    const state = await rpc.request("get_state")
    if (state && typeof state === "object" && "sessionId" in state && typeof state.sessionId === "string") return state.sessionId
    throw new TransportError("pi", "protocol", "Pi did not return a session id")
  })
}

export async function resumePi(host: PiLaunchHost, input: StartInput, profile: PiProfile, broker: SessionBroker, upstreamSessionId: string): Promise<PiRpc> {
  const rpc = await launchPi(host, input, profile, broker, { role: "harness", resume: await piSessionFile(profile, upstreamSessionId) })
  if (await piUpstreamOf(rpc, host.services.clock) === upstreamSessionId) return rpc
  await rpc.retire(piDeadline(host.services.clock))
  throw new TransportError("pi", "session", "Pi resumed a different session")
}

export async function piSessionFile(profile: PiProfile, upstreamSessionId: string): Promise<string> {
  const files = await fs.readdir(profile.sessionDir)
  const file = files.find((name) => name.endsWith(`_${upstreamSessionId}.jsonl`))
  if (!file) throw new TransportError("pi", "session", "Pi session file is missing")
  return path.join(profile.sessionDir, file)
}
