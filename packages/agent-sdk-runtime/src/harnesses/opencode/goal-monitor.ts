/**
 * Watches the OpenCode server on behalf of every session that is running a Goal.
 *
 * A Goal advances without anyone streaming the turn, so progress only reaches
 * the runtime if something reads the server's event feed. That feed —
 * `/global/event` — is process-global: one connection carries every session on
 * the server. So this owns exactly ONE connection per adapter and fans it out to
 * the monitored sessions, instead of opening (and re-parsing) a copy per Goal.
 *
 * The engine announces every Goal transition itself: the snapshot is durable
 * session metadata, and the one durable write publishes `session.updated`
 * carrying the whole session info, goal metadata included. So the live channel
 * is that announcement, read straight off the feed. The authoritative HTTP read
 * is what a fresh connection starts from, because a transition that happened
 * while the stream was down was announced to nobody.
 */

import { eventSessionId, type CompatEvent } from "../../compat-events"
import { Log } from "../../log"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import {
  drainServerEventStream,
  openEventStream,
  type OpenCodeEventStreamHandle,
} from "./events"
import { announcedGoalSnapshot } from "./goal-metadata"
import type { OpenCodeRequestFn } from "./index"

const log = Log.create({ service: "opencode-goal-monitor" })

const MAX_RETRY_DELAY_MS = 5_000

export type OpenCodeGoalMonitorDeps = {
  /** Resolve the adapter's transport; may spawn or await the server. */
  request: () => Promise<OpenCodeRequestFn>
  /** Headers for the shared event stream, built for the given workspace directory. */
  streamHeaders: (directory: string) => Headers
  /** Authoritative Goal read for one session. */
  readGoal: (sessionId: string, directory: string) => Promise<RuntimeGoalSnapshot | null>
  /** Publish a Goal snapshot (deduped by the adapter). */
  publishGoal: (sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) => void
  /** Record whatever the adapter derives from a raw event (subagent observations). */
  observe: (event: CompatEvent, sessionId: string, directory: string) => void
  /** Build the per-session runtime publisher for one stream connection. */
  publisher: (sessionId: string, directory: string) => (event: CompatEvent) => void
}

type Monitored = {
  directory: string
  publish: (event: CompatEvent) => void
}

export class OpenCodeGoalMonitors {
  private readonly sessions = new Map<string, Monitored>()
  private stream: OpenCodeEventStreamHandle | undefined
  private retry: { timer: ReturnType<typeof setTimeout>; cancel: () => void } | undefined
  private running = false
  private disposed = false

  constructor(private readonly deps: OpenCodeGoalMonitorDeps) {}

  /** Watch `sessionId` until its Goal stops being active. */
  start(sessionId: string, directory: string) {
    if (this.disposed) return
    this.sessions.set(sessionId, { directory, publish: this.deps.publisher(sessionId, directory) })
    if (!this.running) {
      this.running = true
      void this.run().finally(() => {
        this.running = false
      })
      return
    }
    if (this.retry) {
      // Parked between connections: waking the watcher reads every monitored
      // Goal, this one included, instead of waiting out the remaining backoff.
      this.retry.cancel()
      return
    }
    // Parked on a live stream: read this session once so its snapshot is not
    // withheld until its first turn boundary.
    void this.refresh(sessionId, directory).catch((error: unknown) => {
      log.warn("OpenCode Goal monitor could not read a newly monitored Goal", { sessionId, error })
    })
  }

  /** Stop watching `sessionId`; closes the shared stream once nobody is left. */
  stop(sessionId: string) {
    if (!this.sessions.delete(sessionId)) return
    if (this.sessions.size === 0) this.closeStream()
  }

  isMonitoring(sessionId: string) {
    return this.sessions.has(sessionId)
  }

  monitored(): string[] {
    return [...this.sessions.keys()]
  }

  dispose() {
    this.disposed = true
    this.sessions.clear()
    this.closeStream()
  }

  private closeStream() {
    this.stream?.close()
    this.stream = undefined
    this.retry?.cancel()
  }

  private async run() {
    let failures = 0
    while (!this.disposed && this.sessions.size > 0) {
      let received = false
      try {
        const request = await this.deps.request()
        // Every connection starts from durable truth: a Goal may have finished
        // while the stream was down, and the reconnect is the only chance to see
        // it.
        await this.refreshAll()
        if (this.disposed || this.sessions.size === 0) return
        const stream = openEventStream(request, this.deps.streamHeaders(this.streamDirectory()))
        this.stream = stream
        for (const [sessionId, entry] of this.sessions) {
          entry.publish = this.deps.publisher(sessionId, entry.directory)
        }
        for await (const event of drainServerEventStream(stream)) {
          if (this.disposed || this.stream !== stream) return
          received = true
          const sessionId = eventSessionId(event)
          const entry = sessionId ? this.sessions.get(sessionId) : undefined
          if (!sessionId || !entry) continue
          this.deps.observe(event, sessionId, entry.directory)
          entry.publish(event)
          const announced = announcedGoalSnapshot(event)
          if (announced === undefined) continue
          this.settle(sessionId, entry.directory, announced)
          if (this.disposed || this.sessions.size === 0) return
        }
      } catch (error) {
        log.warn("OpenCode Goal monitor will reconnect after failure", {
          sessions: this.monitored(),
          error,
        })
      } finally {
        if (this.stream) this.stream = undefined
      }
      if (this.disposed || this.sessions.size === 0) return
      failures = received ? 1 : failures + 1
      if (!(await this.waitForRetry(failures))) return
    }
  }

  /**
   * `/global/event` is server-global, so any monitored workspace directory
   * resolves the same feed; the header only has to name a real workspace.
   */
  private streamDirectory() {
    return this.sessions.values().next().value!.directory
  }

  private async refreshAll() {
    for (const [sessionId, entry] of [...this.sessions]) {
      await this.refresh(sessionId, entry.directory)
    }
  }

  private async refresh(sessionId: string, directory: string) {
    this.settle(sessionId, directory, await this.deps.readGoal(sessionId, directory))
  }

  /**
   * Hand one observed snapshot to the adapter and drop the session once its
   * Goal is no longer running. Publication is deduped by the adapter, so the
   * same snapshot arriving from the reconnect read and from the engine's own
   * announcement publishes once.
   */
  private settle(sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) {
    this.deps.publishGoal(sessionId, directory, goal)
    if (!goal || goal.status !== "active") this.stop(sessionId)
  }

  private waitForRetry(failures: number) {
    const delay = Math.min(100 * 2 ** Math.min(failures - 1, 6), MAX_RETRY_DELAY_MS)
    return new Promise<boolean>((resolve) => {
      const finish = (retry: boolean) => {
        if (this.retry?.timer === timer) this.retry = undefined
        resolve(retry)
      }
      const timer = setTimeout(() => finish(!this.disposed && this.sessions.size > 0), delay)
      this.retry = {
        timer,
        cancel: () => {
          clearTimeout(timer)
          finish(!this.disposed && this.sessions.size > 0)
        },
      }
    })
  }
}
