import { describe, expect, test } from "bun:test"
import {
  createHarnessConnectionsCatalog,
  decodeHarnessConnectionRefs,
} from "@/platform/runtime/agent/connection-catalog"

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
  test("decodes the exact sanitized projection and never retains trusted fields", () => {
    const rows = decodeHarnessConnectionRefs({
      connections: [{
        ...publicRow,
        providerKey: "must-not-survive",
        config: { endpoint: "https://private.example.test", token: "secret-token" },
        secretRefs: { token: "credentials/private" },
      }],
    })
    expect(rows).toEqual([publicRow])
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain("providerKey")
    expect(serialized).not.toContain("private.example")
    expect(serialized).not.toContain("secret-token")
    expect(serialized).not.toContain("secretRefs")
  })

  test("drops malformed contract fields while accepting additive capability fields", () => {
    expect(decodeHarnessConnectionRefs({ connections: [
      { ...publicRow, readiness: "unknown" },
      { ...publicRow, modelSelection: { status: "guessed" } },
      { ...publicRow, connectionId: "" },
    ] })).toEqual([])
    expect(decodeHarnessConnectionRefs({ connections: [
      { ...publicRow, capabilities: { ...publicRow.capabilities, futureCapability: true } },
    ] })).toEqual([publicRow])
  })

  test("loads and removes by opaque connection id without parsing or prefixing it", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const responses = [
      new Response(JSON.stringify({ connections: [publicRow] }), { status: 200 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      new Response(JSON.stringify({ connections: [] }), { status: 200 }),
    ]
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" })
      const response = responses.shift()
      if (!response) throw new Error("Unexpected request")
      return response
    }
    const store = createHarnessConnectionsCatalog({ base: "http://127.0.0.1:7331", request })
    await store.refresh()
    expect(store.rows()).toEqual([publicRow])
    expect(await store.remove("opaque/id with spaces")).toEqual({ ok: true })
    expect(store.rows()).toEqual([])
    expect(calls).toEqual([
      { url: "http://127.0.0.1:7331/api/claxedo/agent-config/connections", method: "GET" },
      { url: "http://127.0.0.1:7331/api/claxedo/agent-config/connections/opaque%2Fid%20with%20spaces", method: "DELETE" },
      { url: "http://127.0.0.1:7331/api/claxedo/agent-config/connections", method: "GET" },
    ])
  })
})
