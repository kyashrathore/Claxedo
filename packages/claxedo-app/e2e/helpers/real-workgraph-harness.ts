import fs from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
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
import type { SourceIssueConnector } from "@claxedo/workgraph/connectors"
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
import { buildSessionListResponse, parseSessionListQuery } from "../../../claxedo-server/src/session-list"

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
  scheduleRecaps: () => ReturnType<LocalEmbeddedWorkGraph["recaps"]["scheduleDue"]>
  runRecap: () => ReturnType<LocalEmbeddedWorkGraph["recaps"]["runDue"]>
  completeControlledAttempt: (
    workItemId: string,
    summary: string,
    artifacts: readonly string[],
  ) => Promise<CommandResult>
  projectIndependentSession: (input: Readonly<{ sessionId: string; title: string; summary: string }>) => Promise<"created" | "existing" | "ignored">
  connectionEvidence: () => Readonly<{
    requests: readonly ControlledSourceIssueRequest[]
    effects: readonly ControlledSourceIssueEffect[]
    connectionId: string
    connectionIds: Readonly<Record<"github" | "linear" | "jira", string>>
  }>
  controlledExecutionDiagnostics: () => Readonly<{
    queued: readonly ControlledExecutionResult[]
    attempts: readonly (readonly [string, "running" | ControlledExecutionResult])[]
    durableAttempts: readonly unknown[]
    leases: readonly unknown[]
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
}>): Promise<RealWorkGraphHarness> {
  fs.mkdirSync(input.temporaryRoot ?? os.tmpdir(), { recursive: true })
  const directory = fs.mkdtempSync(path.join(input.temporaryRoot ?? os.tmpdir(), "claxedo-workgraph-browser-"))
  const database = new Database(path.join(directory, "workgraph.sqlite"))
  const queuedExecutionResults: ControlledExecutionResult[] = []
  const attempts = new Map<string, "running" | ControlledExecutionResult>()
  const sourceIssueRequests: ControlledSourceIssueRequest[] = []
  const sourceIssueEffects: ControlledSourceIssueEffect[] = []
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
  let executeAttempt: ((context: WorkGraphContext, request: WorkGraphAttemptOperationRequest) => Promise<CommandResult>) | undefined
  const realSessions = input.realSessions
    ? await createRealSessionRuntime(directory, (forward) => createSessionV2WorkGraphGateway(forward, {
        executeAttempt: (context, request, signal) => {
          if (signal.aborted) throw signal.reason
          if (!executeAttempt) throw new Error("WorkGraph Attempt command broker is not ready")
          return executeAttempt(context, request)
        },
        connections,
        connectors: Object.fromEntries(sourceIssueConnectors.map((connector) => [connector.provider, connector])),
        resolveTeamOwner: (context) => `org:${context.organizationId}`,
      }))
    : undefined
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
  const embedded = await createLocalEmbeddedWorkGraph({
    database,
    ...(input.trustedAuthContexts ? { auth: trustedAuth(input.trustedAuthContexts) } : {}),
    execution,
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
      readConnections: async (context) => (await connections.list({
        owner: context.ownerUserId,
        teamOwner: `org:${context.organizationId}`,
      })).flatMap((connection) => connection.status === "connected" ? [{
          id: connection.id as never,
          integrationId: connection.integrationId,
          scope: connection.scope,
          grantedCapabilities: connection.grantedCapabilities,
          ...(connection.accountLabel ? { accountLabel: connection.accountLabel } : {}),
        }] : []),
      connectionToolIds: WorkGraphConnectionToolNames,
      now: () => now,
    }),
    sourcePlanning: { sessions: generationSessions, directory: repository },
    recaps: { sessions: generationSessions, directory: repository, clock: { now: () => now } },
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
    scheduleRecaps: () => serialized(() => embedded.recaps.scheduleDue(context())),
    runRecap: () => serialized(() => embedded.recaps.runDue(context())),
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
      if (request.title.startsWith("Recap: ")) {
        return {
          state: "succeeded",
          summary: JSON.stringify({
            summary: "Stream activity is ready for review.",
            actionableReferences: [{ type: "stream", id: recapStreamId(request.prompt) }],
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
  const connectionId = serializedRequest.match(/Trusted Connection handles:\\n- ([^\\"]+)/)?.[1]
    ?? serializedRequest.match(/Trusted Connection handles:\n- ([^\n]+)/)?.[1]
  const externalId = serializedRequest.match(/\\?"externalId\\?":\s*\\?"([^"\\]+)\\?"/)?.[1]
  if (!connectionId || !externalId) {
    throw new Error("Connection-bound real Session prompt omitted its trusted Connection or external issue identity")
  }
  return { connectionId, externalId }
}

function recapStreamId(prompt: string) {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith("Stream: "))
  const separator = line?.lastIndexOf(" (") ?? -1
  if (!line || separator < 0 || !line.endsWith(")")) throw new Error("Recap prompt omitted its Stream identity")
  return line.slice(separator + 2, -1)
}

type RealSessionRuntime = Readonly<{
  gateway: WorkGraphSessionGateway
  records: Map<string, RealSessionRecord>
  fetch: (request: Request) => Promise<Response>
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
  createGateway: (request: Parameters<typeof createSessionV2WorkGraphGateway>[0]) => WorkGraphSessionGateway,
): Promise<RealSessionRuntime> {
  const records = new Map<string, RealSessionRecord>()
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
    const messages = Array.isArray(body.messages) ? body.messages : []
    const toolResults = messages.filter((message) => object(message)?.role === "tool").length
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
      sendProviderTool(outgoing, "call_workgraph_complete", "workgraph_complete_task", {
        summary: "Completed the WorkGraph Task through its real project Session",
        artifacts: ["file:WORKGRAPH_REAL_SESSION_E2E.md"],
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
  const config = providerConfig(`http://127.0.0.1:${providerPort}/v1`)
  const opencode = spawn(
    "bun",
    ["run", "--conditions=browser", "./src/index.ts", "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(opencodePort)],
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const logs: string[] = []
  const proxyRequests: unknown[] = []
  opencode.stdout.on("data", (chunk) => logs.push(String(chunk)))
  opencode.stderr.on("data", (chunk) => logs.push(String(chunk)))
  await waitForOpenCode(opencodePort, opencode, logs)
  const forward = async (request: Request) => {
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text()
    proxyRequests.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
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

function providerConfig(baseUrl: string) {
  return {
    formatter: false,
    lsp: false,
    model: "workgraph-e2e/workgraph-model",
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
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error(`OpenCode exited before readiness:\n${logs.join("")}`)
    const ready = await fetch(`http://127.0.0.1:${port}/global/health`).then((response) => response.ok, () => false)
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode did not become ready:\n${logs.join("")}`)
}

function object(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function readIncomingBody(incoming: NodeJS.ReadableStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
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
  response.setHeader("access-control-allow-headers", "authorization,content-type,x-request-id,x-opencode-directory,x-claxedo-idempotency-retry")
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
