import fs from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  createAttempts,
  createConnectionsService,
  createIntegrationRegistry,
  createMemoryConnectionStore,
  createMemoryCredentialStore,
} from "../../../claxedo-connections/src/index"
import { createSessionIntakeService } from "@claxedo/workgraph"
import type { SourceIssueConnector } from "@claxedo/workgraph/connectors"
import { WorkGraphConnectionToolNames, type WorkGraphContext, type WorkSourceRevisionRef } from "@claxedo/workgraph/contracts"
import type { WorkspaceAuthority } from "../../../claxedo-server/src/control-plane/authority"
import {
  createLocalEmbeddedWorkGraph,
  type LocalEmbeddedWorkGraph,
  type LocalWorkGraphAuthOptions,
} from "../../../claxedo-server/src/server-workgraph"
import { createExecutionCapabilitiesPort } from "../../../claxedo-server/src/workgraph-host/execution-capabilities"
import { createLocalWorkspaceExecution, type WorkGraphSessionGateway } from "../../../claxedo-server/src/workgraph-host/local-execution"

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
  projectIndependentSession: (input: Readonly<{ sessionId: string; title: string; summary: string }>) => Promise<"created" | "existing" | "ignored">
  connectionEvidence: () => Readonly<{ requests: readonly ControlledSourceIssueRequest[]; connectionId: string }>
  assertHealthy: () => void
  close: () => Promise<void>
}>

type ControlledExecutionResult =
  | Readonly<{ state: "succeeded"; summary: string; artifacts: readonly string[] }>
  | Readonly<{ state: "failed"; message: string }>

type ControlledSourceIssueRequest = Readonly<{
  providerUserId: string
  filters: Readonly<Record<string, string>>
  authorized: boolean
}>

export async function createRealWorkGraphHarness(input: Readonly<{
  port: number
  temporaryRoot?: string
  reconcileIntervalMs?: number
  organizationId?: string
  ownerUserId?: string
  trustedAuthContexts?: Readonly<Record<string, Readonly<{ organizationId: string; ownerUserId: string }>>>
}>): Promise<RealWorkGraphHarness> {
  fs.mkdirSync(input.temporaryRoot ?? os.tmpdir(), { recursive: true })
  const directory = fs.mkdtempSync(path.join(input.temporaryRoot ?? os.tmpdir(), "claxedo-workgraph-browser-"))
  const database = new Database(path.join(directory, "workgraph.sqlite"))
  const queuedExecutionResults: ControlledExecutionResult[] = []
  const attempts = new Map<string, "running" | ControlledExecutionResult>()
  const sourceIssueRequests: ControlledSourceIssueRequest[] = []
  let now = Date.now()
  const organizationId = input.organizationId ?? "local"
  const ownerUserId = input.ownerUserId ?? "local"
  const teamOwner = `org:${organizationId}`
  const registry = createIntegrationRegistry()
  registry.register({
    id: "github",
    name: "GitHub",
    methods: ["key"],
    capabilities: ["code-host", "work-source"],
    keyTokenType: "bearer",
    prompts: [{ id: "token", label: "Token", secret: true }],
  }, { verify: async () => ({ ok: true as const, accountLabel: "claxedo/claxedo" }) })
  const connections = createConnectionsService({
    registry,
    credentials: createMemoryCredentialStore(),
    connections: createMemoryConnectionStore(),
    attempts: createAttempts({ sweepIntervalMs: 0 }),
    newId: () => "connection_browser_github",
    now: () => now,
  })
  const connected = await connections.connect({ integrationId: "github", owner: teamOwner, fields: {}, secret: "browser-e2e-secret" })
  if (!connected.ok) throw new Error(`Controlled GitHub Connection failed: ${connected.code}`)
  const github: SourceIssueConnector = {
    provider: "github",
    async list(authorization, request) {
      sourceIssueRequests.push({
        providerUserId: request.providerUserId,
        filters: request.filters,
        authorized: authorization.token === "browser-e2e-secret" && authorization.tokenType === "bearer",
      })
      return {
        issues: [{
          externalId: "101",
          externalKey: "#101",
          externalUrl: "https://github.example/claxedo/claxedo/issues/101",
          title: "Connection-filtered launch issue",
          body: "Reached through the team GitHub Connection with the owner's source filter.",
          status: "open",
          updatedAt: now,
          revision: "browser-e2e-1",
        }],
      }
    },
    async comment() { throw new Error("Controlled GitHub connector did not expect a comment") },
    async update() { throw new Error("Controlled GitHub connector did not expect an update") },
  }
  const execution = createLocalWorkspaceExecution({
    worktreeRoot: path.join(directory, "worktrees"),
    repositoryDirectory: async () => repository,
    sessions: {
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
    sourceIssueConnectors: [github],
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
          connected: ["openai"],
          all: [{ id: "openai", models: { "gpt-5": { id: "gpt-5", name: "GPT-5", variants: { high: {} } } } }],
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
  let backgroundFailure: unknown
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
    void respond(incoming, outgoing, input.port, embedded, () => backgroundFailure, request.controller)
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
  const reconcile = setInterval(() => {
    void serialized(() => embedded.reconcile(context())).catch(() => undefined)
  }, input.reconcileIntervalMs ?? 50)
  let closing: Promise<void> | undefined

  return {
    apiUrl: `http://127.0.0.1:${port}`,
    directory,
    embedded,
    advanceTime: (milliseconds) => { now += milliseconds },
    queueExecutionResults: (...results) => { queuedExecutionResults.push(...results) },
    worktreeDirectory: (streamId) => path.join(directory, "worktrees", encode(organizationId), encode(ownerUserId), encode(streamId), "envelope"),
    runReconcile: () => serialized(() => embedded.reconcile(context())),
    runSourcePlanning: () => serialized(() => embedded.sourcePlanning.runDue(context())),
    scheduleRecaps: () => serialized(() => embedded.recaps.scheduleDue(context())),
    runRecap: () => serialized(() => embedded.recaps.runDue(context())),
    projectIndependentSession: (session) => serialized(() => createSessionIntakeService(embedded.sessionIntake).onIdle(context(), {
      ...session,
      meaningful: true,
      becameIdleAt: now,
    })),
    connectionEvidence: () => ({ requests: [...sourceIssueRequests], connectionId: "connection_browser_github" }),
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
        database.close()
        fs.rmSync(directory, { recursive: true, force: true })
        spawnSync("git", ["-C", repository, "worktree", "prune"], { stdio: "ignore" })
        if (backgroundFailure) throw backgroundFailure
      })()
      return closing
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
        return {
          state: "succeeded",
          summary: JSON.stringify({
            source,
            suggestedPlacement: evidence.targetStreamId
              ? { mode: "existing", streamId: evidence.targetStreamId }
              : { mode: "new_stream", streamTitle: "Planned from AI context" },
            placementMatches: [],
            proposedOutcomes: [{
              key: "launch-ready",
              title: "Launch is ready",
              successCriteria: ["Launch readiness is verified"],
              execution: {},
            }],
            proposedWorkItems: [{
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

function recapStreamId(prompt: string) {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith("Stream: "))
  const separator = line?.lastIndexOf(" (") ?? -1
  if (!line || separator < 0 || !line.endsWith(")")) throw new Error("Recap prompt omitted its Stream identity")
  return line.slice(separator + 2, -1)
}

async function respond(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  port: number,
  embedded: LocalEmbeddedWorkGraph,
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
    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      incoming.on("end", () => resolve(Buffer.concat(chunks)))
      incoming.on("error", reject)
    })
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

function setCors(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS")
  response.setHeader("access-control-allow-headers", "authorization,content-type,x-request-id")
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
