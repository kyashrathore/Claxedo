import { describe, expect, test } from "vitest"
import { workGraphSmoke } from "./smoke-workgraph"

describe("WorkGraph deployment smoke", () => {
  test("proves same-user cross-organization and same-organization cross-user isolation", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    const sourceToken = `Bearer ${token("user_a", "org_a")}`
    const otherOrganizationToken = `Bearer ${token("user_a", "org_b")}`
    const otherUserToken = `Bearer ${token("user_b", "org_a")}`
    const sessions = new Map<string, { userId: string; organizationId: string }>()
    let deleted = false
    let capabilityRefreshes = 0
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      requests.push({ url, init })
      if (url.hostname === "api.clerk.com" && url.pathname === "/v1/sessions") {
        const body = JSON.parse(String(init?.body))
        const id = `session_${body.user_id}_${body.active_organization_id}`
        sessions.set(id, { userId: body.user_id, organizationId: body.active_organization_id })
        return Response.json({ id })
      }
      if (url.hostname === "api.clerk.com" && url.pathname.endsWith("/tokens/convex")) {
        const session = sessions.get(url.pathname.split("/")[3]!)!
        return Response.json({ jwt: token(session.userId, session.organizationId) })
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
      if (url.pathname === "/documents/__claxedo_deployment_probe__") {
        return Response.json({ error: { code: "document_not_found" } }, { status: 404 })
      }
      if (url.pathname === "/api/workgraph/execution-capabilities") {
        return Response.json({
          schemaVersion: 1,
          ownerUserId: "owner_a",
          environments: [
            {
              kind: "hosted_workspace",
              repositoryRequired: false,
              remoteUrlInput: true,
              baseRevisionInput: true,
            },
          ],
          harnesses: [{ id: "opencode" }],
          agents: [{ id: "build", harnessId: "opencode" }],
          models: [{ harnessId: "opencode", providerId: "test", modelId: "no-op", efforts: ["low"] }],
          tools: [],
        })
      }
      if (url.pathname === "/api/workgraph/execution-capabilities/refresh") {
        capabilityRefreshes += 1
        if (capabilityRefreshes === 1) {
          return Response.json(
            {
              error: {
                code: "execution_capabilities_unavailable",
                capability: "catalog_workspace",
                reason: "runtime_unavailable",
                message: "The hosted capability catalog is provisioning; retry after 2000ms",
                retryable: true,
              },
            },
            { status: 503 },
          )
        }
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
      if (url.pathname === "/api/control/sessions/session_runtime_1/gateway") {
        return Response.json({
          gatewayUrl: null,
          workspaceId: "workgraph_workspace_1",
          directory: null,
          harnessHost: "central",
        })
      }
      if (url.pathname === "/api/control/sessions") {
        return Response.json({
          sessions: [{ session_id: "session_runtime_1", title: "Confirm the hosted WorkGraph no-op execution path" }],
        })
      }
      if (url.pathname === "/api/control/sessions/session_runtime_1/messages") {
        return Response.json({
          allowed: true,
          messages: [
            { info: { id: "msg_user", role: "user" }, parts: [{ type: "text", text: "Confirm deployment" }] },
            { info: { id: "msg_assistant", role: "assistant" }, parts: [{ type: "text", text: "confirmed" }] },
          ],
          maxEventOrdinal: 0,
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
          WORKGRAPH_SMOKE_REPOSITORY_URL: "https://github.com/claxedo/claxedo.git",
          WORKGRAPH_SMOKE_BASE_REVISION: "dev",
          WORKGRAPH_SMOKE_RETRY_DELAY_MS: "1",
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
    expect(capabilityRefreshes).toBe(2)
    expect(requests.filter((entry) => entry.url.pathname.endsWith("/tokens/convex"))).not.toHaveLength(0)
    expect(
      requests
        .filter((entry) => entry.url.pathname.endsWith("/tokens/convex"))
        .every((entry) => JSON.parse(String(entry.init?.body)).expires_in_seconds === 900),
    ).toBe(true)
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
    expect(
      requests.some(
        (entry) =>
          entry.url.pathname === "/documents/__claxedo_deployment_probe__" && authorization(entry.init) === sourceToken,
      ),
    ).toBe(true)
    expect(
      requests.some(
        (entry) =>
          entry.url.pathname === "/api/control/sessions/session_runtime_1/gateway" &&
          authorization(entry.init) === sourceToken,
      ),
    ).toBe(true)
    expect(
      requests.some(
        (entry) =>
          entry.url.pathname === "/api/control/sessions/session_runtime_1/messages" &&
          entry.url.searchParams.get("workspaceId") === "workgraph_workspace_1" &&
          authorization(entry.init) === sourceToken,
      ),
    ).toBe(true)
    expect(
      requests
        .filter((entry) => entry.url.pathname === "/api/workgraph/commands")
        .map((entry) => JSON.parse(String(entry.init?.body)).command)
        .find((command) => command.type === "create_stream"),
    ).toMatchObject({
      execution: {
        environment: { kind: "hosted_workspace", repositoryUrl: "https://github.com/claxedo/claxedo.git" },
        repository: { remoteUrl: "https://github.com/claxedo/claxedo.git", baseRevision: "dev" },
      },
    })
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

function token(userId: string, organizationId: string) {
  return `header.${Buffer.from(JSON.stringify({ aud: "convex", sub: userId, org_id: organizationId })).toString("base64url")}.signature`
}

function authorization(init: RequestInit | undefined) {
  return new Headers(init?.headers).get("authorization")
}
