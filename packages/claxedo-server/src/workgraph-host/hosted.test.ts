import { createHmac } from "node:crypto"
import { describe, expect, test, vi } from "vitest"
import type { ConnectionWebhookVerifier } from "@claxedo/connections"
import type { ControlPlaneCredentials } from "../control-plane/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { ExecutionCapabilitiesUnavailableError, type ExecutionCapabilitiesPort } from "@claxedo/workgraph/ports"
import {
  createChangeCursor,
  EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
  type CommandResult,
} from "@claxedo/workgraph/contracts"
import type { SignedControlPlaneAuth } from "../control-plane/auth"
import type { WorkspaceAuthority } from "../control-plane/authority"
import { createHostedWorkGraph } from "./hosted"
import type { SettlementDispatcher } from "./settlement-dispatcher"
import type { ClaxedoEvent } from "../bus"
import type { LiveSyncRoomNamespace } from "../live-sync-room"

// Records every nudge POSTed to a room without a live Workers runtime: mirrors
// the DO namespace contract (deterministic idFromName, per-name stub) and parses
// the nudge body so a test can assert the exact room + event a command fired.
function recordingLiveSyncNamespace() {
  const nudges: Array<{ room: string; event: ClaxedoEvent }> = []
  const namespace: LiveSyncRoomNamespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (request: Request) => {
        const event = (await request.json()) as ClaxedoEvent
        nudges.push({ room: id as string, event })
        return Response.json({ delivered: 1, held: 1 })
      },
    }),
  }
  return { namespace, nudges }
}

const authConfig = { enabled: true as const, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" }

function composition(
  calls: Record<string, unknown>[],
  webhookVerifier?: ConnectionWebhookVerifier,
  webhookCredentials?: (orgId: string) => ControlPlaneCredentials,
  sandboxManager?: SandboxManager,
  executionCapabilities?: ExecutionCapabilitiesPort,
  now?: () => number,
  options?: Readonly<{
    capabilityReadWait?: Readonly<{ attempts: number; intervalMs: number }>
    /** Share one durable attestation store across compositions ("isolates"). */
    attested?: { value?: unknown }
    dispatcher?: SettlementDispatcher
    commandResult?: CommandResult
    commandError?: Error
    liveSyncRoom?: LiveSyncRoomNamespace
    waitUntilForRequest?: (request: Request) => ((promise: Promise<unknown>) => void) | undefined
  }>,
) {
  const attested = options?.attested ?? {}
  return createHostedWorkGraph({
    capabilityReadWait: options?.capabilityReadWait ?? { attempts: 1, intervalMs: 1 },
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
    authority: {
      usersMe: async (auth: SignedControlPlaneAuth) => ({ user_id: `internal_${auth.user.subject}` }),
      resolveOrgId: async (auth: SignedControlPlaneAuth) =>
        auth.user.orgId === "clerk_org_b" ? "org_internal_b" : "org_internal_a",
    } as unknown as WorkspaceAuthority,
    ...(webhookVerifier ? { webhookVerifier } : {}),
    ...(webhookCredentials ? { webhookCredentials } : {}),
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(executionCapabilities ? { executionCapabilities } : {}),
    ...(now ? { now } : {}),
    ...(options?.dispatcher ? { settlementDispatcher: options.dispatcher } : {}),
    ...(options?.liveSyncRoom ? { liveSyncRoom: options.liveSyncRoom } : {}),
    ...(options?.waitUntilForRequest ? { waitUntilForRequest: options.waitUntilForRequest } : {}),
    executor: {
      mutation: async (_fn, args) => {
        calls.push(args)
        if (args.actor_type && options?.commandError) throw options.commandError
        if (args.actor_type && options?.commandResult) return options.commandResult
        if (args.capabilities) {
          attested.value = args.capabilities
          return { attested: true }
        }
        if (args.renew_only) return { ok: true, state: "renewed" }
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
        if (
          args.organization_id &&
          args.owner_subject &&
          args.now !== undefined &&
          Object.keys(args).length === 4
        ) return attested.value ?? null
        if (args.connectionId === "connection_1" && !("query" in args)) return {
          id: "connection_1",
          integrationId: "github",
          capabilities: ["work-source"],
          status: "connected",
          orgId: "org_internal_a",
        }
        if (args.query && typeof args.query === "object") {
          const query = args.query as Record<string, unknown>
          if (query.kind === "attention") return internalOwnerAttentionPage()
          if (query.kind === "changes") return internalOwnerChanges()
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

test("hosted capability GET reads only the persisted attestation and explicit refresh discovers and attests", async () => {
  const calls: Record<string, unknown>[] = []
  const discover = vi.fn(async (context: Parameters<ExecutionCapabilitiesPort["read"]>[0]) =>
    capabilityCatalog(context))
  const workgraph = composition(calls, undefined, undefined, undefined, {
    read: discover,
    refresh: discover,
  })

  const unavailable = await workgraph.router.request("/execution-capabilities", {
    headers: { authorization: "Bearer user_a" },
  })
  expect({ status: unavailable.status, body: await unavailable.text(), calls }).toMatchObject({ status: 503 })
  expect(discover).not.toHaveBeenCalled()
  expect(calls).toEqual([expect.objectContaining({
    service_token: "service-secret",
    organization_id: "org_internal_a",
    owner_subject: "user_a",
  })])

  calls.length = 0
  const refreshed = await workgraph.router.request("/execution-capabilities/refresh", {
    method: "POST",
    headers: { authorization: "Bearer user_a" },
  })
  expect(refreshed.status).toBe(200)
  expect(discover).toHaveBeenCalledTimes(1)
  expect(calls).toEqual([expect.objectContaining({
    service_token: "service-secret",
    organization_id: "org_internal_a",
    owner_subject: "user_a",
    capabilities: expect.objectContaining({ ownerUserId: "user_a" }),
  })])

  calls.length = 0
  const response = await workgraph.router.request("/execution-capabilities", {
    headers: { authorization: "Bearer user_a" },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ownerUserId: "user_a", environments: [{ kind: "hosted_workspace" }] })
  expect(discover).toHaveBeenCalledTimes(1)
  expect(calls).toEqual([expect.objectContaining({
    service_token: "service-secret",
    organization_id: "org_internal_a",
    owner_subject: "user_a",
  })])
})

test("hosted capability GET joins the signed owner activation already started by bootstrap", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const discover = vi.fn(async (context: Parameters<ExecutionCapabilitiesPort["read"]>[0]) => {
    await gate
    return capabilityCatalog(context)
  })
  const workgraph = composition([], undefined, undefined, undefined, {
    read: discover,
    refresh: discover,
  })

  const activation = workgraph.activateOwner(signedAuth("user_a"))
  await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1))
  let responseSettled = false
  const response = Promise.resolve(workgraph.router.request("/execution-capabilities", {
    headers: { authorization: "Bearer user_a" },
  })).then((value) => {
    responseSettled = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(responseSettled).toBe(false)
  release()

  await expect(activation).resolves.toEqual({ status: "ready" })
  await expect(response.then(async (value) => ({ status: value.status, body: await value.json() }))).resolves.toMatchObject({
    status: 200,
    body: { ownerUserId: "user_a", environments: [{ kind: "hosted_workspace" }] },
  })
  expect(discover).toHaveBeenCalledTimes(1)
})

test("hosted capability GET waits for the attestation published by an activation in another isolate", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const discover = vi.fn(async (context: Parameters<ExecutionCapabilitiesPort["read"]>[0]) => {
    await gate
    return capabilityCatalog(context)
  })
  const attested: { value?: unknown } = {}
  const bootstrapIsolate = composition([], undefined, undefined, undefined, { read: discover, refresh: discover }, undefined, { attested })
  const readIsolate = composition([], undefined, undefined, undefined, { read: discover, refresh: discover }, undefined, {
    attested,
    capabilityReadWait: { attempts: 200, intervalMs: 2 },
  })

  let responseSettled = false
  const response = Promise.resolve(readIsolate.router.request("/execution-capabilities", {
    headers: { authorization: "Bearer user_a" },
  })).then((value) => {
    responseSettled = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(responseSettled).toBe(false)

  const activation = bootstrapIsolate.activateOwner(signedAuth("user_a"))
  release()
  await expect(activation).resolves.toEqual({ status: "ready" })

  await expect(response.then(async (value) => ({ status: value.status, body: await value.json() }))).resolves.toMatchObject({
    status: 200,
    body: { ownerUserId: "user_a", environments: [{ kind: "hosted_workspace" }] },
  })
  expect(discover).toHaveBeenCalledTimes(1)
})

test("hosted capability GET rejects an expired attestation and explicit refresh records a new revision", async () => {
  let now = 1_000
  let revision = 0
  const source: ExecutionCapabilitiesPort = {
    read: async (context) => capabilityCatalog(context, now, `${revision}`.repeat(64)),
    refresh: async (context) => capabilityCatalog(context, now, `${++revision}`.repeat(64)),
  }
  const workgraph = composition([], undefined, undefined, undefined, source, () => now)

  const first = await workgraph.router.request("/execution-capabilities/refresh", {
    method: "POST",
    headers: { authorization: "Bearer user_a" },
  })
  const firstBody = await first.json()
  expect({ status: first.status, body: firstBody }).toMatchObject({
    status: 200,
    body: { catalogRevision: "1".repeat(64) },
  })

  now += EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS
  const stale = await workgraph.router.request("/execution-capabilities", {
    headers: { authorization: "Bearer user_a" },
  })
  expect(stale.status).toBe(503)
  expect(await stale.json()).toMatchObject({
    error: { code: "execution_capabilities_unavailable", retryable: true },
  })

  const refreshed = await workgraph.router.request("/execution-capabilities/refresh", {
    method: "POST",
    headers: { authorization: "Bearer user_a" },
  })
  expect(refreshed.status).toBe(200)
  expect((await refreshed.json()).catalogRevision).toBe("2".repeat(64))
})

test("signed owner activation coalesces idempotent capability setup and derives the owner from auth", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const refresh = vi.fn(async (context) => {
    await gate
    const observedAt = Date.now()
    return {
      schemaVersion: 1 as const,
      organizationId: context.organizationId,
      ownerUserId: context.ownerUserId,
      catalogRevision: "e".repeat(64),
      observedAt,
      expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
      environments: [],
      harnesses: [],
      agents: [],
      models: [],
      tools: [],
      repository: { baseRevisions: [] },
      connections: [],
    }
  })
  const workgraph = composition([], undefined, undefined, undefined, {
    read: refresh,
    refresh,
  })
  const auth = signedAuth("owner_a")
  const first = workgraph.activateOwner(auth)
  const second = workgraph.activateOwner(auth)
  release()
  await expect(Promise.all([first, second])).resolves.toEqual([{ status: "ready" }, { status: "ready" }])
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(refresh.mock.calls[0]![0]).toMatchObject({ organizationId: "org_internal_a", ownerUserId: "owner_a", access: { mode: "owner" } })
})

test("owner activation isolates the same user across trusted organizations", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const refresh = vi.fn(async (context: Parameters<ExecutionCapabilitiesPort["read"]>[0]) => {
    await gate
    return capabilityCatalog(context)
  })
  const workgraph = composition([], undefined, undefined, undefined, { read: refresh, refresh })

  const first = workgraph.activateOwner(signedAuth("owner_a", "clerk_org_a"))
  const second = workgraph.activateOwner(signedAuth("owner_a", "clerk_org_b"))
  expect(first).not.toBe(second)
  release()
  await Promise.all([first, second])
  expect(refresh.mock.calls.map(([resolved]) => resolved)).toEqual(expect.arrayContaining([
    expect.objectContaining({ organizationId: "org_internal_a", ownerUserId: "owner_a" }),
    expect.objectContaining({ organizationId: "org_internal_b", ownerUserId: "owner_a" }),
  ]))
})

test("hosted capability attestation rejects a catalog from another organization", async () => {
  const calls: Record<string, unknown>[] = []
  const refresh = vi.fn(async (context: Parameters<ExecutionCapabilitiesPort["read"]>[0]) => ({
    ...capabilityCatalog(context),
    organizationId: "org_internal_b" as typeof context.organizationId,
  }))
  const workgraph = composition(calls, undefined, undefined, undefined, { read: refresh, refresh })

  await expect(workgraph.activateOwner(signedAuth("owner_a"))).resolves.toMatchObject({
    status: "failed",
    error: {
      code: "execution_capabilities_unavailable",
      capability: "runtime",
      reason: "runtime_unavailable",
      retryable: false,
    },
  })
  expect(calls).toEqual([])
})

test("signed owner activation reports typed pending state without substitute capabilities", async () => {
  const workgraph = composition([], undefined, undefined, undefined, {
    read: async () => {
      throw new Error("not read")
    },
    refresh: async () => {
      throw new ExecutionCapabilitiesUnavailableError(
        "catalog_workspace",
        "runtime_unavailable",
        "Catalog provisioning is still running",
        true,
      )
    },
  })
  await expect(workgraph.activateOwner(signedAuth("owner_a"))).resolves.toEqual({
    status: "pending",
    error: {
      code: "execution_capabilities_unavailable",
      capability: "catalog_workspace",
      reason: "runtime_unavailable",
      message: "Catalog provisioning is still running",
      retryable: true,
    },
  })
})

test("signed owner activation preserves unexpected failures and permits a clean retry", async () => {
  const refresh = vi.fn()
    .mockRejectedValueOnce(new Error("catalog runtime contract violated"))
    .mockImplementationOnce(async (context) => capabilityCatalog(context))
  const workgraph = composition([], undefined, undefined, undefined, {
    read: refresh,
    refresh,
  })
  const auth = signedAuth("owner_a")
  await expect(workgraph.activateOwner(auth)).rejects.toThrow("catalog runtime contract violated")
  await expect(workgraph.activateOwner(auth)).resolves.toEqual({ status: "ready" })
  expect(refresh).toHaveBeenCalledTimes(2)
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
      // The signed user's actor type crosses the service seam unchanged —
      // the former user→agent downgrade sent hosted user-created Tasks into
      // the approval gate and starved the continuous execution drain.
      actor_type: "user",
      actor_id: "user_a",
      request_id: "request-hosted",
    })
  })

  test("nudges settlement for the authenticated tenant after a successful delete command", async () => {
    const nudge = vi.fn()
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      dispatcher: { nudge },
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "delete_a",
        command: {
          version: 1,
          type: "delete_stream",
          streamId: "stream_a",
          expectedVersion: 1,
          reason: "Discard",
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(nudge).toHaveBeenCalledOnce()
    expect(nudge).toHaveBeenCalledWith({ organizationId: "org_internal_a", ownerUserId: "internal_user_a" })
  })

  test("also nudges the fast control lane for a control-effect command", async () => {
    const nudge = vi.fn()
    const nudgeControl = vi.fn()
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      dispatcher: { nudge, nudgeControl },
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "delete_a",
        command: { version: 1, type: "delete_stream", streamId: "stream_a", expectedVersion: 1, reason: "Discard" },
      }),
    })

    expect(response.status).toBe(200)
    expect(nudge).toHaveBeenCalledOnce()
    expect(nudgeControl).toHaveBeenCalledWith({ organizationId: "org_internal_a", ownerUserId: "internal_user_a" })
  })

  test("does not nudge the control lane for a non-control command", async () => {
    const nudge = vi.fn()
    const nudgeControl = vi.fn()
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      dispatcher: { nudge, nudgeControl },
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "op_a", command: { version: 1, type: "create_stream", title: "Mine" } }),
    })

    expect(response.status).toBe(200)
    expect(nudge).toHaveBeenCalledOnce()
    expect(nudgeControl).not.toHaveBeenCalled()
  })

  test("does not nudge settlement when a command returns a failure", async () => {
    const nudge = vi.fn()
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      dispatcher: { nudge },
      commandResult: {
        ok: false,
        operationId: "delete_failure" as never,
        error: { code: "validation_error", message: "Delete rejected", retryable: false },
      },
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "delete_failure",
        command: {
          version: 1,
          type: "delete_stream",
          streamId: "stream_a",
          expectedVersion: 1,
          reason: "Discard",
        },
      }),
    })

    expect(response.status).toBe(400)
    expect(nudge).not.toHaveBeenCalled()
  })

  test("does not nudge settlement when a command mutation throws", async () => {
    const nudge = vi.fn()
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      dispatcher: { nudge },
      commandError: new Error("persistence unavailable"),
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "create_failure",
        command: { version: 1, type: "create_stream", title: "Unavailable" },
      }),
    })

    expect(response.status).toBe(500)
    expect(nudge).not.toHaveBeenCalled()
  })

  test("returns the successful command response when the settlement dispatcher throws", async () => {
    const nudge = vi.fn(() => {
      throw new Error("dispatcher unavailable")
    })
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      dispatcher: { nudge },
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "create_a",
        command: { version: 1, type: "create_stream", title: "Still succeeds" },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      operationId: "create_a",
      cursor: "1",
      value: { streamId: "stream_user_a" },
    })
    expect(nudge).toHaveBeenCalledOnce()
  })

  test("W5.3: rings the caller's live-sync room with a workgraph.changed doorbell after a successful command", async () => {
    const { namespace, nudges } = recordingLiveSyncNamespace()
    // Capture the per-request waitUntil work so the test can deterministically
    // await the nudge fetch (the real Worker gets this from its ExecutionContext).
    const pending: Promise<unknown>[] = []
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      liveSyncRoom: namespace,
      waitUntilForRequest: () => (promise) => pending.push(promise),
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "create_a",
        command: { version: 1, type: "create_stream", title: "Ring the room" },
      }),
    })

    expect(response.status).toBe(200)
    await Promise.all(pending)
    // Room name is keyed off the AUTHORITY-INTERNAL org id the context already
    // resolved (`authority.resolveOrgId` → "org_internal_a"), matching how the
    // hosted events route keys the room the client's SSE stream is held in.
    // The Clerk org claim ("clerk_org_a" from the verifier) is a disjoint
    // namespace and must never name the room. The event's ownerUserId is the
    // Clerk subject so the room's per-connection eventVisibleTo narrows it to
    // the right user inside the shared org room.
    expect(nudges).toEqual([
      {
        room: "org:org_internal_a",
        event: { type: "workgraph.changed", ownerUserId: "user_a", ts: expect.any(Number) },
      },
    ])
  })

  test("W5.3: does not ring the live-sync room when a command fails", async () => {
    const { namespace, nudges } = recordingLiveSyncNamespace()
    const pending: Promise<unknown>[] = []
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      liveSyncRoom: namespace,
      waitUntilForRequest: () => (promise) => pending.push(promise),
      commandResult: {
        ok: false,
        operationId: "delete_failure" as never,
        error: { code: "validation_error", message: "Delete rejected", retryable: false },
      },
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "delete_failure",
        command: { version: 1, type: "delete_stream", streamId: "stream_a", expectedVersion: 1, reason: "Discard" },
      }),
    })

    expect(response.status).toBe(400)
    await Promise.all(pending)
    expect(nudges).toEqual([])
  })

  test("W5.3: a failing room nudge never fails the successful command", async () => {
    const failingNamespace: LiveSyncRoomNamespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ error: "room down" }, { status: 500 }) }),
    }
    const pending: Promise<unknown>[] = []
    const workgraph = composition([], undefined, undefined, undefined, undefined, undefined, {
      liveSyncRoom: failingNamespace,
      waitUntilForRequest: () => (promise) => pending.push(promise),
    })

    const response = await workgraph.router.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer user_a", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "create_a",
        command: { version: 1, type: "create_stream", title: "Still succeeds" },
      }),
    })

    expect(response.status).toBe(200)
    // The rejected nudge promise is caught internally; awaiting it must not throw.
    await expect(Promise.all(pending)).resolves.toBeDefined()
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

  test("projects internal Convex Attention ownership to the public owner through the full hosted router", async () => {
    const calls: Record<string, unknown>[] = []
    const workgraph = composition(calls)

    const response = await workgraph.router.request("/attention?limit=50", {
      headers: { authorization: "Bearer user_a" },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      items: [
        {
          kind: "work_item",
          ownerUserId: "user_a",
          record: { ownerUserId: "user_a" },
        },
      ],
      total: 1,
      hasMore: false,
    })
    expect(calls).toContainEqual(expect.objectContaining({
      service_token: "service-secret",
      organization_id: "org_internal_a",
      owner_subject: "user_a",
      query: { kind: "attention", limit: 50 },
    }))
  })

  // The `/changes` route is deleted; the Convex-backed change
  // log stays and is read in-process by settlement/wakes/audit, so this asserts the
  // hosted changes query directly instead of through the router.
  test("reads Convex deletion and admission-retry change events from the hosted change log", async () => {
    const workgraph = composition([])
    const context = await workgraph.resolveContext(
      new Request("https://hosted.test/api/workgraph", { headers: { authorization: "Bearer user_a" } }),
    )

    expect(await workgraph.service.queries.changes.list(context, { limit: 100 })).toMatchObject([
      { ownerUserId: "user_a", event: { type: "admission_planning_retried", ownerUserId: "user_a" } },
      { ownerUserId: "user_a", event: { type: "stream_deletion_requested", ownerUserId: "user_a" } },
    ])
    expect((await workgraph.router.request("/changes", { headers: { authorization: "Bearer user_a" } })).status).toBe(404)
  })

  test("never accepts an owner selector and keeps two signed users isolated", async () => {
    const calls: Record<string, unknown>[] = []
    const workgraph = composition(calls)
    await Promise.all(["user_a", "user_b"].map((user) => workgraph.router.request("/snapshot?limit=10", {
      headers: { authorization: `Bearer ${user}` },
    })))
    expect(calls.map((call) => call.owner_subject).sort()).toEqual(["user_a", "user_b"])
    expect(calls.every((call) => !("ownerUserId" in call))).toBe(true)

    const selected = await workgraph.router.request("/snapshot?limit=10&organizationId=org_internal_b", {
      headers: { authorization: "Bearer user_a" },
    })
    expect(selected.status).toBe(400)
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
      organization_id: "org_internal_a",
      owner_subject: "user_a",
      query: { kind: "connection", connectionId: "connection_1" },
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
    expect(() => createHostedWorkGraph({
      env: {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      authConfig,
    })).toThrow("trusted WorkspaceAuthority")
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

function internalOwnerChanges() {
  const cursor = (position: number) =>
    createChangeCursor({
      organizationId: "org_internal_a" as never,
      ownerUserId: "internal_user_id" as never,
      position,
    })
  const envelope = (position: number, type: string, resource: Record<string, unknown>, payload: Record<string, unknown>) => ({
    cursor: cursor(position),
    ownerUserId: "internal_user_id",
    resource,
    event: {
      schemaVersion: 1,
      id: `event_${position}`,
      ownerUserId: "internal_user_id",
      streamId: "stream_1",
      sequence: position,
      type,
      payload,
      provenance: {
        actor: { type: "system", id: "convex" },
        operationId: `operation_${position}`,
        requestId: `request_${position}`,
      },
      occurredAt: position,
    },
  })
  return [
    envelope(1, "admission_planning_retried", { type: "admission_proposal", id: "admission_1" }, { proposalId: "admission_1" }),
    envelope(2, "stream_deletion_requested", { type: "stream", id: "stream_1" }, { streamId: "stream_1" }),
  ]
}

function internalOwnerAttentionPage() {
  return {
    items: [
      {
        id: "work_item_1",
        ownerUserId: "internal_user_id",
        kind: "work_item",
        updatedAt: 5,
        record: {
          recordType: "work_item",
          schemaVersion: 1,
          ownerUserId: "internal_user_id",
          version: 1,
          createdAt: 1,
          updatedAt: 5,
          provenance: { actor: { type: "system", id: "convex" } },
          id: "work_item_1",
          streamId: "stream_1",
          title: "Review hosted result",
          state: "result_ready",
          priority: 0,
          dependencyIds: [],
          sourceRevisionRefs: [],
          completionContract: {
            version: 1,
            mode: "all",
            requirements: [{
              id: "review",
              kind: "owner_confirmation",
              description: "Owner accepts the hosted result",
            }],
          },
          evidenceIds: [],
        },
      },
    ],
    total: 1,
    hasMore: false,
  }
}

function signedAuth(subject: string, orgId = "clerk_org_a"): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: "token",
    user: {
      subject,
      tokenIdentifier: `https://clerk.test|${subject}`,
      issuer: "https://clerk.test",
      orgId,
    },
  }
}

function capabilityCatalog(
  context: Parameters<ExecutionCapabilitiesPort["read"]>[0],
  observedAt = Date.now(),
  catalogRevision = "d".repeat(64),
) {
  return {
    schemaVersion: 1 as const,
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    catalogRevision,
    observedAt,
    expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
    environments: [{
      kind: "hosted_workspace" as const,
      repositoryRequired: false,
      remoteUrlInput: true,
      baseRevisionInput: true,
    }],
    harnesses: [{ id: "opencode" }],
    agents: [{ harnessId: "opencode", id: "build", label: "build" }],
    models: [],
    tools: [{ harnessId: "opencode", id: "terminal" }],
    repository: { baseRevisions: [] },
    connections: [],
  }
}
