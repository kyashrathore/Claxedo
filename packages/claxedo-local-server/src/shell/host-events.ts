import type { Context } from "hono"
import {
  createIdentityAwareEventSource,
  isRetainedWorkspaceEventFrame,
  streamWorkspaceEventFrames,
  type WorkspaceEventFramesTap,
  type WorkspaceEventStreamFrame,
} from "@claxedo/workspace-runtime"

/** The registry view the aggregate reads: one stable object per mounted runtime. */
export type HostAggregateRuntime = {
  workspace: { id: string; directory: string }
  frames: WorkspaceEventFramesTap
}

export type HostAggregateRuntimeObserver = (
  listener: (runtime: HostAggregateRuntime, phase: "mounted" | "retired" | "disposed") => void,
) => () => void

export type HostAggregateEventsOptions = {
  observe: HostAggregateRuntimeObserver
  /** Where a fresh ring starts numbering: the clock, or 0 for a test that reads ids as 1, 2, 3. */
  sequenceOrigin?: () => number
}

/**
 * `/api/wr/events` with no workspace named — the daemon's HOST AGGREGATE.
 *
 * On loopback the daemon hosts every local workspace's runtime, and the
 * desktop holds one connection here instead of one per workspace (a browser
 * caps plain-HTTP connections per host at six, and a workspace off screen
 * went silent when it held none). Each runtime's frames ride it VERBATIM,
 * taken from the same subscription that feeds that runtime's own
 * `wr/events` (`WorkspaceHost.frames`), so nothing is projected twice and a
 * frame carries the directory the reader addresses it by.
 *
 * Runtimes mounted after a connection opened join it: the observer replays
 * what is mounted when the source subscribes and reports every later change.
 * A runtime is let go on `"disposed"`, not on `"retired"` — disposal aborts
 * the runtime's live turns, and the terminal `agent.lifecycle` and
 * `session.lifecycle` frames that settles are published from inside it, with
 * nothing downstream to re-state them. Nothing is buffered for a runtime that
 * is not mounted — a workspace with no live runtime has nothing live to say.
 *
 * One ring and one cursor space, the aggregate's own, under the
 * unmanaged-local principal: every runtime this process hosts is the local
 * user's, and `hostAggregateEvents` refuses any reader that is not
 * loopback-direct before this handler is reached. Otherwise the rules are a
 * runtime stream's, kept by calling the same writer
 * (`streamWorkspaceEventFrames`).
 */
export function createHostAggregateEventsHandler(options: HostAggregateEventsOptions) {
  const source = createIdentityAwareEventSource<WorkspaceEventStreamFrame>({
    subscribe: (fn) => {
      const attached = new Map<HostAggregateRuntime, () => void>()
      const stop = options.observe((runtime, phase) => {
        if (phase === "retired") return
        if (phase === "disposed") {
          attached.get(runtime)?.()
          attached.delete(runtime)
          return
        }
        if (attached.has(runtime)) return
        attached.set(runtime, runtime.frames.subscribe((frame) => fn(frame)))
      })
      return () => {
        stop()
        for (const detach of attached.values()) detach()
        attached.clear()
      }
    },
    policy: () => "deliver",
    sessionId: () => undefined,
    isTerminal: isRetainedWorkspaceEventFrame,
    ...(options.sequenceOrigin ? { sequenceOrigin: options.sequenceOrigin } : {}),
  })
  // Open from construction, so every frame is decided and numbered as it is
  // published; a scope created at the first connection instead re-decides the
  // whole retained ring in one batch under a startup deadline.
  source.open({ mode: "unmanaged-local", connectionId: "local-replay" })

  const handler = async (c: Context) => {
    const opened = source.open({ mode: "unmanaged-local", connectionId: crypto.randomUUID() })
    await opened.ready
    return streamWorkspaceEventFrames(c, opened)
  }
  handler.close = () => source.close()
  return handler
}
