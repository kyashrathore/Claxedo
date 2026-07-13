import { describe, expect, test } from "vitest"
import { workGraphSmoke } from "./smoke-workgraph"

describe("WorkGraph deployment smoke", () => {
  test("mints two short-lived identities, proves owner isolation and revokes both Sessions", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      requests.push({ url, init })
      if (url.hostname === "api.clerk.com" && url.pathname === "/v1/sessions") {
        const user = JSON.parse(String(init?.body)).user_id
        return Response.json({ id: user === "user_a" ? "session_a" : "session_b" })
      }
      if (url.hostname === "api.clerk.com" && url.pathname.endsWith("/tokens")) {
        return Response.json({ jwt: url.pathname.includes("session_a") ? "token_a" : "token_b" })
      }
      if (url.hostname === "api.clerk.com" && url.pathname.endsWith("/revoke")) return Response.json({ revoked: true })
      if (url.pathname === "/api/workgraph/snapshot" && authorization(init) === "Bearer workgraph-smoke-invalid") {
        return new Response(null, { status: 401 })
      }
      if (url.pathname === "/api/workgraph/snapshot" && authorization(init)?.startsWith("Bearer workgraph-smoke-invalid-")) {
        return new Response(null, { status: 401 })
      }
      if (url.pathname === "/api/workgraph/execution-capabilities") {
        return Response.json({
          schemaVersion: 1,
          ownerUserId: "owner_a",
          workspaceId: "workspace_1",
          environments: [{ kind: "hosted_workspace" }],
        })
      }
      if (url.pathname === "/api/workgraph/commands") {
        const input = JSON.parse(String(init?.body))
        if (input.command.type === "create_stream") return Response.json({ ok: true, value: { streamId: "stream_1" } })
        if (input.command.type === "create_work_item") return Response.json({ ok: true, value: { workItemId: "item_1" } })
        if (input.command.type === "delete_stream") return Response.json({ ok: true, value: { streamId: "stream_1" } })
      }
      if (url.pathname === "/api/workgraph/streams/stream_1") {
        if (authorization(init) === "Bearer token_b") return Response.json({ error: { code: "not_found" } }, { status: 404 })
        return Response.json({ id: "stream_1" })
      }
      if (url.pathname === "/api/workgraph/work-items/item_1") return Response.json({ id: "item_1" })
      if (url.pathname === "/api/workgraph/snapshot" && authorization(init) === "Bearer token_b") {
        return Response.json({ records: [] })
      }
      if (url.pathname === "/api/workgraph/snapshot") return Response.json({ records: [{ id: "stream_1" }, { id: "item_1" }] })
      return Response.json({ error: "unexpected request" }, { status: 500 })
    }

    await expect(workGraphSmoke({
      BASE_URL: "https://control.example.test",
      CLERK_SECRET_KEY: "clerk_secret",
      WORKGRAPH_SMOKE_USER_A_ID: "user_a",
      WORKGRAPH_SMOKE_USER_B_ID: "user_b",
      WORKGRAPH_SMOKE_WORKSPACE_ID: "workspace_1",
    }, request as typeof fetch)).resolves.toBeUndefined()

    expect(requests.filter((entry) => entry.url.pathname.endsWith("/revoke"))).toHaveLength(2)
    expect(requests.some((entry) => entry.url.pathname === "/api/workgraph/execution-capabilities" && entry.url.searchParams.get("workspaceId") === "workspace_1")).toBe(true)
    expect(requests.some((entry) => entry.url.pathname === "/api/workgraph/streams/stream_1" && authorization(entry.init) === "Bearer token_b")).toBe(true)
  })

  test("requires two distinct configured users", async () => {
    await expect(workGraphSmoke({
      BASE_URL: "https://control.example.test",
      CLERK_SECRET_KEY: "clerk_secret",
      WORKGRAPH_SMOKE_USER_A_ID: "same_user",
      WORKGRAPH_SMOKE_USER_B_ID: "same_user",
      WORKGRAPH_SMOKE_WORKSPACE_ID: "workspace_1",
    })).rejects.toThrow("must be different users")
  })
})

function authorization(init: RequestInit | undefined) {
  return new Headers(init?.headers).get("authorization")
}
