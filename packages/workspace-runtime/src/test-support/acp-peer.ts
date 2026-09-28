import { PassThrough } from "node:stream"
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError, type Agent, type PromptResponse, type SessionModeState } from "@agentclientprotocol/sdk"
import type { HarnessServices } from "@claxedo/harness/contract"

export function acpPeer() {
  const services: HarnessServices = {
    spawn: async () => { throw new Error("Peer not installed") },
    recordHomeUse: async () => {},
    firstPartyMcp: () => undefined,
    transcripts: { register: async () => { throw new Error("No transcript in this fixture") } },
    patternEvaluator: async () => {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clock: { now: Date.now, setTimeout, clearTimeout },
    healthChanged: () => {},
  }
  const peers: { connection: AgentSideConnection; die(): void }[] = []
  const requests: { method: string; params: unknown }[] = []
  let usage: PromptResponse["usage"] = { totalTokens: 30, inputTokens: 11, outputTokens: 7, thoughtTokens: 3, cachedReadTokens: 5, cachedWriteTokens: 4 }
  let context: { size: number; used: number } | undefined
  let startError: Error | undefined
  let startBarrier: Promise<void> | undefined
  let modes: SessionModeState | undefined
  services.firstPartyMcp = (sessionId) => ({ kind: "http", name: "claxedo", url: `http://localhost/mcp/${sessionId}`, headers: { Authorization: `Bearer ${sessionId}` } })
  services.spawn = async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const generation = peers.length + 1
    let exit!: (value: { code: number; signal: null }) => void
    const exited = new Promise<{ code: number; signal: null }>((resolve) => { exit = resolve })
    let connection!: AgentSideConnection
    const sessions = new Set<string>()
    let goal: Record<string, unknown> | null = null
    const agent: Agent = {
      initialize: async () => ({ protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, resume: {} }, mcpCapabilities: { http: true } },
        _meta: { goal: { version: 1, methods: ["session/goal/get", "session/goal/start", "session/goal/stop"] } } }),
      authenticate: async () => ({}),
      newSession: async (params) => {
        await startBarrier
        if (startError) throw startError
        requests.push({ method: "session/new", params })
        const sessionId = `up-${generation}-${sessions.size}`
        sessions.add(sessionId)
        return { sessionId, ...(modes ? { modes } : {}) }
      },
      resumeSession: async (params) => {
        requests.push({ method: "session/resume", params })
        if (!sessions.has(params.sessionId)) throw RequestError.resourceNotFound(params.sessionId)
        return modes ? { modes } : {}
      },
      setSessionMode: async (params) => {
        requests.push({ method: "session/set_mode", params })
        if (modes) modes = { ...modes, currentModeId: params.modeId }
        return {}
      },
      loadSession: async (params) => {
        if (!sessions.has(params.sessionId)) throw RequestError.resourceNotFound(params.sessionId)
        return {}
      },
      unstable_forkSession: async (params) => { requests.push({ method: "session/fork", params }); return { sessionId: "forked" } },
      prompt: async (params) => {
        requests.push({ method: "session/prompt", params })
        await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Restored evidence" } } })
        if (context) await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "usage_update", ...context } })
        return { stopReason: "end_turn", ...(usage ? { usage } : {}) }
      },
      cancel: async (params) => { requests.push({ method: "session/cancel", params }) },
      extMethod: async (method, params) => {
        if (method === "session/goal/start") goal = { objective: params.objective, status: "active", createdAt: 1, updatedAt: 1 }
        if (method === "session/goal/stop" && goal) goal = { ...goal, status: "complete", updatedAt: 2 }
        return { goal }
      },
    }
    connection = new AgentSideConnection(() => agent, ndJsonStream(new WritableStream({ write(chunk: Uint8Array) { stdout.write(chunk) } }), new ReadableStream({
      start(controller) { stdin.on("data", (chunk: Buffer) => controller.enqueue(chunk)); stdin.on("end", () => controller.close()) },
    })))
    const die = () => { stdout.end(); stdin.end(); exit({ code: 0, signal: null }) }
    peers.push({ connection, die })
    return { pid: 5_000_000 + generation, stdin, stdout, stderr: new PassThrough(), exited, retire: async () => { die(); return { stopped: true } } }
  }
  return { services, peers, requests, setModes: (value: SessionModeState) => { modes = value }, holdStart: (barrier: Promise<void>) => { startBarrier = barrier }, setUsage: (value: PromptResponse["usage"]) => { usage = value }, setContext: (value: { size: number; used: number }) => { context = value }, failStart: (error: Error) => { startError = error } }
}
