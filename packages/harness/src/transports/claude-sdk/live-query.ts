import type { Query, SDKActiveGoalMessage, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { AsyncPushQueue } from "@claxedo/helpers"
import { NO_BACKGROUND_WORK, sameBackgroundWork, type BackgroundWork } from "@claxedo/agent-runtime-contract"
import type { RoutedEvent } from "../../contract"
import { TransportError } from "../../contract"
import { countBackgroundTasks, type ClaudeBackgroundTask } from "./between-turns"
import { isClaudeOutsideTurnNotice } from "./translate/child-messages"
import { claudeChildFrameKey } from "./events"
import { createClaudeTaskLedger, createClaudeTranslatorMemory } from "./translate"
import { ClaudeHeldFrames } from "./held-frames"
import { ClaudeQueryInput } from "./query-input"
import type { ClaudeMirroredUsage } from "./mirrored-usage"
import type { ClaudeProcess } from "./process"
import { applyClaudeLiveSettings, applyClaudePermissionMode, type ClaudeLiveSettings } from "./live-settings"

export type ClaudeFrame = SDKMessage | SDKActiveGoalMessage

export type ClaudeClaimEnd = "result" | "prompt" | "exit"

export type ClaudeClaim = { frames: AsyncIterable<ClaudeFrame>; dropped?: RoutedEvent }

type Claim = { sink: AsyncPushQueue<ClaudeFrame>; end: ClaudeClaimEnd; interrupted: boolean }

type Frames = { kind: "idle" } | { kind: "announced" } | { kind: "claimed"; claim: Claim }

type Process = { kind: "launching" } | { kind: "open"; stream: Query } | { kind: "closing"; stream: Query } | { kind: "ended"; failure?: unknown }

type MirroredRequest = Parameters<ClaudeMirroredUsage["observe"]>[0]

export type ClaudeBetweenTurns = { unclaimed: (current: () => boolean) => void; stage: (frame: SDKMessage) => () => Promise<void>; background: (work: BackgroundWork) => void }

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
  transcriptOwner: string | undefined
  private background = new Set<string>()
  private work = NO_BACKGROUND_WORK
  private readonly held = new ClaudeHeldFrames()
  private frames: Frames = { kind: "idle" }
  private process: Process = { kind: "launching" }
  private resolveEnded!: () => void
  readonly ended = new Promise<void>((resolve) => { this.resolveEnded = resolve })

  private delivered = Promise.resolve()
  private preparingPrompt = false
  private settingsUpdate = Promise.resolve()
  private readonly opened = Promise.withResolvers<void>()

  constructor(readonly key: string, private readonly between: ClaudeBetweenTurns, private readonly settings?: ClaudeLiveSettings) {}

  get childrenDelivered(): Promise<void> { return this.delivered }

  get reusable(): boolean { return this.process.kind === "open" && this.frames.kind !== "claimed" }

  get hasBackgroundTasks(): boolean { return this.background.size > 0 }

  async prompt(opening: SDKUserMessage, assistantMessageId?: string, settings?: ClaudeLiveSettings): Promise<ClaudeClaim> {
    this.preparingPrompt = true
    try {
      if (settings) await this.updateSettings(async () => {
        if (this.process.kind === "open" && this.settings) await applyClaudeLiveSettings(this.process.stream, this.settings, settings)
      })
      if (!this.reusable) throw new TransportError("claude", "process", "Claude process ended while preparing the next prompt")
      this.input.write(opening)
      return this.claim("prompt", assistantMessageId)!
    } finally {
      this.preparingPrompt = false
      if (this.frames.kind !== "claimed" && this.background.size === 0) this.close()
    }
  }

  get failure(): unknown { return this.process.kind === "ended" ? this.process.failure : undefined }

  get stderr(): string { return [...this.processes].at(-1)?.stderr ?? "" }

  run(stream: Query): void {
    this.process = { kind: "open", stream }
    this.opened.resolve()
    void this.read(stream)
  }

  setPermissionMode(modeId: string): Promise<void> {
    return this.updateSettings(async () => {
      await this.opened.promise
      if (this.process.kind !== "open") return
      try { await applyClaudePermissionMode(this.process.stream, this.settings, modeId) }
      catch (cause) { throw new TransportError("claude", "configuration", "Claude refused the permission mode change", { cause }) }
    })
  }

  private updateSettings(apply: () => Promise<void>): Promise<void> {
    const update = this.settingsUpdate.then(apply, apply)
    this.settingsUpdate = update
    return update
  }

  fail(error: unknown): void {
    this.input.close()
    this.finish(error)
  }

  claim(end: ClaudeClaimEnd, assistantMessageId?: string): ClaudeClaim | undefined {
    if (this.frames.kind === "claimed") return undefined
    if (assistantMessageId) this.transcriptOwner = assistantMessageId
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
    this.replaceBackground([])
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
    this.opened.resolve()
    this.replaceBackground([])
    if (this.frames.kind === "claimed") this.settle(this.frames.claim)
    void this.delivered.then(() => this.resolveEnded(), (error: unknown) => {
      this.process = { kind: "ended", failure: error }
      this.resolveEnded()
    })
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
    if (frame.type === "system" && frame.subtype === "status" && frame.permissionMode && this.settings) {
      this.settings.permissionMode = frame.permissionMode
    }
    if (frame.type !== "system" || frame.subtype !== "background_tasks_changed") return
    this.replaceBackground(frame.tasks)
    if (this.background.size === 0 && this.frames.kind !== "claimed" && !this.preparingPrompt) this.close()
  }

  private replaceBackground(tasks: readonly ClaudeBackgroundTask[]): void {
    this.background = new Set(tasks.map((task) => task.task_id))
    const work = countBackgroundTasks(tasks)
    if (sameBackgroundWork(work, this.work)) return
    this.work = work
    this.between.background(work)
  }

  private hold(frame: ClaudeFrame): void {
    if (frame.type !== "active_goal" && (claudeChildFrameKey(frame, this.tasks) !== undefined || isClaudeOutsideTurnNotice(frame))) {
      if (frame.type !== "stream_event") this.delivered = this.delivered.then(this.between.stage(frame))
      return
    }
    if (frame.type === "tool_progress" || (frame.type === "stream_event" && this.frames.kind === "idle")) return
    this.held.hold(frame)
    if (this.frames.kind !== "idle" || frame.type !== "system" || frame.subtype !== "init") return
    const announced = { kind: "announced" as const }
    this.frames = announced
    this.between.unclaimed(() => this.frames === announced)
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
