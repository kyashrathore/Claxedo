import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Clock, HarnessServices, SessionBroker, StartInput } from "../../../contract"
import { ScriptedProcess } from "../../../test-support/scripted-process"
import { CodexAppServerTransport } from ".."
import { CodexPeer, CodexScriptedFailure, type Frame } from "./protocol"
export type { Frame } from "./protocol"

type CodexProcess = { wire: ScriptedProcess<Frame>; protocol: CodexPeer }

export async function scriptedTransport(options: { holdTurnStart?: boolean; clock?: Clock; models?: unknown[]; completeTurns?: boolean
  modelListFailures?: number; goal?: unknown; userAgent?: string } = {}) {
  const script = { modelListFailures: options.modelListFailures, goal: options.goal, userAgent: options.userAgent }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-scripted-"))
  const frames: Frame[] = []
  const violations: unknown[] = []
  const environments: Record<string, string>[] = []
  const processes: CodexProcess[] = []
  let turnStarted!: () => void
  const started = new Promise<void>((resolve) => { turnStarted = resolve })
  let heldTurnStart: number | undefined
  const emit = (process: CodexProcess, frame: Frame) => { process.protocol.emitted(frame); process.wire.send(frame) }
  const answer = (process: CodexProcess, frame: Frame) => {
    frames.push(frame)
    let result: unknown
    try { result = process.protocol.receive(frame) }
    catch (error) {
      if (error instanceof CodexScriptedFailure && frame.id !== undefined) { process.wire.send({ id: frame.id, error: { code: -32603, message: error.message } }); return }
      violations.push(error)
      if (frame.id !== undefined) process.wire.send({ id: frame.id, error: { code: -32602, message: String(error) } })
      else process.wire.exit({ code: 1, signal: null })
      return
    }
    if (frame.id === undefined || !frame.method) return
    if (frame.method === "turn/start" && options.holdTurnStart) { heldTurnStart = frame.id; turnStarted(); return }
    process.wire.send({ id: frame.id, result })
    if (frame.method !== "turn/start") return
    turnStarted()
    if (options.completeTurns) emit(process, { method: "turn/completed", params: { threadId: String(frame.params?.threadId), turn: { id: "turn-current", status: "completed" } } })
  }
  const spawn: HarnessServices["spawn"] = async (command) => {
    environments.push(command.env)
    const process: CodexProcess = { protocol: new CodexPeer(options.models ?? [{ model: "test-model", isDefault: true }], script),
      wire: new ScriptedProcess<Frame>((frame) => answer(process, frame)) }
    processes.push(process)
    return process.wire.owned()
  }
  const healthChanges = { count: 0 }
  const services = { spawn, recordHomeUse: async () => {}, healthChanged: () => { healthChanges.count += 1 }, firstPartyMcp: () => undefined,
    clock: options.clock ?? { now: Date.now, setTimeout, clearTimeout } } as unknown as HarnessServices
  const transport = new CodexAppServerTransport(services, { binary: "unused", homeRoot: path.join(root, "homes"), ownerHome: path.join(root, "owner"), env: {} })
  const startInput: StartInput = { workspaceId: "w1", sessionId: "s1", directory: root, locality: "local", owner: { kind: "machine-owner" },
    config: { harness: { id: "codex", access: "native" } }, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" },
    projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [] } }
  const close = async () => {
    await transport.dispose()
    await fs.rm(root, { recursive: true, force: true })
    if (violations.length) throw new AggregateError(violations, "The transport broke the Codex app-server protocol")
  }
  const latest = () => processes.at(-1)!
  const releaseTurnStart = () => {
    if (heldTurnStart === undefined) throw new Error("No held turn/start")
    latest().wire.send({ id: heldTurnStart, result: { turn: { id: "turn-current" } } })
  }
  const liveBroker = () => ({ rebind: async (upstreamSessionId: string) => Object.freeze({ sessionId: "s1", workspaceId: "w1", directory: root, connectionId: "codex-app-server", upstreamSessionId }), goal: { read: () => null, publish: async () => {} }, reportFailure: () => {} } as unknown as SessionBroker)
  return { root, environments, transport, startInput, started, frames, releaseTurnStart, liveBroker, close, healthChanges,
    retired: () => processes.reduce((total, process) => total + process.wire.retirements, 0),
    request: (id: number, method: string, params: unknown) => { latest().protocol.request(id); latest().wire.send({ id, method, params }) },
    emit: (frame: Frame) => emit(latest(), frame),
    get stdout() { return latest().wire.stdout }, get stderr() { return latest().wire.stderr }, spawned: () => processes.length, exitLatest: () => latest().wire.exit({ code: 1, signal: null }) }
}
