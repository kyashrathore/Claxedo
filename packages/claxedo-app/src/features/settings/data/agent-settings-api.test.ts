import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

const calls: Array<{ url: string; init?: RequestInit }> = []
let answer: (url: string, init?: RequestInit) => Response

/** The JSON a request carried; every request here sends a string body or none. */
function sentBody(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined
}

// Bun's mock.module registry is process-wide, so this mock stays a faithful
// superset of the real module: captured through a cache-busting query, spread
// whole so every named export keeps resolving for later-loaded suites, with
// only the network boundary and the server URL overridden.
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?agent-settings-restore`)) }
afterAll(async () => {
  await mock.module("@/platform/api/api", () => realApiModule)
})

await mock.module("@/platform/api/api", () => ({
  ...realApiModule,
  authFetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return answer(url, init)
  },
  getClaxedoServerUrl: () => "https://api.example.test",
}))

const { readAgentSettings, writeAgentSettings } = await import("./agent-settings-api")

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  calls.length = 0
})

describe("account agent settings", () => {
  test("reads the account's own setting from the control plane", async () => {
    answer = () => json({ cross_machine_writes: true })
    expect(await readAgentSettings()).toEqual({ crossMachineWrites: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.example.test/api/account/agent-settings")
    expect(calls[0]?.init?.method).toBeUndefined()
  })

  test("writes the setting as the control plane spells it and reads the answer back", async () => {
    answer = (_url, init) => json(sentBody(init))
    expect(await writeAgentSettings({ crossMachineWrites: true })).toEqual({ crossMachineWrites: true })
    expect(calls[0]?.init?.method).toBe("PUT")
    expect(sentBody(calls[0]?.init)).toEqual({ cross_machine_writes: true })
  })

  test("a refusal carries the control plane's own sentence", async () => {
    answer = () => json({ error: { code: "identity_provisioning", message: "Canonical application identity is required" } }, 503)
    await expect(readAgentSettings()).rejects.toThrow("Canonical application identity is required")
  })

  test("a server without the route, or an answer without the field, is unavailable rather than off", async () => {
    answer = () => new Response("not found", { status: 404 })
    await expect(readAgentSettings()).rejects.toThrow("Agent settings are unavailable")
    answer = () => json({})
    await expect(readAgentSettings()).rejects.toThrow("Agent settings are unavailable")
  })
})
