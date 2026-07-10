import { randomUUID } from "crypto"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { claxedoBus, globalBus } from "../bus"

export function streamGlobalEvents(c: Context) {
  const normalizeEvent = (event: Parameters<Parameters<typeof globalBus.subscribe>[0]>[0]) => {
    const payload = event.payload as typeof event.payload & { id?: unknown }
    return {
      ...event,
      directory: event.directory ?? "global",
      payload: {
        id: typeof payload.id === "string" ? payload.id : randomUUID(),
        properties: {},
        ...event.payload,
      },
    }
  }
  return streamSSE(c, async (stream) => {
    const writeHeartbeat = () =>
      stream.writeSSE({
        data: JSON.stringify({
          directory: "global",
          payload: { id: randomUUID(), type: "server.connected", properties: {} },
        }),
      })
    const unsubscribeGlobal = globalBus.subscribe((event) => {
      void stream.writeSSE({ data: JSON.stringify(normalizeEvent(event)) })
    })
    // `claxedoBus` (aka `workspaceRuntimeBus`) carries events that never touch
    // `globalBus` — most importantly `session.lifecycle`, the ONLY notification
    // a non-opencode/harness (ACP) session's `POST /session` emits (see
    // `packages/workspace-runtime/src/routes/session-core.ts`'s `.post("/session")`,
    // which calls `publishSessionLifecycle`, never `publishGlobal`). Local/
    // unsigned workspaces never open a workspace-scoped `/api/wr/events`
    // connection (`claxedoEventStreamTargets` in
    // `packages/claxedo-app/src/providers/claxedo-events.tsx` only adds that
    // target for `cloud`/`user-hosted` workspace kinds) — this central stream,
    // shared by `/global/event` and the local-mode `/api/wr/events` fallback,
    // is their ONLY channel, so without this subscription a harness session's
    // `session.lifecycle` "created" event (and any later title update) is
    // silently dropped and the session never reaches the sidebar's session
    // inventory. Written verbatim (flat, unwrapped) to match the shape
    // `ClaxedoEventsProvider`'s `isClaxedoEvent` guard requires (a top-level
    // `.type`) — the same format `runtimeBusEventsHandler`
    // (`packages/workspace-runtime/src/routes/runtime-events.ts`) already uses
    // for workspace-scoped connections.
    const unsubscribeClaxedo = claxedoBus.subscribe((event) => {
      void stream.writeSSE({ data: JSON.stringify(event) })
    })
    void writeHeartbeat()
    const heartbeat = setInterval(() => {
      void writeHeartbeat()
    }, 5000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat)
        unsubscribeGlobal()
        unsubscribeClaxedo()
        resolve()
      })
    })
  })
}
