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
describe("interactive hosted Session smoke", () => {
  test("uses a production-shaped long session id", () => {
    expect(productionLengthSessionId("abc123").length).toBeGreaterThan(100)
    expect(productionLengthSessionId("abc123").startsWith("ses_")).toBe(true)
  })

  test("keeps an active projected turn running", () => {
    expect(classifyTurn({ status: "busy" })).toMatchObject({ state: "running" })
    expect(classifyTurn({ status: "idle" })).toMatchObject({ state: "running" })
  })

  test("settles only from the persisted completed outcome", () => {
    expect(classifyTurn({
      status: "idle",
      lastTurn: { status: "completed", completedAt: 3, assistantMessageId: "msg_1" },
    })).toMatchObject({ state: "settled" })
  })

  test("surfaces persisted failed and cancelled outcomes", () => {
    expect(classifyTurn({ lastTurn: { status: "failed", completedAt: 3, error: "provider unavailable" } }))
      .toEqual({ state: "failed", reason: "provider unavailable" })
    expect(classifyTurn({ lastTurn: { status: "cancelled", completedAt: 3, reason: "owner stopped" } }))
      .toEqual({ state: "failed", reason: "owner stopped" })
  })

  test("warns only when the token expires before the deadline", () => {
    const now = 1_000_000
    expect(tokenLifetimeShortfallMs(now + 15 * 60_000, now + 6 * 60_000, now)).toBeUndefined()
    expect(tokenLifetimeShortfallMs(now + 60_000, now + 6 * 60_000, now)).toBe(5 * 60_000)
    expect(tokenLifetimeShortfallMs(undefined, now + 6 * 60_000, now)).toBeUndefined()
  })

  test("reassembles the reply from the canonical assistant message", () => {
    expect(replyText([
      { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "prompt" }] },
      { info: { id: "assistant", role: "assistant" }, parts: [{ type: "text", text: "SMOKE-abc" }] },
    ])).toBe("SMOKE-abc")
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
      model: { providerID: "opencode", modelID: "mimo-v2.5-free" },
      variant: "default",
    })
    expect(harness.promptText).toContain(markerToken(harness.runId!))
    expect(harness.calls.some((call) => call.url.includes("/message?snapshot=1"))).toBe(true)
    // Cleanup released everything the smoke created. The session is reclaimed
    // with the workspace. BOTH
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
      WORKGRAPH_SMOKE_RETRY_DELAY_MS: "1",
    } as Record<string, string>,
    calls: [] as Array<{ url: string; method: string; headers: Headers }>,
    connectionPolls: 0,
    observedRetryAfterMs: [] as number[],
    turnPolls: 0,
    createdSessionId: undefined as string | undefined,
    createdSessionProfile: undefined as
      | { agent: string; model: { providerID: string; modelID: string }; variant: string }
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
      if (path === "/session" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          id: string
          agent: string
          model: { providerID: string; modelID: string }
          variant: string
        }
        state.createdSessionId = body.id
        state.createdSessionProfile = { agent: body.agent, model: body.model, variant: body.variant }
        return Response.json({ id: options.rewriteSessionId ? "ses_rewritten" : body.id }, { status: 201 })
      }
      const sessionSegment = `/session/${encodeURIComponent(state.createdSessionId ?? "")}`
      if (path === `${sessionSegment}/prompt_async` && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { parts: Array<{ type: string; text?: string }> }
        state.promptText = body.parts.find((part) => part.type === "text")?.text ?? ""
        state.prompted = true
        return Response.json({ accepted: true })
      }
      if (path === `${sessionSegment}/abort` && method === "POST") {
        state.interrupted = true
        return Response.json({ aborted: true })
      }
      if (path === sessionSegment && method === "GET") {
        state.turnPolls += 1
        if (!state.prompted || state.turnPolls <= runningPolls) {
          return Response.json({ id: state.createdSessionId, status: "busy" })
        }
        return Response.json({
          id: state.createdSessionId,
          status: "idle",
          lastTurn: { status: "completed", completedAt: 3, assistantMessageId: "msg_assistant" },
        })
      }
      if (path === `${sessionSegment}/message` && method === "GET") {
        const messages = !state.prompted
          ? []
          : [
              { info: { id: "msg_user", role: "user" }, parts: [{ type: "text", text: state.promptText }] },
              ...(state.turnPolls <= runningPolls
                ? []
                : [{
                    info: { id: "msg_assistant", role: "assistant" },
                    parts: [{ type: "text", text: options.reply ?? markerToken(state.runId ?? "") }],
                  }]),
            ]
        return Response.json({ messages, maxEventOrdinal: state.turnPolls })
      }
    }

    return new Response(`unexpected ${method} ${url.pathname}`, { status: 500 })
  }) as typeof fetch

  return state
}
