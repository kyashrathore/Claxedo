import { describe, expect, test } from "vitest"
import { CREDENTIAL_BROKER_ERRORS } from "@claxedo/agent-runtime-contract"
import {
  createEgressBroker,
  mintRuntimeToken,
  verifyRuntimeToken,
  type Binding,
  type BindingAuthority,
  type BindingFailure,
} from "./index.js"

const key = new Uint8Array(32).fill(7)
const identity = { userId: "user", orgId: "org", workspaceId: "workspace", leaseId: "lease", leaseGeneration: 1, runtimeId: "runtime" }

async function fixture(tuning: {
  authorityTimeoutMs?: number
  upstreamTimeoutMs?: number
  maxConcurrentUpstream?: number
  resolve?: BindingAuthority["resolve"]
  fetch?: typeof fetch
} = {}) {
  let binding: Binding = {
    ...identity, id: "binding", credentialId: "credential", revision: 1, status: "active",
    destination: { origin: "https://api.anthropic.com", methods: ["POST"], pathPrefixes: ["/v1/messages"] },
    injection: { header: "x-api-key" },
  }
  let current = true
  let value = "real-key"
  const failures: BindingFailure[] = []
  const used: string[] = []
  let reportingUnavailable = false
  const upstream: Request[] = []
  let respond = async () => new Response("streamed result", { headers: { "content-type": "text/event-stream", "x-api-key": "real-key", "set-cookie": "secret=value" } })
  const token = await mintRuntimeToken({ ...identity, bindingIds: ["binding"], expiresAt: Date.now() + 60_000 }, key)
  const broker = createEgressBroker({
    verifyToken: (value) => verifyRuntimeToken(value, key),
    authority: {
      resolve: tuning.resolve ?? (async () => ({ binding, value })),
      currentRuntime: async () => current,
      markUsed: async (bindingId) => { used.push(bindingId) },
      reportFailure: async (failure) => { if (reportingUnavailable) throw Error("failure store unavailable"); failures.push(failure) },
    },
    fetch: tuning.fetch ?? (async (url, init) => { upstream.push(new Request(url, init)); return respond() }) as typeof fetch,
    authorityTimeoutMs: tuning.authorityTimeoutMs,
    upstreamTimeoutMs: tuning.upstreamTimeoutMs,
    maxConcurrentUpstream: tuning.maxConcurrentUpstream,
  })
  const request = (pathname = "/v1/messages", init: RequestInit = {}) => broker(new Request(`http://broker.test/bindings/binding${pathname}`, {
    method: "POST", headers: { "x-api-key": token, cookie: "local=private" }, body: "prompt", ...init,
  }))
  const broker404 = (url: string) => broker(new Request(url, { method: "POST" }))
  return { request, broker404, token, upstream, failures, used, failReporting: () => { reportingUnavailable = true }, update: (patch: Partial<Binding>) => { binding = { ...binding, ...patch } }, unreadable: () => { value = "" }, stop: () => { current = false }, respond: (fn: typeof respond) => { respond = fn } }
}

describe("binding broker HTTP entrypoint", () => {
  test("injects only at the upstream boundary and streams the response", async () => {
    const f = await fixture()
    const response = await f.request()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("streamed result")
    expect(f.upstream[0].url).toBe("https://api.anthropic.com/v1/messages")
    expect(f.upstream[0].headers.get("x-api-key")).toBe("real-key")
    expect(f.upstream[0].headers.get("cookie")).toBeNull()
    expect(f.upstream[0].headers.get("authorization")).toBeNull()
    expect(await f.upstream[0].text()).toBe("prompt")
    expect(response.headers.get("x-api-key")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  test.each(["/v1/files", "/v1/messages-other", "/v1/messages/%2fprivate", "/v1/messages/%252e%252e/private"])("refuses path %s before upstream", async (path) => {
    const f = await fixture()
    expect((await f.request(path)).status).toBe(403)
    expect(f.upstream).toHaveLength(0)
  })

  test("refuses methods outside policy", async () => {
    const f = await fixture()
    expect((await f.request("/v1/messages", { method: "DELETE" })).status).toBe(403)
  })

  test.each([{ orgId: "other" }, { userId: "other" }, { workspaceId: "other" }, { leaseId: "other" }, { leaseGeneration: 2 }, { runtimeId: "other" }, { status: "withdrawn" as const }])("refuses foreign or withdrawn binding %j", async (patch) => {
    const f = await fixture()
    f.update(patch)
    expect((await f.request()).status).toBe(403)
    expect(f.upstream).toHaveLength(0)
  })

  test("marks the binding used only for a request it forwards", async () => {
    const f = await fixture()
    f.update({ leaseGeneration: 2 })
    expect((await f.request()).status).toBe(403)
    expect(f.used).toEqual([])

    f.update({ leaseGeneration: 1 })
    expect((await f.request()).status).toBe(200)
    expect(f.used).toEqual(["binding"])
  })

  test("rejects replay after runtime withdrawal", async () => {
    const f = await fixture()
    expect((await f.request()).status).toBe(200)
    f.stop()
    expect((await f.request()).status).toBe(403)
    expect(f.upstream).toHaveLength(1)
  })

  test("names the reason a token is rejected", async () => {
    const f = await fixture()
    const expired = await mintRuntimeToken({ ...identity, bindingIds: ["binding"], expiresAt: Date.now() - 1000 }, key, Date.now() - 5000)
    const other = await mintRuntimeToken({ ...identity, bindingIds: ["other"], expiresAt: Date.now() + 60000 }, key)
    const refusals = []
    for (const token of [expired, "garbage", other]) {
      const response = await f.request("/v1/messages", { headers: { authorization: `Bearer ${token}` } })
      refusals.push([response.status, (await response.json()).error.code])
    }
    expect(refusals).toEqual([
      [401, "runtime_token_invalid"],
      [401, "runtime_token_invalid"],
      [403, "binding_not_permitted"],
    ])
    expect(f.upstream).toHaveLength(0)
  })

  test("refuses a caller presenting two different identities", async () => {
    const f = await fixture()
    const other = await mintRuntimeToken({ ...identity, bindingIds: ["binding"], expiresAt: Date.now() + 60_000 }, key, Date.now() - 1000)
    expect(other).not.toBe(f.token)
    const response = await f.request("/v1/messages", { headers: { authorization: `Bearer ${f.token}`, "x-api-key": other } })
    expect([response.status, (await response.json()).error.code]).toEqual([401, "runtime_token_required"])
    expect(f.upstream).toHaveLength(0)
  })

  test("accepts the token in every header a harness puts an API key in, and forwards none of them", async () => {
    const f = await fixture()
    const response = await f.request("/v1/messages", { headers: { "x-goog-api-key": f.token } })
    expect(response.status).toBe(200)
    expect(f.upstream[0].headers.get("x-goog-api-key")).toBeNull()
    expect(f.upstream[0].headers.get("x-api-key")).toBe("real-key")
  })

  test("refuses an injection policy that would overwrite a transport header or the credential slot", async () => {
    const policies: Record<string, string>[] = [{ host: "evil.test" }, { "X-Api-Key": "duplicate" }]
    for (const headers of policies) {
      const f = await fixture()
      f.update({ injection: { header: "x-api-key", headers } })
      const response = await f.request()
      expect([response.status, (await response.json()).error.code]).toEqual([503, "binding_injection_invalid"])
      expect(f.upstream).toHaveLength(0)
    }
  })

  test.each([
    { patch: { revision: 0 }, unreadable: false },
    { patch: {}, unreadable: true },
  ])("refuses a binding whose credential cannot be spent %j", async ({ patch, unreadable }) => {
    const f = await fixture()
    f.update(patch as Partial<Binding>)
    if (unreadable) f.unreadable()
    const response = await f.request()
    expect([response.status, (await response.json()).error.code]).toEqual([503, "credential_unavailable"])
    expect(f.upstream).toHaveLength(0)
  })

  test("answers anything off the binding route with 404", async () => {
    const f = await fixture()
    const response = await f.broker404("http://broker.test/v1/messages")
    expect([response.status, (await response.json()).error.code]).toEqual([404, "binding_route_required"])
    expect(f.upstream).toHaveLength(0)
  })

  test("reports the revision used when rotation races a failed request", async () => {
    const f = await fixture()
    f.respond(async () => {
      f.update({ revision: 2 })
      return new Response("unauthorized", { status: 401 })
    })
    expect((await f.request()).status).toBe(401)
    expect(f.failures).toEqual([{ bindingId: "binding", credentialId: "credential", revision: 1, status: 401 }])
  })

  test.each([401, 403])("cancels the upstream response when recording %s fails", async (status) => {
    const f = await fixture()
    let cancelled = false
    f.respond(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("upstream response")) },
      cancel() { cancelled = true },
    }), { status }))
    f.failReporting()
    const response = await f.request()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: "broker_authority_unavailable", message: CREDENTIAL_BROKER_ERRORS.broker_authority_unavailable.message },
    })
    expect(cancelled).toBe(true)
    expect(f.upstream).toHaveLength(1)
  })

  test.each([301, 302, 303, 307, 308])("returns 502 without Location on %s", async (status) => {
    const f = await fixture()
    f.respond(async () => new Response(null, { status, headers: { location: "https://evil.test" } }))
    const response = await f.request()
    expect(response.status).toBe(502)
    expect(response.headers.get("location")).toBeNull()
    expect(f.upstream).toHaveLength(1)
  })

  test.each([
    { authorization: "Basic dXNlcjpwYXNz", keyed: true },
    { authorization: "Bearer", keyed: true },
    { authorization: "Digest abc", keyed: false },
  ])("refuses an Authorization scheme the broker does not serve %j", async ({ authorization, keyed }) => {
    const f = await fixture()
    const response = await f.request("/v1/messages", {
      headers: { authorization, ...(keyed ? { "x-api-key": f.token } : {}) },
    })
    expect([response.status, (await response.json()).error.code]).toEqual([401, "runtime_token_required"])
    expect(f.upstream).toHaveLength(0)
  })

  test("refuses a caller when the authority never answers", async () => {
    const f = await fixture({ authorityTimeoutMs: 25, resolve: () => new Promise(() => {}) })
    const response = await f.request()
    expect([response.status, (await response.json()).error.code]).toEqual([503, "broker_authority_unavailable"])
    expect(f.upstream).toHaveLength(0)
  })

  test("refuses an upstream that never reaches headers", async () => {
    const f = await fixture({
      upstreamTimeoutMs: 25,
      fetch: ((_url: unknown, init: RequestInit) => new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch,
    })
    const response = await f.request()
    expect([response.status, (await response.json()).error.code]).toEqual([502, "upstream_unavailable"])
  })

  test("refuses a caller that cannot get a lane while one is held", async () => {
    let upstreamCalls = 0
    let reachedFetch!: () => void
    let releaseFetch!: (response: Response) => void
    const reached = new Promise<void>((resolve) => { reachedFetch = resolve })
    const gate = new Promise<Response>((resolve) => { releaseFetch = resolve })
    const f = await fixture({
      maxConcurrentUpstream: 1,
      upstreamTimeoutMs: 30,
      fetch: (async () => { upstreamCalls += 1; reachedFetch(); return gate }) as typeof fetch,
    })
    const first = f.request()
    await reached
    const second = await f.request()
    expect([second.status, (await second.json()).error.code]).toEqual([503, "broker_authority_unavailable"])
    expect(upstreamCalls).toBe(1)
    releaseFetch(new Response("done"))
    const firstResponse = await first
    expect(firstResponse.status).toBe(200)
    await firstResponse.body?.cancel()
  })

  test("keeps the lane until the streamed answer is spent or abandoned", async () => {
    const f = await fixture({ maxConcurrentUpstream: 1, upstreamTimeoutMs: 200 })
    f.respond(async () => new Response(new ReadableStream({ start: () => {} })))
    const first = await f.request()
    expect(first.status).toBe(200)
    const queued = f.request()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(f.upstream).toHaveLength(1)
    await first.body?.cancel()
    const second = await queued
    expect(second.status).toBe(200)
    expect(f.upstream).toHaveLength(2)
    await second.body?.cancel()
  })

  test("strips credential slots from the forwarded query of a vendor that reads none", async () => {
    const f = await fixture()
    const response = await f.request("/v1/messages?key=foreign&access_token=foreign&api_key=foreign&apikey=foreign&model=x")
    expect(response.status).toBe(200)
    expect(f.upstream[0].url).toBe("https://api.anthropic.com/v1/messages?model=x")
  })

  test("refuses a query credential slot the vendor does read, and echoes none of it", async () => {
    const f = await fixture()
    f.update({
      destination: {
        origin: "https://generativelanguage.googleapis.com",
        methods: ["POST"],
        pathPrefixes: ["/v1beta"],
        credentialQuerySlots: ["key"],
      },
    })
    const response = await f.request("/v1beta/models:generateContent?key=foreign-key&model=x")
    const body = await response.text()
    expect([response.status, JSON.parse(body).error.code]).toEqual([403, "request_outside_policy"])
    expect(f.upstream).toHaveLength(0)
    expect(body).not.toContain("foreign-key")
    expect([...response.headers.values()].join(" ")).not.toContain("foreign-key")
  })

  test("forwards only the answer headers a harness reads", async () => {
    const f = await fixture()
    f.respond(async () => new Response("ok", {
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-requests-remaining": "42",
        "x-ratelimit-limit-tokens": "100",
        "retry-after": "30",
        "request-id": "req_1",
        "content-encoding": "gzip",
        "www-authenticate": `Bearer realm="anthropic"`,
        "set-cookie": "session=1",
        authorization: "Bearer leaked",
        "openai-organization": "org-of-the-operator",
        "anthropic-organization-id": "org_secret",
        "x-goog-api-key": "real-key",
      },
    }))
    const response = await f.request()
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "application/json",
      "anthropic-ratelimit-requests-remaining": "42",
      "x-ratelimit-limit-tokens": "100",
      "retry-after": "30",
      "request-id": "req_1",
    })
  })

  test("strips every credential slot the binding owns from the answer", async () => {
    const f = await fixture()
    f.update({ injection: { header: "x-goog-api-key", headers: { "ChatGPT-Account-Id": "acct" } } })
    f.respond(async () => new Response("ok", { headers: { "x-goog-api-key": "real-key", "chatgpt-account-id": "other" } }))
    const response = await f.request()
    expect(response.status).toBe(200)
    expect(f.upstream[0].headers.get("x-goog-api-key")).toBe("real-key")
    expect(f.upstream[0].headers.get("chatgpt-account-id")).toBe("acct")
    expect(response.headers.get("x-goog-api-key")).toBeNull()
    expect(response.headers.get("chatgpt-account-id")).toBeNull()
  })

  test("an unexpired token dies with the runtime that minted it", async () => {
    const f = await fixture()
    f.stop()
    const response = await f.request()
    expect([response.status, (await response.json()).error.code]).toEqual([403, "binding_unavailable"])
    expect(await verifyRuntimeToken(f.token, key)).toBeDefined()
    expect(f.upstream).toHaveLength(0)
  })
})
