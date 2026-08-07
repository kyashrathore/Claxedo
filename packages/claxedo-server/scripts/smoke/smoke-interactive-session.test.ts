import { describe, expect, test } from "vitest"
import {
  classifyConnection,
  classifyTurn,
  interactiveSessionSmoke,
  markerToken,
  productionLengthSessionId,
  replyText,
  tokenLifetimeShortfallMs,
} from "./smoke-interactive-session"

const ended = (text: string) => ({
  type: "session.next.text.ended",
  data: { text, assistantMessageID: "msg_1", textID: "txt_1" },
  durable: { seq: 2 },
})
const stepEnded = { type: "session.next.step.ended", data: { finish: "stop" }, durable: { seq: 3 } }
const prompted = { type: "session.next.prompted", data: {}, durable: { seq: 1 } }

describe("interactive hosted Session smoke", () => {
  test("uses a session id past the router's 100-char parameter ceiling", () => {
    // A short id passes against a router that silently 404s long parameters —
    // exactly how that bug reached staging. See router-config.ts.
    expect(productionLengthSessionId("abc123").length).toBeGreaterThan(100)
    expect(productionLengthSessionId("abc123").startsWith("ses_")).toBe(true)
  })

  test("treats a prompted turn with no terminal step as still running while the harness drains it", () => {
    // `session.next.prompted` fires at ADMISSION; the first step ends seconds
    // later. History alone must never read as settled here.
    const active = { data: { ses_x: { type: "running" } } }
    expect(classifyTurn([prompted], active, "ses_x")).toMatchObject({ state: "running" })
  })

  test("treats a terminal step as still running while the harness owns the drain", () => {
    const active = { data: { ses_x: { type: "running" } } }
    expect(classifyTurn([prompted, stepEnded], active, "ses_x")).toMatchObject({ state: "running" })
  })

  test("settles only on a terminal step AND an idle harness", () => {
    expect(classifyTurn([prompted, ended("hi"), stepEnded], { data: {} }, "ses_x")).toMatchObject({
      state: "settled",
    })
  })

  test("fails toward still-active on a malformed active envelope", () => {
    // The safe direction: never declare live work finished because a probe
    // returned something unrecognizable.
    for (const malformed of [undefined, null, [], "nope", { data: [] }, { data: null }]) {
      expect(classifyTurn([stepEnded], malformed, "ses_x")).toMatchObject({ state: "running" })
    }
  })

  test("fails fast when the harness stops after admitting the prompt without settling", () => {
    // The opposite failure from the four-day outage: not "parked too eagerly"
    // but "prompt accepted, harness went away". Polling this out to the
    // deadline reports an undiagnosable timeout instead of the real defect.
    expect(classifyTurn([prompted], { data: {} }, "ses_x")).toMatchObject({
      state: "failed",
      reason: "the harness stopped after admitting the prompt without settling a step",
    })
  })

  test("does not judge a turn before the prompt is admitted", () => {
    // An empty history with an idle harness is the gap between session create
    // and prompt admission — not a failure.
    expect(classifyTurn([], { data: {} }, "ses_x")).toMatchObject({ state: "running" })
  })

  test("warns only when the token expires before the deadline", () => {
    const now = 1_000_000
    // Signer floor is 15 minutes, deadline is 6 — the normal case is silent.
    expect(tokenLifetimeShortfallMs(now + 15 * 60_000, now + 6 * 60_000, now)).toBeUndefined()
    expect(tokenLifetimeShortfallMs(now + 60_000, now + 6 * 60_000, now)).toBe(5 * 60_000)
    // Absent or non-numeric expiry is not something to warn about.
    expect(tokenLifetimeShortfallMs(undefined, now + 6 * 60_000, now)).toBeUndefined()
  })

  test("surfaces a failed step rather than waiting out the deadline", () => {
    const failed = {
      type: "session.next.step.failed",
      data: { error: { message: "Couldn't reach Anthropic — Not Found" } },
      durable: { seq: 3 },
    }
    expect(classifyTurn([prompted, failed], { data: {} }, "ses_x")).toMatchObject({
      state: "failed",
      reason: "Couldn't reach Anthropic — Not Found",
    })
  })

  test("reassembles the reply from replayable text boundaries", () => {
    expect(replyText([prompted, ended("SMOKE-abc"), stepEnded])).toBe("SMOKE-abc")
  })

  test("provisions, prompts through the relay, asserts the marker, and cleans up", async () => {
    const harness = fakeStaging()
    await interactiveSessionSmoke(harness.env, harness.request)

    // The turn must have gone through the RELAY, not straight at a sandbox.
    const relayPaths = harness.calls.filter((call) => call.url.startsWith("https://relay.test/workspaces/"))
    expect(relayPaths.length).toBeGreaterThan(0)
    for (const call of relayPaths) {
      expect(call.headers.get("authorization")).toBe("Bearer runtime-token")
      expect(call.headers.get("x-opencode-directory")).toBe("/workspace")
    }
    expect(harness.createdSessionId!.length).toBeGreaterThan(100)
    expect(harness.createdSessionProfile).toEqual({
      agent: "build",
      model: { providerID: "opencode", id: "mimo-v2.5-free", variant: "default" },
      tools: [],
    })
    expect(harness.promptText).toContain(markerToken(harness.runId!))
    // Both probes were consulted before declaring the turn settled.
    expect(harness.calls.some((call) => call.url.endsWith("/api/session/active"))).toBe(true)
    expect(harness.calls.some((call) => call.url.includes("/history?"))).toBe(true)
    // Cleanup released everything the smoke created. The session is reclaimed
    // with the workspace — Session V2 has no DELETE, only interrupt. BOTH
    // teardown layers must run: lifecycle/destroy reclaims the sandbox VM, and
    // the row DELETE removes the Convex workspace row — without it every
    // deploy left one "Interactive session smoke …" corpse in the app's
    // project inventory (and a per-project /documents 404 on every index load).
    expect(harness.interrupted).toBe(true)
    expect(harness.destroyedWorkspace).toBe(true)
    expect(harness.deletedWorkspaceRow).toBe(true)
    expect(harness.revokedClerkSession).toBe(true)
  })

  test("fails when the turn settles without the marker, and still cleans up", async () => {
    const harness = fakeStaging({ reply: "I would rather not." })
    await expect(interactiveSessionSmoke(harness.env, harness.request)).rejects.toThrow(/settled without the marker/)
    expect(harness.destroyedWorkspace).toBe(true)
    expect(harness.deletedWorkspaceRow).toBe(true)
    expect(harness.revokedClerkSession).toBe(true)
  })

  test("names the engine router when a bodyless 404 refuses the long session id", async () => {
    // The discriminator that cost a staging incident: a bare 404 with no
    // content-type is the router refusing the parameter, not an absent session.
    const harness = fakeStaging({ routerRefusesLongIds: true })
    await expect(interactiveSessionSmoke(harness.env, harness.request)).rejects.toThrow(
      /engine router refused the path parameter/,
    )
    expect(harness.destroyedWorkspace).toBe(true)
  })

  test("waits out sandbox provisioning before opening the session", async () => {
    const harness = fakeStaging({ provisioningPolls: 3 })
    await interactiveSessionSmoke(harness.env, harness.request)
    expect(harness.connectionPolls).toBe(4)
  })

  test("reads each transient backoff from where that response actually carries it", () => {
    // `provisioning` puts retryAfterMs on the BODY; the 409 puts it on the
    // ERROR object, because `apiError` spreads extras flat rather than nesting
    // them under `data`. Reading the wrong place silently falls back to the
    // default delay instead of the server's own pacing.
    expect(classifyConnection(200, { status: "provisioning", retryAfterMs: 1500 })).toEqual({
      state: "provisioning",
      retryAfterMs: 1500,
    })
    expect(
      classifyConnection(409, { error: { code: "cloud_runtime_unavailable", message: "busy", retryAfterMs: 700 } }),
    ).toEqual({ state: "unavailable", retryAfterMs: 700 })
    // Absent or nonsense backoffs fall back to the caller's default rather
    // than becoming a zero-delay hot loop against the control plane.
    expect(classifyConnection(200, { status: "provisioning" }).retryAfterMs).toBeUndefined()
    expect(
      classifyConnection(409, { error: { code: "cloud_runtime_unavailable", retryAfterMs: -1 } }).retryAfterMs,
    ).toBeUndefined()
  })

  test("treats every non-transient connection response as a deployment fault", () => {
    // Polling through these burns the whole budget and then reports a timeout,
    // hiding the actual cause: entitlement, auth, or no configured driver.
    for (const [status, code] of [
      [402, "billing_entitlement_required"],
      [401, "missing_bearer_token"],
      [403, "workspace_forbidden"],
      [503, "sandbox_driver_unavailable"],
    ] as const) {
      const verdict = classifyConnection(status, { error: { code, message: "denied" } })
      expect(verdict.state).toBe("fatal")
      expect(verdict.reason).toContain(code)
    }
  })

  test("fails the deploy on a non-transient connection error rather than polling out the clock", async () => {
    const harness = fakeStaging({ connectionFailure: { status: 402, code: "billing_entitlement_required" } })
    await expect(interactiveSessionSmoke(harness.env, harness.request)).rejects.toThrow(
      /billing_entitlement_required/,
    )
    expect(harness.connectionPolls).toBe(1)
  })

  test("polls through a transient 409 and then opens the session", async () => {
    const harness = fakeStaging({ unavailablePolls: 2 })
    await interactiveSessionSmoke(harness.env, harness.request)
    expect(harness.connectionPolls).toBe(3)
  })

  test("does not accept a session the runtime created under a different id", async () => {
    const harness = fakeStaging({ rewriteSessionId: true })
    await expect(interactiveSessionSmoke(harness.env, harness.request)).rejects.toThrow(/did not adopt the requested/)
  })
})

function fakeStaging(
  options: {
    reply?: string
    provisioningPolls?: number
    unavailablePolls?: number
    connectionFailure?: { status: number; code: string }
    routerRefusesLongIds?: boolean
    rewriteSessionId?: boolean
    runningPolls?: number
  } = {},
) {
  const state = {
    env: {
      BASE_URL: "https://control.test/",
      CLERK_SECRET_KEY: "sk_test",
      WORKGRAPH_SMOKE_USER_A_ID: "user_a",
      WORKGRAPH_SMOKE_ORGANIZATION_A_ID: "org_a",
      WORKGRAPH_SMOKE_REPOSITORY_URL: "https://github.test/owner/repo.git",
      WORKGRAPH_SMOKE_AGENT: "build",
      WORKGRAPH_SMOKE_PROVIDER_ID: "opencode",
      WORKGRAPH_SMOKE_MODEL_ID: "mimo-v2.5-free",
      WORKGRAPH_SMOKE_EFFORT: "default",
      WORKGRAPH_SMOKE_TOOLS_JSON: "[]",
      WORKGRAPH_SMOKE_RETRY_DELAY_MS: "1",
    } as Record<string, string>,
    calls: [] as Array<{ url: string; method: string; headers: Headers }>,
    connectionPolls: 0,
    observedRetryAfterMs: [] as number[],
    turnPolls: 0,
    createdSessionId: undefined as string | undefined,
    createdSessionProfile: undefined as
      | { agent: string; model: { providerID: string; id: string; variant: string }; tools: string[] }
      | undefined,
    promptText: "",
    runId: undefined as string | undefined,
    prompted: false,
    interrupted: false,
    destroyedWorkspace: false,
    deletedWorkspaceRow: false,
    revokedClerkSession: false,
    request: null as unknown as typeof fetch,
  }
  const provisioningPolls = options.provisioningPolls ?? 0
  const runningPolls = options.runningPolls ?? 1

  state.request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    const method = init?.method ?? "GET"
    state.calls.push({ url: url.toString(), method, headers: new Headers(init?.headers) })

    if (url.hostname === "api.clerk.com") {
      if (url.pathname === "/v1/sessions") return Response.json({ id: "clerk_session_1" })
      if (url.pathname.endsWith("/tokens/convex")) return Response.json({ jwt: "clerk.jwt.token" })
      if (url.pathname.endsWith("/revoke")) {
        state.revokedClerkSession = true
        return Response.json({ revoked: true })
      }
    }

    if (url.pathname === "/api/workspace/create") {
      const body = JSON.parse(String(init?.body)) as { workspaceName?: string }
      state.runId = body.workspaceName?.split(" ").at(-1)
      return Response.json({ workspaceId: "ws_1", directory: "/workspace" })
    }
    if (url.pathname === "/api/workspace/ws_1/connection") {
      state.connectionPolls += 1
      if (options.connectionFailure) {
        return Response.json(
          { error: { code: options.connectionFailure.code, message: "denied" } },
          { status: options.connectionFailure.status },
        )
      }
      if (state.connectionPolls <= provisioningPolls) {
        return Response.json({ status: "provisioning", workspaceId: "ws_1", retryAfterMs: 1 })
      }
      if (state.connectionPolls <= provisioningPolls + (options.unavailablePolls ?? 0)) {
        // The real 409 shape: `apiError` spreads extras FLAT onto the error.
        state.observedRetryAfterMs.push(7)
        return Response.json(
          { error: { code: "cloud_runtime_unavailable", message: "Cloud runtime is unavailable", retryAfterMs: 7 } },
          { status: 409 },
        )
      }
      return Response.json({
        access: "cloud",
        workspaceId: "ws_1",
        relayUrl: "https://relay.test",
        runtimeAccessToken: "runtime-token",
        tokenExpiresAt: Date.now() + 600_000,
      })
    }
    if (url.pathname === "/api/workspace/ws_1/lifecycle/destroy") {
      state.destroyedWorkspace = true
      return Response.json({ ok: true })
    }
    if (url.pathname === "/api/workspace/ws_1" && method === "DELETE") {
      state.deletedWorkspaceRow = true
      return Response.json({ deleted: true })
    }

    const relayPrefix = "/workspaces/ws_1"
    if (url.pathname.startsWith(relayPrefix)) {
      const path = url.pathname.slice(relayPrefix.length)
      if (path === "/api/session" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          id: string
          agent: string
          model: { providerID: string; id: string; variant: string }
          tools: string[]
        }
        if (options.routerRefusesLongIds && body.id.length > 100) {
          // The exact router-level refusal shape: no body, no content-type.
          return new Response(null, { status: 404 })
        }
        state.createdSessionId = body.id
        state.createdSessionProfile = { agent: body.agent, model: body.model, tools: body.tools }
        return Response.json({ id: options.rewriteSessionId ? "ses_rewritten" : body.id }, { status: 201 })
      }
      const sessionSegment = `/api/session/${encodeURIComponent(state.createdSessionId ?? "")}`
      if (path === `${sessionSegment}/prompt` && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { prompt: { text: string } }
        state.promptText = body.prompt.text
        state.prompted = true
        return Response.json({ ok: true })
      }
      if (path === `${sessionSegment}/interrupt` && method === "POST") {
        state.interrupted = true
        return Response.json({ ok: true })
      }
      if (path.startsWith(`${sessionSegment}/history`)) {
        state.turnPolls += 1
        if (!state.prompted) return Response.json({ data: [], hasMore: false })
        if (state.turnPolls <= runningPolls) return Response.json({ data: [prompted], hasMore: false })
        return Response.json({
          data: [prompted, ended(options.reply ?? markerToken(state.runId ?? "")), stepEnded],
          hasMore: false,
        })
      }
      if (path === "/api/session/active") {
        // Mirrors the real contract: the harness reports the drain it owns
        // while running, and an empty map once it lets go.
        return Response.json(
          state.turnPolls <= runningPolls && state.createdSessionId
            ? { data: { [state.createdSessionId]: { type: "running" } } }
            : { data: {} },
        )
      }
    }

    return new Response(`unexpected ${method} ${url.pathname}`, { status: 500 })
  }) as typeof fetch

  return state
}
