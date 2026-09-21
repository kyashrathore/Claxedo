import { isRecord } from "@claxedo/agent-runtime-contract"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { DEFAULT_RECOVERY_BUDGETS, type RecoveryBudgets } from "@claxedo/agent-runtime-contract"
import { observeAgentProcess, type AgentProcessObserver, type AgentProcessObserverHandle } from "../../process-observer"
import { piCommand } from "./executable"
import {
  launchOwnedProcess,
  type LaunchOwnershipStore,
  type OwnedLaunch,
  type RetirementResult,
} from "../../launch"

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

export type PiRpcProcessInput = {
  binary: string
  directory: string
  args: string[]
  env: NodeJS.ProcessEnv
  observer?: AgentProcessObserver
  /** Required: a composition with no durable store passes the volatile one itself. */
  ownership: LaunchOwnershipStore
  /** The workspace this launch is recorded under, and reconciled with. */
  workspaceId: string
  sessionId?: string
  budgets?: Partial<RecoveryBudgets>
}

export class PiRpcProcess {
  private readonly child: ChildProcess
  private readonly observation: AgentProcessObserverHandle
  private readonly parser = new PiJsonLines()
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly listeners = new Set<(event: PiRpcMessage) => void>()
  private readonly exits = new Set<(error: Error) => void>()
  private failure?: Error
  private leaderExited = false
  private retirement?: Promise<RetirementResult>

  /**
   * Started, not constructed: the payload may not run until this owner's launch
   * record is durable, and that exchange is asynchronous.
   */
  static async start(input: PiRpcProcessInput) {
    // JS entrypoints are useful for native npm shims and deterministic protocol fixtures.
    const command = piCommand(input.binary, input.args)
    const launch = await launchOwnedProcess({
      ownership: input.ownership,
      role: "harness",
      scope: { workspaceId: input.workspaceId, directory: input.directory, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
      payload: { command: command.file, args: command.args },
      cwd: input.directory,
      env: input.env,
    })
    return new PiRpcProcess(launch, { ...DEFAULT_RECOVERY_BUDGETS, ...input.budgets }, input)
  }

  private constructor(
    private readonly launch: OwnedLaunch,
    private readonly budgets: RecoveryBudgets,
    input: PiRpcProcessInput,
  ) {
    this.child = launch.child
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
      pid: launch.payloadPid,
      executableBasename: input.binary.split(/[\\/]/).at(-1),
    })
    this.child.stdout!.setEncoding("utf8")
    this.child.stdout!.on("data", (chunk: string) => {
      try {
        for (const message of this.parser.read(chunk)) this.receive(message)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
        void this.dispose()
      }
    })
    // Drain stderr; provider diagnostics may contain credentials and must not enter the transcript.
    this.child.stderr!.resume()
    this.child.on("error", (error) => this.fail(error))
    this.child.on("exit", (code, signal) => {
      this.leaderExited = true
      const exit = new Error(`Pi process exited (${signal ?? code})`)
      this.observation.exit({ reason: "exited", ...(code === null ? {} : { exitCode: code }) })
      this.fail(exit)
      for (const listener of this.exits) listener(exit)
      this.exits.clear()
    })
  }

  /** Usable: neither the transport nor the OS has taken this process away. */
  get alive() {
    return !this.failure && !this.leaderExited
  }
  onEvent(listener: (event: PiRpcMessage) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  /** Fires on a leader exit the OS reported, never on a transport failure. */
  onExit(listener: (error: Error) => void) {
    if (this.leaderExited) listener(this.failure ?? new Error("Pi process exited"))
    else this.exits.add(listener)
    return () => {
      this.exits.delete(listener)
    }
  }
  send(message: PiRpcMessage) {
    if (this.failure) throw this.failure
    this.child.stdin!.write(JSON.stringify(message) + "\n", (error) => {
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
  /**
   * The transport is unusable. That is all it means: a broken pipe, a protocol
   * violation or a rejected write says nothing about whether the process or the
   * tools it started are still running, so no exit is published from here.
   */
  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** Whether the OS reported this process gone, as opposed to the transport failing. */
  get exited() {
    return this.leaderExited
  }

  dispose(): Promise<RetirementResult> {
    this.retirement ??= this.retireLaunch()
    return this.retirement
  }

  private async retireLaunch(): Promise<RetirementResult> {
    this.fail(new Error("Pi process disposed"))
    return await this.launch.retire(this.budgets)
  }
}

/** A Pi RPC frame always names its type; anything else is a protocol violation. */
function isPiRpcMessage(value: unknown): value is PiRpcMessage {
  return isRecord(value) && typeof value.type === "string"
}
