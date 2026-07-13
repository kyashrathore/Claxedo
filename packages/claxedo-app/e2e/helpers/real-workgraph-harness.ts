import fs from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import type { WorkGraphContext, WorkSourceRevisionRef } from "@claxedo/workgraph/contracts"
import { createLocalEmbeddedWorkGraph, type LocalEmbeddedWorkGraph } from "../../../claxedo-server/src/server-workgraph"
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
  assertHealthy: () => void
  close: () => Promise<void>
}>

type ControlledExecutionResult =
  | Readonly<{ state: "succeeded"; summary: string; artifacts: readonly string[] }>
  | Readonly<{ state: "failed"; message: string }>

export async function createRealWorkGraphHarness(input: Readonly<{
  port: number
  temporaryRoot?: string
  reconcileIntervalMs?: number
}>): Promise<RealWorkGraphHarness> {
  fs.mkdirSync(input.temporaryRoot ?? os.tmpdir(), { recursive: true })
  const directory = fs.mkdtempSync(path.join(input.temporaryRoot ?? os.tmpdir(), "claxedo-workgraph-browser-"))
  const database = new Database(path.join(directory, "workgraph.sqlite"))
  const queuedExecutionResults: ControlledExecutionResult[] = []
  const attempts = new Map<string, "running" | ControlledExecutionResult>()
  const execution = createLocalWorkspaceExecution({
    worktreeRoot: path.join(directory, "worktrees"),
    repositoryDirectory: async () => repository,
    sessions: {
      admit: async ({ attemptId, sessionId }) => {
        const adopted = sessionId ?? `session:${attemptId}`
        attempts.set(adopted, "running")
        const result = queuedExecutionResults.shift() ?? {
          state: "succeeded" as const,
          summary: "Controlled Session completed",
          artifacts: ["commit:browser-e2e"],
        }
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
  let now = Date.now()
  const embedded = await createLocalEmbeddedWorkGraph({
    database,
    execution,
    sourcePlanning: { sessions: generationSessions, directory: repository },
    recaps: { sessions: generationSessions, directory: repository, clock: { now: () => now } },
  })
  let backgroundFailure: unknown
  let background = Promise.resolve<unknown>(undefined)
  const context = (): WorkGraphContext => ({
    ownerUserId: "local" as never,
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
  const server = createServer((incoming, outgoing) => {
    void respond(incoming, outgoing, input.port, embedded, () => backgroundFailure).catch((error) => {
      capture(error)
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500
        outgoing.setHeader("content-type", "application/json")
        setCors(outgoing)
      }
      if (!outgoing.writableEnded) outgoing.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    })
  })
  await listen(server, input.port)
  const reconcile = setInterval(() => {
    void serialized(() => embedded.reconcile(context())).catch(() => undefined)
  }, input.reconcileIntervalMs ?? 50)
  let closed = false

  return {
    apiUrl: `http://127.0.0.1:${input.port}`,
    directory,
    embedded,
    advanceTime: (milliseconds) => { now += milliseconds },
    queueExecutionResults: (...results) => { queuedExecutionResults.push(...results) },
    worktreeDirectory: (streamId) => path.join(directory, "worktrees", encode("local"), encode(streamId), "envelope"),
    runReconcile: () => serialized(() => embedded.reconcile(context())),
    runSourcePlanning: () => serialized(() => embedded.sourcePlanning.runDue(context())),
    scheduleRecaps: () => serialized(() => embedded.recaps.scheduleDue(context())),
    runRecap: () => serialized(() => embedded.recaps.runDue(context())),
    assertHealthy: () => {
      if (backgroundFailure) throw backgroundFailure
    },
    close: async () => {
      if (closed) return
      closed = true
      clearInterval(reconcile)
      await background
      await closeServer(server)
      database.close()
      fs.rmSync(directory, { recursive: true, force: true })
      spawnSync("git", ["-C", repository, "worktree", "prune"], { stdio: "ignore" })
      if (backgroundFailure) throw backgroundFailure
    },
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
        return {
          state: "succeeded",
          summary: JSON.stringify({
            source,
            suggestedPlacement: { mode: "new_stream", streamTitle: "Planned from AI context" },
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
) {
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
    ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body }),
  })
  const response = await embedded.router.fetch(request)
  outgoing.statusCode = response.status
  response.headers.forEach((value, key) => outgoing.setHeader(key, value))
  setCors(outgoing)
  outgoing.end(Buffer.from(await response.arrayBuffer()))
}

function setCors(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS")
  response.setHeader("access-control-allow-headers", "authorization,content-type,x-request-id")
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}
