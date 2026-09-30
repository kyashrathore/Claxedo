import { NO_BACKGROUND_WORK, type BackgroundWork, type SubagentStatus } from "@claxedo/agent-runtime-contract"
import type { RoutedEvent } from "../../contract"
import { CodexEvents } from "./events"
import type { RpcMessage } from "./rpc"

export type ChildState = "spawned" | "running" | "idle" | "released"
type ChildMove = "turn-started" | "turn-ended" | "release"

const MOVES: Record<ChildState, Partial<Record<ChildMove, ChildState>>> = {
  spawned: { "turn-started": "running", release: "released" },
  running: { "turn-ended": "idle", release: "released" },
  idle: { "turn-started": "running", release: "released" },
  released: {},
}

export type ChildSpawn = { toolCallId?: string; label: string; description?: string; subagentType?: string }

export class CodexChild {
  state: ChildState = "spawned"
  turnId?: string
  interaction?: string
  outcome?: SubagentStatus
  readonly calls = new Set<string>()
  private events?: CodexEvents
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly threadId: string, readonly spawn?: ChildSpawn) {
    this.events = new CodexEvents(threadId)
    if (spawn?.toolCallId) this.calls.add(spawn.toolCallId)
  }

  move(move: ChildMove): ChildState {
    this.state = MOVES[this.state][move] ?? this.state
    if (this.state === "released") this.events = undefined
    return this.state
  }

  get live(): boolean { return this.state === "spawned" || this.state === "running" }

  translate(message: RpcMessage): RoutedEvent[] {
    return this.events ? this.events.ingest(message).map((routed) => ({ ...routed, route: { kind: "child", correlationKey: this.threadId } })) : []
  }

  enqueue(step: () => Promise<void>, fail: (error: unknown) => void): void {
    this.tail = this.tail.then(step).then(undefined, fail)
  }

  flushed(): Promise<void> { return this.tail }
}

export class CodexChildren {
  private readonly byThread = new Map<string, CodexChild>()
  private agents = 0

  constructor(private readonly backgroundWork: (work: BackgroundWork) => void) {}

  get(threadId: string | undefined): CodexChild | undefined { return threadId ? this.byThread.get(threadId) : undefined }

  has(threadId: string | undefined): boolean { return this.get(threadId) !== undefined }

  add(child: CodexChild): CodexChild {
    this.byThread.set(child.threadId, child)
    this.changed()
    return child
  }

  move(child: CodexChild, move: ChildMove): ChildState {
    const state = child.move(move)
    this.changed()
    return state
  }

  byCall(toolCallId: string): CodexChild | undefined {
    return [...this.byThread.values()].find((child) => child.calls.has(toolCallId))
  }

  end(): void {
    for (const child of this.byThread.values()) child.move("release")
    this.changed()
  }

  private changed(): void {
    const agents = [...this.byThread.values()].filter((child) => child.live).length
    if (agents === this.agents) return
    this.agents = agents
    this.backgroundWork({ ...NO_BACKGROUND_WORK, agents })
  }
}
