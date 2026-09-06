import { describe, expect, test } from "bun:test"
import { createHarnessConnectionsCatalog } from "./connection-catalog"
import { requestUrl } from "@/lib/url"

const publicRow = {
  connectionId: "opaque-connection-id",
  label: "Remote agent",
  enabled: true,
  readiness: "ready",
  capabilities: {
    abort: true,
    reconnect: false,
    replay: true,
    permissions: true,
    questions: false,
    todos: false,
    commands: false,
    fork: false,
    revert: false,
    unrevert: false,
    configOptions: true,
    subagents: false,
  },
  modelSelection: { status: "optional" },
}

describe("generic harness connection discovery", () => {
  test.each(["not-json", "{}", JSON.stringify({ status: "supported", connections: [{ ...publicRow, capabilities: {} }] })])("reports failed discovery instead of a successful empty catalog: %s", async (body) => {
    const store = createHarnessConnectionsCatalog({ base: "http://localhost", request: async () => new Response(body) })
    expect(store.data()).toBeUndefined()
    await store.refresh()
    expect(store.data()).toBeUndefined()
    expect(store.error()).toBeTruthy()
    expect(store.loading()).toBe(false)
  })

  test("keeps unsupported distinct and refuses management without a request", async () => {
    let calls = 0
    const unsupported = { status: "unsupported", reason: "operator_local_configuration" }
    const store = createHarnessConnectionsCatalog({ base: "http://localhost", request: async () => { calls++; return Response.json(unsupported) } })
    await store.refresh()
    expect(store.data()).toEqual(unsupported)
    expect(store.error()).toBeUndefined()
    expect((await store.remove("pi")).ok).toBe(false)
    expect(calls).toBe(1)
  })

  test("recovers from failure to an authoritative successful empty catalog", async () => {
    let calls = 0
    const store = createHarnessConnectionsCatalog({ base: "http://localhost", request: async () => ++calls === 1 ? new Response("offline", { status: 503 }) : Response.json({ status: "supported", connections: [] }) })
    await store.refresh()
    expect(store.error()).toContain("503")
    await store.refresh()
    expect(store.data()).toEqual({ status: "supported", connections: [] })
    expect(store.error()).toBeUndefined()
  })

  test("loads and removes by opaque connection id without parsing or prefixing it", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const responses = [
      new Response(JSON.stringify({ status: "supported", connections: [publicRow] }), { status: 200 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(JSON.stringify({ status: "supported", connections: [] }), { status: 200 }),
    ]
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: requestUrl(input), method: init?.method ?? "GET" })
      const response = responses.shift()
      if (!response) throw new Error("Unexpected request")
      return response
    }
    const store = createHarnessConnectionsCatalog({ base: "http://127.0.0.1:7331", request })
    await store.refresh()
    expect(store.data()).toEqual({ status: "supported", connections: [publicRow] })
    expect(await store.remove("opaque/id with spaces")).toEqual({ ok: true })
    expect(store.data()).toEqual({ status: "supported", connections: [] })
    expect(calls).toEqual([
      { url: "http://127.0.0.1:7331/api/claxedo/agent-config/connections", method: "GET" },
      { url: "http://127.0.0.1:7331/api/claxedo/agent-config/connections/opaque%2Fid%20with%20spaces", method: "DELETE" },
      { url: "http://127.0.0.1:7331/api/claxedo/agent-config/connections", method: "GET" },
    ])
  })
})
