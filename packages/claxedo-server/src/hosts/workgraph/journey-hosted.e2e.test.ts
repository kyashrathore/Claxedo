import { afterEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import type { ClaxedoEvent } from "../../lib/bus"
import type { LiveSyncRoomNamespace } from "../../deployments/hosted-workerd/live-sync-room.cf"
import type { WorkspaceAuthority } from "../../authority/authority"
import { hostedOrgCredentials } from "../../authority/worker-credentials"
import schema from "../../../../../convex/schema"
import { api } from "../../../../../convex/_generated/api"
import { createHostedWorkGraph } from "./hosted"
import { createHostedConnectionOperationExecutor } from "./hosted-connection-operation"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("../../../../../convex/**/*.ts")

/**
 * The hosted credential env the REAL `hostedOrgCredentials` composition
 * demands. Only the Cloudflare KV *transport* is faked below (`kvFetch`); the
 * envelope encryption, per-org HKDF partition, ref scheme, and status gate are
 * all the production code paths.
 */
const HOSTED_CREDENTIAL_ENV = {
  CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
  CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1",
  CLAXEDO_CF_KV_URL: "https://kv.test",
  CLAXEDO_CF_KV_TOKEN: "kv-token",
  CLAXEDO_CREDENTIALS_KEK: Buffer.from("k".repeat(32)).toString("base64"),
} as const

/**
 * External boundary #1: the Cloudflare KV REST API and the GitHub REST API.
 * Everything Claxedo-owned in between stays real. `kv` holds ciphertext only —
 * the test asserts the plaintext credential never appears in it.
 */
function externalBoundary(github: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const kv = new Map<string, string>()
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET"
    if (url.startsWith("https://kv.test/")) {
      const key = decodeURIComponent(url.slice("https://kv.test/values/".length))
      if (method === "PUT") {
        kv.set(key, input instanceof Request ? await input.text() : String(init?.body ?? ""))
        return new Response("{}")
      }
      if (method === "DELETE") {
        kv.delete(key)
        return new Response("{}")
      }
      const stored = kv.get(key)
      return stored === undefined ? new Response("", { status: 404 }) : new Response(stored)
    }
    calls.push(`${method} ${url}`)
    return await github(url, init)
  }) as unknown as typeof fetch
  return { kv, calls, fetchImpl }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("WorkGraph hosted headless journey", () => {
  test("concurrent HTTP commands commit through convex-test and publish monotonic doorbells", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "issuer|hosted-owner",
        clerk_subject: "hosted-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Hosted journey",
        clerk_org_id: "clerk_org_hosted",
        kind: "clerk",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      await ctx.db.insert("org_memberships", {
        org_id: organizationId,
        user_id: ownerUserId,
        role: "owner",
        created_at: 1,
        updated_at: 1,
      })
      return { organizationId, ownerUserId }
    })
    const nudges: Array<{ room: string; event: ClaxedoEvent }> = []
    const liveSyncRoom: LiveSyncRoomNamespace = {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          nudges.push({ room: String(id), event: (await request.json()) as ClaxedoEvent })
          return Response.json({ delivered: 1, held: 1 })
        },
      }),
    }
    const executor = convex as unknown as {
      mutation: (fn: unknown, args: unknown) => Promise<unknown>
      query: (fn: unknown, args: unknown) => Promise<unknown>
    }
    const workgraph = createHostedWorkGraph({
      env: {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      authConfig: {
        enabled: true,
        issuer: "https://clerk.test",
        jwksUrl: "https://clerk.test/jwks",
      },
      verifier: async () => ({
        mode: "signed",
        user: {
          subject: "hosted-owner",
          tokenIdentifier: "issuer|hosted-owner",
          issuer: "https://clerk.test",
          orgId: "clerk_org_hosted",
        },
      }),
      authority: {
        usersMe: async () => ({ user_id: String(tenant.ownerUserId) }),
        resolveOrgId: async () => String(tenant.organizationId),
      } as unknown as WorkspaceAuthority,
      requestId: () => crypto.randomUUID(),
      liveSyncRoom,
      executor: {
        mutation: (fn, args) => executor.mutation(fn, args),
        query: (fn, args) => executor.query(fn, args),
      },
    })

    const responses = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        workgraph.router.request("/commands", {
          method: "POST",
          headers: { authorization: "Bearer hosted-owner", "content-type": "application/json" },
          body: JSON.stringify({
            operationId: `hosted-command-${index}`,
            command: { version: 1, type: "create_stream", title: `Hosted Stream ${index}` },
          }),
        }),
      ),
    )
    expect(responses.every((response) => response.status === 200)).toBe(true)
    await expect.poll(() => nudges.length).toBe(16)
    expect(new Set(nudges.map((nudge) => nudge.room))).toEqual(new Set([`org:${String(tenant.organizationId)}`]))
    const cursors = nudges.map((nudge) => (nudge.event.type === "workgraph.changed" ? nudge.event.cursor : ""))
    expect(cursors.every(Boolean)).toBe(true)
    expect(new Set(cursors).size).toBe(16)

    const snapshot = await workgraph.router.request("/snapshot?limit=100", {
      headers: { authorization: "Bearer hosted-owner" },
    })
    expect(snapshot.status).toBe(200)
    expect(((await snapshot.json()) as { records: Array<{ recordType: string }> }).records.filter((record) => record.recordType === "stream")).toHaveLength(16)
  })

  test("a Connection-bound master Run opens a pull request and lands a durable receipt without leaking the credential", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "issuer|hosted-owner",
        clerk_subject: "hosted-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Hosted connection journey",
        clerk_org_id: "clerk_org_hosted",
        kind: "clerk",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      await ctx.db.insert("org_memberships", {
        org_id: organizationId,
        user_id: ownerUserId,
        role: "owner",
        created_at: 1,
        updated_at: 1,
      })
      return { organizationId, ownerUserId }
    })
    const nudges: Array<{ room: string; event: ClaxedoEvent }> = []
    const liveSyncRoom: LiveSyncRoomNamespace = {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          nudges.push({ room: String(id), event: (await request.json()) as ClaxedoEvent })
          return Response.json({ delivered: 1, held: 1 })
        },
      }),
    }
    const executor = convex as unknown as {
      mutation: (fn: unknown, args: unknown) => Promise<unknown>
      query: (fn: unknown, args: unknown) => Promise<unknown>
    }
    const workgraph = createHostedWorkGraph({
      env: {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      authConfig: {
        enabled: true,
        issuer: "https://clerk.test",
        jwksUrl: "https://clerk.test/jwks",
      },
      verifier: async () => ({
        mode: "signed",
        user: {
          subject: "hosted-owner",
          tokenIdentifier: "issuer|hosted-owner",
          issuer: "https://clerk.test",
          orgId: "clerk_org_hosted",
        },
      }),
      authority: {
        usersMe: async () => ({ user_id: String(tenant.ownerUserId) }),
        resolveOrgId: async () => String(tenant.organizationId),
      } as unknown as WorkspaceAuthority,
      requestId: () => crypto.randomUUID(),
      liveSyncRoom,
      executor: {
        mutation: (fn, args) => executor.mutation(fn, args),
        query: (fn, args) => executor.query(fn, args),
      },
    })

    // Hop 1 — the org's secret-free Connection metadata is written by the REAL
    // `workgraphConnections.upsertMetadata` mutation through convex-test, so
    // the schema/index and the credential-shaped-value rejection are real.
    const connectionId = "connection-github-hosted"
    const metadata = await executor.mutation(api.workgraphConnections.upsertMetadata, {
      service_token: "service-secret",
      ownerUserId: tenant.ownerUserId,
      orgId: tenant.organizationId,
      connectionId,
      integrationId: "github",
      capabilities: ["code-host", "work-source"],
      status: "connected",
      accountLabel: "Claxedo GitHub",
      fields: { installation_id: "4242" },
      tokenType: "bearer",
    })
    expect(metadata).toMatchObject({ id: connectionId, integrationId: "github", status: "connected" })

    // Hop 2 — a Stream exists through the REAL authenticated command router,
    // and its master turn is armed exactly the way the hosted runtime arms it
    // (`master_${streamId}` / `ses_master_${streamId}`).
    const created = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer hosted-owner", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "hosted-connection-stream",
        command: { version: 1, type: "create_stream", title: "Ship the Connection journey" },
      }),
    })
    expect(created.status).toBe(200)
    const streamId = ((await created.json()) as { value: { streamId: string } }).value.streamId
    const runId = `master_${streamId}`
    const sessionId = `ses_master_${streamId}`
    const workspaceId = `workspace_${streamId}`
    await convex.run(async (ctx) => {
      const stream = await ctx.db.query("workgraph_streams")
        .withIndex("by_tenant_id", (query) => query.eq("organization_id", tenant.organizationId)
          .eq("owner_user_id", tenant.ownerUserId).eq("id", streamId))
        .unique()
      await ctx.db.patch(stream!._id, {
        master_status: { state: "acting", sessionId, message: "Opening the pull request", receiptRefs: [], updatedAt: 10 },
        execution_defaults: {
          ...(stream!.execution_defaults as Record<string, unknown>),
          connectionIds: [connectionId],
          tools: ["connection_code_host_open_pr"],
        },
      })
    })

    // Hop 3 — the REAL `bindRunConnections` mutation binds the Connection to
    // the master Run, enforcing the immutable Run profile against the row it
    // just read back.
    await expect(executor.mutation(api.workgraphConnections.bindRunConnections, {
      service_token: "service-secret",
      ownerUserId: tenant.ownerUserId,
      orgId: tenant.organizationId,
      runId,
      sessionId,
      workspaceId,
      connectionIds: [connectionId],
      tools: ["connection_code_host_open_pr"],
    })).resolves.toEqual({ bound: true })

    // Hop 4 — the REAL `resolveOperationBinding` query resolves that binding
    // for the exact identity, and returns null for every mismatched one.
    await expect(executor.query(api.workgraphConnections.resolveOperationBinding, {
      service_token: "service-secret",
      ownerUserId: tenant.ownerUserId,
      orgId: tenant.organizationId,
      runId,
      sessionId,
      workspaceId,
      connectionId,
      tool: "connection_code_host_open_pr",
    })).resolves.toMatchObject({
      context: { ownerUserId: String(tenant.ownerUserId), ownerPartition: `org:${String(tenant.organizationId)}` },
      streamId,
      connection: { id: connectionId, status: "connected" },
    })
    for (const mismatch of [
      { workspaceId: "workspace-other" },
      { sessionId: "ses_master_other" },
      { connectionId: "connection-other" },
      { tool: "connection_work_source_comment" },
    ]) {
      await expect(executor.query(api.workgraphConnections.resolveOperationBinding, {
        service_token: "service-secret",
        ownerUserId: tenant.ownerUserId,
        orgId: tenant.organizationId,
        runId,
        sessionId,
        workspaceId,
        connectionId,
        tool: "connection_code_host_open_pr",
        ...mismatch,
      })).resolves.toBeNull()
    }

    // Hop 5 — the REAL hosted executor, over the REAL broker and the REAL
    // hosted ConnectionsPort. Only the GitHub HTTP boundary and the org
    // credential store (Cloudflare KV) are replaced — both are true externals.
    const secret = "github_pat_hostedjourneysecret0001"
    const boundary = externalBoundary((url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`)
      if (url.endsWith("/repos/claxedo/app")) return Response.json({ private: true })
      return Response.json({ id: 4242, html_url: "https://github.com/claxedo/app/pull/4242", draft: false })
    })
    vi.stubGlobal("fetch", boundary.fetchImpl)
    // The credential is written through the REAL envelope-encrypted per-org
    // hosted store, so the executor's own `hostedOrgCredentials` lookup — not a
    // stub — is what opens it inside `withAuthorization`.
    await hostedOrgCredentials(String(tenant.organizationId), HOSTED_CREDENTIAL_ENV).putCredential({
      provider_id: `integration:${connectionId}`,
      kind: "api_key",
      source: "managed",
      secret,
    })
    expect(JSON.stringify([...boundary.kv.values()])).not.toContain(secret)
    const execute = createHostedConnectionOperationExecutor({
      env: HOSTED_CREDENTIAL_ENV,
      executor: {
        query: (fn, args) => executor.query(fn, args),
        mutation: (fn, args) => executor.mutation(fn, args),
      },
    })!
    const result = await execute({ ownerUserId: String(tenant.ownerUserId), orgId: String(tenant.organizationId) }, {
      version: 1,
      identity: { runId, sessionId, workspaceId, connectionId: connectionId as never },
      operation: {
        type: "open_pull_request",
        repository: "claxedo/app",
        head: "workgraph/connection-journey",
        base: "dev",
        title: "Ship the Connection journey",
        draft: false,
        publicRepository: true,
        idempotencyKey: `${streamId}:pr`,
      },
    })

    // Hop 6 — the durable outcome: a receipt + integration Evidence written by
    // the REAL `completePullRequestEffect`, read back through the REAL
    // authenticated Evidence route.
    expect(result).toMatchObject({
      type: "open_pull_request",
      pullRequestId: "4242",
      url: "https://github.com/claxedo/app/pull/4242",
    })
    const receiptId = (result as { durableEffectReceiptId?: string }).durableEffectReceiptId
    const evidenceId = (result as { evidenceId?: string }).evidenceId
    expect(receiptId).toMatch(/^receipt_pr_/)
    // The provider-verified private repository skips the public-PR hold, so the
    // effect proceeds without owner confirmation; the visibility lookup is a
    // real provider call, never the agent-supplied flag.
    expect(boundary.calls).toEqual([
      "GET https://api.github.com/repos/claxedo/app",
      "POST https://api.github.com/repos/claxedo/app/pulls",
    ])
    // The durable Evidence row itself is correct and receipt-linked.
    const stored = await convex.run(async (ctx) => ctx.db.query("workgraph_evidence")
      .withIndex("by_tenant_id", (query) => query.eq("organization_id", tenant.organizationId)
        .eq("owner_user_id", tenant.ownerUserId).eq("id", evidenceId!))
      .unique())
    expect(stored).toMatchObject({
      evidence_kind: "integration",
      stream_id: streamId,
      summary: "Opened pull request",
      reference: { kind: "integration", effect: "published", reference: "https://github.com/claxedo/app/pull/4242", durableEffectReceiptId: receiptId },
    })

    // Regression guard for a defect this journey found: the connection
    // pull-request writer (convex/workgraphConnections.ts persistPullRequest
    // Receipt) stores `summary` as a COLUMN but omits it from `reference`,
    // while `evidenceDto` built the DTO from `...row.reference` only — so the
    // required `summary` was undefined and every hosted PR Evidence row 500ed
    // on read. `evidenceDto` now sources `summary` from the column. Reverting
    // that one line turns this back into a 500.
    const evidence = await workgraph.router.request(`/evidence/${evidenceId}`, {
      headers: { authorization: "Bearer hosted-owner" },
    })
    expect(evidence.status).toBe(200)
    expect(await evidence.json()).toMatchObject({
      id: evidenceId,
      summary: "Opened pull request",
      kind: "integration",
      effect: "published",
      reference: "https://github.com/claxedo/app/pull/4242",
    })
    const durable = await convex.run(async (ctx) => ({
      receipts: await ctx.db.query("workgraph_durable_effect_receipts").collect(),
      outbox: await ctx.db.query("workgraph_outbox").collect(),
    }))
    expect(durable.receipts).toHaveLength(1)
    expect(durable.outbox.filter((row) => row.effect_type === "open_pull_request")).toMatchObject([{ status: "completed" }])

    // Hop 7 — no credential byte reaches any Convex row or any response the
    // owner can read. Metadata is secret-free by construction; this asserts it.
    const everything = await convex.run(async (ctx) => Promise.all(
      ["workgraph_connection_metadata", "workgraph_run_connection_bindings", "workgraph_outbox",
        "workgraph_durable_effect_receipts", "workgraph_evidence", "workgraph_events", "workgraph_changes",
      ].map((table) => ctx.db.query(table as "workgraph_events").collect()),
    ))
    expect(JSON.stringify(everything)).not.toContain(secret)
    const snapshot = await workgraph.router.request("/snapshot?limit=100", {
      headers: { authorization: "Bearer hosted-owner" },
    })
    expect(await snapshot.text()).not.toContain(secret)
  })

  test("a failing provider compensates the claimed pull-request effect and holds the first public PR for the owner", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "issuer|hosted-owner",
        clerk_subject: "hosted-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Hosted compensation journey",
        clerk_org_id: "clerk_org_hosted",
        kind: "clerk",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      await ctx.db.insert("org_memberships", {
        org_id: organizationId,
        user_id: ownerUserId,
        role: "owner",
        created_at: 1,
        updated_at: 1,
      })
      return { organizationId, ownerUserId }
    })
    const liveSyncRoom: LiveSyncRoomNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => Response.json({ delivered: 1, held: 1 }) }),
    }
    const executor = convex as unknown as {
      mutation: (fn: unknown, args: unknown) => Promise<unknown>
      query: (fn: unknown, args: unknown) => Promise<unknown>
    }
    const workgraph = createHostedWorkGraph({
      env: {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      authConfig: {
        enabled: true,
        issuer: "https://clerk.test",
        jwksUrl: "https://clerk.test/jwks",
      },
      verifier: async () => ({
        mode: "signed",
        user: {
          subject: "hosted-owner",
          tokenIdentifier: "issuer|hosted-owner",
          issuer: "https://clerk.test",
          orgId: "clerk_org_hosted",
        },
      }),
      authority: {
        usersMe: async () => ({ user_id: String(tenant.ownerUserId) }),
        resolveOrgId: async () => String(tenant.organizationId),
      } as unknown as WorkspaceAuthority,
      requestId: () => crypto.randomUUID(),
      liveSyncRoom,
      executor: {
        mutation: (fn, args) => executor.mutation(fn, args),
        query: (fn, args) => executor.query(fn, args),
      },
    })
    const connectionId = "connection-github-hosted"
    await executor.mutation(api.workgraphConnections.upsertMetadata, {
      service_token: "service-secret",
      ownerUserId: tenant.ownerUserId,
      orgId: tenant.organizationId,
      connectionId,
      integrationId: "github",
      capabilities: ["code-host"],
      status: "connected",
      tokenType: "bearer",
    })
    const created = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer hosted-owner", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "hosted-compensation-stream",
        command: { version: 1, type: "create_stream", title: "Compensate a failed pull request" },
      }),
    })
    expect(created.status).toBe(200)
    const streamId = ((await created.json()) as { value: { streamId: string } }).value.streamId
    const runId = `master_${streamId}`
    const sessionId = `ses_master_${streamId}`
    const workspaceId = `workspace_${streamId}`
    await convex.run(async (ctx) => {
      const stream = await ctx.db.query("workgraph_streams")
        .withIndex("by_tenant_id", (query) => query.eq("organization_id", tenant.organizationId)
          .eq("owner_user_id", tenant.ownerUserId).eq("id", streamId))
        .unique()
      await ctx.db.patch(stream!._id, {
        master_status: { state: "acting", sessionId, message: "Opening the pull request", receiptRefs: [], updatedAt: 10 },
        execution_defaults: {
          ...(stream!.execution_defaults as Record<string, unknown>),
          connectionIds: [connectionId],
          tools: ["connection_code_host_open_pr"],
        },
      })
    })
    await executor.mutation(api.workgraphConnections.bindRunConnections, {
      service_token: "service-secret",
      ownerUserId: tenant.ownerUserId,
      orgId: tenant.organizationId,
      runId,
      sessionId,
      workspaceId,
      connectionIds: [connectionId],
      tools: ["connection_code_host_open_pr"],
    })
    const secret = "github_pat_hostedjourneysecret0002"
    // One REAL envelope-encrypted credential and one REAL external boundary
    // serve both phases; `repositoryPrivate`/`createStatus` steer the provider.
    let createStatus = 201
    const boundary = externalBoundary((url) => url.endsWith("/repos/claxedo/app")
      ? Response.json({ private: false })
      : new Response("nope", { status: createStatus }))
    vi.stubGlobal("fetch", boundary.fetchImpl)
    await hostedOrgCredentials(String(tenant.organizationId), HOSTED_CREDENTIAL_ENV).putCredential({
      provider_id: `integration:${connectionId}`,
      kind: "api_key",
      source: "managed",
      secret,
    })
    const operation = {
      version: 1 as const,
      identity: { runId, sessionId, workspaceId, connectionId: connectionId as never },
      operation: {
        type: "open_pull_request" as const,
        repository: "claxedo/app",
        head: "workgraph/compensation",
        base: "dev",
        title: "Compensate a failed pull request",
        draft: false,
        publicRepository: true,
        idempotencyKey: `${streamId}:pr`,
      },
    }

    // A PUBLIC repository, provider-verified, is held at the durable
    // authorization gate: the REAL `authorizePullRequest` mutation escalates
    // the master to Needs-you and denies, before any credential is opened.
    const execute = createHostedConnectionOperationExecutor({
      env: HOSTED_CREDENTIAL_ENV,
      executor: { query: (fn, args) => executor.query(fn, args), mutation: (fn, args) => executor.mutation(fn, args) },
    })!
    await expect(execute(
      { ownerUserId: String(tenant.ownerUserId), orgId: String(tenant.organizationId) },
      operation,
    )).rejects.toMatchObject({ code: "connection_operation_denied" })
    const held = await convex.run(async (ctx) => ctx.db.query("workgraph_streams")
      .withIndex("by_tenant_id", (query) => query.eq("organization_id", tenant.organizationId)
        .eq("owner_user_id", tenant.ownerUserId).eq("id", streamId))
      .unique())
    expect(held?.master_status).toMatchObject({ state: "attention", escalation: "public_pr_confirmation" })
    expect(await convex.run(async (ctx) => ctx.db.query("workgraph_outbox").collect())).toEqual([])

    // The owner confirms, then the provider rejects the create. The REAL
    // `failPullRequestEffect` compensation must release the claimed lease
    // instead of stranding it, and no receipt may exist.
    const version = held!.row_version
    const confirmed = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer hosted-owner", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "hosted-compensation-confirm",
        command: { version: 1, type: "confirm_public_pr", streamId, expectedVersion: version },
      }),
    })
    expect(confirmed.status).toBe(200)
    await convex.run(async (ctx) => {
      const stream = await ctx.db.query("workgraph_streams")
        .withIndex("by_tenant_id", (query) => query.eq("organization_id", tenant.organizationId)
          .eq("owner_user_id", tenant.ownerUserId).eq("id", streamId))
        .unique()
      await ctx.db.patch(stream!._id, {
        master_status: { state: "acting", sessionId, message: "Opening the pull request", receiptRefs: [], updatedAt: 20 },
      })
    })
    createStatus = 500
    await expect(execute(
      { ownerUserId: String(tenant.ownerUserId), orgId: String(tenant.organizationId) },
      operation,
    )).rejects.toMatchObject({ code: "connection_provider_rejected" })
    const compensated = await convex.run(async (ctx) => ({
      outbox: await ctx.db.query("workgraph_outbox").collect(),
      receipts: await ctx.db.query("workgraph_durable_effect_receipts").collect(),
    }))
    expect(compensated.receipts).toEqual([])
    expect(compensated.outbox).toMatchObject([{
      effect_type: "open_pull_request",
      status: "pending",
      last_error: "Pull request provider operation failed",
    }])
    // The lease is genuinely released, not merely re-labelled.
    expect(compensated.outbox[0]).not.toHaveProperty("claimed_by")
    expect(compensated.outbox[0]).not.toHaveProperty("claim_expires_at")
    expect(JSON.stringify(compensated)).not.toContain(secret)
  })
})
