import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import { claxedoBus, createBus, globalBus, type ClaxedoEvent, type GlobalEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import {
  createGlobalEventsHandler,
  globalEventSessionId,
  signedGlobalEventVisibleTo,
  streamGlobalEvents,
} from "./events"
import { eventScopePrincipal } from "@claxedo/server-core/platform/http/event-visibility"

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

describe("globalEventSessionId", () => {
  // `session.deleted` carries the id the same place `session.updated` does
  // (`properties.info.id`, never `properties.sessionID`). A signed
  // principal's per-session visibility check keys on this resolving, so a
  // delete notice with an unresolvable id would silently deny every signed
  // subscriber — the opposite of a private frame leaking, but still a
  // consumer never seeing a deletion it is entitled to.
  test("resolves the id from properties.info for session.deleted, like session.updated", () => {
    expect(globalEventSessionId({
      directory: "/tmp/central",
      payload: { id: "evt_1", type: "session.deleted", properties: { info: { id: "ses_1" } } },
    })).toBe("ses_1")
  })

  test("does not resolve an id from an unrelated event's info field", () => {
    expect(globalEventSessionId({
      directory: "/tmp/central",
      payload: { id: "evt_2", type: "message.updated", properties: { info: { id: "msg_1" } } },
    })).toBeUndefined()
  })
})

describe("signed global event visibility", () => {
  const principal = eventScopePrincipal({
    mode: "signed",
    token: "token",
    user: {
      subject: "user_1",
      tokenIdentifier: "issuer|user_1",
      issuer: "issuer",
    },
  }, "org_1")

  test("uses canonical subject and organization scoping for sessionless events", async () => {
    await expect(signedGlobalEventVisibleTo({
      type: "session.share.changed",
      phase: "granted",
      ownerUserId: "user_1",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      ts: 1,
    }, principal)).resolves.toBe(true)
    await expect(signedGlobalEventVisibleTo({
      type: "session.share.changed",
      phase: "granted",
      ownerUserId: "user_2",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      ts: 1,
    }, principal)).resolves.toBe(false)
    await expect(signedGlobalEventVisibleTo({
      type: "document.changed",
      orgId: "org_1",
      projectId: "project_1",
      documentId: "doc_1",
      ts: 1,
    }, principal)).resolves.toBe(true)
    await expect(signedGlobalEventVisibleTo({
      type: "document.changed",
      orgId: "org_2",
      projectId: "project_2",
      documentId: "doc_2",
      ts: 1,
    }, principal)).resolves.toBe(false)
  })

  test("fails closed for unclassified envelopes and delegates session frames", async () => {
    await expect(signedGlobalEventVisibleTo({
      directory: "/tmp/other",
      payload: { id: "evt_1", type: "provider.updated", properties: {} },
    }, principal)).resolves.toBe(false)

    const authorized: string[] = []
    await expect(signedGlobalEventVisibleTo({
      type: "session.lifecycle",
      phase: "created",
      sessionID: "ses_1",
      ts: 1,
    }, principal, async (sessionId) => {
      authorized.push(sessionId)
      return true
    })).resolves.toBe(true)
    expect(authorized).toEqual(["ses_1"])
  })
})

// ─── SSE replay ────────────────────────────────────────────────────────────
//
// Mirrors `packages/workspace-runtime/src/routes/runtime-events.test.ts`. This
// is the central `/global/event` + `/api/wr/events` stream used in local/desktop
// mode; it was subscribe-on-connect only, so every frame published while a
// consumer sat in its reconnect gap was gone for good. It is also the stream
// that carries `permission.asked` / `question.asked` compat envelopes, which is
// why a cursor-less connection must be served NOTHING from the ring.
//
// These tests drive `createGlobalEventsHandler` with private buses rather than
// the module-level `streamGlobalEvents`, so the retained sequence is
// deterministic instead of shared with the process-global buses.

type ReplayConnection = {
  until: (match: (text: string) => boolean, label: string) => Promise<string>
  ended: () => Promise<boolean>
  close: () => void
}

function mount(handler: ReturnType<typeof createGlobalEventsHandler>) {
  return new Hono().get("/api/wr/events", handler)
}

async function connect(app: Hono, lastEventId?: string, actor?: string, credential?: string): Promise<ReplayConnection> {
  const ac = new AbortController()
  const query = new URLSearchParams()
  if (actor) query.set("actor", actor)
  if (credential) query.set("credential", credential)
  const res = await app.request(`http://127.0.0.1/api/wr/events${query.size > 0 ? `?${query}` : ""}`, {
    ...(lastEventId === undefined ? {} : { headers: { "Last-Event-ID": lastEventId } }),
    signal: ac.signal,
  })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  return {
    async until(match, label) {
      for (let reads = 0; reads < 40; reads += 1) {
        if (match(text)) return text
        const next = await reader.read()
        if (next.done) break
        text += decoder.decode(next.value, { stream: true })
      }
      if (match(text)) return text
      throw new Error(`${label}\n--- stream so far ---\n${text}`)
    },
    async ended() {
      return await Promise.race([
        (async () => {
          for (let reads = 0; reads < 10; reads += 1) {
            if ((await reader.read()).done) return true
          }
          return false
        })(),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ])
    },
    close: () => ac.abort(),
  }
}

/** Field-order-independent frame split; Hono writes `data:` before `id:`. */
function frames(text: string) {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n")
      return {
        id: lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim(),
        data: lines.find((line) => line.startsWith("data:"))?.slice("data:".length).trim(),
      }
    })
}

function bootstrapId(text: string) {
  return frames(text)[0]?.id
}

function buses() {
  const global = createBus<GlobalEvent>()
  const claxedo = createBus<ClaxedoEvent>()
  const app = mount(createGlobalEventsHandler({ globalBus: global, claxedoBus: claxedo }))
  return { global, claxedo, app }
}

const part = (id: string): GlobalEvent => ({
  directory: "/tmp/central",
  payload: { type: "message.part.updated", properties: { part: { id } } },
})

describe("createGlobalEventsHandler — central /api/wr/events replay", () => {
  test("the handshake frame carries the cursor the connection resumes from", async () => {
    const { global, app } = buses()
    global.publish(part("prt_1"))
    global.publish(part("prt_2"))

    const stream = await connect(app)
    const text = await stream.until((seen) => seen.includes("server.connected"), "no cursor bootstrap frame")
    stream.close()

    // Shape unchanged (claxedo-app treats `server.connected` as a project
    // refresh nudge); the `id:` line is the only addition.
    expect(bootstrapId(text)).toBe("2")
    expect(frames(text)[0]?.data).toContain(`"type":"server.connected"`)
  })

  test("bootstraps at cursor 0 when nothing has been published yet", async () => {
    const { app } = buses()
    const stream = await connect(app)
    const text = await stream.until((seen) => seen.includes("server.connected"), "no cursor bootstrap frame")
    stream.close()

    expect(bootstrapId(text)).toBe("0")
  })

  test("a cursor-less connection is NOT served the retained log", async () => {
    // This stream carries `permission.asked`/`question.asked` compat envelopes
    // and claxedo-app applies them to the shell caches, so re-reading the log on
    // every reconnect resurrects docks the user already answered.
    const { global, app } = buses()
    global.publish({
      directory: "/tmp/central",
      payload: { type: "permission.asked", properties: { id: "perm_answered" } },
    })

    const stream = await connect(app)
    await stream.until((seen) => seen.includes("server.connected"), "no cursor bootstrap frame")
    global.publish(part("prt_after"))
    const text = await stream.until((seen) => seen.includes("prt_after"), "live frame never arrived")
    stream.close()

    expect(text).not.toContain("perm_answered")
  })

  test("live frames carry an `id:` line so the reader builds a cursor", async () => {
    const { global, claxedo, app } = buses()

    const stream = await connect(app)
    await stream.until((seen) => seen.includes("server.connected"), "no cursor bootstrap frame")
    global.publish(part("prt_live"))
    claxedo.publish({ type: "session.lifecycle", phase: "created", directory: "/tmp/central", sessionID: "ses_live", ts: 1 })
    const text = await stream.until((seen) => seen.includes("ses_live"), "live frames never arrived")
    stream.close()

    expect(frames(text).find((frame) => frame.data?.includes("prt_live"))?.id).toBe("1")
    expect(frames(text).find((frame) => frame.data?.includes("ses_live"))?.id).toBe("2")
  })

  test("the compat stream applies one content-aware visibility decision to live and replay", async () => {
    const global = createBus<GlobalEvent>()
    const claxedo = createBus<ClaxedoEvent>()
    const handler = createGlobalEventsHandler({ globalBus: global, claxedoBus: claxedo }, {
      resolveSubscription: (c) => {
        const actorId = c.req.query("actor")!
        return {
          identity: {
            mode: "verified",
            connectionId: `connection_${actorId}`,
            actorId,
            actorKind: "human",
            orgId: "org_1",
            workspaceId: "ws_1",
            role: "editor",
          },
          visible: (frame) => !globalEventSessionId(frame) || actorId === "actor_participant",
        }
      },
    })
    const app = mount(handler)
    claxedo.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/tmp/central",
      sessionID: "ses_private",
      ts: 1,
    })
    claxedo.publish({ type: "process.status", directory: "/tmp/central", configId: "proc_public", status: "running" })

    const participant = await connect(app, "0", "actor_participant")
    const workspaceOnly = await connect(app, "0", "actor_workspace_only")
    const participantText = await participant.until((seen) => seen.includes("proc_public"), "participant replay incomplete")
    const workspaceOnlyText = await workspaceOnly.until((seen) => seen.includes("proc_public"), "workspace replay incomplete")
    participant.close()
    workspaceOnly.close()

    expect(participantText).toContain("ses_private")
    expect(workspaceOnlyText).not.toContain("ses_private")
  })

  test("keeps live authorization connection-scoped when one actor renews credentials", async () => {
    const global = createBus<GlobalEvent>()
    const claxedo = createBus<ClaxedoEvent>()
    const revoked = new Set<string>()
    const handler = createGlobalEventsHandler({ globalBus: global, claxedoBus: claxedo }, {
      resolveSubscription: (c) => {
        const credential = c.req.query("credential")!
        return {
          identity: {
            mode: "verified",
            connectionId: `connection_${credential}`,
            actorId: "actor_participant",
            actorKind: "human",
            orgId: "org_1",
            workspaceId: "ws_1",
            role: "editor",
          },
          visible: (frame) => !globalEventSessionId(frame) || !revoked.has(credential),
        }
      },
    })
    const app = mount(handler)
    const old = await connect(app, undefined, "actor_participant", "old")
    const fresh = await connect(app, undefined, "actor_participant", "fresh")
    await old.until((seen) => seen.includes("server.connected"), "old connection did not open")
    await fresh.until((seen) => seen.includes("server.connected"), "fresh connection did not open")

    claxedo.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/tmp/central",
      sessionID: "ses_private",
      ts: 1,
    })
    await old.until((seen) => seen.includes("ses_private"), "old connection missed initial event")
    await fresh.until((seen) => seen.includes("ses_private"), "fresh connection missed initial event")

    revoked.add("old")
    claxedo.publish({
      type: "session.lifecycle",
      phase: "creating",
      directory: "/tmp/central",
      sessionID: "ses_private",
      ts: 2,
    })
    expect(await old.ended()).toBe(true)
    expect(await fresh.until((seen) => seen.includes('"phase":"creating"'), "fresh connection missed live event"))
      .toContain('"phase":"creating"')
    fresh.close()
  })

  test("private-session traffic cannot create a false gap for a workspace-only principal", async () => {
    const global = createBus<GlobalEvent>()
    const claxedo = createBus<ClaxedoEvent>()
    const handler = createGlobalEventsHandler({ globalBus: global, claxedoBus: claxedo }, {
      resolveSubscription: (c) => {
        const actorId = c.req.query("actor")!
        return {
          identity: {
            mode: "verified",
            connectionId: crypto.randomUUID(),
            actorId,
            actorKind: "human",
            orgId: "org_1",
            workspaceId: "ws_1",
            role: "editor",
          },
          visible: (frame) => !globalEventSessionId(frame) || actorId === "actor_participant",
        }
      },
    })
    const app = mount(handler)
    const first = await connect(app, undefined, "actor_workspace_only")
    const opened = await first.until((seen) => seen.includes("server.connected"), "no cursor bootstrap frame")
    expect(bootstrapId(opened)).toBe("0")
    first.close()

    for (let index = 0; index < 300; index += 1) {
      claxedo.publish({
        type: "session.lifecycle",
        phase: "created",
        directory: "/tmp/central",
        sessionID: `ses_private_${index}`,
        ts: index,
      })
    }
    claxedo.publish({ type: "process.status", directory: "/tmp/central", configId: "proc_public", status: "running" })

    const second = await connect(app, "0", "actor_workspace_only")
    const text = await second.until((seen) => seen.includes("proc_public"), "public replay frame never arrived")
    second.close()

    expect(text).not.toContain("stream.replay-gap")
    expect(text).not.toContain("ses_private")
    expect(frames(text).find((frame) => frame.data?.includes("proc_public"))?.id).toBe("1")
  })

  test("a frame published while disconnected is delivered on the next Last-Event-ID reconnect", async () => {
    const { claxedo, app } = buses()

    const first = await connect(app)
    const opened = await first.until((seen) => seen.includes("server.connected"), "no cursor bootstrap frame")
    const cursor = bootstrapId(opened)
    expect(cursor).toBe("0")
    first.close()

    // The frame-loss window: a harness session's ONLY notification, published
    // with no connection attached. Before replay it never reached the sidebar.
    claxedo.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/tmp/central",
      sessionID: "ses_during_gap",
      ts: 1,
    })

    const second = await connect(app, cursor)
    const text = await second.until((seen) => seen.includes("ses_during_gap"), "gap frame was lost")
    second.close()

    const recovered = frames(text).find((frame) => frame.data?.includes("ses_during_gap"))
    expect(recovered?.id).toBe("1")
    expect(recovered?.data).toContain(`"type":"session.lifecycle"`)
  })

  test("resuming from a mid-log cursor replays only what follows it", async () => {
    const { global, app } = buses()
    global.publish(part("prt_old"))
    global.publish(part("prt_new"))

    const stream = await connect(app, "1")
    const text = await stream.until((seen) => seen.includes("prt_new"), "cursor resume delivered nothing")
    stream.close()

    expect(text).toContain("id: 2")
    expect(text).not.toContain("prt_old")
  })

  test("a globalBus envelope keeps ONE synthesized id across live delivery and replay", async () => {
    // `normalizeGlobalEvent` mints a `randomUUID()` for envelopes with no
    // `payload.id`. Normalizing per connection would hand each reader a
    // different body for the same event (and break `replay.idFor`, which is
    // keyed on object identity), so the normalization happens once, upstream of
    // both the ring and the fanout.
    const { global, app } = buses()
    global.publish({ directory: "/tmp/central", payload: { type: "session.updated", properties: {} } })

    const first = await connect(app, "0")
    const live = await first.until((seen) => seen.includes("session.updated"), "frame never arrived")
    first.close()

    const second = await connect(app, "0")
    const replayed = await second.until((seen) => seen.includes("session.updated"), "frame was not replayed")
    second.close()

    const idOf = (text: string) =>
      JSON.parse(frames(text).find((frame) => frame.data?.includes("session.updated"))!.data!).payload.id
    expect(typeof idOf(live)).toBe("string")
    expect(idOf(replayed)).toBe(idOf(live))
  })

  test("emits a replay-gap notice when the cursor has fallen out of the retention window", async () => {
    const { global, app } = buses()
    // Retention is 256 frames; 258 pushes the cursor at 1 out of the window.
    for (let i = 1; i <= 258; i += 1) global.publish(part(`prt_${i}`))

    const stream = await connect(app, "1")
    const text = await stream.until((seen) => seen.includes("stream.replay-gap"), "no replay-gap notice")
    stream.close()

    expect(text).toContain("global.sse_replay_gap")
    expect(text).toContain(`"lastEventId":"1"`)
    expect(text).toContain(`"throughId":"258"`)
    // The notice REPLACES the partial replay.
    expect(text).not.toContain("prt_258")
  })

  test("terminal compat frames survive eviction by the chatty ones", async () => {
    const { global, app } = buses()
    global.publish({
      directory: "/tmp/central",
      payload: { type: "session.idle", properties: { sessionID: "ses_settled" } },
    })
    for (let i = 1; i <= 300; i += 1) global.publish(part(`prt_${i}`))

    const stream = await connect(app, "0")
    const text = await stream.until((seen) => seen.includes("session.idle"), "terminal frame was evicted")
    stream.close()

    expect(text).toContain("ses_settled")
  })

  test("a harness session's session.lifecycle survives a burst of engine deltas", async () => {
    // The reason the terminal ring, not a bigger main ring, is the answer to
    // this bus's traffic profile. `session.lifecycle` "created" is the ONLY
    // notification an ACP/harness session emits and this stream is a
    // local/unsigned workspace's only channel for it, so losing it to 256
    // frames of `message.part.updated` chatter means the session never reaches
    // the sidebar — the exact BUG A this handler's claxedoBus subscription
    // exists to fix, reintroduced through the replay window.
    const { global, claxedo, app } = buses()
    claxedo.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/tmp/central",
      sessionID: "ses_harness",
      ts: 1,
    })
    for (let i = 1; i <= 300; i += 1) global.publish(part(`prt_${i}`))

    const stream = await connect(app, "0")
    const text = await stream.until((seen) => seen.includes("ses_harness"), "harness session frame was evicted")
    stream.close()

    expect(text).toContain(`"phase":"created"`)
  })
})
