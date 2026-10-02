import { createInterface } from "node:readline"
import { errorMessage } from "@claxedo/helpers"
import type { AgentOptions, Run, SDKAgent } from "@cursor/sdk"
import { forwardedDelta, HostDeltaOrder } from "./host-deltas"
import { hostFailure, hostRunError, isHostCommand, type HostCommand, type HostReply, type HostSession } from "./protocol"
import { CursorRunState } from "./run-state"

const TITLE_AGENT_NAME = "Claxedo session title"

type SdkAgent = typeof import("@cursor/sdk").Agent
type StreamCommand = Extract<HostCommand, { kind: "run" | "title" }>

const protocolOut = process.stdout.write.bind(process.stdout)

function keepStdoutForProtocol() {
  process.stdout.write = process.stderr.write.bind(process.stderr)
  console.log = (...args: unknown[]) => console.error(...args)
  console.info = (...args: unknown[]) => console.error(...args)
  console.debug = (...args: unknown[]) => console.error(...args)
}

function agentOptions(session: HostSession): AgentOptions {
  return {
    apiKey: session.apiKey,
    ...(session.model ? { model: { id: session.model } } : {}),
    ...(Object.keys(session.mcpServers).length ? { mcpServers: session.mcpServers } : {}),
    local: { cwd: session.directory, ...session.local },
  }
}

export class CursorHostRuntime {
  private readonly agents = new Map<string, SDKAgent>()
  private readonly runs = new Map<string, CursorRunState>()

  constructor(private readonly post: (reply: HostReply) => void = (reply) => { protocolOut(`${JSON.stringify(reply)}\n`) },
    private readonly sdk: () => Promise<Pick<typeof import("@cursor/sdk"), "Agent" | "Cursor">> = () => import("@cursor/sdk")) {}

  private discard(sessionId: string): void {
    this.agents.get(sessionId)?.close()
    this.agents.delete(sessionId)
  }

  private async open(session: HostSession): Promise<SDKAgent> {
    const existing = this.agents.get(session.sessionId)
    if (existing) return existing
    const { Agent } = await this.sdk()
    const options = agentOptions(session)
    if (session.agentId) await this.endOrphanedRuns(Agent, session.agentId, session.directory)
    const agent = session.agentId ? await Agent.resume(session.agentId, options) : await Agent.create(options)
    this.agents.set(session.sessionId, agent)
    return agent
  }

  private async endOrphanedRuns(Agent: SdkAgent, agentId: string, cwd: string): Promise<void> {
    if ((await Agent.get(agentId, { cwd })).status !== "running") return
    let cursor: string | undefined
    do {
      const page = await Agent.listRuns(agentId, { runtime: "local", cwd, ...(cursor ? { cursor } : {}) })
      for (const run of page.items) if (run.status === "running") await Agent.cancelRun(run.id, { runtime: "local", cwd })
      cursor = page.nextCursor
    } while (cursor)
  }

  private async run(command: StreamCommand): Promise<void> {
    const pending = this.begin(command.session.sessionId)
    try { await this.send(command, pending) }
    finally {
      pending.finish()
      if (command.kind === "title") this.discard(command.session.sessionId)
      this.release(command.session.sessionId, pending)
    }
  }

  private begin(sessionId: string): CursorRunState {
    if (this.runs.has(sessionId)) throw new Error("Cursor run already active")
    const pending = new CursorRunState()
    this.runs.set(sessionId, pending)
    return pending
  }

  private release(sessionId: string, pending: CursorRunState): void {
    if (pending.releasable) this.runs.delete(sessionId)
  }

  private async titleAgent(session: HostSession): Promise<SDKAgent> {
    const { Agent } = await this.sdk()
    const agent = await Agent.create({ ...agentOptions(session), name: TITLE_AGENT_NAME })
    this.agents.set(session.sessionId, agent)
    return agent
  }

  private async send(command: StreamCommand, pending: CursorRunState): Promise<void> {
    const agent = command.kind === "title" ? await this.titleAgent(command.session) : await this.open(command.session)
    pending.beforeSend()
    const order = new HostDeltaOrder((reply) => this.post({ id: command.id, ...reply }))
    let run: Run
    try {
      run = await agent.send(command.prompt, command.kind === "title" ? { local: { force: false } } : {
        ...(command.session.model ? { model: { id: command.session.model } } : {}),
        ...(Object.keys(command.session.mcpServers).length ? { mcpServers: command.session.mcpServers } : {}),
        ...(command.mode ? { mode: command.mode } : {}), local: { force: false },
        onDelta: ({ update }) => { const delta = forwardedDelta(update); if (delta) order.delta(delta) },
      })
    } catch (error) {
      this.discard(command.session.sessionId)
      throw error
    }
    pending.activate(run)
    for await (const message of run.stream()) if (command.kind === "run") order.message(message)
    order.end()
    const result = await run.wait()
    this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId, runId: run.id,
      status: result.status, ...(result.result ? { result: result.result } : {}), ...(command.kind === "run" ? hostRunError(result.error) : {}) } })
  }

  private async models(command: Extract<HostCommand, { kind: "models" }>): Promise<void> {
    const { Cursor } = await this.sdk()
    const listed = await Cursor.models.list({ apiKey: command.apiKey })
    this.post({ id: command.id, kind: "result", value: { models: listed.map((model) => ({ id: model.id, name: model.displayName,
      ...(model.description ? { description: model.description } : {}) })) } })
  }

  async receive(command: HostCommand): Promise<void> {
    try {
      if (command.kind === "run" || command.kind === "title") await this.run(command)
      else if (command.kind === "models") await this.models(command)
      else if (command.kind === "open") {
        const agent = await this.open(command.session)
        this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId } })
      } else if (command.kind === "steer") {
        this.post({ id: command.id, kind: "result", value: { steer: await (this.runs.get(command.sessionId)?.steer(command.text) ?? "no_run") } })
      } else if (command.kind === "cancel") {
        const pending = this.runs.get(command.sessionId)
        if (pending) {
          try { await pending.cancel() }
          finally { this.release(command.sessionId, pending) }
        }
        this.post({ id: command.id, kind: "result" })
      } else {
        this.discard(command.sessionId)
        this.post({ id: command.id, kind: "result" })
      }
    } catch (error) {
      this.post({ id: command.id, kind: "error", ...hostFailure(error, errorMessage(error)) })
    }
  }
}

if (import.meta.main) {
  keepStdoutForProtocol()
  const runtime = new CursorHostRuntime()
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (line) => {
    if (!line.trim()) return
    const command: unknown = JSON.parse(line)
    if (!isHostCommand(command)) throw new Error(`Cursor SDK host received an invalid command: ${line.slice(0, 120)}`)
    void runtime.receive(command)
  })
  lines.on("close", () => process.exit(0))
}
