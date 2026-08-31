import { describe, expect, test } from "bun:test"
import { agentPluginApi } from "./api"

describe("Agent Plugins client", () => {
  test("Refresh is a read-only catalog query and activation carries optimistic revision", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Response.json(init?.method === "POST"
        ? { revision: 8, reconciliation: { state: "applied" } }
        : { revision: 7, supportedHarnesses: [], candidates: [], errors: [] })
    }
    const api = agentPluginApi({ baseUrl: "http://127.0.0.1:2593", request })

    await api.catalog({ refresh: true, projectId: "project_1" })
    await api.activation({ pluginInstanceId: "source/plugin", harnessIds: ["codex"], choice: true, expectedRevision: 7 })

    expect(calls[0]?.url).toBe("http://127.0.0.1:2593/api/claxedo/plugins/projects/project_1/refresh")
    expect(calls[1]?.url).toBe("http://127.0.0.1:2593/api/claxedo/plugins/activation")
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      pluginInstanceId: "source/plugin",
      harnessIds: ["codex"],
      choice: true,
      expectedRevision: 7,
    })
  })

  test("surfaces the server's canonical error instead of synthesizing catalog state", async () => {
    const api = agentPluginApi({
      baseUrl: "https://claxedo.test",
      request: async () => Response.json({ error: { message: "revision changed" } }, { status: 409 }),
    })

    await expect(api.update({ pluginInstanceId: "source/plugin", expectedRevision: 1 })).rejects.toThrow("revision changed")
  })

  test("rejects successful responses that do not match the catalog contract", async () => {
    const api = agentPluginApi({
      baseUrl: "https://claxedo.test",
      request: async () => Response.json({ revision: 1, supportedHarnesses: ["imaginary"], candidates: [], errors: [] }),
    })

    await expect(api.catalog()).rejects.toThrow("did not match its API contract")
  })

  test("rejects malformed mutation receipts", async () => {
    const api = agentPluginApi({
      baseUrl: "https://claxedo.test",
      request: async () => Response.json({ revision: 2, reconciliation: { state: 42 } }),
    })

    await expect(api.update({ pluginInstanceId: "source/plugin", expectedRevision: 1 })).rejects.toThrow("did not match its API contract")
  })
})
