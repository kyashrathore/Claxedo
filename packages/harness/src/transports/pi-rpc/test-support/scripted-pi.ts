import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HarnessServices, McpServerSpec, SessionBroker, SpawnCommand, SpawnOptions, StartInput } from "../../../contract"
import { ScriptedProcess } from "../../../test-support/scripted-process"
import { PiRpcTransport } from ".."
import { PI_RANGE } from "../version"

type Frame = { type: string; id?: string; message?: string; name?: string }
type Handoff = { file: string; mode: number; content: string }
type Launch = { command: SpawnCommand; options: SpawnOptions; wire: ScriptedProcess<Frame>; handoffs: Handoff[] }

const EXTENSION_COMMANDS: Record<string, string> = { "claxedo-session-title.ts": "claxedo-title" }

function registeredCommands(launch: Launch) {
  const args = launch.command.args
  return args.flatMap((arg, index) => {
    const name = args[index - 1] === "-e" ? EXTENSION_COMMANDS[path.basename(arg)] : undefined
    return name ? [{ name, source: "extension", sourceInfo: { path: arg } }] : []
  })
}

function loadMcpExtension(launch: Launch) {
  const args = launch.command.args
  const file = launch.command.env.CLAXEDO_PI_MCP_HANDOFF
  if (!file || !args.some((arg, index) => args[index - 1] === "-e" && path.basename(arg) === "claxedo-mcp.ts")) return
  launch.handoffs.push({ file, mode: statSync(file).mode & 0o777, content: readFileSync(file, "utf8") })
  rmSync(file)
}

function projectModel(cwd: string): string {
  try { return (JSON.parse(readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8")) as { defaultModel: string }).defaultModel }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "default-model"
    throw error
  }
}

function answer(frame: Frame, launch: Launch): unknown {
  const sessionDir = launch.command.args[launch.command.args.indexOf("--session-dir") + 1]
  if (frame.type === "prompt" && sessionDir) {
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(path.join(sessionDir, "scripted_scripted-pi.jsonl"), "")
  }
  if (frame.type === "get_commands") return { commands: registeredCommands(launch) }
  if (frame.type === "get_available_models") return { models: [{ provider: "scripted", id: projectModel(launch.command.cwd), name: "Scripted" }] }
  if (frame.type === "get_available_thinking_levels") return { levels: [] }
  if (frame.type === "prompt") return { disposition: "handled" }
  return frame.type === "get_state" ? { sessionId: "scripted-pi", thinkingLevel: "off" } : {}
}

function versionProcess(version: string) {
  const wire = new ScriptedProcess<Frame>(() => {})
  queueMicrotask(() => { wire.stdout.write(`${version}\n`); wire.exit() })
  return wire.owned()
}

export async function scriptedPi(input: { firstPartyMcp?: HarnessServices["firstPartyMcp"]; mcpUnloaded?: true;
  onLaunch?: (launch: Launch) => void; version?: string; binary?: string } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-scripted-")))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  const launches: Launch[] = []
  const health = { changes: 0 }
  const mcpRequests: [string, string][] = []
  const versions: SpawnCommand[] = []
  const spawn: HarnessServices["spawn"] = async (command, options) => {
    if (command.args.includes("--version")) {
      versions.push(command)
      return versionProcess(input.version ?? PI_RANGE.max)
    }
    const launch: Launch = { command, options, handoffs: [], wire: new ScriptedProcess<Frame>((frame) => {
      if (frame.type === "set_session_name") launch.wire.send({ type: "session_info_changed", name: frame.name?.trim() })
      if (frame.type === "prompt" && frame.message?.startsWith("/claxedo-title ")) launch.wire.send({ type: "session_info_changed", name: "Scripted title" })
      if (frame.id) launch.wire.send({ type: "response", id: frame.id, command: frame.type, success: true, data: answer(frame, launch) })
    }) }
    launches.push(launch)
    if (!input.mcpUnloaded) loadMcpExtension(launch)
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
  const transport = new PiRpcTransport(services, { binary: input.binary ?? "pi", runtime: "node", env: {}, placement: "loopback", machineOwnerUserId: "owner",
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
  return { root, directory, transport, launches, versions, health, mcpRequests, start, broker, draft, close,
    probes: () => launches.filter((launch) => launch.options.role === "probe") }
}
