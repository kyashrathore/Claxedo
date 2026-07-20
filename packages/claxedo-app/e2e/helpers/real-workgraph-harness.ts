import fs from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import {
  createAttempts,
  createConnectionsService,
  createIntegrationRegistry,
  createIntegrationsRoutes,
  createMemoryConnectionStore,
  createMemoryCredentialStore,
} from "../../../claxedo-connections/src/index"
import { createSessionIntakeService } from "@claxedo/workgraph"
import type { CodeHostConnector, SourceIssueConnector } from "@claxedo/workgraph/connectors"
import {
  WorkGraphConnectionToolNames,
  type CommandResult,
  type WorkGraphAttemptOperationRequest,
  type WorkGraphContext,
  type WorkSourceRevisionRef,
} from "@claxedo/workgraph/contracts"
import type { WorkspaceAuthority } from "../../../claxedo-server/src/control-plane/authority"
import {
  createLocalEmbeddedWorkGraph,
  type LocalEmbeddedWorkGraph,
  type LocalWorkGraphAuthOptions,
} from "../../../claxedo-server/src/server-workgraph"
import { createExecutionCapabilitiesPort } from "../../../claxedo-server/src/workgraph-host/execution-capabilities"
import { createLocalWorkspaceExecution, type WorkGraphSessionGateway } from "../../../claxedo-server/src/workgraph-host/local-execution"
import { createSessionV2WorkGraphGateway } from "../../../claxedo-server/src/workgraph-session-gateway"
import { createSqlitePullRequestEffects } from "../../../claxedo-server/src/workgraph-host/sqlite-pull-request-effects"
import { buildSessionListResponse, parseSessionListQuery } from "../../../claxedo-server/src/session-list"
import {
  createLocalWorkGraphAgentTools,
  localSessionContext,
  localSessionExecution,
} from "../../../claxedo-server/src/workgraph-agent-tools"
import type { OpenCodeApplicationToolRegistration } from "../../../claxedo-server/src/opencode-engine"

const repository = path.resolve(import.meta.dirname, "../../../..")
type WorkGraphDatabase = Parameters<typeof createLocalEmbeddedWorkGraph>[0]["database"]
const Database = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../../../claxedo-server/node_modules/better-sqlite3")) as new (filename: string) => WorkGraphDatabase

export type RealWorkGraphHarness = Readonly<{
  apiUrl: string
  directory: string
  embedded: LocalEmbeddedWorkGraph
  advanceTime: (milliseconds: number) => void
  queueExecutionResults: (...results: ControlledExecutionResult[]) => void
  worktreeDirectory: (streamId: string) => string
  runReconcile: () => ReturnType<LocalEmbeddedWorkGraph["reconcile"]>
  runSourcePlanning: () => ReturnType<LocalEmbeddedWorkGraph["sourcePlanning"]["runDue"]>
  completeControlledAttempt: (
    workItemId: string,
    summary: string,
    artifacts: readonly string[],
  ) => Promise<CommandResult>
  projectIndependentSession: (input: Readonly<{ sessionId: string; title: string; summary: string }>) => Promise<"created" | "existing" | "ignored">
  connectionEvidence: () => Readonly<{
    requests: readonly ControlledSourceIssueRequest[]
    effects: readonly ControlledSourceIssueEffect[]
    pullRequests: readonly ControlledPullRequestRequest[]
    connectionId: string
    connectionIds: Readonly<Record<"github" | "linear" | "jira", string>>
  }>
  controlledExecutionDiagnostics: () => Readonly<{
    queued: readonly ControlledExecutionResult[]
    attempts: readonly (readonly [string, "running" | ControlledExecutionResult])[]
    durableAttempts: readonly unknown[]
    leases: readonly unknown[]
    pendingWork: readonly unknown[]
    capabilityReads: readonly unknown[]
    lastReconcile: unknown
  }>
  realSessionEvidence: () => readonly RealSessionRecord[]
  realSessionDiagnostics: () => Readonly<{
    providerRequests: number
    toolResults: readonly unknown[]
    proxyRequests: readonly unknown[]
    proxyErrors: readonly unknown[]
    logs: readonly string[]
  }>
  assertHealthy: () => void
  close: () => Promise<void>
}>

type ControlledExecutionResult =
  | "running"
  | Readonly<{ state: "succeeded"; summary: string; artifacts: readonly string[] }>
  | Readonly<{ state: "failed"; message: string }>

type ControlledSourceIssueRequest = Readonly<{
  provider: "github" | "linear" | "jira"
  providerUserId: string
  filters: Readonly<Record<string, string>>
  authorized: boolean
}>

type ControlledSourceIssueEffect = Readonly<{
  provider: "github" | "linear" | "jira"
  action: "comment" | "update"
  externalId: string
  body: string
  status?: string
  idempotencyKey: string
  authorized: boolean
}>

type ControlledPullRequestRequest = Readonly<{
  repository: string
  head: string
  base: string
  title: string
  draft: boolean
  idempotencyKey: string
  authorized: boolean
}>

type RealSessionRecord = Readonly<{
  sessionId: string
  directory: string
  title: string
  createdAt: number
  updatedAt: number
}>

export async function createRealWorkGraphHarness(input: Readonly<{
  port: number
  temporaryRoot?: string
  reconcileIntervalMs?: number
  organizationId?: string
  ownerUserId?: string
  trustedAuthContexts?: Readonly<Record<string, Readonly<{ organizationId: string; ownerUserId: string }>>>
  realSessions?: boolean
  realMasters?: boolean
}>): Promise<RealWorkGraphHarness> {
  const diagT0 = Date.now()
  const diagMark = (label: string) => process.stderr.write(`[harness-diag] ${label} +${Date.now() - diagT0}ms\n`)
  diagMark("start")
  fs.mkdirSync(input.temporaryRoot ?? os.tmpdir(), { recursive: true })
  const directory = fs.mkdtempSync(path.join(input.temporaryRoot ?? os.tmpdir(), "claxedo-workgraph-browser-"))
  const database = new Database(path.join(directory, "workgraph.sqlite"))
  const pullRequestEffects = createSqlitePullRequestEffects(database)
  const queuedExecutionResults: ControlledExecutionResult[] = []
  const attempts = new Map<string, "running" | ControlledExecutionResult>()
  const sourceIssueRequests: ControlledSourceIssueRequest[] = []
  const sourceIssueEffects: ControlledSourceIssueEffect[] = []
  const pullRequestRequests: ControlledPullRequestRequest[] = []
  const capabilityReads: unknown[] = []
  let now = Date.now()
  const organizationId = input.organizationId ?? "local"
  const ownerUserId = input.ownerUserId ?? "local"
  const teamOwner = `org:${organizationId}`
  const registry = createIntegrationRegistry()
  const integrationFixtures = [
    { integrationId: "github", provider: "github", name: "GitHub", tokenType: "bearer", accountLabel: "claxedo/claxedo" },
    { integrationId: "linear", provider: "linear", name: "Linear", tokenType: "bearer", accountLabel: "Claxedo Engineering" },
    { integrationId: "atlassian", provider: "jira", name: "Atlassian", tokenType: "basic", accountLabel: "claxedo.atlassian.net" },
  ] as const
  integrationFixtures.forEach((integration) => registry.register({
    id: integration.integrationId,
    name: integration.name,
    methods: ["key"],
    capabilities: integration.provider === "github" ? ["code-host", "work-source"] : ["work-source"],
    keyTokenType: integration.tokenType,
    prompts: [{ id: "token", label: "Token", secret: true }],
  }, { verify: async () => ({ ok: true as const, accountLabel: integration.accountLabel }) }))
  let connectionNumber = 0
  const connections = createConnectionsService({
    registry,
    credentials: createMemoryCredentialStore(),
    connections: createMemoryConnectionStore(),
    attempts: createAttempts({ sweepIntervalMs: 0 }),
    newId: () => `connection_browser_${++connectionNumber}`,
    now: () => now,
  })
  await Promise.all(integrationFixtures.map(async (integration) => {
    const result = await connections.connect({
      integrationId: integration.integrationId,
      owner: teamOwner,
      fields: {},
      secret: `browser-e2e-${integration.provider}-secret`,
    })
    if (!result.ok) throw new Error(`Controlled ${integration.name} Connection failed: ${result.code}`)
  }))
  diagMark("connections connected")
  const connectedRows = await connections.list({ teamOwner })
  const connectionIds = Object.fromEntries(integrationFixtures.map((integration) => {
    const row = connectedRows.find((connection) => connection.integrationId === integration.integrationId)
    if (!row) throw new Error(`Controlled ${integration.name} Connection was not stored`)
    return [integration.provider, row.id]
  })) as Record<"github" | "linear" | "jira", string>
  const connectionsRoutes = createIntegrationsRoutes(connections, {
    owner: () => ownerUserId,
    teamOwner: () => teamOwner,
    ownerlessRows: "refuse",
  })
  const sourceIssueConnectors = integrationFixtures.map((integration) => controlledSourceIssueConnector({
    provider: integration.provider,
    token: `browser-e2e-${integration.provider}-secret`,
    tokenType: integration.tokenType,
    now: () => now,
    requests: sourceIssueRequests,
    effects: sourceIssueEffects,
  }))
  const codeHostConnectors = {
    github: controlledCodeHostConnector({
      token: "browser-e2e-github-secret",
      requests: pullRequestRequests,
    }),
  }
  let executeAttempt: ((context: WorkGraphContext, request: WorkGraphAttemptOperationRequest) => Promise<CommandResult>) | undefined
  let recordPullRequest:
    | ((context: WorkGraphContext, input: Readonly<{
        streamId: string
        attemptId: string
        idempotencyKey: string
        pullRequestId: string
        url: string
        draft: boolean
      }>) => Promise<Readonly<{ durableEffectReceiptId: string; evidenceId?: string }>>)
    | undefined
  let authorizePullRequest:
    | ((context: WorkGraphContext, input: Readonly<{
        streamId: string
        repository: string
        title: string
        draft: boolean
        publicRepository: boolean
      }>) => Promise<boolean>)
    | undefined
  diagMark("before createRealSessionRuntime")
  const realSessions = input.realSessions
    ? await createRealSessionRuntime(directory, `http://127.0.0.1:${input.port}`, (forward) => createSessionV2WorkGraphGateway(forward, {
        executeAttempt: (context, request, signal) => {
          if (signal.aborted) throw signal.reason
          if (!executeAttempt) throw new Error("WorkGraph Attempt command broker is not ready")
          return executeAttempt(context, request)
        },
        connections,
        connectors: Object.fromEntries(sourceIssueConnectors.map((connector) => [connector.provider, connector])),
        codeHostConnectors,
        resolveTeamOwner: (context) => `org:${context.organizationId}`,
        recordPullRequest: (context, input) => {
          if (!recordPullRequest) throw new Error("WorkGraph pull request receipt broker is not ready")
          return recordPullRequest(context, input)
        },
        authorizePullRequest: (context, input) => {
          if (!authorizePullRequest) throw new Error("WorkGraph pull request authorization broker is not ready")
          return authorizePullRequest(context, input)
        },
        pullRequestEffects,
      }))
    : undefined
  diagMark("after createRealSessionRuntime (provider mock server listening)")
  const execution = createLocalWorkspaceExecution({
    worktreeRoot: path.join(directory, "worktrees"),
    repositoryDirectory: async () => repository,
    sessions: realSessions?.gateway ?? {
      admit: async ({ attemptId, sessionId }) => {
        const adopted = sessionId ?? `session:${attemptId}`
        attempts.set(adopted, "running")
        const result = queuedExecutionResults.shift()
        if (!result) throw new Error(`Execution ${attemptId} had no explicit controlled Session result`)
        queueMicrotask(() => attempts.set(adopted, result))
        return adopted
      },
      cancel: async (sessionId) => { attempts.delete(sessionId) },
      result: async (sessionId) => {
        const result = attempts.get(sessionId)
        return !result || result === "running" ? { state: "running" } : result
      },
    },
  })
  const generationSessions = createGenerationSessions()
  diagMark("before createLocalEmbeddedWorkGraph")
  const embedded = await createLocalEmbeddedWorkGraph({
    database,
    ...(input.trustedAuthContexts ? { auth: trustedAuth(input.trustedAuthContexts) } : {}),
    execution,
    ...(input.realMasters && realSessions
      ? {
          master: {
            sessions: realSessions.gateway,
            directory: (context, streamId) => path.join(
              directory,
              "worktrees",
              encode(context.organizationId),
              encode(context.ownerUserId),
              encode(streamId),
              "envelope",
            ),
          },
        }
      : {}),
    connections,
    resolveTeamOwner: (context) => `org:${context.organizationId}`,
    sourceIssueConnectors,
    executionCapabilities: createExecutionCapabilitiesPort({
      environment: {
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
        isolation: ["stream", "child"],
        cleanup: ["destroy_on_close", "retain"],
        integration: ["manual"],
      },
      readRuntime: async () => ({
        harness: { harness: "opencode" },
        agents: [{ name: "build", mode: "primary", description: "Controlled browser execution agent" }],
        providers: {
          connected: [input.realSessions ? "workgraph-e2e" : "openai"],
          all: input.realSessions
            ? [{ id: "workgraph-e2e", models: { "workgraph-model": { id: "workgraph-model", name: "WorkGraph Model", variants: { high: {} } } } }]
            : [{ id: "openai", models: { "gpt-5": { id: "gpt-5", name: "GPT-5", variants: { high: {} } } } }],
        },
        tools: ["read", "edit"],
      }),
      readRepository: async () => ({ baseRevisions: ["HEAD", "dev"] }),
      readConnections: async (context) => {
        const available = (await connections.list({
          owner: context.ownerUserId,
          teamOwner: `org:${context.organizationId}`,
        })).flatMap((connection) => connection.status === "connected" ? [{
          id: connection.id as never,
          integrationId: connection.integrationId,
          scope: connection.scope,
          grantedCapabilities: connection.grantedCapabilities,
          ...(connection.accountLabel ? { accountLabel: connection.accountLabel } : {}),
        }] : [])
        capabilityReads.push({ context, available })
        return available
      },
      connectionToolIds: WorkGraphConnectionToolNames,
      now: () => now,
    }),
    sourcePlanning: { sessions: generationSessions, directory: repository },
  })
  executeAttempt = (context, request) => embedded.service.execute(context, {
    operationId: request.operation.operationId,
    command: request.operation.type === "record_checkpoint"
      ? {
          version: 1,
          type: "record_attempt_checkpoint",
          attemptId: request.identity.attemptId,
          sessionId: request.identity.sessionId,
          workspaceId: request.identity.workspaceId,
          ...(request.identity.leaseEpoch === undefined ? {} : { leaseEpoch: request.identity.leaseEpoch }),
          level: request.operation.level,
          summary: request.operation.summary,
          evidenceIds: request.operation.evidenceIds,
        }
      : {
          version: 1,
          type: "complete_attempt",
          attemptId: request.identity.attemptId,
          sessionId: request.identity.sessionId,
          workspaceId: request.identity.workspaceId,
          ...(request.identity.leaseEpoch === undefined ? {} : { leaseEpoch: request.identity.leaseEpoch }),
          summary: request.operation.summary,
          artifacts: request.operation.artifacts,
          evidence: request.operation.evidence,
      },
  })
  recordPullRequest = async (context, request) => {
    const result = await embedded.service.execute(context, {
      operationId: `pull_request_${request.idempotencyKey}` as never,
      command: {
        version: 1,
        type: "record_evidence",
        subject: { type: "stream", streamId: request.streamId as never },
        evidence: {
          kind: "integration",
          summary: `Opened ${request.draft ? "draft " : ""}pull request ${request.pullRequestId}`,
          effect: "published",
          reference: request.url,
        },
      },
    })
    if (!result.ok) throw new Error(result.error.message)
    const value = result.value as { durableEffectReceiptId?: string; evidenceId?: string }
    if (!value.durableEffectReceiptId) throw new Error("Pull request durable effect receipt is missing")
    return {
      durableEffectReceiptId: value.durableEffectReceiptId,
      ...(value.evidenceId ? { evidenceId: value.evidenceId } : {}),
    }
  }
  authorizePullRequest = async (context, request) => {
    if (request.draft || !request.publicRepository) return true
    const stream = await embedded.service.queries.streams.read(context, { streamId: request.streamId as never })
    if (!stream) throw new Error("Pull request Stream is unavailable")
    if (stream.publicPrConfirmedAt !== undefined) return true
    const result = await embedded.service.execute(context, {
      operationId: `public_pr_confirmation_${request.streamId}` as never,
      command: {
        version: 1,
        type: "request_public_pr_confirmation",
        streamId: request.streamId as never,
        expectedVersion: stream.version,
        repository: request.repository,
        title: request.title,
      },
    })
    if (!result.ok) throw new Error(result.error.message)
    return false
  }
  diagMark("after createLocalEmbeddedWorkGraph, before configureApplicationTools")
  if (realSessions) {
    await realSessions.configureApplicationTools(await createLocalWorkGraphAgentTools(embedded, {
      organizationId,
      ownerUserId,
      sessionExecution: (sessionId) => localSessionExecution(realSessions.fetch, sessionId),
      sessionContext: (sessionId) => localSessionContext(realSessions.fetch, sessionId),
    }))
  }
  diagMark("after configureApplicationTools (opencode ready)")
  let backgroundFailure: unknown
  let lastReconcile: unknown
  let background = Promise.resolve<unknown>(undefined)
  const context = (): WorkGraphContext => ({
    organizationId: organizationId as never,
    ownerUserId: ownerUserId as never,
    actor: { type: "system", id: "browser-workgraph-worker" as never },
    requestId: crypto.randomUUID() as never,
    access: { mode: "owner" },
  })
  const serialized = <Value>(effect: () => Promise<Value>) => {
    const next = background.then(effect)
    background = next.then(
      (value) => value,
      (error) => {
        backgroundFailure ??= error
        return undefined
      },
    )
    return next
  }
  const capture = (error: unknown) => { backgroundFailure ??= error }
  const activeRequests = new Set<Readonly<{
    controller: AbortController
    incoming: IncomingMessage
    outgoing: ServerResponse
  }>>()
  const server = createServer((incoming, outgoing) => {
    const request = { controller: new AbortController(), incoming, outgoing }
    activeRequests.add(request)
    void respond(
      incoming,
      outgoing,
      input.port,
      embedded,
      realSessions,
      (request) => connectionsRoutes.fetch(request),
      () => backgroundFailure,
      request.controller,
    )
      .catch((error) => {
        capture(error)
        if (!outgoing.headersSent) {
          outgoing.statusCode = 500
          outgoing.setHeader("content-type", "application/json")
          setCors(outgoing)
        }
        if (!outgoing.writableEnded) outgoing.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
      })
      .finally(() => activeRequests.delete(request))
  })
  const sockets = new Set<import("node:net").Socket>()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  const port = await listen(server, input.port)
  diagMark("main WorkGraph API server listening")
  const runReconcile = () => serialized(async () => {
    const result = await embedded.reconcile(context())
    lastReconcile = result
    return result
  })
  const reconcile = setInterval(() => {
    void runReconcile().catch(() => undefined)
  }, input.reconcileIntervalMs ?? 50)
  let closing: Promise<void> | undefined

  return {
    apiUrl: `http://127.0.0.1:${port}`,
    directory,
    embedded,
    advanceTime: (milliseconds) => { now += milliseconds },
    queueExecutionResults: (...results) => { queuedExecutionResults.push(...results) },
    worktreeDirectory: (streamId) => path.join(directory, "worktrees", encode(organizationId), encode(ownerUserId), encode(streamId), "envelope"),
    runReconcile,
    runSourcePlanning: () => serialized(() => embedded.sourcePlanning.runDue(context())),
    completeControlledAttempt: (workItemId, summary, artifacts) => serialized(async () => {
      const attempt = database.prepare(
        `SELECT attempts.id, attempts.session_id, attempts.lease_epoch, bindings.project_id
         FROM wg_v2_attempts attempts
         JOIN wg_v2_session_bindings bindings
           ON bindings.organization_id = attempts.organization_id
          AND bindings.owner_user_id = attempts.owner_user_id
          AND bindings.session_id = attempts.session_id
          AND bindings.current_attempt_id = attempts.id
          AND bindings.state = 'active'
         WHERE attempts.organization_id = ? AND attempts.owner_user_id = ? AND attempts.work_item_id = ?
         ORDER BY attempt_number DESC LIMIT 1`,
      ).get(organizationId, ownerUserId, workItemId) as
        | { id: string; session_id: string; lease_epoch: number; project_id: string }
        | undefined
      if (!attempt) throw new Error("Controlled Attempt is not running")
      return embedded.service.execute(context(), {
        operationId: crypto.randomUUID() as never,
        command: {
          version: 1,
          type: "complete_attempt",
          attemptId: attempt.id as never,
          sessionId: attempt.session_id,
          workspaceId: attempt.project_id,
          leaseEpoch: attempt.lease_epoch,
          summary,
          artifacts: [...artifacts],
          evidence: [{
            evidence: {
              kind: "finding",
              summary: "The controlled Session reported an explicit terminal result",
            },
          }],
        },
      })
    }),
    projectIndependentSession: (session) => serialized(() => createSessionIntakeService(embedded.sessionIntake).onIdle(context(), {
      ...session,
      meaningful: true,
      becameIdleAt: now,
    })),
    connectionEvidence: () => ({
      requests: [...sourceIssueRequests],
      effects: [...sourceIssueEffects],
      pullRequests: [...pullRequestRequests],
      connectionId: connectionIds.github,
      connectionIds: { ...connectionIds },
    }),
    controlledExecutionDiagnostics: () => ({
      queued: [...queuedExecutionResults],
      attempts: [...attempts.entries()],
      durableAttempts: database.prepare(
        "SELECT id, lifecycle, lease_epoch, session_id FROM wg_v2_attempts ORDER BY created_at, id",
      ).all(),
      leases: database.prepare(
        "SELECT resource_id, holder_id, epoch, expires_at FROM wg_v2_leases ORDER BY resource_id",
      ).all(),
      pendingWork: database.prepare(
        `SELECT items.id, items.title, items.lifecycle, items.execution_overrides_json,
          streams.title AS stream_title, streams.lifecycle AS stream_lifecycle,
          streams.execution_defaults_json AS stream_defaults_json
         FROM wg_v2_work_items items
         JOIN wg_v2_streams streams ON streams.organization_id = items.organization_id
          AND streams.owner_user_id = items.owner_user_id AND streams.id = items.stream_id
         WHERE items.lifecycle = 'pending' ORDER BY items.created_at, items.id`,
      ).all(),
      capabilityReads: capabilityReads.slice(-20),
      lastReconcile,
    }),
    realSessionEvidence: () => [...(realSessions?.records.values() ?? [])],
    realSessionDiagnostics: () => realSessions?.diagnostics() ?? {
      providerRequests: 0,
      toolResults: [],
      proxyRequests: [],
      proxyErrors: [],
      logs: [],
    },
    assertHealthy: () => {
      if (backgroundFailure) throw backgroundFailure
    },
    close: () => {
      if (closing) return closing
      closing = (async () => {
        clearInterval(reconcile)
        const serverClosed = closeServer(server)
        activeRequests.forEach((request) => {
          request.controller.abort()
          request.incoming.destroy()
          request.outgoing.destroy()
        })
        // The test owns every socket accepted by this server. Destroy them only
        // after admission stops so a response transitioning to keep-alive cannot
        // escape the one-time idle-connection sweep during teardown.
        sockets.forEach((socket) => socket.destroy())
        await background
        await serverClosed
        await realSessions?.close()
        database.close()
        fs.rmSync(directory, { recursive: true, force: true })
        spawnSync("git", ["-C", repository, "worktree", "prune"], { stdio: "ignore" })
        if (backgroundFailure) throw backgroundFailure
      })()
      return closing
    },
  }
}

function controlledCodeHostConnector(input: Readonly<{
  token: string
  requests: ControlledPullRequestRequest[]
}>): CodeHostConnector {
  return {
    provider: "github",
    async openPullRequest(authorization, request) {
      const authorized = authorization.token === input.token && authorization.tokenType === "bearer"
      input.requests.push({
        repository: request.repository,
        head: request.head,
        base: request.base,
        title: request.title,
        draft: request.draft,
        idempotencyKey: request.idempotencyKey,
        authorized,
      })
      if (!authorized) throw new Error("Controlled GitHub connector received invalid authorization")
      return {
        pullRequestId: "482",
        url: "https://github.example/claxedo/app/pull/482",
        draft: request.draft,
      }
    },
  }
}

function controlledSourceIssueConnector(input: Readonly<{
  provider: "github" | "linear" | "jira"
  token: string
  tokenType: "bearer" | "basic"
  now: () => number
  requests: ControlledSourceIssueRequest[]
  effects: ControlledSourceIssueEffect[]
}>): SourceIssueConnector {
  const issue = input.provider === "github"
    ? {
        externalId: "101",
        externalKey: "#101",
        externalUrl: "https://github.example/claxedo/claxedo/issues/101",
        title: "Connection-filtered launch issue",
        body: "Reached through the team GitHub Connection with the owner's source filter.",
      }
    : input.provider === "linear"
      ? {
          externalId: "linear-101",
          externalKey: "LIN-101",
          externalUrl: "https://linear.example/claxedo/issue/LIN-101",
          title: "Linear launch issue",
          body: "Reached through the team Linear Connection with the owner's source filter.",
        }
      : {
          externalId: "jira-101",
          externalKey: "CLX-101",
          externalUrl: "https://claxedo.atlassian.example/browse/CLX-101",
          title: "Jira launch issue",
          body: "Reached through the team Atlassian Connection with the owner's JQL filter.",
        }
  const authorized = (authorization: Readonly<{ token: string; tokenType: "bearer" | "basic" }>) =>
    authorization.token === input.token && authorization.tokenType === input.tokenType
  return {
    provider: input.provider,
    async list(authorization, request) {
      input.requests.push({
        provider: input.provider,
        providerUserId: request.providerUserId,
        filters: request.filters,
        authorized: authorized(authorization),
      })
      if (!authorized(authorization)) throw new Error(`Controlled ${input.provider} connector received invalid authorization`)
      return {
        issues: [{
          ...issue,
          status: "open",
          updatedAt: input.now(),
          revision: `browser-e2e-${input.provider}-1`,
        }],
      }
    },
    async comment(authorization, effect) {
      input.effects.push({
        provider: input.provider,
        action: "comment",
        externalId: effect.externalId,
        body: effect.body,
        idempotencyKey: effect.idempotencyKey,
        authorized: authorized(authorization),
      })
      if (!authorized(authorization)) throw new Error(`Controlled ${input.provider} connector received invalid authorization`)
    },
    async update(authorization, effect) {
      input.effects.push({
        provider: input.provider,
        action: "update",
        externalId: effect.externalId,
        body: effect.body ?? "",
        ...(effect.status ? { status: effect.status } : {}),
        idempotencyKey: effect.idempotencyKey,
        authorized: authorized(authorization),
      })
      if (!authorized(authorization)) throw new Error(`Controlled ${input.provider} connector received invalid authorization`)
    },
  }
}

function trustedAuth(contexts: Readonly<Record<string, Readonly<{ organizationId: string; ownerUserId: string }>>>): LocalWorkGraphAuthOptions {
  const issuer = "https://workgraph-e2e.claxedo.test"
  return {
    authConfig: { enabled: true, issuer, jwksUrl: `${issuer}/jwks` },
    verifier: async (token) => {
      const context = contexts[token]
      if (!context) throw new Error("Unknown WorkGraph E2E bearer token")
      return {
        mode: "signed",
        user: {
          subject: context.ownerUserId,
          tokenIdentifier: `workgraph-e2e:${token}`,
          issuer,
          orgId: context.organizationId,
        },
      }
    },
    // The harness implements the single authority method exercised by WorkGraph auth.
    authority: {
      resolveOrgId: async (auth: Parameters<WorkspaceAuthority["resolveOrgId"]>[0]) => {
        if (!auth.user.orgId) throw new Error("WorkGraph E2E auth context omitted its organization")
        return auth.user.orgId as never
      },
    } as unknown as WorkspaceAuthority,
  }
}

function encode(value: string) {
  return Buffer.from(value).toString("base64url")
}

function createGenerationSessions(): WorkGraphSessionGateway {
  const admitted = new Map<string, Readonly<{ title: string; prompt: string }>>()
  return {
    admit: async (input) => {
      if (!input.sessionId) throw new Error("WorkGraph background Session must provide its durable identity")
      admitted.set(input.sessionId, { title: input.title, prompt: input.prompt })
      return input.sessionId
    },
    cancel: async (sessionId) => { admitted.delete(sessionId) },
    result: async (sessionId) => {
      const request = admitted.get(sessionId)
      if (!request) throw new Error(`Unknown WorkGraph background Session: ${sessionId}`)
      if (request.title.startsWith("Plan: ")) {
        const source = sourceReference(request.prompt)
        const evidence = sourcePlanningEvidence(request.prompt)
        const external = externalPlanningSource(request.prompt)
        return {
          state: "succeeded",
          summary: JSON.stringify({
            source,
            suggestedPlacement: evidence.targetStreamId
              ? { mode: "existing", streamId: evidence.targetStreamId }
              : { mode: "new_stream", streamTitle: external ? `${external.externalKey ?? external.provider} · ${external.title}` : "Planned from AI context" },
            placementMatches: [],
            proposedOutcomes: external ? [] : [{
                key: "launch-ready",
                title: "Launch is ready",
                successCriteria: ["Launch readiness is verified"],
                execution: {},
              }],
            proposedWorkItems: external
              ? [{
                  key: `resolve-${external.provider}-issue`,
                  title: `Resolve ${external.externalKey ?? external.title}`,
                  description: `${external.content}\n\nUse the trusted bound Connection to publish a meaningful result for external issue ${external.externalId}.`,
                  dependencyKeys: [],
                  completionContract: {
                    version: 1,
                    mode: "all",
                    requirements: [{ id: "real-session-proof", kind: "test", description: "The real project Session completes through its scoped WorkGraph tool" }],
                  },
                  execution: {},
                }]
              : [{
                  key: "verify-launch",
                  outcomeKey: "launch-ready",
                  title: "Verify launch readiness",
                  dependencyKeys: [],
                  completionContract: {
                    version: 1,
                    mode: "all",
                    requirements: [{ id: "owner-verification", kind: "owner_confirmation", description: "Owner verifies launch readiness" }],
                  },
                  execution: {},
                }],
            duplicateMatches: [],
          }),
          artifacts: [],
        }
      }
      throw new Error(`Unsupported WorkGraph background Session: ${request.title}`)
    },
  }
}

function sourceReference(prompt: string): WorkSourceRevisionRef {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith("Source reference: "))
  if (!line) throw new Error("Source planning prompt omitted the immutable source reference")
  const parsed = JSON.parse(line.slice("Source reference: ".length)) as WorkSourceRevisionRef
  if (!parsed.workSourceId || !parsed.revisionId || !parsed.contentHash) throw new Error("Source planning prompt contained an invalid source reference")
  return parsed
}

function sourcePlanningEvidence(prompt: string): Readonly<{ targetStreamId?: string }> {
  const prefix = "Bounded current placement and duplicate evidence: "
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix))
  if (!line) throw new Error("Source planning prompt omitted its bounded evidence")
  const parsed = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>
  return typeof parsed.targetStreamId === "string" && parsed.targetStreamId.trim()
    ? { targetStreamId: parsed.targetStreamId }
    : {}
}

function externalPlanningSource(prompt: string) {
  const title = prompt.split("\n").find((line) => line.startsWith("Source title: "))?.slice("Source title: ".length).trim()
  const contentStart = prompt.indexOf("Source content: ")
  const evidenceStart = prompt.indexOf("\nBounded current placement and duplicate evidence: ", contentStart)
  if (!title || contentStart < 0 || evidenceStart < 0) return
  const content = prompt.slice(contentStart + "Source content: ".length, evidenceStart)
  const fenced = content.match(/## WorkGraph intake evidence\s+```json\s+([\s\S]*?)\s+```/)
  if (!fenced?.[1]) return
  const evidence = JSON.parse(fenced[1]) as Record<string, unknown>
  if (
    evidence.candidateKind !== "external_issue" ||
    !["github", "linear", "jira"].includes(String(evidence.provider)) ||
    typeof evidence.externalId !== "string"
  ) return
  return {
    title,
    content,
    provider: evidence.provider as "github" | "linear" | "jira",
    externalId: evidence.externalId,
    ...(typeof evidence.externalKey === "string" ? { externalKey: evidence.externalKey } : {}),
  }
}

function connectionInvocation(serializedRequest: string) {
  const connectionId = connectionHandle(serializedRequest)
  const externalId = serializedRequest.match(/\\?"externalId\\?":\s*\\?"([^"\\]+)\\?"/)?.[1]
  if (!externalId) {
    throw new Error("Connection-bound real Session prompt omitted its trusted Connection or external issue identity")
  }
  return { connectionId, externalId }
}

function connectionHandle(serializedRequest: string) {
  const connectionId = serializedRequest.match(/Trusted Connection handles:\\n- ([^\\"]+)/)?.[1]
    ?? serializedRequest.match(/Trusted Connection handles:\n- ([^\n]+)/)?.[1]
  if (!connectionId) throw new Error("Connection-bound real Session prompt omitted its trusted Connection")
  return connectionId
}

type RealSessionRuntime = Readonly<{
  gateway: WorkGraphSessionGateway
  records: Map<string, RealSessionRecord>
  fetch: (request: Request) => Promise<Response>
  configureApplicationTools: (tools: Readonly<Record<string, OpenCodeApplicationToolRegistration>>) => Promise<void>
  invokeApplicationTool: (input: unknown) => Promise<unknown>
  diagnostics: () => Readonly<{
    providerRequests: number
    toolResults: readonly unknown[]
    proxyRequests: readonly unknown[]
    proxyErrors: readonly unknown[]
    logs: readonly string[]
  }>
  close: () => Promise<void>
}>

async function createRealSessionRuntime(
  directory: string,
  claxedoServerUrl: string,
  createGateway: (request: Parameters<typeof createSessionV2WorkGraphGateway>[0]) => WorkGraphSessionGateway,
): Promise<RealSessionRuntime> {
  const records = new Map<string, RealSessionRecord>()
  const sessionConfigs = new Map<string, Record<string, unknown>>()
  let applicationTools: Readonly<Record<string, OpenCodeApplicationToolRegistration>> = {}
  const providerRequests: unknown[] = []
  const proxyErrors: unknown[] = []
  const provider = createServer(async (incoming, outgoing) => {
    const body = JSON.parse((await readIncomingBody(incoming)).toString() || "{}") as Record<string, unknown>
    providerRequests.push(body)
    const serialized = JSON.stringify(body)
    if (serialized.includes("Generate a title for this conversation")) {
      sendProviderText(outgoing, "WorkGraph execution")
      return
    }
    if (
      serialized.includes("You are the long-lived master for Stream") &&
      serialized.includes("Open the first public non-draft PR for the browser release")
    ) {
      const messages = Array.isArray(body.messages) ? body.messages : []
      const toolResults = messages.filter((message) => object(message)?.role === "tool").length
      const masterTurns = messages.filter((message) =>
        object(message)?.role === "user" && JSON.stringify(message).includes("You are the long-lived master for Stream")).length
      if ((masterTurns === 1 && toolResults === 0) || (masterTurns >= 2 && toolResults === 1)) {
        sendProviderTool(
          outgoing,
          masterTurns === 1 ? "call_master_open_pr_initial" : "call_master_open_pr_confirmed",
          "connection_code_host_open_pr",
          {
            connectionId: connectionHandle(serialized),
            repository: "claxedo/app",
            head: "workgraph/v2",
            base: "dev",
            title: "Release WorkGraph V2",
            body: "Release the verified WorkGraph V2 implementation.",
            draft: false,
            publicRepository: true,
            idempotencyKey: "workgraph-e2e:public-release",
          },
        )
        return
      }
      if (masterTurns >= 2 && toolResults >= 2) {
        sendProviderText(outgoing, JSON.stringify(messages.findLast((message) => object(message)?.role === "tool"))
          .includes("https://github.example/claxedo/app/pull/482")
          ? "Opened the confirmed public pull request with its durable receipt."
          : "The confirmed public pull request could not be opened.")
        return
      }
      sendProviderText(outgoing, "Held the first public pull request for owner confirmation.")
      return
    }
    if (serialized.includes("You are the long-lived master for Stream")) {
      sendProviderText(outgoing, "Processed the serialized master duty and preserved its durable receipts.")
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const toolResults = messages.filter((message) => object(message)?.role === "tool").length
    const directLedger = serialized.includes("Use one WorkGraph ledger call to add the owner-directed Task")
    const discoveredLedger = serialized.includes("Use one WorkGraph ledger call to file the discovered Task")
    if (directLedger || discoveredLedger) {
      const streamId = serialized.match(/(?:to|into) Stream ([A-Za-z0-9_:-]+)\./)?.[1]
      if (!streamId) throw new Error("Plain Session ledger prompt omitted its target Stream")
      const priorResults = discoveredLedger ? 1 : 0
      if (toolResults === priorResults) {
        sendProviderTool(outgoing, discoveredLedger ? "call_ledger_discovered" : "call_ledger_direct", "workgraph_ledger", {
          action: discoveredLedger ? "file_discovered" : "create_task",
          operation_id: discoveredLedger ? "e2e-ledger-file-discovered" : "e2e-ledger-create-direct",
          stream_id: streamId,
          title: discoveredLedger ? "Document rollout caveat" : "Capture launch checklist",
          completion_contract: {
            version: 1,
            mode: "all",
            requirements: [{
              id: discoveredLedger ? "ledger-discovered-proof" : "ledger-direct-proof",
              kind: "owner_confirmation",
              description: "The ledger entry is reviewed",
            }],
          },
        })
        return
      }
      if (!latestToolSucceeded(messages)) {
        sendProviderText(outgoing, "The WorkGraph ledger rejected the requested Task.")
        return
      }
      sendProviderText(outgoing, discoveredLedger
        ? "Filed the discovered Task as Staged with one WorkGraph ledger call."
        : "Filed the owner-directed Task with one WorkGraph ledger call.")
      return
    }
    const continueLedger = serialized.includes("Refresh the WorkGraph ledger, complete the first Task with evidence, and select the next ready Task.")
    if (continueLedger) {
      const results = successfulCommandResults(messages)
      const payloads = toolResultPayloads(messages)
      if (toolResults > 0 && payloads.length !== toolResults) {
        sendProviderText(outgoing, "The trusted WorkGraph ledger tool failed, so the current Session did not advance.")
        return
      }
      if (toolResults === 7) {
        sendProviderTool(outgoing, "call_ledger_refresh", "workgraph_refresh_context", {})
        return
      }
      if (toolResults === 8) {
        sendProviderTool(outgoing, "call_ledger_complete_first", "workgraph_complete_current_work", {
          operation_id: "e2e-ledger-complete-first",
          summary: "Completed the first bounded ledger Task",
          evidence: [{
            requirement_id: "ledger-first-proof",
            evidence: {
              kind: "test_result",
              summary: "The first logical boundary passed its focused verification",
              passed: true,
            },
          }],
        })
        return
      }
      if (toolResults === 9) {
        sendProviderTool(outgoing, "call_ledger_select_second", "workgraph_select_work", {
          operation_id: "e2e-ledger-select-second",
          work_item_id: commandResultId(results[3], "workItemId"),
        })
        return
      }
      if (toolResults === 10) {
        sendProviderTool(outgoing, "call_ledger_current", "workgraph_current_work", {})
        return
      }
      sendProviderText(outgoing, "Completed the first ledger Task and selected the next ready Task in this same Session.")
      return
    }
    const startLedger = serialized.includes("Maintain a bounded WorkGraph ledger in this Session and checkpoint the first Task.")
    if (startLedger) {
      const results = successfulCommandResults(messages)
      const payloads = toolResultPayloads(messages)
      if (toolResults > 0 && payloads.length !== toolResults) {
        sendProviderText(outgoing, "The trusted WorkGraph ledger tool failed, so no Session attachment was fabricated.")
        return
      }
      if (toolResults === 0) {
        sendProviderTool(outgoing, "call_ledger_create_stream", "workgraph_create_stream", {
          operation_id: "e2e-ledger-create-stream",
          title: "Long-running Session ledger",
          description: "A bounded ledger of meaningful verification boundaries.",
        })
        return
      }
      const streamId = commandResultId(results[0], "streamId")
      const completionContract = (id: string) => ({
        version: 1,
        mode: "all",
        requirements: [{
          id,
          kind: "test",
          description: "The logical boundary passes focused verification",
        }],
      })
      if (toolResults === 1) {
        sendProviderTool(outgoing, "call_ledger_pause", "workgraph_pause", {
          operation_id: "e2e-ledger-pause-stream",
          stream_id: streamId,
          expected_version: 1,
          reason: "Reserve this Stream for the bound project Session",
        })
        return
      }
      if (toolResults === 2) {
        sendProviderTool(outgoing, "call_ledger_create_first", "workgraph_create_task", {
          operation_id: "e2e-ledger-create-first",
          stream_id: streamId,
          title: "Verify the first ledger boundary",
          completion_contract: completionContract("ledger-first-proof"),
        })
        return
      }
      const firstTaskId = commandResultId(results[2], "workItemId")
      if (toolResults === 3) {
        sendProviderTool(outgoing, "call_ledger_create_second", "workgraph_create_task", {
          operation_id: "e2e-ledger-create-second",
          stream_id: streamId,
          title: "Verify the second ledger boundary",
          dependency_ids: [firstTaskId],
          completion_contract: completionContract("ledger-second-proof"),
        })
        return
      }
      if (toolResults === 4) {
        sendProviderTool(outgoing, "call_ledger_bind", "workgraph_bind_session", {
          operation_id: "e2e-ledger-bind",
          stream_id: streamId,
        })
        return
      }
      if (toolResults === 5) {
        sendProviderTool(outgoing, "call_ledger_select_first", "workgraph_select_work", {
          operation_id: "e2e-ledger-select-first",
          work_item_id: firstTaskId,
        })
        return
      }
      if (toolResults === 6) {
        sendProviderTool(outgoing, "call_ledger_checkpoint", "workgraph_record_progress", {
          operation_id: "e2e-ledger-checkpoint-first",
          level: "progress",
          summary: "First logical boundary verified",
        })
        return
      }
      sendProviderText(outgoing, "Bound this Session to the ledger and recorded the first meaningful checkpoint.")
      return
    }
    const chatCreation = serialized.includes("Use Claxedo MCP to create the WorkGraph stream MCP review pipeline with three dependent tasks.")
    if (chatCreation) {
      const results = successfulCommandResults(messages)
      if (toolResults > 0 && results.length !== toolResults) {
        sendProviderText(outgoing, "Claxedo MCP rejected the requested WorkGraph creation, so no substitute work was created.")
        return
      }
      if (toolResults === 0) {
        sendProviderTool(outgoing, "call_claxedo_create_stream", "claxedo_workgraph_create_stream", {
          operation_id: "e2e-chat-create-stream",
          title: "MCP review pipeline",
          description: "Review and verify the WorkGraph implementation through real project Sessions.",
        })
        return
      }
      const streamId = commandResultId(results[0], "streamId")
      const completionContract = {
        version: 1,
        mode: "all",
        requirements: [{
          id: "real-session-proof",
          kind: "test",
          description: "The real project Session completes through its scoped WorkGraph tool",
        }],
      }
      if (toolResults === 1) {
        sendProviderTool(outgoing, "call_claxedo_create_review", "claxedo_workgraph_create_task", {
          operation_id: "e2e-chat-create-review",
          stream_id: streamId,
          title: "Review the WorkGraph implementation",
          completion_contract: completionContract,
        })
        return
      }
      const reviewId = commandResultId(results[1], "workItemId")
      if (toolResults === 2) {
        sendProviderTool(outgoing, "call_claxedo_create_journeys", "claxedo_workgraph_create_task", {
          operation_id: "e2e-chat-create-journeys",
          stream_id: streamId,
          title: "Exercise the WorkGraph user journeys",
          dependency_ids: [reviewId],
          completion_contract: completionContract,
        })
        return
      }
      const journeysId = commandResultId(results[2], "workItemId")
      if (toolResults === 3) {
        sendProviderTool(outgoing, "call_claxedo_create_summary", "claxedo_workgraph_create_task", {
          operation_id: "e2e-chat-create-summary",
          stream_id: streamId,
          title: "Summarize the WorkGraph verification",
          dependency_ids: [journeysId],
          completion_contract: completionContract,
        })
        return
      }
      sendProviderText(outgoing, "Created MCP review pipeline with three dependency-ordered Tasks.")
      return
    }
    const connectionBound = serialized.includes("connection_work_source_comment")
    if (connectionBound && toolResults === 0) {
      const invocation = connectionInvocation(serialized)
      sendProviderTool(outgoing, "call_connection_comment", "connection_work_source_comment", {
        connectionId: invocation.connectionId,
        externalId: invocation.externalId,
        body: `Claxedo completed the requested work for ${invocation.externalId} in a project-scoped autonomous Session.`,
        idempotencyKey: `workgraph-e2e:${invocation.externalId}:result`,
      })
      return
    }
    if (connectionBound && toolResults === 1 && !latestToolSucceeded(messages)) {
      sendProviderText(outgoing, "The provider result was not accepted, so the WorkGraph Task remains incomplete.")
      return
    }
    if (toolResults === (connectionBound ? 1 : 0)) {
      sendProviderTool(outgoing, "call_workgraph_progress", "workgraph_report_progress", {
        level: "milestone",
        summary: "Verified the project-scoped Session and started the requested work",
      })
      return
    }
    if (toolResults === (connectionBound ? 2 : 1)) {
      const invocation = connectionBound ? connectionInvocation(serialized) : undefined
      const artifacts = serialized.includes("Prepare the master candidate")
        ? ["diff:master-candidate"]
        : serialized.includes("Verify the master landing")
          ? ["diff:master-landing"]
          : ["file:WORKGRAPH_REAL_SESSION_E2E.md"]
      sendProviderTool(outgoing, "call_workgraph_complete", "workgraph_complete_task", {
        summary: "Completed the WorkGraph Task through its real project Session",
        artifacts,
        evidence: [
          {
            requirementId: "real-session-proof",
            evidence: {
              kind: "test_result",
              summary: "The real Session V2 transcript and scoped completion tool both succeeded",
              passed: true,
              command: "workgraph real-session e2e",
            },
          },
          ...(invocation ? [{
            evidence: {
              kind: "integration",
              summary: `Published the result to external issue ${invocation.externalId}`,
              effect: "accepted_external_write",
              reference: `connection:${invocation.connectionId}:issue:${invocation.externalId}`,
            },
          }] : []),
        ],
      })
      return
    }
    sendProviderText(outgoing, "Completed the WorkGraph Task in the real project Session.")
  })
  const providerPort = await listen(provider, 0)
  const opencodePort = await availablePort()
  const applicationToolPlugin = path.join(directory, "workgraph-application-tools.mjs")
  const config = providerConfig(
    `http://127.0.0.1:${providerPort}/v1`,
    claxedoServerUrl,
    pathToFileURL(applicationToolPlugin).href,
  )
  const logs: string[] = []
  const proxyRequests: unknown[] = []
  let opencode: ReturnType<typeof spawn> | undefined
  const forward = async (request: Request) => {
    if (!opencode) throw new Error("OpenCode runtime is not configured")
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text()
    proxyRequests.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
    const configMatch = url.pathname.match(/^\/(?:api\/)?session\/([^/]+)\/config$/)
    if (configMatch && request.method === "GET") return Response.json(sessionConfigs.get(configMatch[1]!) ?? {})
    if (configMatch && request.method === "PATCH") {
      const update = object(JSON.parse(body || "{}")) ?? {}
      const harness = object(update.harness)
      const harnessId = typeof harness?.id === "string"
        ? harness.id
        : typeof harness?.type === "string"
          ? harness.type
          : undefined
      const next = {
        ...(sessionConfigs.get(configMatch[1]!) ?? {}),
        ...(harnessId ? { harness: { id: harnessId, access: "native" } } : {}),
        ...(object(update.model) || update.model === null ? { model: update.model } : {}),
        ...(typeof update.variant === "string" || update.variant === null ? { variant: update.variant } : {}),
        ...(typeof update.agent === "string" || update.agent === null ? { agent: update.agent } : {}),
      }
      sessionConfigs.set(configMatch[1]!, next)
      return Response.json(next)
    }
    headers.set("x-opencode-directory", url.searchParams.get("directory") ?? headers.get("x-opencode-directory") ?? repository)
    return fetch(`http://127.0.0.1:${opencodePort}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    }).then(async (response) => {
      if (!response.ok) proxyErrors.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        body: await response.clone().text(),
      })
      if (response.ok && request.method === "POST" && (url.pathname === "/session" || url.pathname === "/api/session")) {
        const responseBody = object(await response.clone().json())
        const session = object(responseBody?.data) ?? responseBody
        const sessionId = typeof session?.id === "string" ? session.id : undefined
        const location = object(session?.location)
        const sessionDirectory = typeof session?.directory === "string" && session.directory.trim()
          ? session.directory
          : typeof location?.directory === "string" && location.directory.trim()
            ? location.directory
            : headers.get("x-opencode-directory")
        if (!sessionId || !sessionDirectory) throw new Error("OpenCode Session creation omitted its identity or project directory")
        const timestamp = Date.now()
        records.set(sessionId, {
          sessionId,
          directory: sessionDirectory,
          title: typeof session?.title === "string" && session.title.trim() ? session.title : "New session",
          createdAt: records.get(sessionId)?.createdAt ?? timestamp,
          updatedAt: timestamp,
        })
      }
      return response
    })
  }
  const sessionGateway = createGateway(forward)
  const gateway: WorkGraphSessionGateway = {
    ...sessionGateway,
    admit: async (input) => {
      fs.writeFileSync(path.join(input.directory, "opencode.json"), JSON.stringify(config))
      const sessionId = await sessionGateway.admit(input)
      const timestamp = Date.now()
      records.set(sessionId, {
        sessionId,
        directory: input.directory,
        title: input.title,
        createdAt: records.get(sessionId)?.createdAt ?? timestamp,
        updatedAt: timestamp,
      })
      return sessionId
    },
  }
  return {
    gateway,
    records,
    fetch: forward,
    configureApplicationTools: async (tools) => {
      const diagT0 = Date.now()
      process.stderr.write(`[harness-diag] configureApplicationTools start +0ms\n`)
      applicationTools = tools
      fs.writeFileSync(
        applicationToolPlugin,
        applicationToolPluginSource(tools, `${claxedoServerUrl}/api/workgraph/application-tool`),
      )
      process.stderr.write(`[harness-diag] plugin written, spawning bun +${Date.now() - diagT0}ms\n`)
      opencode = spawn(
        "bun",
        ["run", "--conditions=browser", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(opencodePort)],
        {
          cwd: path.join(repository, "packages/opencode"),
          env: {
            ...process.env,
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
            WORKGRAPH_E2E_API_KEY: "test-key",
            XDG_CACHE_HOME: path.join(directory, "xdg-cache"),
            XDG_CONFIG_HOME: path.join(directory, "xdg-config"),
            XDG_DATA_HOME: path.join(directory, "xdg-data"),
            OPENCODE_DISABLE_AUTOSHARE: "true",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
      process.stderr.write(`[harness-diag] bun spawned pid=${opencode.pid}, waiting for health +${Date.now() - diagT0}ms\n`)
      opencode.stdout.on("data", (chunk) => logs.push(String(chunk)))
      opencode.stderr.on("data", (chunk) => logs.push(String(chunk)))
      await waitForOpenCode(opencodePort, opencode, logs)
      process.stderr.write(`[harness-diag] opencode healthy +${Date.now() - diagT0}ms\n`)
    },
    invokeApplicationTool: async (input) => {
      const invocation = object(input)
      const sessionID = typeof invocation?.sessionID === "string" ? invocation.sessionID : undefined
      const name = typeof invocation?.name === "string" ? invocation.name : undefined
      const toolCallID = typeof invocation?.toolCallID === "string" ? invocation.toolCallID : undefined
      if (!sessionID || !name || !toolCallID) throw new Error("Application tool callback omitted its Session, tool, or call identity")
      if (!records.has(sessionID)) throw new Error(`Application tool callback referenced unknown Session ${sessionID}`)
      const tool = applicationTools[name]
      if (!tool) throw new Error(`Application tool callback referenced unknown tool ${name}`)
      return tool.execute(invocation.input, {
        sessionID,
        agent: "build",
        assistantMessageID: "e2e-application-tool",
        toolCallID,
      })
    },
    diagnostics: () => ({
      providerRequests: providerRequests.length,
      toolResults: providerRequests.flatMap((request) => {
        const messages = object(request)?.messages
        if (!Array.isArray(messages)) return []
        return messages.flatMap((message) => object(message)?.role === "tool" ? [object(message)?.content] : [])
      }),
      proxyRequests: proxyRequests.slice(-80),
      proxyErrors: proxyErrors.slice(-40),
      logs: logs.slice(-40),
    }),
    close: async () => {
      await closeServer(provider)
      if (!opencode) return
      if (opencode.exitCode === null) opencode.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        if (opencode.exitCode !== null) return resolve()
        const timeout = setTimeout(() => {
          if (opencode.exitCode === null) opencode.kill("SIGKILL")
          resolve()
        }, 5_000)
        opencode.once("exit", () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    },
  }
}

function latestToolSucceeded(messages: unknown[]) {
  const content = object(messages.findLast((message) => object(message)?.role === "tool"))?.content
  if (typeof content !== "string") return false
  try {
    return object(JSON.parse(content))?.ok === true
  } catch {
    return false
  }
}

function successfulCommandResults(messages: unknown[]) {
  return messages.flatMap((message) => {
    if (object(message)?.role !== "tool") return []
    const result = successfulCommandResult(object(message)?.content)
    return result ? [result] : []
  })
}

function toolResultPayloads(messages: unknown[]) {
  return messages.flatMap((message) => {
    if (object(message)?.role !== "tool") return []
    const result = toolResultPayload(object(message)?.content)
    return result ? [result] : []
  })
}

function toolResultPayload(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    try {
      return toolResultPayload(JSON.parse(input))
    } catch {
      return
    }
  }
  if (Array.isArray(input)) return input.map(toolResultPayload).find((result) => result !== undefined)
  const value = object(input)
  if (!value) return
  if (typeof value.ok === "boolean" || typeof value.recordType === "string" || "binding" in value) return value
  return [value.output, value.text, value.content, value.value]
    .map(toolResultPayload)
    .find((result) => result !== undefined)
}

function successfulCommandResult(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    try {
      return successfulCommandResult(JSON.parse(input))
    } catch {
      return
    }
  }
  if (Array.isArray(input)) return input.map(successfulCommandResult).find((result) => result !== undefined)
  const value = object(input)
  if (!value) return
  if (value.ok === true && object(value.value)) return value
  return [value.output, value.text, value.content, value.value]
    .map(successfulCommandResult)
    .find((result) => result !== undefined)
}

function commandResultId(result: Record<string, unknown> | undefined, key: string) {
  const value = object(result?.value)?.[key]
  if (typeof value !== "string" || !value) throw new Error(`Claxedo MCP result omitted ${key}`)
  return value
}

function providerConfig(baseUrl: string, claxedoServerUrl: string, applicationToolPlugin: string) {
  return {
    formatter: false,
    lsp: false,
    model: "workgraph-e2e/workgraph-model",
    plugin: [applicationToolPlugin],
    mcp: {
      claxedo: {
        type: "local",
        command: ["bun", "run", path.join(repository, "packages/claxedo-mcp/src/server.ts")],
        environment: {
          CLAXEDO_SERVER_URL: claxedoServerUrl,
          OPENCODE_API_DIR: repository,
        },
      },
    },
    provider: {
      "workgraph-e2e": {
        name: "WorkGraph E2E",
        id: "workgraph-e2e",
        env: ["WORKGRAPH_E2E_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "workgraph-model": {
            id: "workgraph-model",
            name: "WorkGraph Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            variants: { high: {} },
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: baseUrl },
      },
    },
  }
}

function applicationToolPluginSource(
  tools: Readonly<Record<string, OpenCodeApplicationToolRegistration>>,
  callbackUrl: string,
) {
  const definitions = Object.fromEntries(Object.entries(tools).map(([name, registration]) => {
    const properties = object(registration.inputSchema.properties) ?? {}
    const required = Array.isArray(registration.inputSchema.required)
      ? registration.inputSchema.required.filter((key): key is string => typeof key === "string")
      : []
    return [name, {
      description: registration.description,
      args: Object.fromEntries(required.flatMap((key) => key in properties ? [[key, properties[key]]] : [])),
    }]
  }))
  return [
    `const callbackUrl = ${JSON.stringify(callbackUrl)}`,
    `const definitions = ${JSON.stringify(definitions)}`,
    "export default async () => ({",
    "  tool: Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, {",
    "    description: definition.description,",
    "    args: definition.args,",
    "    execute: async (input, context) => {",
    "      const response = await fetch(callbackUrl, {",
    "        method: 'POST',",
    "        headers: { 'content-type': 'application/json' },",
    "        body: JSON.stringify({ sessionID: context.sessionID, name, input, toolCallID: context.callID }),",
    "      })",
    "      if (!response.ok) throw new Error(`Application tool callback failed: ${response.status} ${await response.text()}`)",
    "      return JSON.stringify(await response.json())",
    "    },",
    "  }]))",
    "})",
    "",
  ].join("\n")
}

function sendProviderText(outgoing: ServerResponse, text: string) {
  sendProviderEvents(outgoing, [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: providerUsage() },
  ])
}

function sendProviderTool(outgoing: ServerResponse, id: string, name: string, input: unknown) {
  sendProviderEvents(outgoing, [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: providerUsage() },
  ])
}

function sendProviderEvents(outgoing: ServerResponse, events: unknown[]) {
  outgoing.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  events.forEach((event) => outgoing.write(`data: ${JSON.stringify(event)}\n\n`))
  outgoing.end("data: [DONE]\n\n")
}

function providerUsage() {
  return { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
}

async function availablePort() {
  const server = createServer()
  const port = await listen(server, 0)
  await closeServer(server)
  return port
}

async function waitForOpenCode(port: number, process: ReturnType<typeof spawn>, logs: string[]) {
  const diagT0 = Date.now()
  // Budget the whole boot rather than a fixed attempt count, and bound every
  // probe with an AbortSignal timeout. On a cold CI runner the engine's first
  // `bun run ./src/index.ts serve` transpiles the entire Effect server tree on
  // demand: `NodeHttpServer.layer` binds the listen socket early in that layer
  // build, but the request handler is only wired once the (slow, cold) route
  // layer finishes building. In that window the socket accepts the TCP
  // connection yet never answers — and an *untimed* fetch sends its request into
  // that void and hangs forever, because Node's HTTP parser consumes the request
  // before any `request` listener exists and never replays it once the handler
  // attaches. That is exactly the observed ~240s silent hook timeout (no throw,
  // no per-attempt log). Timing out each probe lets the loop keep retrying with
  // fresh connections until the handler is live, and the total deadline turns a
  // genuinely stuck boot into a fast failure that carries the engine's own logs.
  const deadlineMs = 120_000
  let attempt = 0
  while (Date.now() - diagT0 < deadlineMs) {
    attempt++
    if (process.exitCode !== null) throw new Error(`OpenCode exited before readiness:\n${logs.join("")}`)
    const fetchT0 = Date.now()
    const ready = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: AbortSignal.timeout(2_000),
    }).then((response) => response.ok, () => false)
    const fetchMs = Date.now() - fetchT0
    // Unconditional (throttled) per-attempt checkpoint so CI shows the probe loop
    // is progressing and pinpoints where a boot stalls instead of going silent.
    if (attempt <= 3 || attempt % 10 === 0 || fetchMs > 500)
      console.error(
        `[harness-diag] waitForOpenCode attempt ${attempt} ready=${ready} fetch=${fetchMs}ms (total +${Date.now() - diagT0}ms)`,
      )
    if (ready) {
      console.error(`[harness-diag] waitForOpenCode ready at attempt ${attempt}, total +${Date.now() - diagT0}ms`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode did not become ready within ${deadlineMs}ms:\n${logs.join("")}`)
}

function object(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function readIncomingBody(incoming: IncomingMessage) {
  const chunks: Buffer[] = []
  for (let chunk = incoming.read(); chunk !== null; chunk = incoming.read()) chunks.push(Buffer.from(chunk))
  if (incoming.complete || incoming.readableEnded) return Promise.resolve(Buffer.concat(chunks))
  return new Promise<Buffer>((resolve, reject) => {
    incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    incoming.on("end", () => resolve(Buffer.concat(chunks)))
    incoming.on("error", reject)
  })
}

async function respond(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  port: number,
  embedded: LocalEmbeddedWorkGraph,
  realSessions: RealSessionRuntime | undefined,
  connectionsRequest: (request: Request) => Promise<Response>,
  failure: () => unknown,
  controller: AbortController,
) {
  const abort = () => controller.abort()
  const abortIncompleteResponse = () => {
    if (!outgoing.writableEnded) controller.abort()
  }
  incoming.on("aborted", abort)
  outgoing.on("close", abortIncompleteResponse)
  try {
    if (incoming.method === "OPTIONS") {
      outgoing.statusCode = 204
      setCors(outgoing)
      outgoing.end()
      return
    }
    if (incoming.method === "GET" && incoming.url === "/api/claxedo/health") {
      const error = failure()
      outgoing.statusCode = error ? 500 : 200
      outgoing.setHeader("content-type", "application/json")
      setCors(outgoing)
      outgoing.end(JSON.stringify(error
        ? { ok: false, error: error instanceof Error ? error.message : String(error) }
        : { ok: true, harnessMode: "workspace", workspaceProfile: "workspace", localExecution: true }))
      return
    }
    const url = new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`)
    const pathname = url.pathname
    if (incoming.method === "POST" && pathname === "/api/workgraph/application-tool") {
      if (!realSessions) throw new Error("Application tool callback requires the real Session runtime")
      sendJson(outgoing, await realSessions.invokeApplicationTool(JSON.parse((await readIncomingBody(incoming)).toString() || "{}")))
      return
    }
    if (pathname === "/api/claxedo/integrations" || pathname.startsWith("/api/claxedo/integrations/")) {
      const body = await readIncomingBody(incoming)
      const routeUrl = new URL(url)
      routeUrl.pathname = pathname.replace(/^\/api\/claxedo\/integrations/, "") || "/"
      const response = await connectionsRequest(new Request(routeUrl, {
        method: incoming.method,
        headers: Object.entries(incoming.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]),
        ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: body.toString() }),
      }))
      outgoing.statusCode = response.status
      response.headers.forEach((value, key) => outgoing.setHeader(key, value))
      setCors(outgoing)
      outgoing.end(Buffer.from(await response.arrayBuffer()))
      return
    }
    if (incoming.method === "GET" && (pathname === "/project" || pathname === "/experimental/project")) {
      sendJson(outgoing, [workGraphProject(realSessions)])
      return
    }
    if (incoming.method === "PATCH" && /^\/project\/[^/]+$/.test(pathname)) {
      sendJson(outgoing, workGraphProject(realSessions))
      return
    }
    if (incoming.method === "GET" && pathname === "/path") {
      sendJson(outgoing, { worktree: repository })
      return
    }
    if (incoming.method === "GET" && pathname === "/api/workspace/resolve") {
      const target = url.searchParams.get("directory")
      if (!target || !path.isAbsolute(target)) {
        outgoing.statusCode = 400
        setCors(outgoing)
        outgoing.end(JSON.stringify({ error: { message: "Workspace directory is required" } }))
        return
      }
      sendJson(outgoing, {
        workspaceId: `workspace_${Buffer.from(target).toString("base64url")}`,
        directory: target,
        kind: "local",
        status: "ready",
      })
      return
    }
    if (incoming.method === "GET" && pathname === "/api/control/session-list") {
      const query = parseSessionListQuery(url)
      sendJson(outgoing, buildSessionListResponse({
        query,
        sessions: [...(realSessions?.records.values() ?? [])].map((session) => ({
          sessionID: session.sessionId,
          projectID: "project_workgraph_e2e",
          workspaceID: session.directory,
          directory: session.directory,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          tags: [],
          attachments: [],
        })),
      }))
      return
    }
    const sessionMeta = pathname.match(/^\/api\/claxedo\/session\/([^/]+)\/meta$/)
    if (incoming.method === "GET" && sessionMeta) {
      const session = realSessions?.records.get(decodeURIComponent(sessionMeta[1]!))
      if (!session) {
        outgoing.statusCode = 404
        setCors(outgoing)
        outgoing.end(JSON.stringify({ error: { message: "Session unavailable" } }))
        return
      }
      sendJson(outgoing, {
        sessionID: session.sessionId,
        directory: session.directory,
        title: session.title,
      })
      return
    }
    const body = await readIncomingBody(incoming)
    if (realSessions && !pathname.startsWith("/api/workgraph")) {
      const response = await realSessions.fetch(new Request(url, {
        method: incoming.method,
        headers: Object.entries(incoming.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]),
        signal: controller.signal,
        ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: body.toString() }),
      }))
      if (controller.signal.aborted || outgoing.destroyed) return
      outgoing.statusCode = response.status
      response.headers.forEach((value, key) => {
        if (key !== "content-encoding" && key !== "content-length") outgoing.setHeader(key, value)
      })
      setCors(outgoing)
      outgoing.end(Buffer.from(await response.arrayBuffer()))
      return
    }
    const requestPath = (incoming.url ?? "/").replace(/^\/api\/workgraph/, "") || "/"
    const request = new Request(`http://127.0.0.1:${port}${requestPath}`, {
      method: incoming.method,
      headers: Object.entries(incoming.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]),
      signal: controller.signal,
      ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: body.toString() }),
    })
    const response = await embedded.router.fetch(request)
    if (controller.signal.aborted || outgoing.destroyed) return
    outgoing.statusCode = response.status
    response.headers.forEach((value, key) => outgoing.setHeader(key, value))
    setCors(outgoing)
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    if (controller.signal.aborted) return
    throw error
  } finally {
    incoming.off("aborted", abort)
    outgoing.off("close", abortIncompleteResponse)
  }
}

function workGraphProject(realSessions: RealSessionRuntime | undefined) {
  const directories = [...new Set([...(realSessions?.records.values() ?? [])].map((session) => session.directory))]
  return {
    id: "project_workgraph_e2e",
    worktree: repository,
    name: "Claxedo",
    sandboxes: directories,
    workspaces: Object.fromEntries(directories.map((directory) => [directory, {
      id: directory,
      kind: "local",
      workspace_name: "WorkGraph",
      directory,
      available: true,
    }])),
    time: { created: Date.now(), updated: Date.now() },
  }
}

function sendJson(response: ServerResponse, value: unknown) {
  response.statusCode = 200
  response.setHeader("content-type", "application/json")
  setCors(response)
  response.end(JSON.stringify(value))
}

function setCors(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
  response.setHeader(
    "access-control-allow-headers",
    "authorization,content-type,x-request-id,x-opencode-directory,x-claxedo-idempotency-retry,x-claxedo-draft-id",
  )
}

function listen(server: Server, port: number) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("WorkGraph E2E server did not expose a TCP port"))
      resolve(address.port)
    })
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
    // Playwright's APIRequestContext keeps completed HTTP/1.1 sockets alive.
    // Sweep idle sockets after stopping admission; the caller then aborts active
    // requests and destroys only sockets accepted by this harness.
    server.closeIdleConnections()
  })
}
