import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HarnessServices, SessionBroker, SpawnCommand, StartInput, TurnBroker, TurnInput } from "../../../contract"
import { ScriptedProcess } from "../../../test-support/scripted-process"
import { ClaudeSdkTransport } from ".."
import { ClaudePeer } from "./protocol"

type Frame = Record<string, unknown>
type ClaudeProcess = { wire: ScriptedProcess<Frame>; protocol: ClaudePeer }

const result = { type: "result", subtype: "success", is_error: false, session_id: "up1", uuid: "result-1", num_turns: 1 }

export async function scriptedClaude(options: { models: unknown[]; steering?: boolean; env?: NodeJS.ProcessEnv }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-scripted-"))
  const launches: { command: SpawnCommand; role: string }[] = []
  const users: Frame[] = []
  const violations: unknown[] = []
  const processes: ClaudeProcess[] = []
  const finish = (process: ClaudeProcess) => {
    process.protocol.complete()
    process.wire.send(result)
    process.wire.exit()
  }
  const answer = (process: ClaudeProcess, frame: Frame) => {
    let kind: ReturnType<ClaudePeer["receive"]>
    try { kind = process.protocol.receive(frame) }
    catch (error) {
      violations.push(error)
      process.wire.send({ type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: String(error) } })
      process.wire.exit({ code: 1, signal: null })
      return
    }
    if (kind !== "user") {
      process.wire.send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: kind === "initialize"
        ? { models: options.models, commands: [], agents: [], account: {}, output_style: "default", available_output_styles: [] } : {} } })
      return
    }
    users.push(frame)
    if (!options.steering) finish(process)
  }
  const services = {
    clock: { now: Date.now, setTimeout, clearTimeout }, firstPartyMcp: () => undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    spawn: async (command, spawnOptions) => {
      launches.push({ command, role: spawnOptions.role })
      const process: ClaudeProcess = { protocol: new ClaudePeer(), wire: new ScriptedProcess<Frame>((frame) => answer(process, frame)) }
      processes.push(process)
      return process.wire.owned()
    },
  } satisfies Partial<HarnessServices>
  const transport = new ClaudeSdkTransport(services as unknown as HarnessServices, { executable: "claude", configRoot: path.join(root, "homes"),
    userConfigRoot: path.join(root, "owner"), env: options.env ?? {} })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: root, locality: "local", owner: { kind: "machine-owner" },
    config: { harness: { id: "claude", access: "native" } }, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  const broker = { config: () => input.config, rebind: async (upstreamSessionId: string) => ({ sessionId: "s1", workspaceId: "w1", directory: root,
    connectionId: "claude-sdk", upstreamSessionId }) } as SessionBroker
  const session = await transport.start(input, broker)
  const run = async (modelID: string, effort?: string) => {
    const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", todos: [], effort,
      model: { providerID: "anthropic", modelID }, origin: { actor: input.owner, via: "loopback", reissued: false },
      prompt: { agent: "", assistantMessageId: "a1", parts: [{ type: "text", text: "hello" }] } }
    for await (const _event of transport.send(session, turn, { signal: new AbortController().signal } as TurnBroker)) {}
  }
  const close = async () => {
    await transport.dispose()
    await fs.rm(root, { recursive: true, force: true })
    if (violations.length) throw new AggregateError(violations, "The transport broke the Claude SDK protocol")
  }
  return { launches, transport, session, run, users, close,
    finish: () => finish(processes.at(-1)!),
    replay: (index: number) => processes.at(-1)!.wire.send({ ...users[index], isReplay: true }) }
}
