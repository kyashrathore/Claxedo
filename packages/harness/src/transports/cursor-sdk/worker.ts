import { MessagePort, workerData } from "node:worker_threads"
import type { Run, SDKAgent } from "@cursor/sdk"
import type { WorkerCommand, WorkerReply, WorkerSession } from "./protocol"

class CursorWorkerRuntime {
  private readonly agents = new Map<string, SDKAgent>()
  private readonly runs = new Map<string, Run>()

  constructor(private readonly port: MessagePort) {
    port.on("message", (command: WorkerCommand) => { void this.receive(command) })
  }

  private post(reply: WorkerReply) { this.port.postMessage(reply) }

  private async open(session: WorkerSession): Promise<SDKAgent> {
    const existing = this.agents.get(session.sessionId)
    if (existing) return existing
    const { Agent } = await import("@cursor/sdk")
    const options = {
      apiKey: session.apiKey,
      ...(session.model ? { model: { id: session.model } } : {}),
      ...(Object.keys(session.mcpServers).length ? { mcpServers: session.mcpServers } : {}),
      local: { cwd: session.directory, ...(session.plugins ? { settingSources: ["plugins" as const] } : {}) },
    }
    const agent = session.agentId ? await Agent.resume(session.agentId, options) : await Agent.create(options)
    this.agents.set(session.sessionId, agent)
    return agent
  }

  private async run(command: Extract<WorkerCommand, { kind: "run" }>): Promise<void> {
    const agent = await this.open(command.session)
    const run = await agent.send(command.prompt, {
      ...(command.session.model ? { model: { id: command.session.model } } : {}),
      ...(Object.keys(command.session.mcpServers).length ? { mcpServers: command.session.mcpServers } : {}),
      ...(command.mode ? { mode: command.mode } : {}), local: { force: false },
    })
    this.runs.set(command.session.sessionId, run)
    try {
      for await (const message of run.stream()) this.post({ id: command.id, kind: "event", message })
      const result = await run.wait()
      this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId, runId: run.id,
        status: result.status, ...(result.result ? { result: result.result } : {}) } })
    } finally { this.runs.delete(command.session.sessionId) }
  }

  private async receive(command: WorkerCommand): Promise<void> {
    try {
      if (command.kind === "run") await this.run(command)
      else if (command.kind === "open") {
        const agent = await this.open(command.session)
        this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId } })
      } else if (command.kind === "cancel") {
        await this.runs.get(command.sessionId)?.cancel()
        this.post({ id: command.id, kind: "result" })
      } else {
        this.agents.get(command.sessionId)?.close()
        this.agents.delete(command.sessionId)
        this.post({ id: command.id, kind: "result" })
      }
    } catch (error) {
      this.post({ id: command.id, kind: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }
}

const data: unknown = workerData
if (!data || typeof data !== "object" || !("port" in data) || !(data.port instanceof MessagePort)) {
  throw new Error("Cursor SDK worker requires a MessagePort")
}
new CursorWorkerRuntime(data.port)
