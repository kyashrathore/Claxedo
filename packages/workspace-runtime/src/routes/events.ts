import { streamSSE } from "hono/streaming"
import { attachSseFanout, createSseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION } from "@claxedo/agent-event-runtime"
import type { RuntimeEventEnvelope, RuntimeEventHub } from "../runtime-event-hub"
import type { Context } from "hono"
import type { SessionAccessPolicy } from "../session-access-policy"
import { authorizeSessionEventScope, scopedReplay } from "./session-event-privacy"

function isTerminalRuntimeEvent(event: RuntimeEventEnvelope) {
  return event.payload.type === "finish" ||
    event.payload.type === "error" ||
    (event.payload.type === "session-status" && (event.payload.status === "idle" || event.payload.status === "error")) ||
    (event.payload.type === "subagent-updated" && (
      event.payload.status === "completed" ||
      event.payload.status === "failed" ||
      event.payload.status === "killed" ||
      event.payload.status === "interrupted"
    ))
}

export type RuntimeEventAuthorization = {
  authorizeParent: (context: Context, parentSessionId: string) => boolean | Promise<boolean>
  resolveParentSessionId: (event: RuntimeEventEnvelope) => string | undefined
}

export function runtimeEventsHandler(
  eventHub: RuntimeEventHub,
  authorization?: RuntimeEventAuthorization,
  sessionAccessPolicy?: SessionAccessPolicy,
) {
  const replay = createSseReplayBuffer<RuntimeEventEnvelope>({ isTerminal: isTerminalRuntimeEvent })
  eventHub.subscribeRuntime((event) => {
    replay.push(event)
  })
  return async function handler(c: Context) {
    const parentSessionId = c.req.query("parentSessionId")
    const scope = await authorizeSessionEventScope(c, sessionAccessPolicy, "parentSessionId")
    if (scope instanceof Response) return scope
    if (parentSessionId && authorization && !await authorization.authorizeParent(c, parentSessionId)) {
      return c.json({ error: "Forbidden" }, 403)
    }
    if (parentSessionId && !authorization && !scope.managed) {
      return c.json({ error: "Forbidden" }, 403)
    }
    const allows = (event: RuntimeEventEnvelope) => {
      const eventParentSessionId = authorization?.resolveParentSessionId(event)
      if (eventParentSessionId) return eventParentSessionId === parentSessionId
      if (!parentSessionId) return true
      return event.sessionId === parentSessionId
    }
    const replayForScope = parentSessionId || authorization ? scopedReplay(replay, allows) : replay
    return streamSSE(c, async (stream) => {
      const cleanup = attachSseFanout({
        subscribe: (listener) => eventHub.subscribeRuntime((event) => {
          if (allows(event)) listener(event)
        }),
        write: (event, meta) => stream.writeSSE({
          ...(meta?.id ? { id: meta.id } : {}),
          data: JSON.stringify(event),
        }),
        heartbeat: { type: "heartbeat" },
        heartbeatMs: 30_000,
        lastEventId: c.req.header("last-event-id"),
        replay: replayForScope,
        replayLive: false,
        replayGap: ({ lastEventId, throughId }) => ({
          contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION as RuntimeEventEnvelope["contractVersion"],
          directory: c.req.query("directory") ?? "global",
          sessionId: "__runtime__",
          payload: {
            type: "harness-notice",
            code: "runtime.sse_replay_gap",
            message: "Runtime event replay cursor is no longer available; refetch session state.",
            severity: "warn" as const,
            details: {
              ...(lastEventId ? { lastEventId } : {}),
              ...(throughId ? { throughId } : {}),
            },
          },
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
