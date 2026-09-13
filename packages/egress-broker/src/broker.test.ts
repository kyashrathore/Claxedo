import { describe, expect, test } from "vitest"
import { BROKER_ERRORS, createEgressBroker, mintRuntimeToken, verifyRuntimeToken, type Binding, type BindingFailure } from "./index.js"

const key = new Uint8Array(32).fill(7)
const identity = { userId: "user", orgId: "org", workspaceId: "workspace", leaseId: "lease", leaseGeneration: 1, runtimeId: "runtime" }

async function fixture() {
  let binding: Binding = {
    ...identity, id: "binding", credentialId: "credential", revision: 1, status: "active",
    destination: { origin: "https://api.anthropic.com", methods: ["POST"], pathPrefixes: ["/v1/messages"] },
    injection: { header: "x-api-key" },
  }
  let current = true
  const failures: BindingFailure[] = []
  let reportingUnavailable = false
  const upstream: Request[] = []
  let respond = async () => new Response("streamed result", { headers: { "content-type": "text/event-stream", "x-api-key": "real-key", "set-cookie": "secret=value" } })
  const token = await mintRuntimeToken({ ...identity, bindingIds: ["binding"], expiresAt: Date.now() + 60_000 }, key)
  const broker = createEgressBroker({
    verifyToken: (value) => verifyRuntimeToken(value, key),
    authority: {
      resolve: async () => ({ binding, value: "real-key" }),
      currentRuntime: async () => current,
      reportFailure: async (failure) => { if (reportingUnavailable) throw Error("failure store unavailable"); failures.push(failure) },
    },
    fetch: (async (url, init) => { upstream.push(new Request(url, init)); return respond() }) as typeof fetch,
  })
  const request = (pathname = "/v1/messages", init: RequestInit = {}) => broker(new Request(`http://broker.test/bindings/binding${pathname}`, {
    method: "POST", headers: { "x-api-key": token, cookie: "local=private" }, body: "prompt", ...init,
  }))
  return { request, token, upstream, failures, failReporting: () => { reportingUnavailable = true }, update: (patch: Partial<Binding>) => { binding = { ...binding, ...patch } }, stop: () => { current = false }, respond: (fn: typeof respond) => { respond = fn } }
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

  test("rejects replay after runtime withdrawal", async () => {
    const f = await fixture()
    expect((await f.request()).status).toBe(200)
    f.stop()
    expect((await f.request()).status).toBe(403)
    expect(f.upstream).toHaveLength(1)
  })

  test("rejects expired, malformed and differently scoped tokens", async () => {
    const f = await fixture()
    const expired = await mintRuntimeToken({ ...identity, bindingIds: ["binding"], expiresAt: Date.now() - 1000 }, key, Date.now() - 5000)
    const other = await mintRuntimeToken({ ...identity, bindingIds: ["other"], expiresAt: Date.now() + 60000 }, key)
    for (const token of [expired, "garbage", other]) {
      expect([401, 403]).toContain((await f.request("/v1/messages", { headers: { authorization: `Bearer ${token}` } })).status)
    }
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
      error: { code: "broker_authority_unavailable", message: BROKER_ERRORS.broker_authority_unavailable },
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
})
