import { streamSSE } from "hono/streaming"
import { attachSseFanout } from "@claxedo/agent-sdk-runtime/sse"
import { isRetainedCompatEvent, type CompatEnvelope, type EventSessionDeleted } from "@claxedo/agent-sdk-runtime/compat-events"
import { presentationEventsFromRuntimeEnvelope } from "@claxedo/agent-event-runtime/projections/client-presentation"
import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-event-runtime"
import type { AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { Context } from "hono"
import { sep } from "node:path"
import { realDirectoryPath } from "../real-directory"
import { registeredWorkspaceDirectories } from "../target"
import type { RuntimeEventHub } from "../runtime-event-hub"
import { workspaceRuntimeBus, type WorkspaceRuntimeEvent } from "../bus"
import type { SessionAccessPolicy } from "../session-access-policy"
import {
  authorizeSessionEventScope,
  compatEnvelopeSessionId,
  isSessionEventScopeResponse,
  workspaceRuntimeEventSessionId,
} from "./session-event-privacy"
import {
  createIdentityAwareEventSource,
  defaultEventDeliveryPolicy,
  eventDeliveryPrincipal,
  type EventDeliveryOptions,
  type EventDeliveryPolicy,
  type EventDeliveryPrincipal,
} from "../event-delivery"

/**
 * Every data frame on `wr/events` is `{ directory, payload }`: the runtime's
 * projected presentation events (parts, deltas, tool state, todo,
 * permissions, status, diagnostics), the two runtime-channel events a client
 * renders (`subagent.updated`, `goal.*`), and the workspace's control frames
 * (pty, process, agent lifecycle, session lifecycle). The heartbeat and the
 * replay-gap notice are per-connection transport frames and carry no
 * directory.
 */
export type WorkspaceEventFrame =
  | CompatEnvelope
  | AgentEventEnvelope
  | { directory: string; payload: WorkspaceRuntimeEvent }

/**
 * Written in place of a replay when the requested cursor has fallen out of
 * the retention window, and at the head of a slow connection's queue when the
 * fanout had to shed a frame. Deliberately not a member of the frame union:
 * nothing publishes it onto a bus, it only ever exists per connection, and
 * the reader answers it by re-reading the sessions this stream feeds.
 */
export type WorkspaceEventGapFrame = {
  type: "stream.replay-gap"
  code: "runtime.sse_replay_gap"
  message: string
  severity: "warn"
  lastEventId?: string
  throughId?: string
}

type StreamFrame = WorkspaceEventFrame | WorkspaceEventGapFrame

function isGapFrame(frame: StreamFrame): frame is WorkspaceEventGapFrame {
  return "type" in frame && frame.type === "stream.replay-gap"
}

function isControlFrame(frame: WorkspaceEventFrame): frame is { directory: string; payload: WorkspaceRuntimeEvent } {
  const type = frame.payload.type
  return type.startsWith("pty.") || type.startsWith("process.") || type === "agent.lifecycle" || type === "session.lifecycle"
}

/**
 * Frames whose loss strands UI state in a shape nothing else self-heals: an
 * exit/stop that never arrives leaves a terminal or managed process pinned
 * to "running", a missed agent Idle/Error leaves an agent pinned to "Busy",
 * and `isRetainedCompatEvent` names the session-shaped ones. The replay
 * buffer keeps a second, independent ring of these, so a burst of chatty
 * frames cannot evict the one frame that settles a state machine, and the
 * fanout sheds them LAST when a slow consumer overflows its pending queue.
 */
export function isRetainedWorkspaceEventFrame(frame: StreamFrame) {
  if (isGapFrame(frame)) return false
  if (isControlFrame(frame)) {
    const event = frame.payload
    switch (event.type) {
      case "pty.exited":
      case "pty.deleted":
      case "process.stopped":
      case "process.crashed":
      case "session.lifecycle":
        return true
      case "pty.stream":
        return event.kind === "exit" || event.kind === "command-exit"
      case "agent.lifecycle":
        return event.eventType === "Idle" || event.eventType === "Error"
      default:
        return false
    }
  }
  return isRetainedCompatEvent(frame.payload as CompatEnvelope["payload"])
}

function sessionDeletion(frame: StreamFrame): EventSessionDeleted | undefined {
  if (isGapFrame(frame) || isControlFrame(frame)) return undefined
  const payload = frame.payload as CompatEnvelope["payload"]
  return payload.type === "session.deleted" ? payload : undefined
}

function isSessionDeletion(frame: StreamFrame) {
  return sessionDeletion(frame) !== undefined
}

function deletedSessionParent(frame: StreamFrame): string | undefined {
  return sessionDeletion(frame)?.properties.info.parentID
}

export function workspaceEventFrameSessionId(frame: StreamFrame): string | undefined {
  if (isGapFrame(frame)) return undefined
  if (isControlFrame(frame)) return workspaceRuntimeEventSessionId(frame.payload)
  return compatEnvelopeSessionId(frame as CompatEnvelope)
}

/**
 * A subagent's child session belongs to its parent's scope: a grantee who may
 * read the parent sees the child's frames on the same session-scoped stream.
 */
export type WorkspaceEventParents = {
  parentSessionIdFor(sessionId: string): string | undefined
}

export type WorkspaceEventsOptions = EventDeliveryOptions<StreamFrame> & {
  /** The runtime's own directory: what its control frames are addressed as, and what admits a bus frame as its own. */
  directory: string
  /** The workspace whose per-session worktrees (`registerWorkspaceDirectory`) this runtime also serves. */
  workspaceId?: string
  eventHub: RuntimeEventHub
  bus?: Pick<typeof workspaceRuntimeBus, "subscribe">
  /** The cwd a live pty was created under; a pty's later frames name only its id. */
  ptyDirectory?: (id: string) => string | undefined
  sessionParents?: WorkspaceEventParents
  sessionAccessPolicy?: SessionAccessPolicy
}

/**
 * The runtime bus is process-global — one daemon hosts an embedded runtime
 * per open workspace — so a handler admits a bus frame only when it names
 * this runtime's workspace: by its workspace id, by a directory the runtime
 * serves (its own, or a per-session worktree registered to the workspace —
 * those live under the storage root, never under the workspace directory),
 * or for a pty (and the terminal a lifecycle frame names) by the cwd it was
 * created under. A pty is remembered from its creation frame because its
 * exit and deletion name only the id, by which time the pty service may have
 * forgotten it. A lifecycle frame that names a workspace is that workspace's;
 * one that names neither a workspace, a directory nor a terminal (an agent
 * hook's own report) has nothing to check against and passes.
 */
function ownsControlFrames(options: Pick<WorkspaceEventsOptions, "directory" | "workspaceId" | "ptyDirectory">) {
  const root = realDirectoryPath(options.directory)
  const ptys = new Set<string>()
  const roots = () => [root, ...(options.workspaceId ? registeredWorkspaceDirectories(options.workspaceId).map(realDirectoryPath) : [])]
  const under = (directory: string | undefined) => {
    if (!directory) return false
    const real = realDirectoryPath(directory)
    return roots().some((base) => real === base || real.startsWith(base + sep))
  }
  const served = (directory: string | undefined) => !!directory && roots().includes(realDirectoryPath(directory))
  const ownsPty = (id: string) => {
    if (ptys.has(id)) return true
    if (!under(options.ptyDirectory?.(id))) return false
    ptys.add(id)
    return true
  }
  return (event: WorkspaceRuntimeEvent): boolean => {
    switch (event.type) {
      case "pty.created":
      case "pty.updated": {
        if (!under(event.info.cwd)) return false
        ptys.add(event.info.id)
        return true
      }
      case "pty.deleted": {
        const owned = ownsPty(event.id)
        ptys.delete(event.id)
        return owned
      }
      case "pty.exited":
      case "pty.stream":
        return ownsPty(event.id)
      case "agent.lifecycle":
        if (event.workspaceId && options.workspaceId) return event.workspaceId === options.workspaceId
        if (event.directory) return under(event.directory)
        if (event.terminalId) return ownsPty(event.terminalId)
        return true
      case "session.lifecycle":
        if (event.workspaceId && event.workspaceId === options.workspaceId) return true
        return !event.directory || served(event.directory)
      default:
        return served(event.directory)
    }
  }
}


/**
 * `/api/wr/events` — the one stream a workspace runtime serves.
 *
 * Two arms, decided by the workspace authority: a principal it admits to the
 * workspace reads the stream unscoped, and the session authority decides per
 * session what reaches it — the workspace's session-less frames, and every
 * session it may read (its own, a share it holds; the workspace's owner is
 * no exception: a session another member created in the workspace is not
 * theirs to read unless shared); a principal it refuses (a share grantee with
 * no workspace access) is answered 403 and re-opens with `?sessionID=`,
 * reading that session and its subagent children under a lease.
 *
 * The unscoped arm is admitted on a workspace lease the control plane mints
 * for the read: the request's own relay host token expires within a minute,
 * so a session first framing after that is authorized under the lease. The
 * session-scoped arm is admitted on that session's lease, which grants the
 * session outright. The delivery policy is the one renewer of both: its
 * cadence rolls the leases and re-asks the sessions a connection was granted,
 * and a refusal there ends the stream. A session-scoped connection reads in
 * a scope of its own, whose ring numbers only that session's frames.
 *
 * Two bounds on that: a lease's renewal is refused once the runtime access
 * token behind it expires, so a connection lives at most one token lifetime
 * (ten minutes through the daemon's proxy, which mints one per request) and
 * then reconnects by cursor into the same actor-keyed scope; and a
 * self-hosted node's embedded policy admits the unscoped arm by the stamped
 * role with no lease, so a member removed from the workspace keeps that
 * arm's session-less frames until the connection closes — only its session
 * grants are re-asked. The relay path ends the stream at the next renewal.
 *
 * `close()` releases the bus subscription when the runtime is disposed.
 *
 * Resumable by SSE `Last-Event-ID`. Two rules about NOT re-applying frames a
 * consumer has already applied:
 *
 *  1. A cursor-less connection is served NOTHING from the buffer — it resumes
 *     from `replay.lastId()`, i.e. "everything from now on". The reader
 *     applies directory events to its caches, so a full re-read would
 *     re-upsert `permission.asked` / `question.asked` for requests the user
 *     already answered and resurrect their docks.
 *  2. The connection opens with a heartbeat frame carrying the cursor it is
 *     resuming from, written BEFORE the fanout is attached so it can never
 *     interleave ahead of replayed frames. A reader only learns a cursor by
 *     receiving a frame, and a reader that drops before its first frame
 *     would otherwise reconnect cursor-less forever.
 *
 * Periodic heartbeats carry NO id: a reader's cursor must mean "the last
 * frame I applied", so a frame shed from a saturated pending queue is
 * redelivered on the next reconnect instead of skipped.
 */
export function workspaceEventsHandler(options: WorkspaceEventsOptions) {
  const bus = options.bus ?? workspaceRuntimeBus
  // A subagent child's frames are authorized and scoped as its parent's. The
  // child's deletion frame names its parent itself: by the time it is
  // decided the child's row is gone and the registry no longer knows it.
  const scopeSessionId = (frame: StreamFrame) => {
    const sessionId = workspaceEventFrameSessionId(frame)
    if (!sessionId) return undefined
    return options.sessionParents?.parentSessionIdFor(sessionId) ?? deletedSessionParent(frame) ?? sessionId
  }
  const delivery: EventDeliveryPolicy<StreamFrame> = options.policy ?? defaultEventDeliveryPolicy
  // A session-scoped connection reads one session, in a scope of its own
  // whose ring numbers only that session's frames — so its cursor is
  // contiguous in that ring, and a scope rebuilt after it was away has no
  // hole where a frame its wire never carried was numbered.
  // Kept synchronous when the policy is: a synchronous decision is applied
  // before the fanout attaches, and the source orders on that.
  const policy: EventDeliveryPolicy<StreamFrame> = Object.assign(
    (input: Parameters<EventDeliveryPolicy<StreamFrame>>[0]) => {
      const sessionScope = input.principal.mode === "unmanaged-local" ? undefined : input.principal.sessionScope
      if (sessionScope && input.sessionId !== sessionScope) return "omit" as const
      const decision = delivery(input)
      // Forgotten once THIS connection has decided the deletion, never before:
      // decided after its grant was gone, the deletion itself would read as a
      // refusal of a session the connection held.
      // A child's deletion is scoped to its parent, whose grant stays.
      const sessionId = input.sessionId
      if (!sessionId || !isSessionDeletion(input.event) || workspaceEventFrameSessionId(input.event) !== sessionId) return decision
      const forget = () => delivery.forgetSession?.(input.principal, sessionId)
      if (decision instanceof Promise) return decision.then((next) => { forget(); return next })
      forget()
      return decision
    },
    delivery,
  )
  const owns = ownsControlFrames(options)
  const source = createIdentityAwareEventSource<StreamFrame>({
    subscribe: (fn) => {
      const unsubscribeCompat = options.eventHub.subscribeGlobal((event) => fn(event))
      const unsubscribeRuntime = options.eventHub.subscribeRuntime((envelope) => {
        for (const event of presentationEventsFromRuntimeEnvelope(envelope)) fn(event)
      })
      const unsubscribeControl = bus.subscribe((event) => {
        if (!owns(event)) return
        fn({ directory: "directory" in event && event.directory ? event.directory : options.directory, payload: event })
      })
      return () => {
        unsubscribeCompat()
        unsubscribeRuntime()
        unsubscribeControl()
      }
    },
    policy,
    sessionId: scopeSessionId,
    // A create's protocol before the session exists is the creator's alone;
    // its draft id and failure message are nobody else's.
    actorId: (frame) =>
      !isGapFrame(frame) && isControlFrame(frame) && frame.payload.type === "session.lifecycle" && !frame.payload.sessionID
        ? frame.payload.actorId
        : undefined,
    sensitive: (frame) =>
      !isGapFrame(frame) && isControlFrame(frame) && frame.payload.type === "agent.lifecycle" &&
      (!!frame.payload.prompt || !!frame.payload.lastAssistantMessage),
    isTerminal: isRetainedWorkspaceEventFrame,
    ...(options.sequenceOrigin ? { sequenceOrigin: options.sequenceOrigin } : {}),
    ...(options.renewalIntervalMs !== undefined ? { renewalIntervalMs: options.renewalIntervalMs } : {}),
  })
  source.open({ mode: "unmanaged-local", connectionId: "local-replay" })

  const handler = async (c: Context) => {
    const scope = await authorizeSessionEventScope(c, options.sessionAccessPolicy)
    if (isSessionEventScopeResponse(scope)) return scope
    const admitted = await (options.principal?.(c) ?? eventDeliveryPrincipal(c))
    const principal: EventDeliveryPrincipal = scope.managed && admitted.mode !== "unmanaged-local"
      ? { ...admitted, sessionScope: scope.sessionId }
      : admitted
    if (scope.managed) {
      delivery.holdSession?.(principal, scope.sessionId, { lease: scope.lease, expiresAt: scope.expiresAt })
    } else if (scope.lease && scope.expiresAt !== undefined) {
      delivery.holdHost?.(principal, { lease: scope.lease, expiresAt: scope.expiresAt })
    }
    const opened = source.open(principal)
    await opened.ready
    return streamSSE(c, async (stream) => {
      const heartbeat = { type: "heartbeat" } as const
      const resumeFrom = c.req.header("last-event-id")
      // The cursor a cursor-less connection resumes from is the ring's own id,
      // read before the bootstrap heartbeat is written: the frames that land
      // between it and the fanout attaching are exactly what replaying after
      // it recovers, and nothing is missing behind it.
      const cursor = resumeFrom ?? opened.replay.lastId() ?? "0"
      // Decided BEFORE the fanout attaches: attaching is what marks a scope as
      // one whose numbering this reader has seen, and a cursor from another
      // numbering must be judged before that.
      const gap = resumeFrom !== undefined && opened.replay.hasGap(resumeFrom, opened.replay.lastId())
      const replay = { ...opened.replay, hasGap: () => gap }
      await stream
        .writeSSE({ id: cursor, data: JSON.stringify(heartbeat) })
        .catch(() => {})

      await new Promise<void>((resolve) => {
        let finished = false
        let cleanup: () => void = () => {}
        const finish = () => {
          if (finished) return
          finished = true
          cleanup()
          resolve()
        }
        cleanup = attachSseFanout<StreamFrame>({
          subscribe: (listener) => opened.subscribe(listener, () => {
            finish()
            stream.abort()
          }),
          write: async (frame, meta) => {
            return stream.writeSSE({
              ...(meta?.id ? { id: meta.id } : {}),
              data: JSON.stringify(frame),
            })
          },
          heartbeat,
          heartbeatMs: EVENT_STREAM_HEARTBEAT_MS,
          lastEventId: cursor,
          replay,
          replayLive: false,
          replayGap: ({ lastEventId, throughId }) => ({
            type: "stream.replay-gap",
            code: "runtime.sse_replay_gap",
            message: "Workspace runtime event replay cursor is no longer available; refetch session state.",
            severity: "warn",
            ...(lastEventId ? { lastEventId } : {}),
            ...(throughId ? { throughId } : {}),
          }),
        })
        // A client gone during the authority round trip or the ring's startup
        // is not reported by the stream: Hono fires `onAbort` only for an abort
        // after registration, and its writes swallow their errors. The
        // stream's flag and the request's own signal are what a connection
        // that never attached is released on.
        stream.onAbort(finish)
        const signal = c.req.raw.signal
        signal.addEventListener("abort", finish, { once: true })
        if (stream.aborted || signal.aborted) finish()
      })
    })
  }
  handler.close = () => source.close()
  return handler
}
