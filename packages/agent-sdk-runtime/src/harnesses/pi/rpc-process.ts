import { isRecord } from "@claxedo/agent-runtime-contract"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { observeAgentProcess, type AgentProcessObserver, type AgentProcessObserverHandle } from "../../process-observer"
import { piCommand } from "./executable"
import { killHarnessProcess } from "../shared/windows-process"

export type PiRpcMessage = Record<string, unknown> & { type: string }

/** Pi's wire format splits on LF only, including when JSON strings contain Unicode separators. */
export class PiJsonLines {
  private buffer = ""
  read(chunk: string): PiRpcMessage[] {
    this.buffer += chunk
    const messages: PiRpcMessage[] = []
    let end: number
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      if (end > 16 * 1024 * 1024) throw new Error("Pi RPC record exceeds 16 MiB")
      const line = this.buffer.slice(0, end).replace(/\r$/, "")
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      const message: unknown = JSON.parse(line)
      if (!isPiRpcMessage(message)) throw new Error("Invalid Pi RPC record")
      messages.push(message)
    }
    if (this.buffer.length > 16 * 1024 * 1024) throw new Error("Pi RPC record exceeds 16 MiB")
    return messages
  }
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly observation: AgentProcessObserverHandle
  private readonly parser = new PiJsonLines()
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly listeners = new Set<(event: PiRpcMessage) => void>()
  private readonly exits = new Set<(error: Error) => void>()
  private failure?: Error
  private killTimer?: ReturnType<typeof setTimeout>

  constructor(input: {
    binary: string
    directory: string
    args: string[]
    env: NodeJS.ProcessEnv
    observer?: AgentProcessObserver
  }) {
    // JS entrypoints are useful for native npm shims and deterministic protocol fixtures.
    const command = piCommand(input.binary, input.args)
    this.child = spawn(command.file, command.args, {
      cwd: input.directory,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.observation = observeAgentProcess(input.observer, {
      ownerId: `pi:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "pi",
      access: "native",
      role: "harness",
      label: "Pi RPC",
      locality: "local-process",
      confidence: "direct",
      capabilities: { resourceMetrics: "process", ownerActions: false },
      directory: input.directory,
      pid: this.child.pid,
      executableBasename: input.binary.split(/[\\/]/).at(-1),
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => {
      try {
        for (const message of this.parser.read(chunk)) this.receive(message)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
        this.dispose()
      }
    })
    // Drain stderr; provider diagnostics may contain credentials and must not enter the transcript.
    this.child.stderr.resume()
    this.child.on("error", (error) => this.fail(error))
    this.child.on("exit", (code, signal) => {
      if (this.killTimer) clearTimeout(this.killTimer)
      this.fail(new Error(`Pi process exited (${signal ?? code})`))
    })
  }

  get alive() {
    return !this.failure
  }
  onEvent(listener: (event: PiRpcMessage) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  onExit(listener: (error: Error) => void) {
    if (this.failure) listener(this.failure)
    else this.exits.add(listener)
    return () => {
      this.exits.delete(listener)
    }
  }
  send(message: PiRpcMessage) {
    if (this.failure) throw this.failure
    this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
      if (error) this.fail(error)
    })
  }
  request(type: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi ${type} acknowledgement timed out; outcome is unknown`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ ...body, type, id })
    })
  }
  private receive(message: PiRpcMessage) {
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.success === true) {
        this.observation.update({ lifecycle: "ready" })
        pending.resolve(message.data)
      } else pending.reject(new Error(typeof message.error === "string" ? message.error : "Pi rejected the command"))
      return
    }
    for (const listener of this.listeners) listener(message)
  }
  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    this.observation.exit({ reason: "exited" })
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const listener of this.exits) listener(error)
    this.exits.clear()
  }
  dispose() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.fail(new Error("Pi process disposed"))
    killHarnessProcess(this.child, "SIGTERM")
    this.killTimer ??= setTimeout(() => killHarnessProcess(this.child, "SIGKILL"), 2_000)
    this.killTimer.unref()
  }
}

/** A Pi RPC frame always names its type; anything else is a protocol violation. */
function isPiRpcMessage(value: unknown): value is PiRpcMessage {
  return isRecord(value) && typeof value.type === "string"
}
