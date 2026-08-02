import { describe, expect, test } from "bun:test"
import { notionIntegration } from "./notion.js"

describe("notion integration", () => {
  test("declares a key-method docs integration with a single secret prompt", () => {
    const { decl } = notionIntegration()
    expect(decl).toEqual({
      id: "notion",
      name: "Notion",
      methods: ["key"],
      capabilities: ["docs"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Internal integration token", secret: true }],
    })
  })

  test("verifies against the Notion users/me endpoint and returns the account label", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const integration = notionIntegration({
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
        return Response.json({ name: "Acme Bot" })
      }),
    })

    const result = await integration.impl.verify!({}, "notion-secret")
    expect(result).toEqual({ ok: true, accountLabel: "Acme Bot" })
    expect(calls).toEqual([{
      url: "https://api.notion.com/v1/users/me",
      headers: { Authorization: "Bearer notion-secret", "Notion-Version": "2022-06-28" },
    }])
    expect(JSON.stringify(result)).not.toContain("notion-secret")
  })

  test("omits accountLabel when the provider returns no usable name", async () => {
    const integration = notionIntegration({
      fetchImpl: (async (_input: string | URL | Request) => Response.json({ name: 42 })),
    })
    expect(await integration.impl.verify!({}, "notion-secret")).toEqual({ ok: true })
  })

  for (const status of [401, 403] as const) {
    test(`maps ${status} to the closed unauthorized reason`, async () => {
      const integration = notionIntegration({
        fetchImpl: (async (_input: string | URL | Request) => new Response("API token is invalid: notion-secret", { status })),
      })
      const result = await integration.impl.verify!({}, "notion-secret")
      expect(result).toEqual({ ok: false, reason: "unauthorized" })
      expect(JSON.stringify(result)).not.toContain("notion-secret")
    })
  }

  test("reports reason 'network' for a transport throw without echoing the secret", async () => {
    const integration = notionIntegration({
      fetchImpl: (async (_input: string | URL | Request): Promise<Response> => {
        throw new Error("connect ECONNREFUSED while sending notion-secret")
      }),
    })
    const result = await integration.impl.verify!({}, "notion-secret")
    expect(result).toEqual({ ok: false, reason: "network" })
    expect(JSON.stringify(result)).not.toContain("notion-secret")
  })

  test("reports reason 'network' for a non-auth error status without echoing the body", async () => {
    const integration = notionIntegration({
      fetchImpl: (async (_input: string | URL | Request) => new Response("upstream boom notion-secret", { status: 500 })),
    })
    const result = await integration.impl.verify!({}, "notion-secret")
    expect(result).toEqual({ ok: false, reason: "network" })
    expect(JSON.stringify(result)).not.toContain("notion-secret")
  })

  test("survives a non-JSON 200 body (no accountLabel, still ok)", async () => {
    const integration = notionIntegration({
      fetchImpl: (async (_input: string | URL | Request) => new Response("not json", { status: 200 })),
    })
    expect(await integration.impl.verify!({}, "notion-secret")).toEqual({ ok: true })
  })
})
