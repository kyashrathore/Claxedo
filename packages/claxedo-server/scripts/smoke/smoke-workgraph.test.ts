import { describe, expect, test } from "vitest"
import { workGraphSmoke } from "./smoke-workgraph"

describe("WorkGraph deployment smoke", () => {
  test("proves same-user cross-organization and same-organization cross-user isolation", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    const sourceToken = "Bearer token_user_a_org_a"
    const otherOrganizationToken = "Bearer token_user_a_org_b"
    const otherUserToken = "Bearer token_user_b_org_a"
    let deleted = false
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      requests.push({ url, init })
      if (url.hostname === "api.clerk.com" && url.pathname === "/v1/sessions") {
        const body = JSON.parse(String(init?.body))
        return Response.json({ id: `session_${body.user_id}_${body.active_organization_id}` })
      }
      if (url.hostname === "api.clerk.com" && url.pathname.endsWith("/tokens")) {
        return Response.json({ jwt: url.pathname.split("/")[3]!.replace("session_", "token_") })
      }
      if (url.hostname === "api.clerk.com" && url.pathname.endsWith("/revoke")) {
        return Response.json({ revoked: true })
      }
      if (
        url.pathname === "/api/workgraph/snapshot" &&
        authorization(init)?.startsWith("Bearer workgraph-smoke-invalid-")
      ) {
        return new Response(null, { status: 401 })
      }
      if (url.pathname === "/api/workgraph/execution-capabilities") {
        return Response.json({
          schemaVersion: 1,
          ownerUserId: "owner_a",
          environments: [
            {
              kind: "hosted_workspace",
              repositoryRequired: false,
            },
          ],
          harnesses: [{ id: "opencode" }],
          agents: [{ id: "build", harnessId: "opencode" }],
          models: [{ harnessId: "opencode", providerId: "test", modelId: "no-op", efforts: ["low"] }],
          tools: [],
        })
      }
      if (url.pathname === "/api/workgraph/execution-capabilities/refresh") {
        return Response.json({ refreshed: true })
      }
      if (url.pathname === "/internal/workgraph/reconcile") return Response.json({ ok: true, summary: {} })
      if (url.pathname === "/api/workgraph/commands") {
        const body = JSON.parse(String(init?.body))
        if (body.command.type === "update_stream" && authorization(init) !== sourceToken) {
          return Response.json({ error: { code: "not_found" } }, { status: 404 })
        }
        if (body.command.type === "create_stream") {
          return Response.json({ ok: true, value: { streamId: "stream_1" } })
        }
        if (body.command.type === "create_work_item") {
          return Response.json({ ok: true, value: { workItemId: "item_1" } })
        }
        if (body.command.type === "execute_work_item") {
          return Response.json({ ok: true, value: { attemptId: "attempt_1" } })
        }
        if (body.command.type === "delete_stream") {
          deleted = true
          return Response.json({ ok: true, value: { streamId: "stream_1" } })
        }
      }
      if (url.pathname === "/api/workgraph/streams/stream_1") {
        if (deleted || authorization(init) !== sourceToken) {
          return Response.json({ error: { code: "not_found" } }, { status: 404 })
        }
        return Response.json({ id: "stream_1" })
      }
      if (url.pathname === "/api/workgraph/work-items/item_1") {
        if (authorization(init) !== sourceToken) {
          return Response.json({ error: { code: "not_found" } }, { status: 404 })
        }
        return Response.json({ id: "item_1" })
      }
      if (url.pathname === "/api/workgraph/attempts/attempt_1") {
        return Response.json({
          attempt: { id: "attempt_1", state: "result" },
          executionReferences: { workspaceId: "workgraph_workspace_1", sessionId: "session_runtime_1" },
        })
      }
      if (url.pathname === "/api/workgraph/snapshot") {
        if (url.searchParams.has("after") && authorization(init) !== sourceToken) {
          return Response.json({ error: { code: "cursor_invalid" } }, { status: 409 })
        }
        if (authorization(init) !== sourceToken) {
          return Response.json({ records: [{ id: `workgraph_${authorization(init)}` }] })
        }
        if (url.searchParams.get("limit") === "1") {
          return Response.json({ records: [{ id: "workgraph_1" }], nextCursor: "cursor_org_a_user_a" })
        }
        return Response.json({ records: [{ id: "stream_1" }, { id: "item_1" }] })
      }
      return Response.json({ error: "unexpected request" }, { status: 500 })
    }

    await expect(
      workGraphSmoke(
        {
          BASE_URL: "https://control.example.test",
          CLERK_SECRET_KEY: "clerk_secret",
          WORKGRAPH_SMOKE_USER_A_ID: "user_a",
          WORKGRAPH_SMOKE_USER_B_ID: "user_b",
          WORKGRAPH_SMOKE_ORGANIZATION_A_ID: "org_a",
          WORKGRAPH_SMOKE_ORGANIZATION_B_ID: "org_b",
          WORKGRAPH_SMOKE_RECONCILE_TOKEN: "reconcile_secret",
          WORKGRAPH_SMOKE_HARNESS: "opencode",
          WORKGRAPH_SMOKE_AGENT: "build",
          WORKGRAPH_SMOKE_PROVIDER_ID: "test",
          WORKGRAPH_SMOKE_MODEL_ID: "no-op",
          WORKGRAPH_SMOKE_EFFORT: "low",
          WORKGRAPH_SMOKE_TOOLS_JSON: "[]",
        },
        request as typeof fetch,
      ),
    ).resolves.toBeUndefined()

    expect(
      requests
        .filter((entry) => entry.url.pathname === "/v1/sessions")
        .map((entry) => JSON.parse(String(entry.init?.body))),
    ).toEqual([
      { user_id: "user_a", active_organization_id: "org_a" },
      { user_id: "user_a", active_organization_id: "org_b" },
      { user_id: "user_b", active_organization_id: "org_a" },
    ])
    expect(requests.filter((entry) => entry.url.pathname.endsWith("/revoke"))).toHaveLength(3)
    expect(
      requests.some(
        (entry) =>
          entry.url.pathname === "/api/workgraph/execution-capabilities/refresh" &&
          entry.init?.method === "POST" &&
          !entry.url.search,
      ),
    ).toBe(true)
    expect(
      requests.some((entry) => entry.url.pathname === "/api/workgraph/execution-capabilities" && !entry.url.search),
    ).toBe(true)
    for (const token of [otherOrganizationToken, otherUserToken]) {
      expect(
        requests.some(
          (entry) => entry.url.pathname === "/api/workgraph/streams/stream_1" && authorization(entry.init) === token,
        ),
      ).toBe(true)
      expect(
        requests.some(
          (entry) => entry.url.pathname === "/api/workgraph/work-items/item_1" && authorization(entry.init) === token,
        ),
      ).toBe(true)
      expect(
        requests.some(
          (entry) =>
            entry.url.pathname === "/api/workgraph/commands" &&
            authorization(entry.init) === token &&
            JSON.parse(String(entry.init?.body)).command.type === "update_stream",
        ),
      ).toBe(true)
      expect(
        requests.some(
          (entry) =>
            entry.url.pathname === "/api/workgraph/snapshot" &&
            entry.url.searchParams.get("after") === "cursor_org_a_user_a" &&
            authorization(entry.init) === token,
        ),
      ).toBe(true)
    }
  })

  test("requires two distinct configured users", async () => {
    await expect(
      workGraphSmoke({
        BASE_URL: "https://control.example.test",
        CLERK_SECRET_KEY: "clerk_secret",
        WORKGRAPH_SMOKE_USER_A_ID: "same_user",
        WORKGRAPH_SMOKE_USER_B_ID: "same_user",
        WORKGRAPH_SMOKE_ORGANIZATION_A_ID: "org_a",
        WORKGRAPH_SMOKE_ORGANIZATION_B_ID: "org_b",
        WORKGRAPH_SMOKE_RECONCILE_TOKEN: "reconcile_secret",
      }),
    ).rejects.toThrow("must be different users")
  })

  test("requires two distinct explicitly configured organizations", async () => {
    await expect(
      workGraphSmoke({
        BASE_URL: "https://control.example.test",
        CLERK_SECRET_KEY: "clerk_secret",
        WORKGRAPH_SMOKE_USER_A_ID: "user_a",
        WORKGRAPH_SMOKE_USER_B_ID: "user_b",
        WORKGRAPH_SMOKE_ORGANIZATION_A_ID: "same_org",
        WORKGRAPH_SMOKE_ORGANIZATION_B_ID: "same_org",
        WORKGRAPH_SMOKE_RECONCILE_TOKEN: "reconcile_secret",
      }),
    ).rejects.toThrow("must use different organizations")
  })

  test("does not infer a smoke organization", async () => {
    await expect(
      workGraphSmoke({
        BASE_URL: "https://control.example.test",
        CLERK_SECRET_KEY: "clerk_secret",
        WORKGRAPH_SMOKE_USER_A_ID: "user_a",
        WORKGRAPH_SMOKE_USER_B_ID: "user_b",
        WORKGRAPH_SMOKE_ORGANIZATION_A_ID: "org_a",
        WORKGRAPH_SMOKE_RECONCILE_TOKEN: "reconcile_secret",
      }),
    ).rejects.toThrow("WORKGRAPH_SMOKE_ORGANIZATION_B_ID is required")
  })
})

function authorization(init: RequestInit | undefined) {
  return new Headers(init?.headers).get("authorization")
}
