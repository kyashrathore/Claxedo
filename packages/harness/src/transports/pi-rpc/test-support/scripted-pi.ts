import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HarnessServices, McpServerSpec, SessionBroker, SpawnCommand, SpawnOptions, StartInput } from "../../../contract"
import { ScriptedProcess } from "../../../test-support/scripted-process"
import { PiRpcTransport } from ".."

type Frame = { type: string; id?: string; message?: string }
type Launch = { command: SpawnCommand; options: SpawnOptions; wire: ScriptedProcess<Frame> }

function projectModel(cwd: string): string {
  try { return (JSON.parse(readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8")) as { defaultModel: string }).defaultModel }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "default-model"
    throw error
  }
}

function answer(frame: Frame, launch: Launch, mcpFailure: string | undefined): unknown {
  const sessionDir = launch.command.args[launch.command.args.indexOf("--session-dir") + 1]
  if (frame.type === "get_state" && launch.options.role === "harness" && sessionDir) {
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(path.join(sessionDir, "scripted_scripted-pi.jsonl"), "")
  }
  if (frame.type === "prompt" && frame.message?.startsWith("/claxedo-mcp ") && mcpFailure) {
    launch.wire.send({ type: "extension_error", extensionPath: "command:claxedo-mcp", error: mcpFailure })
  }
  if (frame.type === "get_available_models") return { models: [{ provider: "scripted", id: projectModel(launch.command.cwd), name: "Scripted" }] }
  if (frame.type === "get_available_thinking_levels") return { levels: [] }
  return frame.type === "get_state" ? { sessionId: "scripted-pi", thinkingLevel: "off" } : {}
}

export async function scriptedPi(input: { firstPartyMcp?: HarnessServices["firstPartyMcp"]; mcpFailure?: string; onLaunch?: (launch: Launch) => void } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-scripted-")))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  const launches: Launch[] = []
  const health = { changes: 0 }
  const mcpRequests: [string, string][] = []
  const spawn: HarnessServices["spawn"] = async (command, options) => {
    const launch: Launch = { command, options, wire: new ScriptedProcess<Frame>((frame) => {
      if (frame.id) launch.wire.send({ type: "response", id: frame.id, command: frame.type, success: true, data: answer(frame, launch, input.mcpFailure) })
    }) }
    launches.push(launch)
    input.onLaunch?.(launch)
    return launch.wire.owned()
  }
  const firstPartyMcp = (sessionId: string, locality: "local" | "remote"): McpServerSpec | undefined => {
    mcpRequests.push([sessionId, locality])
    return input.firstPartyMcp?.(sessionId, locality)
  }
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const services = { spawn, firstPartyMcp, healthChanged: () => { health.changes += 1 }, recordHomeUse: async () => {}, log,
    clock: { now: Date.now, setTimeout, clearTimeout } } as unknown as HarnessServices
  const transport = new PiRpcTransport(services, { binary: "pi", runtime: "node", env: {}, placement: "loopback", machineOwnerUserId: "owner",
    canUseOwnLogin: true, stateRoot: path.join(root, "state"), ownerAgentDir: path.join(root, "owner-agent") })
  const start = (locality: "local" | "remote" = "local"): StartInput => ({ sessionId: "s1", workspaceId: "w1", directory, locality,
    owner: { kind: "machine-owner" }, config: { harness: { id: "pi", access: "native" } },
    projection: { generation: "g1", pluginRoots: [], mcpServers: [], notApplied: [] },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } })
  const broker = { rebind: async (upstreamSessionId: string) =>
    ({ sessionId: "s1", workspaceId: "w1", directory, connectionId: "pi-rpc", upstreamSessionId }), publish: async () => {} } as unknown as SessionBroker
  const draft = () => {
    const { sessionId: _sessionId, ...rest } = start()
    return rest
  }
  const close = async () => { await transport.dispose(); await fs.rm(root, { recursive: true, force: true }) }
  return { root, directory, transport, launches, health, mcpRequests, start, broker, draft, close,
    probes: () => launches.filter((launch) => launch.options.role === "probe") }
}
