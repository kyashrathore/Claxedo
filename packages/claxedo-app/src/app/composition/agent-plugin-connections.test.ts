import { describe, expect, test } from "bun:test"
import { agentPluginConnectionPort } from "./agent-plugin-connections"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("marketplace connection port", () => {
  test("load reads the integrations list from a Response and keeps only well-formed rows", async () => {
    const calls: string[] = []
    const port = agentPluginConnectionPort({
      request: async (path) => {
        calls.push(path)
        return json({
          connections: [
            { id: "c1", integrationId: "composio", scope: "personal", status: "connected" },
            { id: "c2", integrationId: "context7", scope: "team", status: "degraded" },
            { id: "bad", integrationId: "x", scope: "nope", status: "connected" },
          ],
        })
      },
      open: () => {},
    })
    await expect(port.load()).resolves.toEqual({
      connections: [
        { id: "c1", integrationId: "composio", scope: "personal", status: "connected" },
        { id: "c2", integrationId: "context7", scope: "team", status: "degraded" },
      ],
    })
    expect(calls).toEqual([""])
  })

  test("load surfaces the server's error detail instead of a shape error", async () => {
    const port = agentPluginConnectionPort({
      request: async () => json({ error: { code: "unavailable", message: "control plane down" } }, 503),
      open: () => {},
    })
    await expect(port.load()).rejects.toThrow("Connections request failed (503: control plane down)")
  })

  test("disconnect tolerates an already-gone connection and refuses other failures", async () => {
    const seen: Array<{ path: string; method?: string }> = []
    const port = agentPluginConnectionPort({
      request: async (path, init) => {
        seen.push({ path, method: init?.method })
        return path.endsWith("/gone") ? json({ message: "not found" }, 404) : json({ message: "in use" }, 409)
      },
      open: () => {},
    })
    await expect(port.disconnect("gone")).resolves.toBeUndefined()
    await expect(port.disconnect("busy")).rejects.toThrow("Disconnect failed (409: in use)")
    expect(seen).toEqual([
      { path: "/connections/gone", method: "DELETE" },
      { path: "/connections/busy", method: "DELETE" },
    ])
  })
})
