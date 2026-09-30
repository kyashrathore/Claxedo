import type { Query, SDKActiveGoalMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { AsyncPushQueue } from "@claxedo/helpers"
import type { RoutedEvent } from "../../contract"
import { claudeChildFrameKey } from "./events"
import { createClaudeTaskLedger, createClaudeTranslatorMemory } from "./translate"
import { ClaudeHeldFrames } from "./held-frames"
import { ClaudeQueryInput } from "./query-input"
import type { ClaudeMirroredUsage } from "./mirrored-usage"
import type { ClaudeProcess } from "./process"

export type ClaudeFrame = SDKMessage | SDKActiveGoalMessage

export type ClaudeLaunchKey = string

export type ClaudeClaimEnd = "result" | "prompt" | "exit"

export type ClaudeClaim = { frames: AsyncIterable<ClaudeFrame>; dropped?: RoutedEvent }

type Claim = { sink: AsyncPushQueue<ClaudeFrame>; end: ClaudeClaimEnd; interrupted: boolean }

type Frames = { kind: "idle" } | { kind: "announced" } | { kind: "claimed"; claim: Claim }

type Process = { kind: "launching" } | { kind: "open"; stream: Query } | { kind: "closing"; stream: Query } | { kind: "ended"; failure?: unknown }

type MirroredRequest = Parameters<ClaudeMirroredUsage["observe"]>[0]

export type ClaudeBetweenTurns = { unclaimed: () => void; child: (frame: SDKMessage) => Promise<void>; background: (active: boolean) => void }

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
  readonly memory = createClaudeTranslatorMemory()
  readonly usage = new ClaudeUsageRelay()
  readonly processes = new Set<ClaudeProcess>()
  private background = new Set<string>()
  private readonly held = new ClaudeHeldFrames()
  private frames: Frames = { kind: "idle" }
  private process: Process = { kind: "launching" }
  private resolveEnded!: () => void
  readonly ended = new Promise<void>((resolve) => { this.resolveEnded = resolve })

  private delivered = Promise.resolve()

  constructor(readonly key: ClaudeLaunchKey, private readonly between: ClaudeBetweenTurns) {}

  get childrenDelivered(): Promise<void> { return this.delivered }

  get reusable(): boolean { return this.process.kind === "open" && this.frames.kind !== "claimed" }

  get failure(): unknown { return this.process.kind === "ended" ? this.process.failure : undefined }

  get stderr(): string { return [...this.processes].at(-1)?.stderr ?? "" }

  run(stream: Query): void {
    this.process = { kind: "open", stream }
    void this.read(stream)
  }

  fail(error: unknown): void {
    this.input.close()
    this.finish(error)
  }

  claim(end: ClaudeClaimEnd): ClaudeClaim | undefined {
    if (this.frames.kind === "claimed") return undefined
    const claim: Claim = { sink: new AsyncPushQueue<ClaudeFrame>(), end, interrupted: false }
    this.frames = { kind: "claimed", claim }
    const { frames, dropped } = this.held.take()
    for (const frame of frames) this.route(frame)
    if (this.process.kind === "ended" && this.frames.kind === "claimed" && this.frames.claim === claim) this.settle(claim)
    return { frames: claim.sink, ...(dropped ? { dropped } : {}) }
  }

  release(): void {
    if (this.frames.kind !== "claimed") return
    const { sink } = this.frames.claim
    this.frames = { kind: "idle" }
    sink.end()
  }

  close(): void {
    this.input.close()
    if (this.process.kind === "open") this.process = { kind: "closing", stream: this.process.stream }
  }

  async stopBackground(): Promise<void> {
    if (this.process.kind === "open") {
      const { stream } = this.process
      for (const task of [...this.background]) await stream.stopTask(task)
    }
    this.close()
  }

  spawnCall(taskId: string): string | undefined {
    const call = this.tasks.get(taskId)?.toolUseId
    return call === undefined ? undefined : this.tasks.firstLevelSubagent(call)
  }

  async stopTask(toolCallId: string): Promise<boolean> {
    const task = [...this.background].find((id) => this.tasks.get(id)?.toolUseId === toolCallId)
    if (this.process.kind !== "open" || task === undefined) return false
    await this.process.stream.stopTask(task)
    return true
  }

  async interrupt(): Promise<void> {
    if (this.frames.kind === "claimed") this.frames.claim.interrupted = true
    if (this.process.kind === "open" || this.process.kind === "closing") await this.process.stream.interrupt()
  }

  terminate(): void {
    this.input.close()
    this.replaceBackground(new Set())
    this.abort.abort()
    if (this.process.kind === "open" || this.process.kind === "closing") this.process.stream.close()
  }

  private async read(stream: Query): Promise<void> {
    try {
      for await (const frame of stream as AsyncIterable<ClaudeFrame>) {
        this.track(frame)
        this.route(frame)
      }
      this.finish()
    } catch (error) {
      this.finish(error)
    }
  }

  private finish(failure?: unknown): void {
    this.process = { kind: "ended", ...(failure === undefined ? {} : { failure }) }
    this.replaceBackground(new Set())
    if (this.frames.kind === "claimed") this.settle(this.frames.claim)
    this.resolveEnded()
  }

  private settle(claim: Claim): void {
    const failure = this.failure
    this.frames = { kind: "idle" }
    if (failure === undefined || claim.end === "exit") claim.sink.end()
    else claim.sink.fail(failure)
  }

  private ends(claim: Claim): boolean {
    if (claim.end === "exit") return false
    return claim.end === "result" || claim.interrupted || this.input.replayed
  }

  private track(frame: ClaudeFrame): void {
    if (frame.type !== "system" || frame.subtype !== "background_tasks_changed") return
    this.replaceBackground(new Set(frame.tasks.map((task) => task.task_id)))
    if (this.background.size === 0 && this.frames.kind !== "claimed") this.close()
  }

  private replaceBackground(next: Set<string>): void {
    const was = this.background.size > 0
    this.background = next
    if (was !== next.size > 0) this.between.background(next.size > 0)
  }

  private hold(frame: ClaudeFrame): void {
    if (frame.type !== "active_goal" && claudeChildFrameKey(frame, this.tasks) !== undefined) {
      if (frame.type !== "stream_event") this.delivered = this.delivered.then(() => this.between.child(frame))
      return
    }
    if (frame.type === "tool_progress" || (frame.type === "stream_event" && this.frames.kind === "idle")) return
    this.held.hold(frame)
    if (this.frames.kind !== "idle" || frame.type !== "system" || frame.subtype !== "init") return
    this.frames = { kind: "announced" }
    this.between.unclaimed()
  }

  private route(frame: ClaudeFrame): void {
    if (this.frames.kind !== "claimed") {
      this.hold(frame)
      return
    }
    const { claim } = this.frames
    claim.sink.push(frame)
    this.input.acknowledge(frame)
    if (frame.type !== "result" || !this.ends(claim)) return
    this.frames = { kind: "idle" }
    claim.sink.end()
    this.input.endTurn()
    if (this.background.size === 0) this.close()
  }
}
