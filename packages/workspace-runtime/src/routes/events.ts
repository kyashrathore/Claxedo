import { streamSSE } from "hono/streaming"
import { attachSseFanout } from "@claxedo/agent-sdk-runtime/sse"
import { isRetainedCompatEvent, type CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import { presentationEventsFromRuntimeEnvelope } from "@claxedo/agent-event-runtime/projections/client-presentation"
import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-event-runtime"
import type { AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { Context } from "hono"
import type { RuntimeEventHub } from "../runtime-event-hub"
import { workspaceRuntimeBus, type WorkspaceRuntimeEvent } from "../bus"
import type { SessionAccessPolicy } from "../session-access-policy"
import {
  authorizeSessionEventScope,
  compatEnvelopeSessionId,
  isSessionEventScopeResponse,
  scopedReplay,
  waitForSessionEventStream,
  workspaceRuntimeEventSessionId,
} from "./session-event-privacy"
import {
  createIdentityAwareEventSource,
  defaultEventDeliveryPolicy,
  eventDeliveryPrincipal,
  type EventDeliveryOptions,
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
  /** The runtime's own directory, stamped on control frames that name none. */
  directory: string
  eventHub: RuntimeEventHub
  bus?: Pick<typeof workspaceRuntimeBus, "subscribe">
  sessionParents?: WorkspaceEventParents
  sessionAccessPolicy?: SessionAccessPolicy
}

/**
 * `/api/wr/events` — the one stream a workspace runtime serves.
 *
 * Two arms, decided by the workspace authority: a principal it admits to the
 * workspace reads the stream unscoped — the owner sees every session, a
 * workspace share sees the workspace's session-less frames and the sessions
 * the authority grants it; a principal it refuses (a share grantee with no
 * workspace access) is answered 403 and re-opens with `?sessionID=`, reading
 * that session and its subagent children under a lease.
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
  // A subagent child's frames are authorized and scoped as its parent's.
  const scopeSessionId = (frame: StreamFrame) => {
    const sessionId = workspaceEventFrameSessionId(frame)
    if (!sessionId) return undefined
    return options.sessionParents?.parentSessionIdFor(sessionId) ?? sessionId
  }
  // Connections the workspace's OWNER holds: every session is theirs, so the
  // per-session grant the delivery policy negotiates for everyone else is
  // skipped. A workspace share (viewer, editor, admin) is admitted to the
  // unscoped stream too, but sees a session's frames only when the authority
  // grants that session — workspace access alone unlocks no session.
  const workspaceGrants = new Set<string>()
  const delivery = options.policy ?? defaultEventDeliveryPolicy
  const source = createIdentityAwareEventSource<StreamFrame>({
    subscribe: (fn) => {
      const unsubscribeCompat = options.eventHub.subscribeGlobal((event) => fn(event))
      const unsubscribeRuntime = options.eventHub.subscribeRuntime((envelope) => {
        for (const event of presentationEventsFromRuntimeEnvelope(envelope)) fn(event)
      })
      // The runtime bus is process-global (one daemon hosts several embedded
      // runtimes), so a frame that names its own directory keeps it; only a
      // frame that names none is addressed as this runtime's.
      const unsubscribeControl = bus.subscribe((event) => fn({
        directory: "directory" in event && typeof event.directory === "string" && event.directory ? event.directory : options.directory,
        payload: event,
      }))
      return () => {
        unsubscribeCompat()
        unsubscribeRuntime()
        unsubscribeControl()
      }
    },
    policy: (input) => workspaceGrants.has(input.principal.connectionId) ? "deliver" : delivery(input),
    sessionId: scopeSessionId,
    sensitive: (frame) =>
      !isGapFrame(frame) && isControlFrame(frame) && frame.payload.type === "agent.lifecycle" &&
      (!!frame.payload.prompt || !!frame.payload.lastAssistantMessage),
    isTerminal: isRetainedWorkspaceEventFrame,
  })
  source.open({ mode: "unmanaged-local", connectionId: "local-replay" })

  return async (c: Context) => {
    const scope = await authorizeSessionEventScope(c, options.sessionAccessPolicy, "sessionID")
    if (isSessionEventScopeResponse(scope)) return scope
    const allows = scope.managed
      ? (frame: StreamFrame) => !isGapFrame(frame) && scopeSessionId(frame) === scope.sessionId
      : (_frame: StreamFrame) => true
    const principal = await (options.principal?.(c) ?? eventDeliveryPrincipal(c))
    if (!scope.managed && scope.grant === "workspace" && principal.mode === "verified" && principal.role === "owner") {
      workspaceGrants.add(principal.connectionId)
    }
    const opened = source.open(principal)
    await opened.ready
    const replayForScope = scope.managed ? scopedReplay(opened.replay, allows) : opened.replay
    return streamSSE(c, async (stream) => {
      const heartbeat = { type: "heartbeat" } as const
      // The cursor a cursor-less connection resumes from is the ring's own id,
      // read before the bootstrap heartbeat is written: the frames that land
      // between it and the fanout attaching are exactly what replaying after
      // it recovers.
      const cursor = c.req.header("last-event-id") ?? opened.replay.lastId() ?? "0"
      await stream
        .writeSSE({ id: cursor, data: JSON.stringify(heartbeat) })
        .catch(() => {})

      let cleanup: () => void = () => {}
      cleanup = attachSseFanout<StreamFrame>({
        subscribe: (listener) => opened.subscribe((frame) => {
          if (allows(frame)) listener(frame)
        }, () => {
          cleanup()
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
        replay: replayForScope,
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

      await waitForSessionEventStream(stream, scope, options.sessionAccessPolicy, () => {
        workspaceGrants.delete(principal.connectionId)
        cleanup()
      })
    })
  }
}
