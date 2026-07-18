import { createHmac } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { afterEach, describe, expect, it } from "vitest"
import {
  createLocalEmbeddedWorkGraph,
  mountEmbeddedWorkGraph,
  mountLazyEmbeddedWorkGraph,
  requireLocalWorkGraphRepositoryDirectory,
  type LocalWorkGraphAuthOptions,
} from "./server-workgraph"
import type { ExecutionCapabilitiesPort, WorkspaceExecutionPort } from "@claxedo/workgraph"
import { EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS, readChangeCursor, type WorkGraphArchive } from "@claxedo/workgraph/contracts"
import type { SignedControlPlaneAuth } from "./control-plane/auth"
import {
  createAttempts,
  createConnectionsService,
  createIntegrationRegistry,
  createMemoryConnectionStore,
  createMemoryCredentialStore,
  type ConnectionsService,
} from "@claxedo/connections"

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
})

describe("embedded local WorkGraph v2", () => {
  it("requires an explicitly configured absolute local repository before composition", () => {
    expect(() => requireLocalWorkGraphRepositoryDirectory(undefined)).toThrowError(expect.objectContaining({
      code: "local_workgraph_repository_directory_required",
      retryable: false,
    }))
    expect(() => requireLocalWorkGraphRepositoryDirectory("relative/repo")).toThrow("requires CLAXEDO_WORKGRAPH_REPOSITORY")
    expect(requireLocalWorkGraphRepositoryDirectory(" /repo ")).toBe("/repo")
  })

  it("mounts the composed local execution capability port at the WorkGraph API", async () => {
    const executionCapabilities: ExecutionCapabilitiesPort = {
      read: async (context) => {
        const observedAt = Date.now()
        return {
        schemaVersion: 1,
        organizationId: context.organizationId,
        ownerUserId: context.ownerUserId,
        catalogRevision: "a".repeat(64),
        observedAt,
        expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
        environments: [{
          kind: "local_worktree",
          repositoryRequired: true,
          remoteUrlInput: false,
          baseRevisionInput: true,
        }],
        harnesses: [{ id: "opencode" }],
        agents: [{ harnessId: "opencode", id: "build", label: "build" }],
        models: [],
        tools: [{ harnessId: "opencode", id: "terminal" }],
        repository: { baseRevisions: ["HEAD"] },
        connections: [],
        }
      },
    }
    const embedded = await createLocalEmbeddedWorkGraph({
      database: trackedDatabase(databaseFile()),
      execution: terminalExecution(),
      executionCapabilities,
    })
    const app = new Hono()
    mountEmbeddedWorkGraph(app, embedded)

    const response = await app.request("/api/workgraph/execution-capabilities", localAuth())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ownerUserId: "local", harnesses: [{ id: "opencode" }] })
  })

  it("persists manual sources and streams across caller-owned compositions", async () => {
    const file = databaseFile()
    const firstComposition = composition(file)
    const app = new Hono()
    mountLazyEmbeddedWorkGraph(app, async () => firstComposition)

    const source = await command(app, "operation_source", {
      version: 1,
      type: "create_work_source",
      title: "Launch notes",
      content: "Ship Claxedo Cloud",
    })
    expect(source.status).toBe(200)
    const createdSource = await source.json() as { value: { workSourceId: string; revisionId: string } }
    expect(await (await app.request("/api/workgraph/sources", localAuth())).json()).toMatchObject({
      sources: [{ id: createdSource.value.workSourceId, latestRevisionId: createdSource.value.revisionId }],
    })

    const stream = await command(app, "operation_stream", {
      version: 1,
      type: "create_stream",
      title: "Launch Claxedo Cloud",
      description: "Get the cloud launch over the line",
    })
    expect(stream.status).toBe(200)
    const created = await stream.json() as { value: { streamId: string } }

    const first = await firstComposition
    first.database.close()
    databases.splice(databases.indexOf(first.database), 1)
    const reloadedComposition = composition(file)
    const reloadedApp = new Hono()
    mountLazyEmbeddedWorkGraph(reloadedApp, async () => reloadedComposition)

    const snapshot = await reloadedApp.request("/api/workgraph/snapshot", localAuth())
    expect(snapshot.status).toBe(200)
    const snapshotBody = await snapshot.json() as { snapshotCursor: string; records: unknown[] }
    expect(readChangeCursor(snapshotBody.snapshotCursor, "local", "local")).toBe(2)
    expect(snapshotBody).toMatchObject({
      records: expect.arrayContaining([expect.objectContaining({
        recordType: "stream",
        id: created.value.streamId,
        title: "Launch Claxedo Cloud",
      })]),
    })

    // The ordered change log still persists across compositions — asserted at the
    // store level now that the client-facing `/changes` route is gone (plan
    // 2026-07-17-004). Settlement/wakes/audit read this log in-process.
    const reloaded = await reloadedComposition
    const persistedChanges = await reloaded.service.queries.changes.list(await reloaded.resolveContext(
      new Request("http://local/api/workgraph/changes", { headers: { "x-request-id": "request-local" } }),
    ), { limit: 50 })
    expect(persistedChanges.map((change) => readChangeCursor(change.cursor, "local", "local"))).toEqual([1, 2])
    expect((await reloadedApp.request("/api/workgraph/changes", localAuth())).status).toBe(404)
  })

  it("exports and restores an owner archive through the embedded HTTP boundary", async () => {
    const source = await composition(databaseFile())
    const sourceApp = new Hono()
    mountEmbeddedWorkGraph(sourceApp, source)
    const created = await command(sourceApp, "archive_stream", {
      version: 1,
      type: "create_stream",
      title: "Portable local Stream",
    })
    const streamId = ((await created.json()) as { value: { streamId: string } }).value.streamId

    const exported = await sourceApp.request("/api/workgraph/archive", localAuth())
    expect(exported.status).toBe(200)
    const archive = await exported.json() as WorkGraphArchive
    expect(archive).toMatchObject({ version: 1, organizationId: "local", ownerUserId: "local" })

    const target = await composition(databaseFile())
    const targetApp = new Hono()
    mountEmbeddedWorkGraph(targetApp, target)
    const restored = await targetApp.request("/api/workgraph/archive/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "archive_restore", archive }),
    })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ restored: true, recordCount: archive.records.length })
    expect(await (await targetApp.request("/api/workgraph/snapshot", localAuth())).json()).toMatchObject({
      records: expect.arrayContaining([expect.objectContaining({ id: streamId, title: "Portable local Stream" })]),
    })
  })

  it("permanently deletes the trusted owner's complete local WorkGraph through the embedded HTTP boundary", async () => {
    const embedded = await composition(databaseFile())
    const app = new Hono()
    mountEmbeddedWorkGraph(app, embedded)
    await command(app, "owner_delete_stream", { version: 1, type: "create_stream", title: "Remove owner state" })

    const request = {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "owner_delete_all" }),
    }
    const deleted = await app.request("/api/workgraph/owner", request)
    expect(deleted.status).toBe(200)
    const result = await deleted.json()
    expect(result).toMatchObject({ deleted: true, recordCount: expect.any(Number), workspaceCount: 0 })
    expect(await (await app.request("/api/workgraph/owner", request)).json()).toEqual(result)
    expect(embedded.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_streams WHERE owner_user_id = 'local'").get())
      .toEqual({ count: 0 })
  })





  it("mounts owner-scoped Source View and intake routes through shared Connections", async () => {
    const database = trackedDatabase(databaseFile())
    const embedded = await createLocalEmbeddedWorkGraph({
      database,
      execution: terminalExecution(),
      connections: {
        getById: async (id: string) => ({
          id,
          integrationId: "github",
          owner: undefined,
          grantedCapabilities: ["work-source"],
        }),
        getToken: async () => ({ ok: true, response: { token: "live", tokenType: "bearer" } }),
        reportAuthFailure: async () => undefined,
      } as unknown as ConnectionsService,
    })
    const app = new Hono()
    mountEmbeddedWorkGraph(app, embedded)
    const created = await app.request("/api/workgraph/source-views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        teamConnectionId: "connection-1",
        provider: "github",
        providerUserId: "octocat",
        filters: { repo: "claxedo/claxedo" },
      }),
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ provider: "github", providerUserId: "octocat", filters: { repo: "claxedo/claxedo" } })
    expect(await (await app.request("/api/workgraph/source-views")).json()).toMatchObject({
      sourceViews: [expect.objectContaining({ teamConnectionId: "connection-1" })],
    })
    expect(await (await app.request("/api/workgraph/intake?limit=50")).json()).toEqual({ candidates: [], hasMore: false })
  })

  it("maps a foreign-organization Source View Connection to the canonical typed response", async () => {
    const registry = createIntegrationRegistry()
    registry.register({
      id: "github",
      name: "GitHub",
      methods: ["key"],
      capabilities: ["code-host", "work-source"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Token", secret: true }],
    }, { verify: async () => ({ ok: true }) })
    const connections = createConnectionsService({
      registry,
      credentials: createMemoryCredentialStore(),
      connections: createMemoryConnectionStore(),
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-org-a",
    })
    expect(await connections.connect({ integrationId: "github", owner: "org-owner-a", fields: {}, secret: "live" }))
      .toEqual({ ok: true })
    const embedded = await createLocalEmbeddedWorkGraph({
      database: trackedDatabase(databaseFile()),
      execution: terminalExecution(),
      connections,
      auth: signedAuth(),
      resolveTeamOwner: (context) => context.organizationId,
    })
    const app = new Hono()
    mountEmbeddedWorkGraph(app, embedded)
    const body = JSON.stringify({
      teamConnectionId: "connection-org-a",
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/claxedo" },
    })

    expect((await app.request("/api/workgraph/source-views", {
      ...bearer("owner-a"),
      method: "POST",
      headers: { ...bearer("owner-a").headers, "content-type": "application/json" },
      body,
    })).status).toBe(201)
    const hidden = await app.request("/api/workgraph/source-views", {
      ...bearer("owner-b"),
      method: "POST",
      headers: { ...bearer("owner-b").headers, "content-type": "application/json" },
      body,
    })

    expect(hidden.status).toBe(409)
    expect(await hidden.json()).toEqual({
      error: {
        code: "source_view_connection_unavailable",
        message: "Source View Connection is unavailable",
        retryable: false,
      },
    })
  })

  it("automatically verifies local GitHub callbacks from the Connection webhook credential", async () => {
    const registry = createIntegrationRegistry()
    registry.register({
      id: "github",
      name: "GitHub",
      methods: ["key"],
      capabilities: ["code-host", "work-source"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Token", secret: true }],
    }, { verify: async () => ({ ok: true }) })
    const credentials = createMemoryCredentialStore()
    const connections = createConnectionsService({
      registry,
      credentials,
      connections: createMemoryConnectionStore(),
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-local",
    })
    await connections.connect({ integrationId: "github", fields: {}, secret: "access-token" })
    await connections.setWebhookSigningSecret("connection-local", "old-secret")
    const embedded = await createLocalEmbeddedWorkGraph({ database: trackedDatabase(databaseFile()), connections, execution: terminalExecution() })
    const app = new Hono()
    mountEmbeddedWorkGraph(app, embedded)
    const body = JSON.stringify({ repository: { full_name: "claxedo/cloud" } })

    const first = await githubWebhook(app, body, "delivery-local-1", "old-secret")
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ accepted: true, reason: "processed", refreshed: 0 })

    await connections.setWebhookSigningSecret("connection-local", "new-secret")
    expect((await githubWebhook(app, body, "delivery-local-2", "old-secret")).status).toBe(401)
    expect((await githubWebhook(app, body, "delivery-local-2", "new-secret")).status).toBe(202)
    await connections.remove("connection-local")
    expect((await githubWebhook(app, body, "delivery-local-3", "new-secret")).status).toBe(401)
  })

  it("derives ownership from signed auth and rejects client owner selectors", async () => {
    const auth = signedAuth()
    const embedded = await composition(databaseFile(), auth)
    const app = new Hono()
    mountEmbeddedWorkGraph(app, embedded)

    expect((await app.request("/api/workgraph/snapshot")).status).toBe(401)
    expect((await app.request("/api/workgraph/snapshot", bearer("invalid"))).status).toBe(401)
    await expect(embedded.resolveContext(new Request("http://local.test/api/workgraph/snapshot", bearer("owner-a"))))
      .resolves.toMatchObject({ organizationId: "org-owner-a", ownerUserId: "owner-a" })

    const ownerA = await command(app, "operation_a", {
      version: 1,
      type: "create_stream",
      title: "Owner A stream",
    }, bearer("owner-a"))
    expect(ownerA.status).toBe(200)
    const created = await ownerA.json() as { value: { streamId: string } }

    expect((await app.request(`/api/workgraph/streams/${created.value.streamId}`, bearer("owner-b"))).status).toBe(404)
    expect((await app.request("/api/workgraph/snapshot?ownerUserId=owner-a", bearer("owner-b"))).status).toBe(400)
    expect((await app.request("/api/workgraph/snapshot?organizationId=org-owner-a", bearer("owner-b"))).status).toBe(400)

    const smuggled = await app.request("/api/workgraph/commands", {
      ...bearer("owner-b"),
      method: "POST",
      headers: { ...bearer("owner-b").headers, "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "operation_smuggled",
        ownerUserId: "owner-a",
        command: { version: 1, type: "create_stream", title: "Smuggled" },
      }),
    })
    expect(smuggled.status).toBe(400)
  })

  it("fails signed WorkGraph requests closed when trusted organization resolution is unavailable", async () => {
    const trusted = signedAuth()
    const embedded = await composition(databaseFile(), {
      authConfig: trusted.authConfig,
      verifier: trusted.verifier,
    })
    const app = new Hono()
    mountEmbeddedWorkGraph(app, embedded)

    await expect(embedded.resolveContext(new Request("http://local.test/api/workgraph/snapshot", bearer("owner-a"))))
      .rejects.toMatchObject({ status: 503, code: "workspace_authority_unavailable" })
    const response = await app.request("/api/workgraph/snapshot", bearer("owner-a"))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    })
  })

  it("executes through the embedded service and reconciles an explicit terminal result into result_ready", async () => {
    const embedded = await createLocalEmbeddedWorkGraph({
      database: trackedDatabase(databaseFile()),
      execution: terminalExecution(),
      executionCapabilities: localExecutionCapabilities(),
    })
    const app = new Hono()
    mountEmbeddedWorkGraph(app, embedded)
    const stream = await command(app, "operation_execute_stream", {
      version: 1,
      type: "create_stream",
      title: "Execute",
      execution: profile,
    })
    const streamId = ((await stream.json()) as { value: { streamId: string } }).value.streamId
    const item = await command(app, "operation_execute_item", {
      version: 1,
      type: "create_work_item",
      streamId,
      title: "Ship",
      completionContract: { version: 1, mode: "all", requirements: [{ id: "proof", kind: "test", description: "Tests pass" }] },
    })
    const workItemId = ((await item.json()) as { value: { workItemId: string } }).value.workItemId
    // Execution modes are gone: a local (owner) create is born `pending` (approved),
    // and the embedded SQLite drain that runs after every command admits and
    // launches it with no execute command.
    await embedded.reconcile({ organizationId: "local" as never, ownerUserId: "local" as never, actor: { type: "system", id: "reconciler" as never }, requestId: "reconcile" as never, access: { mode: "owner" } })
    const beforeCompletion = await app.request("/api/workgraph/snapshot", localAuth())
    expect(((await beforeCompletion.json()) as { records: Array<{ recordType: string; state?: string }> }).records)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ recordType: "work_item", state: "active" }),
        expect.objectContaining({ recordType: "attempt", state: "running" }),
      ]))
    const attempt = embedded.database.prepare(`
      SELECT attempts.id, attempts.session_id, attempts.lease_epoch, bindings.project_id
      FROM wg_v2_attempts attempts
      JOIN wg_v2_session_bindings bindings
        ON bindings.organization_id = attempts.organization_id
        AND bindings.owner_user_id = attempts.owner_user_id
        AND bindings.session_id = attempts.session_id
        AND bindings.current_attempt_id = attempts.id
      WHERE attempts.work_item_id = ? AND attempts.lifecycle = 'running'
    `).get(workItemId) as { id: string; session_id: string; lease_epoch: number; project_id: string }
    expect((await command(app, "operation_explicit_completion", {
      version: 1,
      type: "complete_attempt",
      attemptId: attempt.id,
      sessionId: attempt.session_id,
      workspaceId: attempt.project_id,
      leaseEpoch: attempt.lease_epoch,
      summary: "Done",
      artifacts: ["commit:abc"],
      evidence: [{
        requirementId: "proof",
        evidence: { kind: "test_result", summary: "Independent proof pending", passed: false },
      }],
    })).status).toBe(200)
    const snapshot = await app.request("/api/workgraph/snapshot", localAuth())
    const records = ((await snapshot.json()) as { records: Array<{ recordType: string; state?: string; result?: unknown }> }).records
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: "work_item", state: "result_ready" }),
      expect.objectContaining({ recordType: "attempt", state: "result", result: expect.objectContaining({ artifactRefs: ["commit:abc"] }) }),
    ]))
  })
})

async function composition(file: string, auth?: LocalWorkGraphAuthOptions) {
  const database = trackedDatabase(file)
  return createLocalEmbeddedWorkGraph({
    database,
    execution: terminalExecution(),
    executionCapabilities: localExecutionCapabilities(),
    ...(auth ? { auth } : {}),
  })
}

function trackedDatabase(file: string) {
  const database = new Database(file)
  databases.push(database)
  return database
}

function databaseFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-workgraph-"))
  directories.push(directory)
  return path.join(directory, "workgraph.sqlite")
}

function localAuth() {
  return { headers: { "x-request-id": "request-local" } }
}

function githubWebhook(app: Hono, body: string, deliveryId: string, secret: string) {
  return app.request("/api/workgraph/webhooks/github/connection-local", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  })
}

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}`, "x-request-id": `request-${token}` } }
}

function signedAuth(): LocalWorkGraphAuthOptions {
  return {
    authConfig: { enabled: true, issuer: "test", jwksUrl: "https://test.invalid/jwks" },
    verifier: async (token) => {
      if (token !== "owner-a" && token !== "owner-b") throw new Error("invalid")
      return {
        mode: "signed",
        user: { subject: token, tokenIdentifier: `session-${token}`, issuer: "test" },
      }
    },
    authority: {
      resolveOrgId: async (auth: SignedControlPlaneAuth) => `org-${auth.user.subject}` as never,
    } as unknown as NonNullable<LocalWorkGraphAuthOptions["authority"]>,
  }
}

async function command(
  app: Hono,
  operationId: string,
  command: Record<string, unknown>,
  init = localAuth(),
) {
  return app.request("/api/workgraph/commands", {
    ...init,
    method: "POST",
    headers: { ...init.headers, "content-type": "application/json" },
    body: JSON.stringify({ operationId, command }),
  })
}

function terminalExecution(): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async (_context, input) => ({ id: "envelope_1" as never, streamId: input.streamId, environment: input.environment, repository: input.repository, workspaceId: "/tmp/worktree" }),
    launch: async (_context, input) => ({ sessionId: "session_1" as never, envelopeId: input.envelopeId, projectId: "/tmp/workgraph" }),
    cancel: async () => undefined,
    result: async () => ({ state: "succeeded", summary: "Done", artifacts: ["commit:abc"] }),
    cleanup: async () => undefined,
  }
}

function localExecutionCapabilities(): ExecutionCapabilitiesPort {
  return {
    read: async (context) => {
      const observedAt = Date.now()
      return {
      schemaVersion: 1,
      organizationId: context.organizationId,
      ownerUserId: context.ownerUserId,
      catalogRevision: "b".repeat(64),
      observedAt,
      expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
      environments: [{
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
      }],
      harnesses: [{ id: "claxedo-v2" }],
      agents: [{ harnessId: "claxedo-v2", id: "build", label: "build" }],
      models: [{
        harnessId: "claxedo-v2",
        providerId: "openai",
        modelId: "gpt-5",
        label: "GPT-5",
        efforts: ["high"],
      }],
      tools: [],
      repository: { baseRevisions: ["HEAD"] },
      connections: [],
      }
    },
  }
}

const profile = {
  environment: { kind: "local_worktree" as const, directory: "/repo" }, repository: { baseRevision: "HEAD" }, harness: "claxedo-v2", agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" }, effort: "high", tools: [], connectionIds: [],
}
