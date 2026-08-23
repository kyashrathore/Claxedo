import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { Database as SQLiteDatabase } from "bun:sqlite"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import type { SessionReadinessTarget } from "./agent-browser-observer"
import { withClaxedoDataDirectory } from "./with-claxedo-data-directory"

type ManifestSession = {
  logicalSessionId: string
  nativeSessionId: string
  workspaceId: string
  role: string
  transcriptBytes: number
  eventCount: number
  file: string
  fileDigestSha256: string
}

type CorpusManifest = {
  schemaVersion: 1
  corpusId: string
  corpusDigestSha256: string
  sourceEventFormat: { schemaDigestSha256: string }
  sessions: ManifestSession[]
}

type SessionInfo = {
  id: string
  slug: string
  title: string
  version: string
  time: { created: number; updated: number }
}

type MessageInfo = {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  [key: string]: unknown
}

type CanonicalPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text" | "reasoning" | "tool" | "patch" | "step-start" | "step-finish"
  text?: string
  state?: { input?: unknown; output?: string }
  [key: string]: unknown
}

type SerializedEvent = {
  id: string
  type: "session.created.1" | "message.updated.1" | "message.part.updated.1"
  seq: number
  aggregateID: string
  data: Record<string, unknown>
}

type Workspace = { directory: string; projectId: string }
type MaterializedSession = {
  logicalSessionId: string
  nativeSessionId: string
  workspaceId: string
  title: string
  createdAt: number
}

export type ClaxedoPublicMaterialization = {
  corpusDigestSha256: string
  eventSchemaDigestSha256: string
  mappingDigestSha256: string
  sessionMapping: Readonly<Record<string, string>>
  readinessTargets: ReadonlyMap<string, SessionReadinessTarget & { logicalSessionId: string }>
  messageCount: number
  transcriptBytes: number
}

export async function materializeClaxedoPublicCorpus(input: {
  corpusDirectory: string
  corpusManifestPath: string
  expectedCorpusDigestSha256: string
  expectedEventSchemaDigestSha256: string
  dataDirectory: string
  workspaceDirectory: string
}): Promise<ClaxedoPublicMaterialization> {
  const manifest = JSON.parse(await readFile(input.corpusManifestPath, "utf8")) as CorpusManifest
  if (manifest.schemaVersion !== 1 || manifest.corpusDigestSha256 !== input.expectedCorpusDigestSha256) {
    throw new Error("Claxedo received a corpus manifest with the wrong digest")
  }
  if (manifest.sourceEventFormat.schemaDigestSha256 !== input.expectedEventSchemaDigestSha256) {
    throw new Error("Claxedo received an OpenCode event schema with the wrong digest")
  }
  await Promise.all([
    mkdir(path.join(input.dataDirectory, "opencode-engine"), { recursive: true, mode: 0o700 }),
    mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 }),
  ])
  const workspaceRoot = await realpath(input.workspaceDirectory)
  const workspaces = new Map<string, Workspace>()
  for (const workspaceId of [...new Set(manifest.sessions.map((session) => session.workspaceId))].sort()) {
    const directory = path.join(workspaceRoot, workspaceId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const projectId = await initializeWorkspace(directory, workspaceId)
    await registerWorkspace({ dataDirectory: input.dataDirectory, directory, projectId, workspaceId })
    workspaces.set(workspaceId, { directory, projectId })
  }

  const dbPath = path.join(input.dataDirectory, "opencode-engine", "opencode.db")
  const initialize = Effect.provide(
    CoreDatabase.Service as unknown as Effect.Effect<unknown, never, never>,
    CoreDatabase.layerFromPath(dbPath) as never,
  )
  await Effect.runPromise(Effect.scoped(initialize))

  const database = new SQLiteDatabase(dbPath)
  const readinessTargets = new Map<string, SessionReadinessTarget & { logicalSessionId: string }>()
  const materializedSessions: MaterializedSession[] = []
  let expectedMessageCount = 0
  let expectedTranscriptBytes = 0
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
  try {
    const baseTime = 1_700_000_000_000
    for (const [workspaceId, workspace] of workspaces) {
      database
        .prepare(
          "INSERT INTO project (id, worktree, name, time_created, time_updated, time_initialized, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          workspace.projectId,
          workspace.directory,
          `Benchmark ${manifest.corpusId} ${workspaceId}`,
          baseTime,
          baseTime,
          baseTime,
          "[]",
        )
    }
    for (const session of manifest.sessions) {
      const workspace = workspaces.get(session.workspaceId)
      if (!workspace) throw new Error(`Claxedo has no workspace for ${session.logicalSessionId}`)
      const parsed = await materializeSession({ database, corpusDirectory: input.corpusDirectory, session, workspace })
      readinessTargets.set(session.logicalSessionId, parsed.readinessTarget)
      materializedSessions.push(parsed.session)
      expectedMessageCount += parsed.messageCount
      expectedTranscriptBytes += parsed.transcriptBytes
    }
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    database.close()
    throw error
  }

  const sessionCount = Number(
    (database.prepare("SELECT COUNT(*) AS count FROM session").get() as { count: number }).count,
  )
  const messageCount = Number(
    (database.prepare("SELECT COUNT(*) AS count FROM message").get() as { count: number }).count,
  )
  let transcriptBytes = 0
  for (const row of database.prepare("SELECT data FROM part").iterate() as Iterable<{ data: string }>) {
    const part = JSON.parse(row.data) as CanonicalPart
    transcriptBytes += partPayloadBytes(part)
  }
  database.close()
  if (
    sessionCount !== manifest.sessions.length ||
    messageCount !== expectedMessageCount ||
    transcriptBytes !== expectedTranscriptBytes
  ) {
    throw new Error("Claxedo native OpenCode database readback does not match the public corpus")
  }

  await registerSessionInventory({ dataDirectory: input.dataDirectory, workspaces, sessions: materializedSessions })
  await seedSessionMeta({ dataDirectory: input.dataDirectory, workspaces, sessions: materializedSessions })
  const sessionMapping = Object.fromEntries(
    materializedSessions.map((session) => [session.logicalSessionId, session.nativeSessionId]),
  )
  return {
    corpusDigestSha256: manifest.corpusDigestSha256,
    eventSchemaDigestSha256: manifest.sourceEventFormat.schemaDigestSha256,
    mappingDigestSha256: createHash("sha256").update(canonicalJson(sessionMapping)).digest("hex"),
    sessionMapping,
    readinessTargets,
    messageCount,
    transcriptBytes,
  }
}

async function materializeSession(input: {
  database: SQLiteDatabase
  corpusDirectory: string
  session: ManifestSession
  workspace: Workspace
}) {
  const root = path.resolve(input.corpusDirectory)
  const file = path.resolve(root, input.session.file)
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Claxedo corpus path escapes its root")
  const fileHash = createHash("sha256")
  let expectedSequence = 0
  let transcriptBytes = 0
  let messageCount = 0
  let sessionInfo: SessionInfo | undefined
  let currentMessage: MessageInfo | undefined
  let latestAssistant: { messageId: string; partId: string; textSha256: string } | undefined
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.length === 0) continue
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("Claxedo rejected an oversized corpus event")
    fileHash.update(`${line}\n`)
    const event = JSON.parse(line) as SerializedEvent
    if (event.seq !== expectedSequence || event.aggregateID !== input.session.nativeSessionId) {
      throw new Error(`Claxedo rejected invalid event order for ${input.session.logicalSessionId}`)
    }
    if (event.type === "session.created.1") {
      if (expectedSequence !== 0) throw new Error("Claxedo received a late session.created event")
      sessionInfo = event.data.info as SessionInfo
      if (sessionInfo.id !== input.session.nativeSessionId)
        throw new Error("Claxedo received the wrong native session id")
      input.database
        .prepare(
          "INSERT INTO session (id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)",
        )
        .run(
          sessionInfo.id,
          input.workspace.projectId,
          sessionInfo.slug,
          input.workspace.directory,
          sessionInfo.title,
          sessionInfo.version,
          sessionInfo.time.created,
          sessionInfo.time.updated,
        )
    } else if (event.type === "message.updated.1") {
      if (!sessionInfo) throw new Error("Claxedo received a message before its session")
      const info = event.data.info as MessageInfo
      if (info.sessionID !== sessionInfo.id) throw new Error("Claxedo received a message for another session")
      const { id, sessionID: _, ...data } = info
      input.database
        .prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run(id, sessionInfo.id, info.time.created, info.time.completed ?? info.time.created, JSON.stringify(data))
      currentMessage = info
      messageCount += 1
    } else if (event.type === "message.part.updated.1") {
      if (!sessionInfo || !currentMessage) throw new Error("Claxedo received a part before its message")
      const part = event.data.part as CanonicalPart
      if (
        !["text", "reasoning", "tool", "patch", "step-start", "step-finish"].includes(part.type) ||
        part.sessionID !== sessionInfo.id ||
        part.messageID !== currentMessage.id
      ) {
        throw new Error("Claxedo received an invalid completed part")
      }
      const { id, sessionID: _, messageID: __, ...data } = part
      const updatedAt =
        typeof event.data.time === "number"
          ? event.data.time
          : (currentMessage.time.completed ?? currentMessage.time.created)
      input.database
        .prepare(
          "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, currentMessage.id, sessionInfo.id, currentMessage.time.created, updatedAt, JSON.stringify(data))
      transcriptBytes += partPayloadBytes(part)
      if (currentMessage.role === "assistant" && part.type === "text" && typeof part.text === "string") {
        latestAssistant = {
          messageId: currentMessage.id,
          partId: part.id,
          textSha256: createHash("sha256").update(normalizeSemanticText(part.text)).digest("hex"),
        }
      }
    } else {
      throw new Error(`Claxedo rejected unknown OpenCode event type ${String(event.type)}`)
    }
    expectedSequence += 1
  }
  if (fileHash.digest("hex") !== input.session.fileDigestSha256 || expectedSequence !== input.session.eventCount) {
    throw new Error(`Claxedo corpus file integrity failed for ${input.session.logicalSessionId}`)
  }
  if (!sessionInfo || !latestAssistant || transcriptBytes !== input.session.transcriptBytes) {
    throw new Error(`Claxedo corpus semantics failed for ${input.session.logicalSessionId}`)
  }
  return {
    session: {
      logicalSessionId: input.session.logicalSessionId,
      nativeSessionId: input.session.nativeSessionId,
      workspaceId: input.session.workspaceId,
      title: sessionInfo.title,
      createdAt: sessionInfo.time.created,
    },
    readinessTarget: {
      logicalSessionId: input.session.logicalSessionId,
      sessionId: input.session.nativeSessionId,
      title: sessionInfo.title,
      expectedMessageIds: [latestAssistant.messageId],
      expectedContentSha256: { [latestAssistant.messageId]: latestAssistant.textSha256 },
      expectedTextPartSha256: { [latestAssistant.partId]: latestAssistant.textSha256 },
      expectedPartIds: [latestAssistant.partId],
    },
    messageCount,
    transcriptBytes,
  }
}

function partPayloadBytes(part: CanonicalPart): number {
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    return Buffer.byteLength(part.text, "utf8")
  }
  if (part.type === "tool") {
    return Buffer.byteLength(JSON.stringify(part.state?.input ?? null), "utf8") +
      Buffer.byteLength(part.state?.output ?? "", "utf8")
  }
  return 0
}

function normalizeSemanticText(value: string): string {
  return value.trim().replace(/\s+/gu, " ")
}

async function initializeWorkspace(directory: string, workspaceId: string) {
  await runGit(["init", "--initial-branch=main", directory])
  await runGit(
    ["-C", directory, "commit", "--allow-empty", "--no-gpg-sign", "-m", `Agent app benchmark corpus ${workspaceId}`],
    {
      GIT_AUTHOR_NAME: "Agent App Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@localhost",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Agent App Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@localhost",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  )
  const projectId = (await runGit(["-C", directory, "rev-list", "--max-parents=0", "HEAD"])).trim()
  if (!/^[0-9a-f]{40}$/u.test(projectId)) throw new Error("Claxedo did not create a canonical workspace project id")
  return projectId
}

async function runGit(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Claxedo workspace preparation failed: ${(stderr || stdout).trim()}`)
  return stdout
}

async function registerWorkspace(input: {
  dataDirectory: string
  directory: string
  projectId: string
  workspaceId: string
}) {
  const workspaceStoreModule = "../../../claxedo-server-core/src/workspace/store/index.ts"
  const { ensureWorkspace } = (await import(workspaceStoreModule)) as {
    ensureWorkspace(input: {
      workspaceId: string
      project_id: string
      project_name: string
      workspace_name: string
      directory: string
    }): Promise<{ id: string } | undefined>
  }
  await withClaxedoDataDirectory(input.dataDirectory, async () => {
    const workspace = await ensureWorkspace({
      workspaceId: input.projectId,
      project_id: input.projectId,
      project_name: `Benchmark ${input.workspaceId}`,
      workspace_name: "main",
      directory: input.directory,
    })
    if (!workspace) throw new Error("Claxedo production workspace store rejected the benchmark workspace")
  })
}

async function registerSessionInventory(input: {
  dataDirectory: string
  workspaces: Map<string, Workspace>
  sessions: MaterializedSession[]
}) {
  const runtimeStoreModule = "../../../workspace-runtime/src/store.ts"
  const { RuntimeStore } = (await import(runtimeStoreModule)) as {
    RuntimeStore: new (root: string) => {
      bindSession(input: {
        sessionId: string
        directory: string
        title: string
        agentSessionId: string
        createdAt: number
      }): void
      updateSessionConfig(
        id: string,
        update: { harness: { id: "opencode"; access: "native" }; variant: null; agent: null },
        input: { directory: string },
      ): unknown
      markSessionInventoryImported(directory: string): void
      flush(): void
      close(): void
    }
  }
  for (const [workspaceId, workspace] of input.workspaces) {
    const store = new RuntimeStore(path.join(input.dataDirectory, "agent-core", workspace.projectId))
    try {
      for (const session of input.sessions
        .filter((candidate) => candidate.workspaceId === workspaceId)
        .toSorted((left, right) => right.createdAt - left.createdAt)) {
        store.bindSession({
          sessionId: session.nativeSessionId,
          directory: workspace.directory,
          title: session.title,
          agentSessionId: session.nativeSessionId,
          createdAt: session.createdAt,
        })
        store.updateSessionConfig(
          session.nativeSessionId,
          { harness: { id: "opencode", access: "native" }, variant: null, agent: null },
          { directory: workspace.directory },
        )
      }
      store.markSessionInventoryImported(workspace.directory)
      store.flush()
    } finally {
      store.close()
    }
  }
}

async function seedSessionMeta(input: {
  dataDirectory: string
  workspaces: Map<string, Workspace>
  sessions: MaterializedSession[]
}) {
  const sessionMetaModule = "../../../claxedo-server-core/src/session/meta/index.ts"
  const { putSessionMeta } = (await import(sessionMetaModule)) as {
    putSessionMeta(
      sessionID: string,
      value: {
        ws: { id: string; project_id: string; directory: string }
        workspaceID: string
        directory: string
        host: "workspace"
        title: string
      },
    ): Promise<unknown>
  }
  await withClaxedoDataDirectory(input.dataDirectory, async () => {
    for (const session of input.sessions) {
      const workspace = input.workspaces.get(session.workspaceId)
      if (!workspace) throw new Error(`Claxedo session meta is missing ${session.logicalSessionId}`)
      await putSessionMeta(session.nativeSessionId, {
        ws: { id: workspace.projectId, project_id: workspace.projectId, directory: workspace.directory },
        workspaceID: workspace.projectId,
        directory: workspace.directory,
        host: "workspace",
        title: session.title,
      })
    }
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
