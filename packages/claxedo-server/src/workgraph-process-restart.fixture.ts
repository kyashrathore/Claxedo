import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { Hono } from "hono"
import type { ExecutionCapabilitiesPort, ExecutionResult } from "@claxedo/workgraph"
import { EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import { createLocalEmbeddedWorkGraph, mountEmbeddedWorkGraph } from "./server-workgraph"
import { createLocalWorkspaceExecution, type WorkGraphSessionGateway } from "./workgraph-host/local-execution"

const databasePath = requiredEnvironment("CLAXEDO_TEST_WORKGRAPH_DATABASE")
const repositoryDirectory = requiredEnvironment("CLAXEDO_TEST_WORKGRAPH_REPOSITORY")
const sessionStatePath = path.join(repositoryDirectory, ".claxedo-workgraph-restart-sessions.json")

type SessionState = Readonly<{
  sessions: Readonly<
    Record<
      string,
      Readonly<{
        runId: string
        directory: string
        admissionCount: number
        result: ExecutionResult
      }>
    >
  >
}>

const readSessions = async (): Promise<SessionState> =>
  fs
    .readFile(sessionStatePath, "utf8")
    .then((content) => JSON.parse(content) as SessionState)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { sessions: {} }
      throw error
    })

const writeSessions = async (state: SessionState) => {
  await fs.writeFile(sessionStatePath, JSON.stringify(state), "utf8")
}

const sessions: WorkGraphSessionGateway = {
  admit: async (input) => {
    const sessionId = `session_${input.runId}`
    const state = await readSessions()
    const previous = state.sessions[sessionId]
    await writeSessions({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          runId: input.runId,
          directory: input.directory,
          admissionCount: (previous?.admissionCount ?? 0) + 1,
          result: { state: "pending" },
        },
      },
    })
    return sessionId
  },
  cancel: async (sessionId) => {
    const state = await readSessions()
    const session = state.sessions[sessionId]
    if (!session) throw new Error(`Session ${sessionId} does not exist`)
    await writeSessions({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...session, result: { state: "cancelled" } },
      },
    })
  },
  result: async (sessionId) => {
    const session = (await readSessions()).sessions[sessionId]
    if (!session) throw new Error(`Session ${sessionId} does not exist`)
    return session.result
  },
}

const capabilities: ExecutionCapabilitiesPort = {
  read: async (context) => {
    const observedAt = Date.now()
    return {
    schemaVersion: 1,
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    catalogRevision: "c".repeat(64),
    observedAt,
    expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
    environments: [
      {
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
      },
    ],
    harnesses: [{ id: "restart-harness" }],
    agents: [{ harnessId: "restart-harness", id: "build", label: "build" }],
    models: [
      {
        harnessId: "restart-harness",
        providerId: "test-provider",
        modelId: "restart-model",
        label: "Restart model",
        efforts: ["high"],
      },
    ],
    tools: [],
    repository: { baseRevisions: ["HEAD"] },
    connections: [],
    }
  },
}

const database = new Database(databasePath)
const embedded = await createLocalEmbeddedWorkGraph({
  database,
  execution: createLocalWorkspaceExecution({
    worktreeRoot: path.join(repositoryDirectory, ".claxedo-workgraph-worktrees"),
    repositoryDirectory: async (baseRevision) => {
      await promisify(execFile)("git", ["-C", repositoryDirectory, "rev-parse", "--verify", baseRevision])
      return repositoryDirectory
    },
    sessions,
  }),
  executionCapabilities: capabilities,
})
const app = new Hono()
mountEmbeddedWorkGraph(app, embedded)
app.get("/runtime/sessions", async (context) => context.json(await readSessions()))
app.post("/runtime/sessions/:sessionId/complete", async (context) => {
  const state = await readSessions()
  const session = state.sessions[context.req.param("sessionId")]
  if (!session) return context.json({ error: "session_not_found" }, 404)
  const body = await context.req.json<{ summary: string; artifacts: string[] }>()
  await writeSessions({
    sessions: {
      ...state.sessions,
      [context.req.param("sessionId")]: {
        ...session,
        result: { state: "succeeded", summary: body.summary, artifacts: body.artifacts },
      },
    },
  })
  return context.json({ completed: true })
})
app.post("/runtime/reconcile", async (context) => {
  const owner = localSystemContext()
  return context.json({ results: await embedded.reconcile(owner) })
})
app.get("/health", (context) => context.json({ ok: true, pid: process.pid }))

const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
server.on("listening", () => {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("WorkGraph restart fixture did not bind a TCP port")
  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port, pid: process.pid })}\n`)
})

const close = () => {
  server.close(() => {
    database.close()
    process.exit(0)
  })
}
process.on("SIGINT", close)
process.on("SIGTERM", close)

function localSystemContext(): WorkGraphContext {
  return {
    organizationId: "local" as never,
    ownerUserId: "local" as never,
    actor: { type: "system", id: "process_restart_reconciler" as never },
    requestId: `process_restart_${crypto.randomUUID()}` as never,
    access: { mode: "owner" },
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
