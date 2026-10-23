import { errorMessage } from "@claxedo/helpers"
import type { HarnessServices, SpawnCommand } from "../../contract/node"
import { deadlineAfter } from "../../contract/node"
import { NdjsonOwnedProcess } from "../../rpc/channel"
import { isRunnerReply, type RunnerReply, type RunnerRequest } from "./runner-protocol"

export type RunnerCommand = () => Pick<SpawnCommand, "file" | "args">

export type RunnerServices = Pick<HarnessServices, "spawn" | "clock" | "log">

export type RunInput = { file: string; args: string[]; cwd: string; env: Record<string, string>; onOutput(text: string): void }

export type RunOutcome = { exit: { code: number | null; signal: string | null } } | { failed: string } | { ended: string }

export const RUNNER_RESTARTED_NOTICE = "The shell host ended unexpectedly and was started again; background processes of earlier commands are gone"

const END_MS = 5_000
const RETIRE_MS = 5_000

type Run = { input: RunInput; stdout: TextDecoder; stderr: TextDecoder; started(): void; settle(outcome: RunOutcome): void }

const START_ATTEMPTS = 2

export class SessionRunner {
  private channel: NdjsonOwnedProcess | undefined
  private starting: Promise<NdjsonOwnedProcess> | undefined
  private ending = false
  private lost = false
  private sequence = 0
  private readonly runs = new Map<string, Run>()

  constructor(private readonly services: RunnerServices, private readonly command: RunnerCommand,
    readonly sessionId: string, private readonly cwd: string, private readonly env: Readonly<Record<string, string>>) {}

  get pid(): number | undefined { return this.channel?.process.pid }

  async start(input: RunInput): Promise<{ id: string; outcome: Promise<RunOutcome> } | { failed: string }> {
    let attempt: Awaited<ReturnType<SessionRunner["attempt"]>> | undefined
    for (let count = 0; count < START_ATTEMPTS; count++) {
      attempt = await this.attempt(input)
      if (!("retry" in attempt)) return attempt
    }
    return { failed: attempt && "retry" in attempt ? attempt.retry : "The shell host did not start" }
  }

  private async attempt(input: RunInput): Promise<{ id: string; outcome: Promise<RunOutcome> } | { failed: string } | { retry: string }> {
    if (this.ending) return { failed: "The session is closing" }
    let channel: NdjsonOwnedProcess
    try { channel = await this.ensure() } catch (error) { return { failed: errorMessage(error) } }
    const id = `run-${++this.sequence}`
    const { promise: outcome, resolve } = Promise.withResolvers<RunOutcome>()
    const { promise: accepted, resolve: accept } = Promise.withResolvers<"started" | RunOutcome>()
    this.runs.set(id, { input, stdout: new TextDecoder(), stderr: new TextDecoder(), started: () => accept("started"),
      settle: (value) => { if (!("exit" in value)) this.runs.delete(id); accept(value); resolve(value) } })
    try { channel.send({ kind: "run", id, file: input.file, args: input.args, cwd: input.cwd, env: input.env } satisfies RunnerRequest) }
    catch (error) { this.runs.delete(id); return { failed: errorMessage(error) } }
    const first = await accepted
    if (first === "started" || "exit" in first) return { id, outcome }
    if ("failed" in first) return { failed: first.failed }
    return this.ending ? { failed: first.ended } : { retry: first.ended }
  }

  kill(id: string): void { this.sendIfAlive({ kind: "kill", id }) }

  release(id: string): void {
    this.runs.delete(id)
    this.sendIfAlive({ kind: "release", id })
  }

  async end(): Promise<void> {
    this.ending = true
    const channel = this.channel ?? (this.starting ? await this.starting.catch((error: unknown) => { this.services.log.warn("Pi shell host did not start", { sessionId: this.sessionId, error: errorMessage(error) }); return undefined }) : undefined)
    this.channel = undefined
    if (!channel) return
    if (channel.alive) {
      channel.send({ kind: "end" } satisfies RunnerRequest)
      await Promise.race([channel.process.exited, new Promise<void>((resolve) => this.services.clock.setTimeout(() => resolve(), END_MS))])
    }
    const outcome = await channel.process.retire(deadlineAfter(this.services.clock, RETIRE_MS))
    if (!outcome.stopped) this.services.log.error("Pi shell host retirement failed", { sessionId: this.sessionId, error: outcome.error.message })
  }

  private sendIfAlive(request: RunnerRequest): void {
    if (this.channel?.alive) this.channel.send(request)
  }

  private ensure(): Promise<NdjsonOwnedProcess> {
    if (this.channel?.alive) return Promise.resolve(this.channel)
    this.starting ??= this.spawn().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async spawn(): Promise<NdjsonOwnedProcess> {
    const command = this.command()
    const owned = await this.services.spawn({ file: command.file, args: command.args, cwd: this.cwd, env: this.env },
      { role: "harness", label: "Pi shell host", sessionId: this.sessionId, signal: new AbortController().signal })
    const channel = new NdjsonOwnedProcess(owned, this.services.clock, (value) => this.receive(value),
      (reason, cause) => new Error(reason === "exit" ? `The shell host ended (${describeExit(cause)})` : `The shell host ${reason} failed: ${errorMessage(cause)}`),
      (error) => this.services.log.error("Pi shell host retirement failed", { sessionId: this.sessionId, error: errorMessage(error) }))
    channel.onFailure((error) => {
      if (this.channel === channel) this.channel = undefined
      if (!this.ending) this.lost = true
      for (const run of this.runs.values()) run.settle({ ended: error.message })
      this.runs.clear()
    })
    this.channel = channel
    return channel
  }

  private receive(value: unknown): void {
    if (!isRunnerReply(value)) throw new Error("Pi shell host answered in no form this transport reads")
    const run = this.runs.get(value.id)
    if (!run) return
    if (value.kind === "output") {
      const text = run[value.stream].decode(Buffer.from(value.data, "base64"), { stream: true })
      if (text) run.input.onOutput(text)
      return
    }
    if (value.kind === "started") {
      if (this.lost) {
        this.lost = false
        run.input.onOutput(`${RUNNER_RESTARTED_NOTICE}\n`)
      }
      run.started()
    } else if (value.kind === "exit") run.settle({ exit: { code: value.code, signal: value.signal } })
    else if (value.kind === "failed") run.settle({ failed: value.message })
  }
}

function describeExit(cause: unknown): string {
  const row = cause && typeof cause === "object" ? cause as { code?: unknown; signal?: unknown } : undefined
  if (row && typeof row.signal === "string") return `signal ${row.signal}`
  if (row && typeof row.code === "number") return `code ${row.code}`
  return errorMessage(cause)
}

export type { RunnerReply }
