import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { eventsHandler, eventVisibleTo } from "./events"
import { eventScopePrincipal, type EventScopePrincipal } from "./event-visibility"
import {
  ControlPlaneAuthError,
  type ControlPlaneAuthConfig,
  type ControlPlaneAuthContext,
} from "@claxedo/server-core/platform/auth/auth"
import { claxedoBus, createBus, type ClaxedoEvent } from "@claxedo/server-core/platform/runtime/lib/bus"

// /api/claxedo/events must reject unauthenticated requests when
// signed cloud auth is enabled, and must remain a pass-through when running
// in local/unsigned mode. The bus subscription should only attach AFTER auth
// passes — anonymous connections must never observe events.

const baseConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.issuer.dev",
  jwksUrl: "https://example.issuer.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

function mountHandler(options: Parameters<typeof eventsHandler>[0]) {
  const app = new Hono()
  app.get("/api/claxedo/events", eventsHandler(options))
  return app
}

describe("eventsHandler — auth gate", () => {
  test("returns 401 when signed cloud auth is enabled and no bearer token is present", async () => {
    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      },
    })
    const res = await app.request("/api/claxedo/events")
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe("missing_bearer_token")
  })

  test("returns 401 when bearer token is invalid", async () => {
    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      },
    })
    const res = await app.request("/api/claxedo/events", {
      headers: { authorization: "Bearer not-a-real-token" },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe("invalid_bearer_token")
  })

  test("the bus subscription does NOT attach when auth fails", async () => {
    // Snapshot the subscriber count before and after a rejected request to
    // prove that no leak occurred. The bus's subscribe API doesn't expose a
    // count, so we observe indirectly: publish an event, count handlers
    // invoked. If a subscription leaked, the count would include the leaked
    // handler.
    let handlerInvocations = 0
    const sentinel = claxedoBus.subscribe(() => {
      handlerInvocations++
    })

    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      },
    })
    await app.request("/api/claxedo/events")

    claxedoBus.publish({
      type: "agent.lifecycle",
      tabId: "sanity",
      eventType: "Idle",
    })

    expect(handlerInvocations).toBe(1) // only the sentinel — no leaked handler
    sentinel()
  })

  test("local/unsigned-local mode does not require authorization", async () => {
    const app = mountHandler({
      authConfig: { enabled: false, mode: "local-only", reason: "CLAXEDO_SIGNED_CLOUD_AUTH not set" },
    })
    // Resolve immediately without writing to localStorage / network. Use
    // AbortController so the SSE handler doesn't keep the test hanging.
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    let res: Response | undefined
    try {
      res = await Promise.resolve(app.request("/api/claxedo/events", { signal: ac.signal }))
    } catch {
      // expected when the abort fires before the response promise resolves
    }
    // Either the response started (200) or the abort fired before headers
    // landed. The key assertion is that we did NOT get a 401 in unsigned mode.
    if (res) expect(res.status).toBe(200)
  })
})

// Per-event authorization: a valid bearer must not grant the whole bus.
// `ownerUserId`/`orgId` on bus events are enforced server-side, not left as
// client-side routing hints.

// Subscriber principals carry the AUTHORITY-INTERNAL org id resolved at
// connect (`authority.resolveOrgId`), matching the namespace events are
// stamped with — never the issuer org claim.
const signedAs = (subject: string, internalOrgId?: string): EventScopePrincipal => ({
  mode: "signed",
  subject,
  ...(internalOrgId ? { orgId: internalOrgId } : {}),
})

const unsignedLocal: EventScopePrincipal = { mode: "unsigned-local" }

describe("eventVisibleTo — per-event authorization", () => {
  test("session.share.changed is visible only to its recipient subject", () => {
    const event = {
      type: "session.share.changed",
      phase: "granted",
      ownerUserId: "user_bob",
      sessionId: "ses_1",
      workspaceId: "ws_1",
      ts: 1,
    } as const
    expect(eventVisibleTo(signedAs("user_bob"), event)).toBe(true)
    expect(eventVisibleTo(signedAs("user_alice"), event)).toBe(false)
    expect(eventVisibleTo(signedAs("user_casey"), event)).toBe(false)
  })

  test("document.changed is visible only within its org", () => {
    const event = {
      type: "document.changed",
      documentId: "doc-1",
      orgId: "org_internal_x",
      projectId: "proj-1",
      ts: 1,
    } as const
    expect(eventVisibleTo(signedAs("user_a", "org_internal_x"), event)).toBe(true)
    expect(eventVisibleTo(signedAs("user_b", "org_internal_y"), event)).toBe(false)
    // No resolved org on the principal → no org-scoped events, fail-closed.
    expect(eventVisibleTo(signedAs("user_c"), event)).toBe(false)
  })

  test("provision is visible only within its org; org-less events stay local-only", () => {
    const scoped = { type: "provision", workspaceId: "ws-1", orgId: "org_internal_x", step: "ready", ts: 1 } as const
    expect(eventVisibleTo(signedAs("user_a", "org_internal_x"), scoped)).toBe(true)
    expect(eventVisibleTo(signedAs("user_b", "org_internal_y"), scoped)).toBe(false)

    const orgless = { type: "provision", workspaceId: "ws-2", step: "ready", ts: 1 } as const
    expect(eventVisibleTo(signedAs("user_a", "org_internal_x"), orgless)).toBe(false)
    expect(eventVisibleTo(unsignedLocal, orgless)).toBe(true)
  })

  test("eventScopePrincipal never leaks the issuer org claim into the org identity", () => {
    // The namespace-split regression this pins: the auth context's `orgId` is
    // the issuer `org_...` claim — a DISJOINT namespace from the internal org
    // id events are stamped with. The principal constructor must only carry an
    // org identity that was explicitly resolved through the authority.
    const auth: ControlPlaneAuthContext = {
      mode: "signed",
      token: "test-token",
      user: {
        subject: "user_a",
        tokenIdentifier: "https://example.issuer.dev|user_a",
        issuer: "https://example.issuer.dev",
        orgId: "org_2orgclaim",
      },
    }
    // No resolved org → NO org identity, even though the issuer claim is set.
    expect(eventScopePrincipal(auth)).toEqual({ mode: "signed", subject: "user_a" })
    // The resolved internal id — not the claim — becomes the org identity.
    expect(eventScopePrincipal(auth, "org_internal_x")).toEqual({
      mode: "signed",
      subject: "user_a",
      orgId: "org_internal_x",
    })
    expect(eventScopePrincipal({ mode: "unsigned-local", reason: "test" })).toEqual({ mode: "unsigned-local" })
  })

  test("unscoped event types are default-denied to signed subscribers", () => {
    const signed = signedAs("user_a", "org_internal_x")
    // Content-bearing runtime events: the original leak. `tail`, `prompt`,
    // and `lastAssistantMessage` are real terminal/agent content.
    expect(eventVisibleTo(signed, { type: "pty.stream", id: "p1", kind: "data", tail: "secret output" })).toBe(false)
    expect(
      eventVisibleTo(signed, { type: "agent.lifecycle", tabId: "t1", eventType: "Idle", prompt: "secret prompt" }),
    ).toBe(false)
    expect(
      eventVisibleTo(signed, {
        type: "session.lifecycle",
        phase: "created",
        directory: "/home/other-user/project",
        ts: 1,
      }),
    ).toBe(false)
    expect(
      eventVisibleTo(signed, { type: "worktree.ready", directory: "/home/other-user/wt", name: "wt", branch: "main" }),
    ).toBe(false)
  })

  test("unsigned-local sees everything (single-user mode)", () => {
    expect(eventVisibleTo(unsignedLocal, { type: "session.share.changed", phase: "granted", ownerUserId: "anyone", sessionId: "ses_1", workspaceId: "ws_1", ts: 1 })).toBe(true)
    expect(eventVisibleTo(unsignedLocal, { type: "pty.stream", id: "p1", kind: "data", tail: "output" })).toBe(true)
  })
})

describe("eventsHandler — signed stream is filtered per-event", () => {
  test("a signed subscriber receives their own session.share.changed but not another user's", async () => {
    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => ({
        mode: "signed",
        user: {
          subject: "user_a",
          tokenIdentifier: "https://example.issuer.dev|user_a",
          issuer: "https://example.issuer.dev",
        },
      }),
    })

    const ac = new AbortController()
    const res = await app.request("/api/claxedo/events", {
      headers: { authorization: "Bearer valid-token" },
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()

    // Let the SSE callback run so the bus subscription attaches.
    await new Promise((resolve) => setTimeout(resolve, 10))

    // user_b's event first: if the filter were missing it would arrive
    // before user_a's own event in the stream below.
    claxedoBus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_b", sessionId: "ses_1", workspaceId: "ws_1", ts: 1 })
    claxedoBus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_a", sessionId: "ses_1", workspaceId: "ws_1", ts: 2 })

    const decoder = new TextDecoder()
    let received = ""
    while (!received.includes("user_a")) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
    ac.abort()

    expect(received).toContain("user_a")
    expect(received).not.toContain("user_b")
  }, 10_000)

  test("a signed subscriber receives document.changed for the org resolved at connect", async () => {
    // Regression for the org-identity namespace split: document.changed frames
    // are stamped with the AUTHORITY-INTERNAL org id, so the subscriber's org
    // identity must come from `resolveOrgId` at connect — with only the issuer
    // claim these frames were invisible to every signed subscriber.
    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => ({
        mode: "signed",
        user: {
          subject: "user_a",
          tokenIdentifier: "https://example.issuer.dev|user_a",
          issuer: "https://example.issuer.dev",
          // The issuer claim (disjoint namespace) must play no part in scoping.
          orgId: "org_2orgclaim",
        },
      }),
      resolveOrgId: async () => "org_internal_x",
    })

    const ac = new AbortController()
    const res = await app.request("/api/claxedo/events", {
      headers: { authorization: "Bearer valid-token" },
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Another org's frame first: with a broken filter it would arrive before
    // the subscriber's own org frame below.
    claxedoBus.publish({
      type: "document.changed",
      documentId: "doc_other",
      orgId: "org_internal_y",
      projectId: "proj_1",
      ts: 1,
    })
    claxedoBus.publish({
      type: "document.changed",
      documentId: "doc_mine",
      orgId: "org_internal_x",
      projectId: "proj_1",
      ts: 2,
    })

    const decoder = new TextDecoder()
    let received = ""
    while (!received.includes("doc_mine")) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
    ac.abort()

    expect(received).toContain("doc_mine")
    expect(received).not.toContain("doc_other")
  }, 10_000)

  test("closes an established org stream before delivering another event after membership changes", async () => {
    const bus = createBus<ClaxedoEvent>()
    let currentOrgId = "org_internal_x"
    const app = mountHandler({
      bus,
      authConfig: baseConfig,
      verifier: async () => ({
        mode: "signed",
        user: {
          subject: "user_a",
          tokenIdentifier: "https://example.issuer.dev|user_a",
          issuer: "https://example.issuer.dev",
        },
      }),
      resolveOrgId: async () => currentOrgId,
    })
    const res = await app.request("/api/claxedo/events", {
      headers: { authorization: "Bearer valid-token" },
    })
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("heartbeat")

    currentOrgId = "org_personal_user_a"
    bus.publish({
      type: "document.changed",
      documentId: "doc_after_removal",
      orgId: "org_internal_x",
      projectId: "proj_1",
      ts: 2,
    })

    const next = await reader.read()
    expect(next.done).toBe(true)
    expect(next.value).toBeUndefined()
  }, 10_000)
})

// ─── SSE replay ────────────────────────────────────────────────────────────
//
// Mirrors `packages/workspace-runtime/src/routes/runtime-events.test.ts`. This
// stream was subscribe-on-connect only, so every frame published while a
// consumer sat in its reconnect gap was gone for good. The central twist the
// workspace stream does not have: the source retention ring is shared across
// every identity, while subscriber cursor rings must contain only frames that
// identity can see. The same `eventVisibleTo` predicate is re-applied at final
// delivery for both replay and live frames.

type ReplayConnection = {
  text: () => string
  until: (match: (text: string) => boolean, label: string) => Promise<string>
  close: () => void
}

async function connect(app: Hono, init: { lastEventId?: string; bearer?: string } = {}): Promise<ReplayConnection> {
  const ac = new AbortController()
  const res = await app.request("http://127.0.0.1/api/claxedo/events", {
    headers: {
      ...(init.lastEventId === undefined ? {} : { "Last-Event-ID": init.lastEventId }),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    signal: ac.signal,
  })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  return {
    text: () => text,
    async until(match, label) {
      // Bounded by a read budget rather than a timer: each frame this handler
      // writes arrives as its own chunk, so a match that never comes shows up
      // as a small, deterministic number of reads.
      for (let reads = 0; reads < 40; reads += 1) {
        if (match(text)) return text
        const next = await reader.read()
        if (next.done) break
        text += decoder.decode(next.value, { stream: true })
      }
      if (match(text)) return text
      throw new Error(`${label}\n--- stream so far ---\n${text}`)
    },
    close: () => ac.abort(),
  }
}

/**
 * Field-order-independent frame split. Hono writes `data:` before `id:`; SSE
 * readers (claxedo-app's inline loop, `sseJsonStream`) scan the frame's lines
 * for each field rather than relying on order, so the tests do too.
 */
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

/** The cursor the connection resumed from — always carried by the first frame. */
function bootstrapId(text: string) {
  return frames(text)[0]?.id
}

const localOnly: ControlPlaneAuthConfig = {
  enabled: false,
  mode: "local-only",
  reason: "test",
}

function mountLocal(bus: ReturnType<typeof createBus<ClaxedoEvent>>) {
  const app = new Hono()
  app.get("/api/claxedo/events", eventsHandler({ bus, authConfig: localOnly }))
  return app
}

/** Signed mount: frames only reach the stream if they clear `eventVisibleTo`. */
function mountSignedAs(bus: ReturnType<typeof createBus<ClaxedoEvent>>, subject: string) {
  const app = new Hono()
  app.get(
    "/api/claxedo/events",
    eventsHandler({
      bus,
      allowLoopbackLocal: true,
      authConfig: baseConfig,
      verifier: async () => ({
        mode: "signed",
        user: {
          subject,
          tokenIdentifier: `https://example.issuer.dev|${subject}`,
          issuer: "https://example.issuer.dev",
        },
      }),
    }),
  )
  return app
}

function mountSignedByBearer(bus: ReturnType<typeof createBus<ClaxedoEvent>>) {
  const app = new Hono()
  app.get(
    "/api/claxedo/events",
    eventsHandler({
      bus,
      allowLoopbackLocal: true,
      authConfig: baseConfig,
      verifier: async (token) => ({
        mode: "signed",
        user: {
          subject: token,
          tokenIdentifier: `https://example.issuer.dev|${token}`,
          issuer: "https://example.issuer.dev",
        },
      }),
    }),
  )
  return app
}

const lifecycle = (tabId: string): ClaxedoEvent => ({
  type: "agent.lifecycle",
  tabId,
  workspaceId: "ws_1",
  eventType: "Busy",
})

describe("eventsHandler — /api/claxedo/events replay", () => {
  test("keeps two loopback bearer subscribers isolated by signed principal", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountSignedByBearer(bus)
    const alice = await connect(app, { bearer: "user_alice" })
    const bob = await connect(app, { bearer: "user_bob" })
    await Promise.all([
      alice.until((seen) => seen.includes("heartbeat"), "Alice did not connect"),
      bob.until((seen) => seen.includes("heartbeat"), "Bob did not connect"),
    ])

    bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_alice", sessionId: "ses_1", workspaceId: "ws_1", ts: 1 })
    bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_bob", sessionId: "ses_1", workspaceId: "ws_1", ts: 2 })
    const [aliceText, bobText] = await Promise.all([
      alice.until((seen) => seen.includes("user_alice"), "Alice did not receive her frame"),
      bob.until((seen) => seen.includes("user_bob"), "Bob did not receive his frame"),
    ])
    alice.close()
    bob.close()

    expect(aliceText).not.toContain("user_bob")
    expect(bobText).not.toContain("user_alice")
  })

  test("opens with a heartbeat carrying the cursor the connection resumes from", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountLocal(bus)
    bus.publish(lifecycle("tab_1"))
    bus.publish(lifecycle("tab_2"))

    const stream = await connect(app)
    const text = await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    stream.close()

    expect(frames(text)[0]).toEqual({ id: "2", data: "{\"type\":\"heartbeat\"}" })
  })

  test("bootstraps at cursor 0 when nothing has been published yet", async () => {
    const stream = await connect(mountLocal(createBus<ClaxedoEvent>()))
    const text = await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    stream.close()

    expect(bootstrapId(text)).toBe("0")
  })

  test("a cursor-less connection is NOT served the retained log", async () => {
    // The regression this guards: claxedo-app's reader applies the frames it
    // reads to the shell caches, so a full re-read on every fresh connection
    // re-applies requests the user has already consumed.
    const bus = createBus<ClaxedoEvent>()
    const app = mountLocal(bus)
    bus.publish(lifecycle("tab_before"))

    const stream = await connect(app)
    await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    bus.publish(lifecycle("tab_after"))
    const text = await stream.until((seen) => seen.includes("tab_after"), "live frame never arrived")
    stream.close()

    expect(text).not.toContain("tab_before")
  })

  test("live frames carry an `id:` line so the reader builds a cursor", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountLocal(bus)

    const stream = await connect(app)
    await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    bus.publish(lifecycle("tab_live"))
    const text = await stream.until((seen) => seen.includes("tab_live"), "live frame never arrived")
    stream.close()

    expect(frames(text).find((frame) => frame.data?.includes("tab_live"))?.id).toBe("1")
  })

  test("a frame published while disconnected is delivered on the next Last-Event-ID reconnect", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountLocal(bus)

    // A reader that has never seen a frame still leaves with a cursor.
    const first = await connect(app)
    const opened = await first.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    const cursor = bootstrapId(opened)
    expect(cursor).toBe("0")
    first.close()

    // The frame-loss window: published with no connection attached.
    bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "local", sessionId: "ses_1", workspaceId: "ws_1", ts: 1 })

    const second = await connect(app, { lastEventId: cursor })
    const text = await second.until((seen) => seen.includes("session.share.changed"), "gap frame was lost")
    second.close()

    const recovered = frames(text).find((frame) => frame.data?.includes("session.share.changed"))
    expect(recovered?.id).toBe("1")
    expect(recovered?.data).toContain("\"ownerUserId\":\"local\"")
  })

  test("resuming from a mid-log cursor replays only what follows it", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountLocal(bus)
    bus.publish(lifecycle("tab_old"))
    bus.publish(lifecycle("tab_new"))

    const stream = await connect(app, { lastEventId: "1" })
    const text = await stream.until((seen) => seen.includes("tab_new"), "cursor resume delivered nothing")
    stream.close()

    expect(text).toContain("id: 2")
    expect(text).not.toContain("tab_old")
  })

  test("emits a replay-gap notice when the cursor has fallen out of the retention window", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountLocal(bus)
    // Retention is 256 frames; 258 pushes the cursor at 1 out of the window.
    for (let i = 1; i <= 258; i += 1) bus.publish(lifecycle(`tab_${i}`))

    const stream = await connect(app, { lastEventId: "1" })
    const text = await stream.until((seen) => seen.includes("stream.replay-gap"), "no replay-gap notice")
    stream.close()

    expect(text).toContain("claxedo.sse_replay_gap")
    expect(text).toContain("\"lastEventId\":\"1\"")
    expect(text).toContain("\"throughId\":\"258\"")
    // The gap notice REPLACES the partial replay — a reader must refetch, not
    // stitch a hole-ridden log into its incremental view.
    expect(text).not.toContain("tab_258")
  })

  test("terminal frames survive eviction by the chatty ones", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountLocal(bus)
    bus.publish({ type: "provision", workspaceId: "ws_1", step: "ready", ts: 1 })
    for (let i = 1; i <= 300; i += 1) bus.publish(lifecycle(`tab_${i}`))

    // Cursor 0 == "serve the whole retained log": the terminal ring must still
    // hold the settlement that the 256-frame main ring evicted.
    const stream = await connect(app, { lastEventId: "0" })
    const text = await stream.until((seen) => seen.includes("\"provision\""), "terminal frame was evicted")
    stream.close()

    expect(text).toContain("\"workspaceId\":\"ws_1\"")
  })

  test("replay re-applies the identity filter: another tenant's frame is NOT replayed", async () => {
    // THE central-stream hazard. Source retention is shared by every identity
    // because frames published while nobody is connected still need recovery.
    // user_b's cursor ring is filtered before ids are assigned, and the write
    // path re-applies the same predicate to replayed frames.
    const bus = createBus<ClaxedoEvent>()
    const app = mountSignedAs(bus, "user_b")

    // Both published with no connection attached, so both are in the ring and
    // only the ring can deliver them.
    bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_a", sessionId: "ses_1", workspaceId: "ws_1", ts: 1 })
    bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_b", sessionId: "ses_1", workspaceId: "ws_1", ts: 2 })

    const stream = await connect(app, { lastEventId: "0", bearer: "valid-token" })
    const text = await stream.until((seen) => seen.includes("user_b"), "own frame was not replayed")
    stream.close()

    expect(text).not.toContain("user_a")
    expect(frames(text).find((frame) => frame.data?.includes("user_b"))?.id).toBe("1")
  })

  test("another tenant's traffic cannot create a false replay gap", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountSignedAs(bus, "user_b")

    // Register user_b's stable cursor scope, then disconnect while user_a is
    // busy enough to overflow the shared source retention ring.
    const first = await connect(app, { bearer: "valid-token" })
    const opened = await first.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    expect(bootstrapId(opened)).toBe("0")
    first.close()

    for (let i = 1; i <= 300; i += 1) {
      bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_a", sessionId: "ses_a", workspaceId: "ws_1", ts: i })
    }
    bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_b", sessionId: "ses_1", workspaceId: "ws_1", ts: 301 })

    const second = await connect(app, { lastEventId: "0", bearer: "valid-token" })
    const text = await second.until((seen) => seen.includes("user_b"), "own replay frame never arrived")
    second.close()

    expect(text).not.toContain("stream.replay-gap")
    expect(text).not.toContain("user_a")
    expect(frames(text).find((frame) => frame.data?.includes("user_b"))?.id).toBe("1")
  })

  test("an invisible frame is dropped on the live path too, and does not block the next visible one", async () => {
    const bus = createBus<ClaxedoEvent>()
    const app = mountSignedAs(bus, "user_b")

    const stream = await connect(app, { bearer: "valid-token" })
    await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_a", sessionId: "ses_1", workspaceId: "ws_1", ts: 1 })
    bus.publish({ type: "session.share.changed", phase: "granted", ownerUserId: "user_b", sessionId: "ses_1", workspaceId: "ws_1", ts: 2 })
    const text = await stream.until((seen) => seen.includes("user_b"), "own live frame never arrived")
    stream.close()

    expect(text).not.toContain("user_a")
  })
})
