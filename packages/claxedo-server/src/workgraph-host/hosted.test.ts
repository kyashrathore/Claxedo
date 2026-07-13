import { createHmac } from "node:crypto"
import { describe, expect, test, vi } from "vitest"
import type { ConnectionWebhookVerifier } from "@claxedo/connections"
import type { ControlPlaneCredentials } from "../control-plane/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ExecutionCapabilitiesPort } from "@claxedo/workgraph/ports"
import { createHostedWorkGraph } from "./hosted"

const authConfig = { enabled: true as const, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" }

function composition(
  calls: Record<string, unknown>[],
  webhookVerifier?: ConnectionWebhookVerifier,
  webhookCredentials?: (orgId: string) => ControlPlaneCredentials,
  sandboxManager?: SandboxManager,
  executionCapabilities?: ExecutionCapabilitiesPort,
) {
  return createHostedWorkGraph({
    env: {
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
    },
    authConfig,
    verifier: vi.fn(async (token: string) => ({
      mode: "signed" as const,
      user: { subject: token, tokenIdentifier: `issuer|${token}`, issuer: "https://clerk.test", orgId: "clerk_org_a" },
    })),
    requestId: () => "request-hosted",
    ...(webhookVerifier ? { webhookVerifier } : {}),
    ...(webhookCredentials ? { webhookCredentials } : {}),
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(executionCapabilities ? { executionCapabilities } : {}),
    executor: {
      mutation: async (_fn, args) => {
        calls.push(args)
        if (args.target_snapshot_hash) return {
          ok: true,
          result: { deleted: true, recordCount: 7, workspaceCount: 1, completedAt: 101 },
        }
        if (args.operation_id && args.now && !args.operation) return {
          ok: true,
          state: "acquired",
          targets: [{ streamId: "stream_a", envelopeId: "envelope_a", childIsolationIds: ["child_a"] }],
          targetSnapshotHash: "target_hash_a",
        }
        if (args.operation && typeof args.operation === "object") {
          const operation = args.operation as Record<string, unknown>
          if (operation.type === "begin_webhook") return { state: "completed" }
          if (operation.type === "create_source_view") return operation.view
          if (operation.type === "update_source_view" || operation.type === "delete_source_view") return {
            ok: true,
            view: {
              id: operation.sourceViewId,
              ownerUserId: "durable_owner",
              version: operation.type === "update_source_view" ? Number(operation.expectedVersion) + 1 : operation.expectedVersion,
              teamConnectionId: "connection_1",
              provider: "github",
              providerUserId: operation.providerUserId ?? "octocat",
              filters: operation.filters ?? { repo: "claxedo/claxedo" },
              syncPolicy: operation.syncPolicy ?? "announce",
              status: operation.status ?? "paused",
              createdAt: 10,
              updatedAt: operation.updatedAt ?? 11,
            },
          }
          if (operation.type === "transition_candidate") return {
            ok: true,
            candidate: {
              candidateKind: "session",
              id: operation.candidateId,
              ownerUserId: "durable_owner",
              version: Number(operation.expectedVersion) + 1,
              sessionId: "session_1",
              title: "Independent brainstorm",
              body: "Decisions and remaining work",
              state: operation.to,
              createdAt: 100,
              updatedAt: operation.updatedAt,
            },
          }
        }
        return { ok: true, operationId: args.operation_id, cursor: "1", value: { streamId: `stream_${args.owner_subject}` } }
      },
      query: async (_fn, args) => {
        calls.push(args)
        if (args.connectionId === "connection_1" && !("query" in args)) return {
          id: "connection_1",
          integrationId: "github",
          capabilities: ["work-source"],
          status: "connected",
          orgId: "org_internal_a",
        }
        if (args.query && typeof args.query === "object") {
          const query = args.query as Record<string, unknown>
          if (query.kind === "source_views") return { sourceViews: [] }
          if (query.kind === "source_view") return {
            id: query.sourceViewId,
            ownerUserId: "durable_owner",
            version: 1,
            teamConnectionId: "connection_1",
            provider: "github",
            providerUserId: "octocat",
            filters: { repo: "claxedo/claxedo", state: "open" },
            syncPolicy: "announce",
            status: "active",
            createdAt: 10,
            updatedAt: 10,
          }
          if (query.kind === "candidates" || query.kind === "candidate_page") return { candidates: [{
            candidateKind: "session",
            id: "session_intake_session_1",
            ownerUserId: "durable_owner",
            version: 1,
            sessionId: "session_1",
            title: "Independent brainstorm",
            body: "Decisions and remaining work",
            observedRevision: "100",
            state: "unorganized",
            createdAt: 100,
            updatedAt: 100,
          }], ...(query.kind === "candidate_page" ? { hasMore: false } : {}) }
          if (query.kind === "connection") return {
            id: query.connectionId,
            ownerUserId: "durable_owner",
            orgId: "org_internal_a",
            integrationId: "github",
            capabilities: ["work-source"],
            status: "connected",
            tokenType: "bearer",
          }
        }
        return { snapshotCursor: "0", records: [], references: [], hasMore: false, capturedAt: 1 }
      },
    },
  })
}

test("hosted composition exposes its injected owner-scoped execution capability port", async () => {
  const workgraph = composition([], undefined, undefined, undefined, {
    read: async (context) => ({
      schemaVersion: 1,
      ownerUserId: context.ownerUserId,
      observedAt: 1,
      environments: [{
        kind: "hosted_workspace",
        repositoryRequired: false,
        remoteUrlInput: true,
        baseRevisionInput: true,
        isolation: ["stream"],
        cleanup: ["destroy_on_close"],
        integration: ["manual"],
      }],
      harnesses: [{ id: "opencode" }],
      agents: [{ harnessId: "opencode", id: "build", label: "build" }],
      models: [],
      tools: [{ harnessId: "opencode", id: "terminal" }],
      repository: { baseRevisions: [] },
      connections: [],
    }),
  })

  const response = await workgraph.router.request("/execution-capabilities", {
    headers: { authorization: "Bearer user_a" },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ownerUserId: "user_a", environments: [{ kind: "hosted_workspace" }] })
})

describe("hosted WorkGraph composition", () => {
  test("permanently deletes owner state only after hosted child and envelope cleanup", async () => {
    const calls: Record<string, unknown>[] = []
    const cleanup: string[] = []
    const workgraph = composition(calls, undefined, undefined, {
      destroy: vi.fn(async (workspaceId: string) => {
        cleanup.push(`destroy:${workspaceId}`)
        return { ok: true as const, status: "destroyed" as const }
      }),
      release: vi.fn(async (workspaceId: string) => {
        cleanup.push(`release:${workspaceId}`)
        return { released: true }
      }),
    } as unknown as SandboxManager)

    const response = await workgraph.router.request("/owner", {
      method: "DELETE",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "delete_owner_a" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deleted: true, recordCount: 7, workspaceCount: 1, completedAt: 101 })
    expect(cleanup).toEqual([
      "destroy:child_a",
      "release:child_a",
      "destroy:envelope_a",
      "release:envelope_a",
    ])
    expect(calls).toContainEqual(expect.objectContaining({
      service_token: "service-secret",
      owner_subject: "user_a",
      operation_id: "delete_owner_a",
      target_snapshot_hash: "target_hash_a",
    }))
  })

  test("requires signed auth and derives the personal owner from the verified subject", async () => {
    const calls: Record<string, unknown>[] = []
    const workgraph = composition(calls)
    const unauthorized = await workgraph.router.request("/snapshot?limit=10")
    expect(unauthorized.status).toBe(401)

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "op_a", command: { version: 1, type: "create_stream", title: "Mine" } }),
    })
    expect(response.status).toBe(200)
    expect(calls[0]).toMatchObject({
      service_token: "service-secret",
      owner_subject: "user_a",
      actor_type: "agent",
      actor_id: "user_a",
      request_id: "request-hosted",
    })
  })

  test("accepts Connection-verified provider callbacks without requiring Clerk auth", async () => {
    const calls: Record<string, unknown>[] = []
    const verify = vi.fn(async () => ({
      connectionId: "connection_1",
      provider: "github",
      deliveryId: "delivery_1",
      event: "issues",
      attributes: { repo: "claxedo/cloud" },
      receivedAt: 1,
    }))
    const workgraph = composition(calls, { verify })
    const response = await workgraph.router.request("/webhooks/github/connection_1", {
      method: "POST",
      body: "{}",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: false, reason: "already_processed", refreshed: 0 })
    expect(verify).toHaveBeenCalledOnce()
    expect(calls).toContainEqual(expect.objectContaining({
      service_token: "service-secret",
      operation: expect.objectContaining({ type: "begin_webhook", connectionId: "connection_1" }),
    }))
  })

  test("automatically composes the GitHub verifier from encrypted org credentials", async () => {
    const calls: Record<string, unknown>[] = []
    const secret = "hosted-webhook-secret"
    const body = JSON.stringify({ repository: { full_name: "claxedo/cloud" } })
    const orgs: string[] = []
    const workgraph = composition(calls, undefined, (orgId) => {
      orgs.push(orgId)
      return credentialStore(secret)
    })
    const response = await workgraph.router.request("/webhooks/github/connection_1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-hosted",
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: false, reason: "already_processed", refreshed: 0 })
    expect(orgs).toEqual(["org_internal_a"])
    expect(calls).toContainEqual({ service_token: "service-secret", connectionId: "connection_1" })
    expect(calls).toContainEqual(expect.objectContaining({
      operation: expect.objectContaining({ type: "begin_webhook", connectionId: "connection_1" }),
    }))
  })

  test("never accepts an owner selector and keeps two signed users isolated", async () => {
    const calls: Record<string, unknown>[] = []
    const workgraph = composition(calls)
    await Promise.all(["user_a", "user_b"].map((user) => workgraph.router.request("/snapshot?limit=10", {
      headers: { authorization: `Bearer ${user}` },
    })))
    expect(calls.map((call) => call.owner_subject).sort()).toEqual(["user_a", "user_b"])
    expect(calls.every((call) => !("ownerUserId" in call))).toBe(true)
  })

  test("mounts Convex-backed hosted Source View and independent Session intake routes", async () => {
    const calls: Record<string, unknown>[] = []
    const workgraph = composition(calls)
    const headers = { authorization: "Bearer user_a" }

    const candidates = await workgraph.router.request("/intake?limit=25", { headers })
    expect(candidates.status).toBe(200)
    expect(await candidates.json()).toEqual({ candidates: [{
      candidateKind: "session",
      id: "session_intake_session_1",
      ownerUserId: "user_a",
      version: 1,
      sessionId: "session_1",
      title: "Independent brainstorm",
      body: "Decisions and remaining work",
      observedRevision: "100",
      state: "unorganized",
      createdAt: 100,
      updatedAt: 100,
    }], hasMore: false })

    const created = await workgraph.router.request("/source-views", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        teamConnectionId: "connection_1",
        provider: "github",
        providerUserId: "octocat",
        filters: { repo: "claxedo/claxedo", state: "open" },
      }),
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      ownerUserId: "user_a",
      teamConnectionId: "connection_1",
      provider: "github",
      providerUserId: "octocat",
    })
    const updated = await workgraph.router.request("/source-views/source_view_1", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, providerUserId: "octocat", filters: { repo: "claxedo/claxedo" }, syncPolicy: "announce", status: "paused" }),
    })
    const dismissed = await workgraph.router.request("/intake/session_intake_session_1/dismiss", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    })
    const restored = await workgraph.router.request("/intake/session_intake_session_1/restore", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    })
    const deleted = await workgraph.router.request("/source-views/source_view_1", {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    })
    expect([updated.status, dismissed.status, restored.status, deleted.status]).toEqual([200, 200, 200, 200])
    expect(await updated.json()).toMatchObject({ version: 2, status: "paused" })
    expect(await dismissed.json()).toMatchObject({ version: 2, state: "dismissed" })
    expect(await restored.json()).toMatchObject({ version: 3, state: "unorganized" })
    expect(calls).toContainEqual(expect.objectContaining({
      service_token: "service-secret",
      owner_subject: "user_a",
      query: { kind: "connection", clerkOrgId: "clerk_org_a", connectionId: "connection_1" },
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      operation: expect.objectContaining({ type: "create_source_view", orgId: "org_internal_a" }),
    }))
    expect(calls).toContainEqual(expect.objectContaining({ operation: expect.objectContaining({ type: "update_source_view", expectedVersion: 1 }) }))
    expect(calls).toContainEqual(expect.objectContaining({ operation: expect.objectContaining({ type: "transition_candidate", from: "unorganized", to: "dismissed" }) }))
    expect(calls).toContainEqual(expect.objectContaining({ operation: expect.objectContaining({ type: "delete_source_view", expectedVersion: 2 }) }))
  })

  test("fails closed when Cloud persistence credentials are absent", () => {
    expect(() => createHostedWorkGraph({ env: {}, authConfig })).toThrow("Hosted WorkGraph requires Convex storage")
    expect(() => createHostedWorkGraph({
      env: { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test" },
      authConfig,
    })).toThrow("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN")
  })
})

function credentialStore(secret: string): ControlPlaneCredentials {
  return {
    listCredentials: async () => [],
    getCredentialByProvider: async () => undefined,
    resolveCredentialSecret: async (providerId) =>
      providerId === "integration:connection_1:webhook-signing" ? secret : null,
    putCredential: async () => { throw new Error("unused") },
    deleteCredential: async () => false,
    deleteCredentialsByProvider: async () => 0,
    updateCredentialStatus: async () => undefined,
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}
