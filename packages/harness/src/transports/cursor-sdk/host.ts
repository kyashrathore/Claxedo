import { createInterface } from "node:readline"
import { errorMessage } from "@claxedo/helpers"
import type { AgentOptions, Run, SDKAgent } from "@cursor/sdk"
import { isHostCommand, type HostCommand, type HostReply, type HostSession } from "./protocol"

const TITLE_AGENT_NAME = "Claxedo session title"
type ActiveRun = { state: "starting" } | { state: "running"; run: Run } | { state: "cancelled" }

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
  private readonly runs = new Map<string, { active: ActiveRun }>()

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
    const agent = session.agentId ? await Agent.resume(session.agentId, options) : await Agent.create(options)
    this.agents.set(session.sessionId, agent)
    return agent
  }

  private async run(command: Extract<HostCommand, { kind: "run" }>): Promise<void> {
    const pending = this.begin(command.session.sessionId)
    try { await this.send(command, pending) }
    finally { this.runs.delete(command.session.sessionId) }
  }

  private begin(sessionId: string): { active: ActiveRun } {
    if (this.runs.has(sessionId)) throw new Error("Cursor run already active")
    const pending = { active: { state: "starting" as const } }
    this.runs.set(sessionId, pending)
    return pending
  }

  private async activate(pending: { active: ActiveRun }, run: Run): Promise<void> {
    if (pending.active.state === "cancelled") await run.cancel()
    else pending.active = { state: "running", run }
  }

  private async send(command: Extract<HostCommand, { kind: "run" }>, pending: { active: ActiveRun }): Promise<void> {
    const agent = await this.open(command.session)
    if (pending.active.state === "cancelled") throw new Error("Cursor run cancelled before send")
    let run: Run
    try {
      run = await agent.send(command.prompt, {
        ...(command.session.model ? { model: { id: command.session.model } } : {}),
        ...(Object.keys(command.session.mcpServers).length ? { mcpServers: command.session.mcpServers } : {}),
        ...(command.mode ? { mode: command.mode } : {}), local: { force: false },
      })
    } catch (error) {
      this.discard(command.session.sessionId)
      throw error
    }
    await this.activate(pending, run)
    for await (const message of run.stream()) this.post({ id: command.id, kind: "event", message })
    const result = await run.wait()
    this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId, runId: run.id,
      status: result.status, ...(result.result ? { result: result.result } : {}) } })
  }

  private async title(command: Extract<HostCommand, { kind: "title" }>): Promise<void> {
    const pending = this.begin(command.session.sessionId)
    try { await this.sendTitle(command, pending) }
    finally { this.runs.delete(command.session.sessionId) }
  }

  private async sendTitle(command: Extract<HostCommand, { kind: "title" }>, pending: { active: ActiveRun }): Promise<void> {
    const { Agent } = await this.sdk()
    const agent = await Agent.create({ ...agentOptions(command.session), name: TITLE_AGENT_NAME })
    try {
      if (pending.active.state === "cancelled") throw new Error("Cursor title cancelled before send")
      const run = await agent.send(command.prompt, { local: { force: false } })
      await this.activate(pending, run)
      for await (const _message of run.stream()) {}
      const result = await run.wait()
      this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId, runId: run.id, status: result.status,
        ...(result.result ? { result: result.result } : {}) } })
    } finally { agent.close() }
  }

  private async models(command: Extract<HostCommand, { kind: "models" }>): Promise<void> {
    const { Cursor } = await this.sdk()
    const listed = await Cursor.models.list({ apiKey: command.apiKey })
    this.post({ id: command.id, kind: "result", value: { models: listed.map((model) => ({ id: model.id, name: model.displayName,
      ...(model.description ? { description: model.description } : {}) })) } })
  }

  async receive(command: HostCommand): Promise<void> {
    try {
      if (command.kind === "run") await this.run(command)
      else if (command.kind === "title") await this.title(command)
      else if (command.kind === "models") await this.models(command)
      else if (command.kind === "open") {
        const agent = await this.open(command.session)
        this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId } })
      } else if (command.kind === "cancel") {
        const pending = this.runs.get(command.sessionId)
        if (pending) {
          const active = pending.active
          pending.active = { state: "cancelled" }
          if (active.state === "running") await active.run.cancel()
        }
        this.post({ id: command.id, kind: "result" })
      } else {
        this.discard(command.sessionId)
        this.post({ id: command.id, kind: "result" })
      }
    } catch (error) {
      this.post({ id: command.id, kind: "error", message: errorMessage(error) })
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
