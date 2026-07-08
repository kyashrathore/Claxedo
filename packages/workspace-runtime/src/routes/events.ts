import { streamSSE } from "hono/streaming"
import { attachSseFanout, createSseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION } from "@claxedo/agent-event-runtime"
import type { RuntimeEventEnvelope, RuntimeEventHub } from "../runtime-event-hub"
import type { Context } from "hono"

function isTerminalRuntimeEvent(event: RuntimeEventEnvelope) {
  return event.payload.type === "finish" ||
    event.payload.type === "error" ||
    (event.payload.type === "session-status" && (event.payload.status === "idle" || event.payload.status === "error"))
}

export function runtimeEventsHandler(eventHub: RuntimeEventHub) {
  const replay = createSseReplayBuffer<RuntimeEventEnvelope>({ isTerminal: isTerminalRuntimeEvent })
  eventHub.subscribeRuntime((event) => {
    replay.push(event)
  })
  return async function handler(c: Context) {
    return streamSSE(c, async (stream) => {
      const cleanup = attachSseFanout({
        subscribe: eventHub.subscribeRuntime,
        write: (event, meta) => stream.writeSSE({
          ...(meta?.id ? { id: meta.id } : {}),
          data: JSON.stringify(event),
        }),
        heartbeat: { type: "heartbeat" },
        heartbeatMs: 30_000,
        lastEventId: c.req.header("last-event-id"),
        replay,
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
