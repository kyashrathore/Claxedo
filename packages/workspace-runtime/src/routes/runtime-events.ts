import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { attachSseFanout, createSseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { workspaceRuntimeBus, type WorkspaceRuntimeEvent } from "../bus"
import type { SessionAccessPolicy } from "../session-access-policy"
import {
  authorizeSessionEventScope,
  scopedReplay,
  workspaceRuntimeEventSessionId,
} from "./session-event-privacy"

/**
 * Synthetic frame written in place of a replay when the requested cursor has
 * already fallen out of the retention window. Deliberately NOT a member of
 * {@link WorkspaceRuntimeEvent}: nothing publishes it onto the bus, it only
 * ever exists per-connection, and keeping it out of the bus union means no
 * consumer of that union has to grow a case for it. Consumers that do not know
 * the type simply ignore it (claxedo-app's event emitter dispatches by `type`
 * and no-ops on an unregistered one); consumers that do know it should refetch
 * the state the stream feeds instead of trusting their incremental view.
 */
export type WorkspaceRuntimeStreamGapEvent = {
  type: "stream.replay-gap"
  code: "runtime.sse_replay_gap"
  message: string
  severity: "warn"
  lastEventId?: string
  throughId?: string
}

type StreamFrame = WorkspaceRuntimeEvent | WorkspaceRuntimeStreamGapEvent

/**
 * Frames whose loss strands UI state in a shape nothing else self-heals: an
 * exit/stop that never arrives leaves a terminal or managed process pinned to
 * "running", and a missed agent Idle/Error leaves an agent pinned to "Busy".
 *
 * Two effects, both wanted here:
 *  - `createSseReplayBuffer` keeps a second, independent ring of these, so a
 *    burst of chatty frames cannot evict the one frame that settles a state
 *    machine;
 *  - `attachSseFanout` drops heartbeats first and terminal frames LAST when a
 *    slow consumer overflows the per-connection pending queue.
 */
function isTerminalBusEvent(event: StreamFrame) {
  switch (event.type) {
    case "pty.exited":
    case "pty.deleted":
    case "process.stopped":
    case "process.crashed":
      return true
    case "pty.stream":
      return event.kind === "exit" || event.kind === "command-exit"
    case "agent.lifecycle":
      return event.eventType === "Idle" || event.eventType === "Error"
    default:
      return false
  }
}

type WorkspaceRuntimeBus = Pick<typeof workspaceRuntimeBus, "subscribe">

/**
 * `/api/wr/events` — the flat (unwrapped) workspace-runtime bus stream.
 *
 * Resumable by SSE `Last-Event-ID`, same shape as the sibling
 * `/api/wr/runtime-events` handler in `./events.ts`. Before this, the handler
 * was subscribe-on-connect only: every frame published while a consumer sat in
 * its reconnect gap (claxedo-app's 2s reconnect floor, its 45s heartbeat
 * watchdog, the 2s session-switch quiet window) was gone for good, and only
 * the frame types with an independent REST reconciliation path recovered.
 *
 * Two deliberate differences from `./events.ts`, both about NOT re-applying
 * frames a consumer has already applied:
 *
 *  1. A cursor-less connection is served NOTHING from the buffer — it resumes
 *     from `replay.lastId()`, i.e. "everything from now on". `./events.ts`
 *     replays its whole retained log to a cursor-less connection, which is
 *     wrong for THIS stream: claxedo-app's reader
 *     (`app/integrations/claxedo-events.tsx`) unwraps `{directory, payload}`
 *     envelopes and applies directory events to the shell caches, so a full
 *     re-read re-upserts `permission.asked` / `question.asked` for requests
 *     the user already answered and resurrects their docks. Re-applying is
 *     safe for the pure state frames on this bus (`pty.*` upserts by id,
 *     `process.*` status assignment, `agent.lifecycle`, `session.lifecycle`
 *     upsert by id) and NOT safe for the accumulating/consumed ones, so the
 *     handler simply never creates the duplicate rather than sorting frames
 *     into safe and unsafe buckets.
 *
 *  2. The connection opens with a heartbeat frame carrying the cursor it is
 *     resuming from. Without it the buffer would be dead weight for exactly
 *     the gap that matters most: a reader only learns a cursor by receiving a
 *     frame, so a reader that drops before its first frame — the common case
 *     across the draft -> session navigation, seconds after page load —
 *     reconnects cursor-less and the fix would not apply to it. The bootstrap
 *     id is `replay.lastId() ?? "0"`; "0" is the "nothing retained yet"
 *     cursor, and a later resume from it correctly replays from the start of
 *     the buffer. It is written BEFORE the fanout is attached so it can never
 *     interleave ahead of replayed frames and walk a reader's cursor forward
 *     past frames it has not seen.
 *
 * Periodic heartbeats intentionally carry NO id: a reader's cursor must mean
 * "the last frame I applied", so that a frame dropped from a saturated pending
 * queue is redelivered on the next reconnect instead of being skipped over.
 */
export function runtimeBusEventsHandler(
  bus: WorkspaceRuntimeBus = workspaceRuntimeBus,
  sessionAccessPolicy?: SessionAccessPolicy,
) {
  // Retention matches `./events.ts` (256 frames, plus a 64-frame terminal
  // ring). Sizing is deliberate rather than copied: this bus carries control
  // frames only — pty/process lifecycle, agent lifecycle, session lifecycle —
  // and no token-level deltas (those ride the runtime event hub on
  // `/api/wr/runtime-events`), and the only pty payload that could be chatty
  // (`pty.stream` kind "data") is published solely on a managed process'
  // address-in-use detection. 256 control frames is therefore far more than
  // the worst client gap (45s heartbeat watchdog + 2s reconnect floor) can
  // span in any realistic workload, and keeping the two SSE routes on one
  // number keeps one thing to reason about.
  const replay = createSseReplayBuffer<StreamFrame>({ isTerminal: isTerminalBusEvent })
  bus.subscribe((event) => {
    replay.push(event)
  })
  return async (c: Context) => {
    const scope = await authorizeSessionEventScope(c, sessionAccessPolicy, "sessionID")
    if (scope instanceof Response) return scope
    const allows = scope.managed
      ? (event: StreamFrame) => workspaceRuntimeEventSessionId(event as WorkspaceRuntimeEvent) === scope.sessionId
      : (_event: StreamFrame) => true
    const replayForScope = scope.managed ? scopedReplay(replay, allows) : replay

    return streamSSE(c, async (stream) => {
      const heartbeat = { type: "heartbeat" } as const
      const cursor = c.req.header("last-event-id") ?? replay.lastId() ?? "0"

      await stream
        .writeSSE({ id: cursor, data: JSON.stringify(heartbeat) })
        .catch(() => {})

      const cleanup = attachSseFanout<StreamFrame>({
        subscribe: (listener) => bus.subscribe((event) => {
          if (allows(event)) listener(event)
        }),
        write: (event, meta) => stream.writeSSE({
          ...(meta?.id ? { id: meta.id } : {}),
          data: JSON.stringify(event),
        }),
        heartbeat,
        heartbeatMs: 30_000,
        lastEventId: cursor,
        replay: replayForScope,
        replayLive: false,
        replayGap: ({ lastEventId, throughId }) => ({
          type: "stream.replay-gap",
          code: "runtime.sse_replay_gap",
          message: "Workspace runtime event replay cursor is no longer available; refetch runtime state.",
          severity: "warn",
          ...(lastEventId ? { lastEventId } : {}),
          ...(throughId ? { throughId } : {}),
        }),
      })

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          cleanup()
          resolve()
        })
      })
    })
  }
}
