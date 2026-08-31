import { describe, expect, test } from "bun:test"
import {
  createConnectFlow,
  createConnectionsStore,
  isOAuthOnly,
  type ConnectionsRequest,
  type IntegrationInfo,
} from "./connections-logic"

type RecordedRequest = { path: string; method: string; body: unknown }

/**
 * Scripted request mock: each call consumes the next queued response and
 * records path/method/body for assertions.
 */
function scriptedRequest(responses: Array<{ status: number; body?: unknown }>) {
  const calls: RecordedRequest[] = []
  const queue = [...responses]
  const request: ConnectionsRequest = async (path, init) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected request: ${path}`)
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  return { request, calls }
}

const notion: IntegrationInfo = {
  id: "notion",
  name: "Notion",
  methods: ["key"],
  capabilities: ["docs"],
  prompts: [
    { id: "workspace", label: "Workspace", placeholder: "acme" },
    { id: "token", label: "Internal integration secret", secret: true },
  ],
}

const google: IntegrationInfo = {
  id: "google",
  name: "Google",
  methods: ["oauth"],
  capabilities: ["docs"],
}

const listBody = {
  integrations: [notion, google],
  connections: [
    {
      id: "notion-team",
      integrationId: "notion",
      scope: "team",
      accountLabel: "Acme",
      grantedCapabilities: ["docs"],
      fields: { workspace: "acme" },
      status: "connected",
      createdAt: 1,
      updatedAt: 2,
    },
  ],
}

describe("connections list store", () => {
  test("load maps integrations and connections; connectionFor resolves by integrationId", async () => {
    const { request, calls } = scriptedRequest([{ status: 200, body: listBody }])
    const store = createConnectionsStore({ request })
    await store.load()

    expect(calls).toEqual([{ path: "", method: "GET", body: undefined }])
    expect(store.state.loaded).toBe(true)
    expect(store.state.loading).toBe(false)
    expect(store.state.integrations.map((item) => item.id)).toEqual(["notion", "google"])
    expect(store.connectionFor("notion")?.status).toBe("connected")
    expect(store.connectionFor("notion")?.accountLabel).toBe("Acme")
    expect(store.connectionFor("google")).toBeUndefined()
  })

  test("load surfaces gate errors without marking the list loaded", async () => {
    const { request } = scriptedRequest([{ status: 403, body: { code: "connections_loopback_required" } }])
    const store = createConnectionsStore({ request })
    await store.load()

    expect(store.state.loaded).toBe(false)
    expect(store.state.error).toContain("connections_loopback_required")
  })

  test("disconnect DELETEs the connection then refreshes the list", async () => {
    const { request, calls } = scriptedRequest([
      { status: 200, body: { ok: true } },
      { status: 200, body: { integrations: listBody.integrations, connections: [] } },
    ])
    const store = createConnectionsStore({ request })
    const result = await store.disconnect("notion-team")

    expect(result.ok).toBe(true)
    expect(calls[0]).toEqual({ path: "/connections/notion-team", method: "DELETE", body: undefined })
    expect(calls[1]?.path).toBe("")
    expect(store.state.connections).toEqual([])
  })

  test("reverify maps a 422 verify failure to a readable error and still refreshes", async () => {
    const { request, calls } = scriptedRequest([
      { status: 422, body: { ok: false, reason: "unauthorized" } },
      { status: 200, body: listBody },
    ])
    const store = createConnectionsStore({ request })
    const result = await store.reverify("notion-team")

    expect(calls[0]).toEqual({ path: "/connections/notion-team/reverify", method: "POST", body: undefined })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("rejected")
    expect(store.state.loaded).toBe(true)
  })
})

describe("connect flow: key method", () => {
  test("submitKey sends non-secret prompts as fields and the secret separately, then succeeds", async () => {
    const { request, calls } = scriptedRequest([{ status: 200, body: { ok: true } }])
    let connected = 0
    const flow = createConnectFlow({ integration: notion, request, onConnected: () => void connected++ })

    flow.setField("workspace", "acme")
    flow.setSecret("ntn_secret")
    await flow.submitKey()

    expect(calls[0]).toEqual({
      path: "/notion/connect",
      method: "POST",
      body: { fields: { workspace: "acme" }, secret: "ntn_secret" },
    })
    expect(flow.state.phase).toBe("done")
    expect(connected).toBe(1)
    // Secret is cleared on success and never appears in error state.
    expect(flow.state.secret).toBe("")
    expect(flow.state.error).toBeUndefined()
  })

  test("signed hosts submit the selected personal scope while unsigned hosts keep the legacy request shape", async () => {
    const signed = scriptedRequest([{ status: 200, body: { ok: true } }])
    const signedFlow = createConnectFlow({ integration: notion, request: signed.request, personalScopeEnabled: true })
    signedFlow.setScope("personal")
    signedFlow.setSecret("ntn_secret")
    await signedFlow.submitKey()
    expect(signed.calls[0]?.body).toEqual({ fields: { workspace: "" }, secret: "ntn_secret", scope: "personal" })

    const unsigned = scriptedRequest([{ status: 200, body: { ok: true } }])
    const unsignedFlow = createConnectFlow({ integration: notion, request: unsigned.request })
    unsignedFlow.setScope("personal")
    unsignedFlow.setSecret("ntn_secret")
    await unsignedFlow.submitKey()
    expect(unsigned.calls[0]?.body).toEqual({ fields: { workspace: "" }, secret: "ntn_secret" })
    expect(unsignedFlow.state.scope).toBe("team")
  })

  test("a non-admin signed surface cannot switch its personal connection flow to team scope", async () => {
    const subject = scriptedRequest([{ status: 200, body: { ok: true } }])
    const flow = createConnectFlow({
      integration: notion,
      request: subject.request,
      personalScopeEnabled: true,
      teamScopeEnabled: false,
      initialScope: "team",
    })

    expect(flow.state.scope).toBe("personal")
    flow.setScope("team")
    expect(flow.state.scope).toBe("personal")
    flow.setSecret("ntn_secret")
    await flow.submitKey()
    expect(subject.calls[0]?.body).toMatchObject({ scope: "personal" })
  })

  test("submitKey refuses an empty secret without hitting the network", async () => {
    const { request, calls } = scriptedRequest([])
    const flow = createConnectFlow({ integration: notion, request })

    await flow.submitKey()

    expect(calls).toEqual([])
    expect(flow.state.phase).toBe("form")
    expect(flow.state.error).toContain("secret")
  })

  test("409 connection_exists enters confirm-replace and re-submits with confirmReplace: true", async () => {
    const { request, calls } = scriptedRequest([
      { status: 409, body: { ok: false, code: "connection_exists" } },
      { status: 200, body: { ok: true } },
    ])
    let connected = 0
    const flow = createConnectFlow({ integration: notion, request, onConnected: () => void connected++ })

    flow.setField("workspace", "acme")
    flow.setSecret("ntn_secret")
    await flow.submitKey()

    expect(flow.state.phase).toBe("confirm-replace")
    expect(flow.state.pendingMode).toBe("key")
    expect(connected).toBe(0)

    await flow.confirmReplace()

    expect(calls[1]?.body).toEqual({
      confirmReplace: true,
      fields: { workspace: "acme" },
      secret: "ntn_secret",
    })
    expect(flow.state.phase).toBe("done")
    expect(connected).toBe(1)
    expect(flow.state.secret).toBe("")
  })

  test("cancelReplace returns to the form keeping entered values", async () => {
    const { request } = scriptedRequest([{ status: 409, body: { ok: false, code: "connection_exists" } }])
    const flow = createConnectFlow({ integration: notion, request })

    flow.setField("workspace", "acme")
    flow.setSecret("ntn_secret")
    await flow.submitKey()
    flow.cancelReplace()

    expect(flow.state.phase).toBe("form")
    expect(flow.state.pendingMode).toBeUndefined()
    expect(flow.state.fields.workspace).toBe("acme")
    expect(flow.state.secret).toBe("ntn_secret")
  })

  test("422 connection_verify_failed maps reasons to readable errors that never echo the secret", async () => {
    const { request } = scriptedRequest([
      { status: 422, body: { ok: false, code: "connection_verify_failed", reason: "unauthorized" } },
    ])
    const flow = createConnectFlow({ integration: notion, request })

    flow.setSecret("super-secret-value")
    await flow.submitKey()

    expect(flow.state.phase).toBe("form")
    expect(flow.state.error).toContain("rejected")
    expect(flow.state.error).not.toContain("super-secret-value")
  })

  test("422 with reason network maps to the network error message", async () => {
    const { request } = scriptedRequest([
      { status: 422, body: { ok: false, code: "connection_verify_failed", reason: "network" } },
    ])
    const flow = createConnectFlow({ integration: notion, request })

    flow.setSecret("s")
    await flow.submitKey()

    expect(flow.state.error).toContain("reach")
  })

  test("reset clears fields and secret", async () => {
    const { request } = scriptedRequest([])
    const flow = createConnectFlow({ integration: notion, request })

    flow.setField("workspace", "acme")
    flow.setSecret("ntn_secret")
    flow.reset()

    expect(flow.state.fields).toEqual({})
    expect(flow.state.secret).toBe("")
    expect(flow.state.phase).toBe("form")
  })
})

describe("connect flow: oauth method", () => {
  test("isOAuthOnly is true only for oauth integrations without prompts", () => {
    expect(isOAuthOnly(google)).toBe(true)
    expect(isOAuthOnly(notion)).toBe(false)
    expect(isOAuthOnly({ ...google, prompts: [{ id: "x", label: "X" }] })).toBe(false)
  })

  test("startOAuth opens the url and polls the attempt until complete", async () => {
    const { request, calls } = scriptedRequest([
      { status: 200, body: { ok: true, url: "https://accounts.example/authorize", attemptId: "state-1" } },
      { status: 200, body: { status: "pending", integrationId: "google" } },
      { status: 200, body: { status: "pending", integrationId: "google" } },
      { status: 200, body: { status: "complete", integrationId: "google" } },
    ])
    const opened: string[] = []
    let connected = 0
    const phases: string[] = []
    const flow = createConnectFlow({
      integration: google,
      request,
      openUrl: (url) => void opened.push(url),
      sleep: () => {
        phases.push(flow.state.phase)
        return Promise.resolve()
      },
      onConnected: () => void connected++,
    })

    await flow.startOAuth()

    expect(calls[0]).toEqual({ path: "/google/connect", method: "POST", body: { method: "oauth" } })
    expect(opened).toEqual(["https://accounts.example/authorize"])
    // Every poll happened while the flow reported oauth-waiting.
    expect(phases).toEqual(["oauth-waiting", "oauth-waiting", "oauth-waiting"])
    expect(calls.slice(1).map((call) => call.path)).toEqual([
      "/attempts/state-1",
      "/attempts/state-1",
      "/attempts/state-1",
    ])
    expect(flow.state.phase).toBe("done")
    expect(connected).toBe(1)
  })

  test("oauthFields are sent only when starting OAuth", async () => {
    const { request, calls } = scriptedRequest([
      { status: 200, body: { ok: true, url: "https://accounts.example/authorize", attemptId: "state-issuer" } },
      { status: 200, body: { status: "complete", integrationId: "google" } },
    ])
    const flow = createConnectFlow({
      integration: google,
      request,
      oauthFields: { issuer: "https://login.example/tenant" },
      sleep: () => Promise.resolve(),
    })

    await flow.startOAuth()

    expect(calls[0]?.body).toEqual({
      method: "oauth",
      issuer: "https://login.example/tenant",
    })
  })

  test("failed and expired attempts return to the form with an error", async () => {
    for (const [status, fragment] of [
      ["failed", "failed"],
      ["expired", "expired"],
    ] as const) {
      const { request } = scriptedRequest([
        { status: 200, body: { ok: true, url: "https://x", attemptId: "a" } },
        { status: 200, body: { status, integrationId: "google" } },
      ])
      const flow = createConnectFlow({
        integration: google,
        request,
        openUrl: () => {},
        sleep: () => Promise.resolve(),
      })

      await flow.startOAuth()

      expect(flow.state.phase).toBe("form")
      expect(flow.state.error).toContain(fragment)
    }
  })

  test("oauth 409 enters confirm-replace and re-submits with method oauth + confirmReplace", async () => {
    const { request, calls } = scriptedRequest([
      { status: 409, body: { ok: false, code: "connection_exists" } },
      { status: 200, body: { ok: true, url: "https://x", attemptId: "a" } },
      { status: 200, body: { status: "complete", integrationId: "google" } },
    ])
    const flow = createConnectFlow({
      integration: google,
      request,
      openUrl: () => {},
      sleep: () => Promise.resolve(),
    })

    await flow.startOAuth()
    expect(flow.state.phase).toBe("confirm-replace")
    expect(flow.state.pendingMode).toBe("oauth")

    await flow.confirmReplace()

    expect(calls[1]?.body).toEqual({ method: "oauth", confirmReplace: true })
    expect(flow.state.phase).toBe("done")
  })

  test("reset cancels in-flight polling", async () => {
    let polls = 0
    const request: ConnectionsRequest = async (path, init) => {
      if (path === "/google/connect" && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, url: "https://x", attemptId: "a" }), { status: 200 })
      }
      polls++
      return new Response(JSON.stringify({ status: "pending", integrationId: "google" }), { status: 200 })
    }
    let release: (() => void) | undefined
    const flow = createConnectFlow({
      integration: google,
      request,
      openUrl: () => {},
      // First sleep resolves immediately (one poll happens), the second parks
      // until we reset — the loop must then exit without polling again.
      sleep: () =>
        polls === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              release = resolve
            }),
    })

    const run = flow.startOAuth()
    // Let the connect POST + first poll settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(flow.state.phase).toBe("oauth-waiting")
    expect(polls).toBe(1)

    flow.reset()
    release?.()
    await run

    expect(polls).toBe(1)
    expect(flow.state.phase).toBe("form")
  })

  test("missing url/attemptId from a 200 connect is treated as an error", async () => {
    const { request } = scriptedRequest([{ status: 200, body: { ok: true } }])
    const flow = createConnectFlow({ integration: google, request, openUrl: () => {} })

    await flow.startOAuth()

    expect(flow.state.phase).toBe("form")
    expect(flow.state.error).toContain("authorization URL")
  })
})

describe("connect flow: device grant", () => {
  test("the user code survives into flow state while the attempt is polled", async () => {
    // A device grant sends the user to a page that ASKS for this code, and the
    // connect response is the only place it exists. Dropping it — which this
    // flow used to do — left the UI spinning next to a page the user could not
    // get past, so the connect could never complete.
    const { request } = scriptedRequest([
      {
        status: 200,
        body: {
          ok: true,
          url: "https://github.com/login/device",
          attemptId: "state-1",
          userCode: "WDJB-MJHT",
          intervalMs: 5_000,
        },
      },
      { status: 200, body: { status: "pending", integrationId: "google" } },
      { status: 200, body: { status: "complete", integrationId: "google" } },
    ])
    const codesWhileWaiting: Array<string | undefined> = []
    const flow = createConnectFlow({
      integration: google,
      request,
      openUrl: () => {},
      sleep: () => {
        codesWhileWaiting.push(flow.state.userCode)
        return Promise.resolve()
      },
    })

    await flow.startOAuth()

    // Visible on EVERY poll, not merely set once and cleared — the user is
    // typing it while these polls run.
    expect(codesWhileWaiting).toEqual(["WDJB-MJHT", "WDJB-MJHT"])
    expect(flow.state.phase).toBe("done")
    // Cleared on success: a stale code shown after connecting is misleading.
    expect(flow.state.userCode).toBeUndefined()
  })

  test("the verification url is kept so the user can re-open the page", async () => {
    const { request } = scriptedRequest([
      {
        status: 200,
        body: { ok: true, url: "https://github.com/login/device", attemptId: "state-1", userCode: "WDJB-MJHT" },
      },
      { status: 200, body: { status: "pending", integrationId: "google" } },
      { status: 200, body: { status: "complete", integrationId: "google" } },
    ])
    const urls: Array<string | undefined> = []
    const flow = createConnectFlow({
      integration: google,
      request,
      openUrl: () => {},
      sleep: () => {
        urls.push(flow.state.verificationUrl)
        return Promise.resolve()
      },
    })

    await flow.startOAuth()

    expect(urls).toEqual(["https://github.com/login/device", "https://github.com/login/device"])
  })

  test("the server's poll interval is honored, including a mid-flow slow_down", async () => {
    // Polling faster than the provider asked earns rate limiting, and GitHub
    // raises the interval mid-flow via `slow_down`, relayed as `intervalMs`.
    const { request } = scriptedRequest([
      {
        status: 200,
        body: { ok: true, url: "https://github.com/login/device", attemptId: "state-1", userCode: "X", intervalMs: 5_000 },
      },
      { status: 200, body: { status: "pending", integrationId: "google", intervalMs: 10_000 } },
      { status: 200, body: { status: "pending", integrationId: "google" } },
      { status: 200, body: { status: "complete", integrationId: "google" } },
    ])
    const waits: number[] = []
    const flow = createConnectFlow({
      integration: google,
      request,
      openUrl: () => {},
      pollIntervalMs: 2_000,
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })

    await flow.startOAuth()

    // First wait uses the grant's interval (not the 2s default); the raised
    // interval then persists after the response that asked for it.
    expect(waits).toEqual([5_000, 10_000, 10_000])
    expect(flow.state.phase).toBe("done")
  })

  test("a redirect grant leaves the code absent and keeps the default cadence", async () => {
    // The redirect flow has no user code by construction; the dialog must not
    // invent one, and the default poll interval still applies.
    const { request } = scriptedRequest([
      { status: 200, body: { ok: true, url: "https://accounts.example/authorize", attemptId: "state-1" } },
      { status: 200, body: { status: "complete", integrationId: "google" } },
    ])
    const waits: number[] = []
    const codes: Array<string | undefined> = []
    const flow = createConnectFlow({
      integration: google,
      request,
      openUrl: () => {},
      pollIntervalMs: 2_000,
      sleep: (ms) => {
        waits.push(ms)
        codes.push(flow.state.userCode)
        return Promise.resolve()
      },
    })

    await flow.startOAuth()

    expect(codes).toEqual([undefined])
    expect(waits).toEqual([2_000])
  })

  test("reset clears the code so a reopened dialog never shows a dead one", async () => {
    const { request } = scriptedRequest([
      {
        status: 200,
        body: { ok: true, url: "https://github.com/login/device", attemptId: "state-1", userCode: "WDJB-MJHT" },
      },
      { status: 200, body: { status: "failed", integrationId: "google" } },
    ])
    const flow = createConnectFlow({ integration: google, request, openUrl: () => {}, sleep: () => Promise.resolve() })

    await flow.startOAuth()
    expect(flow.state.userCode).toBe("WDJB-MJHT")

    flow.reset()

    expect(flow.state.userCode).toBeUndefined()
    expect(flow.state.verificationUrl).toBeUndefined()
  })
})
