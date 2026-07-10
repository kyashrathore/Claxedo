import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import { claxedoBus, globalBus } from "../bus"
import { streamGlobalEvents } from "./opencode-compat-events"

// Regression coverage for the BUG A root cause: `claxedoBus` (aka
// `workspaceRuntimeBus`) carries `session.lifecycle`, the only notification a
// non-opencode/harness (ACP) session's `POST /session` publishes
// (`packages/workspace-runtime/src/routes/session-core.ts`). `streamGlobalEvents`
// used to subscribe ONLY to `globalBus` (fed exclusively by the embedded
// native opencode engine's own event bridge), so a harness session's
// `session.lifecycle` event was silently dropped for every local/unsigned
// workspace — the only kind that stays on this central stream
// (`claxedoEventStreamTargets` in `packages/claxedo-app/src/providers/
// claxedo-events.tsx` only opens a workspace-scoped connection for
// cloud/user-hosted workspaces). This never surfaced for opencode-native
// sessions because those ALSO get bridged onto `globalBus` separately
// (`packages/claxedo-server/src/server.ts`'s `upstreamEvents` handler).
function mountStreamGlobalEvents() {
  return new Hono().get("/global/event", (c) => streamGlobalEvents(c))
}

async function readNextFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const next = await reader.read()
  return new TextDecoder().decode(next.value)
}

describe("streamGlobalEvents", () => {
  test("forwards claxedoBus session.lifecycle events verbatim (flat shape), not wrapped", async () => {
    const app = mountStreamGlobalEvents()
    const ac = new AbortController()
    const res = await app.request("http://127.0.0.1/global/event", { signal: ac.signal })
    const reader = res.body!.getReader()

    // First frame is the connection handshake.
    expect(await readNextFrame(reader)).toContain("server.connected")

    claxedoBus.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/tmp/streamGlobalEvents-claxedo-test",
      sessionID: "ses_claxedo_1",
      info: { id: "ses_claxedo_1" },
      ts: 1,
    })

    const frame = await readNextFrame(reader)
    ac.abort()

    // Flat, unwrapped shape — matches `runtimeBusEventsHandler`
    // (packages/workspace-runtime/src/routes/runtime-events.ts), which is what
    // `ClaxedoEventsProvider`'s `isClaxedoEvent` guard
    // (packages/claxedo-app/src/providers/claxedo-events.tsx) requires: a
    // top-level `.type`. A `{directory, payload:{...}}` envelope would fail
    // that guard and be silently dropped.
    expect(frame).toContain(`"type":"session.lifecycle"`)
    expect(frame).toContain(`"phase":"created"`)
    expect(frame).toContain(`"directory":"/tmp/streamGlobalEvents-claxedo-test"`)
    expect(frame).toContain(`"sessionID":"ses_claxedo_1"`)
    expect(frame).not.toContain(`"payload"`)
  })

  test("still forwards globalBus events wrapped in {directory,payload} (unchanged native-opencode path)", async () => {
    const app = mountStreamGlobalEvents()
    const ac = new AbortController()
    const res = await app.request("http://127.0.0.1/global/event", { signal: ac.signal })
    const reader = res.body!.getReader()

    await readNextFrame(reader) // handshake

    globalBus.publish({
      directory: "/tmp/streamGlobalEvents-global-test",
      payload: {
        type: "session.created",
        properties: { info: { id: "ses_global_1" } },
      },
    })

    const frame = await readNextFrame(reader)
    ac.abort()

    expect(frame).toContain(`"directory":"/tmp/streamGlobalEvents-global-test"`)
    expect(frame).toContain(`"payload"`)
    expect(frame).toContain(`"type":"session.created"`)
  })
})
