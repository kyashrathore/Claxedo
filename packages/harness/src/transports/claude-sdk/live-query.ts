import type { Query, SDKActiveGoalMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { AsyncPushQueue } from "@claxedo/helpers"
import { createClaudeTaskLedger } from "./translate"
import { ClaudeQueryInput } from "./query-input"
import type { ClaudeMirroredUsage } from "./mirrored-usage"

export type ClaudeFrame = SDKMessage | SDKActiveGoalMessage

export type ClaudeLaunchKey = string

type Finished = { kind: "ended" } | { kind: "failed"; error: unknown }

type MirroredRequest = Parameters<ClaudeMirroredUsage["observe"]>[0]

export class ClaudeUsageRelay {
  private current: ClaudeMirroredUsage | undefined
  private readonly early: MirroredRequest[] = []

  target(usage: ClaudeMirroredUsage): void {
    this.current = usage
    for (const request of this.early.splice(0)) usage.observe(request)
  }

  observe(request: MirroredRequest): void {
    if (this.current) this.current.observe(request)
    else this.early.push(request)
  }
}

export class ClaudeLiveQuery {
  readonly input = new ClaudeQueryInput()
  readonly abort = new AbortController()
  readonly tasks = createClaudeTaskLedger()
  readonly usage = new ClaudeUsageRelay()
  private background = new Set<string>()
  private sink: AsyncPushQueue<ClaudeFrame> | undefined
  private held: ClaudeFrame[] = []
  private closing = false
  private announced = false
  private finished: Finished | undefined
  private stream: Query | undefined
  private resolveEnded!: () => void
  readonly ended = new Promise<void>((resolve) => { this.resolveEnded = resolve })

  constructor(readonly key: ClaudeLaunchKey, private readonly unclaimed: (notice: string | undefined) => void) {}

  get reusable(): boolean { return !this.closing && !this.finished && !this.sink }

  run(stream: Query): void {
    this.stream = stream
    void this.read(stream)
  }

  claim(): AsyncIterable<ClaudeFrame> | undefined {
    if (this.sink) return undefined
    const sink = new AsyncPushQueue<ClaudeFrame>()
    this.sink = sink
    this.announced = false
    for (const frame of this.held.splice(0)) this.route(frame)
    if (this.sink === sink && this.finished) this.finish(sink)
    return sink
  }

  release(): void {
    const sink = this.sink
    this.sink = undefined
    sink?.end()
  }

  close(): void {
    this.closing = true
    this.input.close()
  }

  interrupt(): void {
    this.abort.abort()
    this.stream?.close()
  }

  private async read(stream: Query): Promise<void> {
    try {
      for await (const frame of stream as AsyncIterable<ClaudeFrame>) {
        this.track(frame)
        this.route(frame)
      }
      this.finished = { kind: "ended" }
    } catch (error) {
      this.finished = { kind: "failed", error }
    }
    if (this.sink) this.finish(this.sink)
    this.sink = undefined
    this.resolveEnded()
  }

  private finish(sink: AsyncPushQueue<ClaudeFrame>): void {
    if (this.finished?.kind === "failed") sink.fail(this.finished.error)
    else sink.end()
  }

  private track(frame: ClaudeFrame): void {
    if (frame.type !== "system" || frame.subtype !== "background_tasks_changed") return
    this.background = new Set(frame.tasks.map((task) => task.task_id))
    if (this.background.size === 0 && !this.sink && !this.closing) this.close()
  }

  private hold(frame: ClaudeFrame): void {
    if (this.announced) {
      this.held.push(frame)
      return
    }
    if (frame.type === "stream_event") return
    this.held.push(frame)
    if (frame.type !== "system" || frame.subtype !== "init") return
    this.announced = true
    this.unclaimed(this.heldNotice())
  }

  private heldNotice(): string | undefined {
    const summaries = this.held.flatMap((frame) =>
      frame.type === "system" && frame.subtype === "task_notification" && frame.summary ? [frame.summary] : [])
    return summaries.length > 0 ? summaries.join("\n") : undefined
  }

  private route(frame: ClaudeFrame): void {
    const sink = this.sink
    if (!sink) {
      this.hold(frame)
      return
    }
    sink.push(frame)
    if (frame.type !== "result" || this.closing) return
    this.input.endTurn()
    if (this.background.size === 0) {
      this.close()
      return
    }
    this.sink = undefined
    sink.end()
  }
}
