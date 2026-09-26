import { createInterface } from "node:readline"
import { errorMessage } from "@claxedo/helpers"
import type { AgentOptions, Run, SDKAgent } from "@cursor/sdk"
import { isHostCommand, type HostCommand, type HostReply, type HostSession } from "./protocol"

const TITLE_AGENT_NAME = "Claxedo session title"

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

class CursorHostRuntime {
  private readonly agents = new Map<string, SDKAgent>()
  private readonly runs = new Map<string, Run>()

  private post(reply: HostReply) { protocolOut(`${JSON.stringify(reply)}\n`) }

  private discard(sessionId: string): void {
    this.agents.get(sessionId)?.close()
    this.agents.delete(sessionId)
  }

  private async open(session: HostSession): Promise<SDKAgent> {
    const existing = this.agents.get(session.sessionId)
    if (existing) return existing
    const { Agent } = await import("@cursor/sdk")
    const options = agentOptions(session)
    const agent = session.agentId ? await Agent.resume(session.agentId, options) : await Agent.create(options)
    this.agents.set(session.sessionId, agent)
    return agent
  }

  private async run(command: Extract<HostCommand, { kind: "run" }>): Promise<void> {
    const agent = await this.open(command.session)
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
    this.runs.set(command.session.sessionId, run)
    try {
      for await (const message of run.stream()) this.post({ id: command.id, kind: "event", message })
      const result = await run.wait()
      this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId, runId: run.id,
        status: result.status, ...(result.result ? { result: result.result } : {}) } })
    } finally { this.runs.delete(command.session.sessionId) }
  }

  private async title(command: Extract<HostCommand, { kind: "title" }>): Promise<void> {
    const { Agent } = await import("@cursor/sdk")
    const agent = await Agent.create({ ...agentOptions(command.session), name: TITLE_AGENT_NAME })
    try {
      const run = await agent.send(command.prompt, { local: { force: false } })
      this.runs.set(command.session.sessionId, run)
      try {
        for await (const _message of run.stream()) {}
        const result = await run.wait()
        this.post({ id: command.id, kind: "result", value: { agentId: agent.agentId, runId: run.id, status: result.status,
          ...(result.result ? { result: result.result } : {}) } })
      } finally { this.runs.delete(command.session.sessionId) }
    } finally { agent.close() }
  }

  private async models(command: Extract<HostCommand, { kind: "models" }>): Promise<void> {
    const { Cursor } = await import("@cursor/sdk")
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
        await this.runs.get(command.sessionId)?.cancel()
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
