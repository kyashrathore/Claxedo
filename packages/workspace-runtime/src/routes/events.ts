import { streamSSE } from "hono/streaming"
import { attachSseFanout, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION } from "@claxedo/agent-event-runtime"
import type { RuntimeEventEnvelope, RuntimeEventHub } from "../runtime-event-hub"
import type { Context } from "hono"
import {
  createIdentityAwareEventSource,
  defaultEventDeliveryPolicy,
  eventDeliveryPrincipal,
  type EventDeliveryOptions,
} from "../event-delivery"

export function isTerminalRuntimeEvent(event: RuntimeEventEnvelope) {
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

export type RuntimeEventOptions = EventDeliveryOptions<RuntimeEventEnvelope> & Partial<RuntimeEventAuthorization>

export function runtimeEventsHandler(
  eventHub: RuntimeEventHub,
  options: RuntimeEventOptions = {},
) {
  const source = createIdentityAwareEventSource({
    subscribe: eventHub.subscribeRuntime,
    policy: options.policy ?? defaultEventDeliveryPolicy,
    sessionId: (event) => event.sessionId,
    isTerminal: isTerminalRuntimeEvent,
  })
  source.open({ mode: "unmanaged-local", connectionId: "local-replay" })
  return async function handler(c: Context) {
    const parentSessionId = c.req.query("parentSessionId")
    if (parentSessionId && (!options.authorizeParent || !await options.authorizeParent(c, parentSessionId))) {
      return c.json({ error: "Forbidden" }, 403)
    }
    const allows = (event: RuntimeEventEnvelope) => {
      const eventParentSessionId = options.resolveParentSessionId?.(event)
      if (eventParentSessionId) return eventParentSessionId === parentSessionId
      if (!parentSessionId) return true
      return event.sessionId === parentSessionId
    }
    const opened = source.open(await (options.principal?.(c) ?? eventDeliveryPrincipal(c)))
    await opened.ready
    const scopedReplay = parentSessionId || options.resolveParentSessionId
      ? filterReplay(opened.replay, allows)
      : opened.replay
    return streamSSE(c, async (stream) => {
      const heartbeat = { type: "heartbeat" } as const
      let cleanup: () => void = () => {}
      cleanup = attachSseFanout<RuntimeEventEnvelope | typeof heartbeat>({
        subscribe: (listener) => opened.subscribe((event) => {
          if (allows(event)) listener(event)
        }, () => {
          cleanup()
          stream.abort()
        }),
        write: async (event, meta) => {
          return stream.writeSSE({
            ...(meta?.id ? { id: meta.id } : {}),
            data: JSON.stringify(event),
          })
        },
        heartbeat,
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
      await waitForSessionEventStream(stream, scope, sessionAccessPolicy, cleanup)
    })
  }
}
