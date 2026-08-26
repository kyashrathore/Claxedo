import { createHash } from "node:crypto"
import { mkdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { Database as SQLiteDatabase } from "bun:sqlite"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import type { SessionReadinessTarget } from "./agent-browser-observer"
import {
  initializeWorkspace,
  registerSessionInventory,
  registerWorkspace,
  seedSessionMeta,
  type MaterializedSession,
  type Workspace,
} from "./public-corpus-materializer"

type SourceSession = {
  id: string
  directory: string
  time_created: number
  time_updated: number
  message_count: number
  part_count: number
  payload_bytes: number
}

type SourceMessage = {
  id: string
  time_created: number
  time_updated: number
  data: string
}

type SourcePart = {
  id: string
  message_id: string
  ordinal: number
  time_created: number
  time_updated: number
  data: string
}

type TargetAssignment = {
  logicalSessionId: string
  workspaceId: "workspace-a" | "workspace-b"
  source: SourceSession
}

export type ActualSessionMaterialization = {
  corpusDigestSha256: string
  eventSchemaDigestSha256: string
  mappingDigestSha256: string
  sessionMapping: Readonly<Record<string, string>>
  readinessTargets: ReadonlyMap<
    string,
    SessionReadinessTarget & {
      logicalSessionId: string
      /** Every persisted latest-turn part; compared with raw HTTP before app normalization. */
      eventualFullPartIds: readonly string[]
    }
  >
  messageCount: number
  transcriptBytes: number
  payloadBytes: number
  sourceDirectoryCount: number
  sourceSessionCount: number
  sourceAliasCount: number
}

const WORKSPACE_A_TARGETS = [
  "control",
  ...Array.from({ length: 10 }, (_, sample) => `latency-within-workspace-cold-${sample}-1048576`),
  ...Array.from({ length: 10 }, (_, sample) => `latency-within-workspace-warm-${sample}-1048576`),
] as const

const WORKSPACE_B_TARGETS = [
  ...Array.from({ length: 10 }, (_, sample) => `latency-across-workspaces-cold-${sample}-1048576`),
  ...Array.from({ length: 10 }, (_, sample) => `latency-across-workspaces-warm-${sample}-1048576`),
] as const

/**
 * Copies a privacy-safe, identity-remapped slice of an actual OpenCode store.
 *
 * The source handle is SQLite read-only and query-only for the entire snapshot.
 * Raw content exists only in the harness's temporary canonical database, which
 * the harness removes on close. Results contain counts, sizes, and timings only.
 */
export async function materializeActualSessions(input: {
  sourceDatabasePath: string
  dataDirectory: string
  workspaceDirectory: string
}): Promise<ActualSessionMaterialization> {
  const sourceInfoBefore = await stat(input.sourceDatabasePath)
  const source = new SQLiteDatabase(input.sourceDatabasePath, { readonly: true, strict: true })
  source.exec("PRAGMA query_only = ON; BEGIN")
  try {
    const sourceSessions = selectActualSessions(source)
    const assignments = assignTargets(sourceSessions)
    const sourceHasPartOrdinal = Boolean(
      source.query<{ name: string }, []>("SELECT name FROM pragma_table_info('part') WHERE name = 'ordinal'").get(),
    )
    const workspaces = await createWorkspaces(input)
    const destinationPath = await initializeDestination(input.dataDirectory)
    const destination = new SQLiteDatabase(destinationPath)
    destination.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
    const readinessTargets = new Map<
      string,
      SessionReadinessTarget & {
        logicalSessionId: string
        eventualFullPartIds: readonly string[]
      }
    >()
    const materializedSessions: MaterializedSession[] = []
    const contentDigests = new Map<string, string>()
    let messageCount = 0
    let transcriptBytes = 0
    let payloadBytes = 0
    try {
      insertProjects(destination, workspaces)
      for (const [index, assignment] of assignments.entries()) {
        const workspace = workspaces.get(assignment.workspaceId)
        if (!workspace) throw new Error("actual-session benchmark workspace preparation failed")
        const copied = copySession({ source, sourceHasPartOrdinal, destination, assignment, workspace, index })
        readinessTargets.set(assignment.logicalSessionId, copied.readinessTarget)
        contentDigests.set(assignment.logicalSessionId, copied.contentDigestSha256)
        materializedSessions.push(copied.session)
        messageCount += copied.messageCount
        transcriptBytes += copied.transcriptBytes
        payloadBytes += copied.payloadBytes
      }
      destination.exec("COMMIT")
    } catch (error) {
      destination.exec("ROLLBACK")
      destination.close()
      throw error
    }
    destination.close()

    await registerSessionInventory({ dataDirectory: input.dataDirectory, workspaces, sessions: materializedSessions })
    await seedSessionMeta({ dataDirectory: input.dataDirectory, workspaces, sessions: materializedSessions })
    source.exec("COMMIT")
    const sourceInfoAfter = await stat(input.sourceDatabasePath)
    if (
      sourceInfoBefore.size !== sourceInfoAfter.size ||
      sourceInfoBefore.mtimeMs !== sourceInfoAfter.mtimeMs ||
      sourceInfoBefore.ino !== sourceInfoAfter.ino
    ) {
      throw new Error("actual-session source database changed during the read-only snapshot")
    }

    const sessionMapping = Object.fromEntries(
      assignments.map((assignment) => [assignment.logicalSessionId, canonicalId("ses", assignment.logicalSessionId)]),
    )
    const sourceSessionCount = new Set(assignments.map((assignment) => assignment.source.id)).size
    const sourceDirectoryCount = new Set(assignments.map((assignment) => assignment.source.directory)).size
    const aggregateIdentity = assignments.map((assignment) => ({
      logicalSessionId: assignment.logicalSessionId,
      workspaceId: assignment.workspaceId,
      messageCount: assignment.source.message_count,
      partCount: assignment.source.part_count,
      payloadBytes: assignment.source.payload_bytes,
      contentDigestSha256: contentDigests.get(assignment.logicalSessionId),
    }))
    return {
      corpusDigestSha256: digest(aggregateIdentity),
      eventSchemaDigestSha256: digest({ schema: "actual-opencode-sqlite-v1" }),
      mappingDigestSha256: digest(sessionMapping),
      sessionMapping,
      readinessTargets,
      messageCount,
      transcriptBytes,
      payloadBytes,
      sourceDirectoryCount,
      sourceSessionCount,
      sourceAliasCount: assignments.length - sourceSessionCount,
    }
  } catch (error) {
    try {
      source.exec("ROLLBACK")
    } catch {}
    throw error
  } finally {
    source.close()
  }
}

function selectActualSessions(database: SQLiteDatabase): SourceSession[] {
  const rows = database
    .query<SourceSession, []>(
      `
    WITH latest_user AS (
      SELECT
        s.id AS session_id,
        (
          SELECT m.time_created
          FROM message m
          WHERE m.session_id = s.id
            AND json_extract(m.data, '$.role') = 'user'
          ORDER BY m.time_created DESC, m.id DESC
          LIMIT 1
        ) AS time_created
      FROM session s
    ),
    latest_finished_assistant AS (
      SELECT
        latest_user.session_id,
        (
          SELECT m.id
          FROM message m
          WHERE m.session_id = latest_user.session_id
            AND m.time_created > latest_user.time_created
            AND json_extract(m.data, '$.role') = 'assistant'
            AND json_extract(m.data, '$.finish') IS NOT NULL
          ORDER BY m.time_created DESC, m.id DESC
          LIMIT 1
        ) AS message_id
      FROM latest_user
      WHERE latest_user.time_created IS NOT NULL
    ),
    eligible AS (
      SELECT s.id, s.directory, s.time_created, s.time_updated
      FROM session s
      JOIN latest_finished_assistant latest ON latest.session_id = s.id
      WHERE latest.message_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM part p
          WHERE p.message_id = latest.message_id
            AND json_extract(p.data, '$.type') = 'text'
            AND length(json_extract(p.data, '$.text')) > 0
        )
    )
    SELECT
      eligible.id,
      eligible.directory,
      eligible.time_created,
      eligible.time_updated,
      (SELECT count(*) FROM message m WHERE m.session_id = eligible.id) AS message_count,
      (SELECT count(*) FROM part p WHERE p.session_id = eligible.id) AS part_count,
      coalesce((SELECT sum(length(CAST(m.data AS BLOB))) FROM message m WHERE m.session_id = eligible.id), 0) +
      coalesce((SELECT sum(length(CAST(p.data AS BLOB))) FROM part p WHERE p.session_id = eligible.id), 0) AS payload_bytes
    FROM eligible
    ORDER BY eligible.directory, payload_bytes, eligible.time_created, eligible.id
  `,
    )
    .all()
  const required = WORKSPACE_A_TARGETS.length + WORKSPACE_B_TARGETS.length
  if (rows.length < required) {
    throw new Error(`actual-session benchmark requires ${required} distinct completed sessions; found ${rows.length}`)
  }
  return rows
}

function assignTargets(sources: SourceSession[]): TargetAssignment[] {
  const logicalTargets = [
    ...WORKSPACE_A_TARGETS.map((logicalSessionId) => ({ logicalSessionId, workspaceId: "workspace-a" as const })),
    ...WORKSPACE_B_TARGETS.map((logicalSessionId) => ({ logicalSessionId, workspaceId: "workspace-b" as const })),
  ]
  const selected = quantileSample(sources, logicalTargets.length)
  return logicalTargets.map((target, index) => ({ ...target, source: selected[index]! }))
}

function quantileSample(values: SourceSession[], count: number) {
  if (count === 1) return [values[Math.floor(values.length / 2)]!]
  return Array.from({ length: count }, (_, index) => values[Math.round((index * (values.length - 1)) / (count - 1))]!)
}

async function createWorkspaces(input: { dataDirectory: string; workspaceDirectory: string }) {
  await Promise.all([
    mkdir(path.join(input.dataDirectory, "opencode-engine"), { recursive: true, mode: 0o700 }),
    mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 }),
  ])
  const root = await realpath(input.workspaceDirectory)
  const workspaces = new Map<string, Workspace>()
  for (const workspaceId of ["workspace-a", "workspace-b"] as const) {
    const directory = path.join(root, workspaceId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const projectId = await initializeWorkspace(directory, workspaceId)
    await registerWorkspace({ dataDirectory: input.dataDirectory, directory, projectId, workspaceId })
    workspaces.set(workspaceId, { directory, projectId })
  }
  return workspaces
}

async function initializeDestination(dataDirectory: string) {
  const databasePath = path.join(dataDirectory, "opencode-engine", "opencode.db")
  const initialize = Effect.provide(
    CoreDatabase.Service as unknown as Effect.Effect<unknown, never, never>,
    CoreDatabase.layerFromPath(databasePath) as never,
  )
  await Effect.runPromise(Effect.scoped(initialize))
  return databasePath
}

function insertProjects(database: SQLiteDatabase, workspaces: Map<string, Workspace>) {
  const now = 1_700_000_000_000
  for (const [workspaceId, workspace] of workspaces) {
    database
      .prepare(
        `
      INSERT INTO project (id, worktree, name, time_created, time_updated, time_initialized, sandboxes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(workspace.projectId, workspace.directory, `Actual load ${workspaceId}`, now, now, now, "[]")
  }
}

function copySession(input: {
  source: SQLiteDatabase
  sourceHasPartOrdinal: boolean
  destination: SQLiteDatabase
  assignment: TargetAssignment
  workspace: Workspace
  index: number
}) {
  const { assignment } = input
  const sessionId = canonicalId("ses", assignment.logicalSessionId)
  const title = `Actual session ${input.index + 1}`
  const messages = input.source
    .query<SourceMessage, [string]>(
      `
    SELECT id, time_created, time_updated, data
    FROM message WHERE session_id = ?
    ORDER BY time_created, id
  `,
    )
    .all(assignment.source.id)
  const parsedMessages = messages.map((message) => JSON.parse(message.data) as Record<string, unknown>)
  const latestUserIndex = parsedMessages.findLastIndex((data) => data.role === "user")
  const messageIds = new Map(
    messages.map((message, index) => [message.id, canonicalOrderedId("msg", assignment.logicalSessionId, index)]),
  )
  const latestTurnMessageIds = new Set(
    messages.flatMap((message, index) => (index >= latestUserIndex ? [messageIds.get(message.id)!] : [])),
  )
  const latestUserMessageId = messageIds.get(messages[latestUserIndex]!.id)!
  const sourceOrdinal = input.sourceHasPartOrdinal
    ? "ordinal"
    : "ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY rowid) - 1"
  // Pre-ordinal databases retain no producer order other than physical insert
  // chronology. This mirrors the one-time core migration without interpreting IDs.
  const parts = input.source
    .query<SourcePart, [string]>(
      `
    SELECT id, message_id, ${sourceOrdinal} AS ordinal, time_created, time_updated, data
    FROM part WHERE session_id = ?
    ORDER BY rowid
  `,
    )
    .all(assignment.source.id)
  const contentHash = createHash("sha256")
  for (const message of messages) updateContentHash(contentHash, "message", message.data)
  for (const part of parts) updateContentHash(contentHash, "part", part.data)
  const partIds = new Map(
    parts.map((part, index) => [part.id, canonicalOrderedId("prt", assignment.logicalSessionId, index)]),
  )

  input.destination
    .prepare(
      `
    INSERT INTO session (
      id, project_id, slug, directory, title, version, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)
  `,
    )
    .run(
      sessionId,
      input.workspace.projectId,
      assignment.logicalSessionId,
      input.workspace.directory,
      title,
      "actual-load-v1",
      assignment.source.time_created,
      assignment.source.time_updated,
    )

  let latestAssistant: { messageId: string; createdAt: number; finished: boolean } | undefined
  let payloadBytes = 0
  for (const [messageIndex, message] of messages.entries()) {
    const data = parsedMessages[messageIndex]!
    const parentID = typeof data.parentID === "string" ? messageIds.get(data.parentID) : undefined
    if (parentID) data.parentID = parentID
    if (data.path && typeof data.path === "object") {
      data.path = { cwd: input.workspace.directory, root: input.workspace.directory }
    }
    const serialized = JSON.stringify(data)
    payloadBytes += Buffer.byteLength(serialized)
    const id = messageIds.get(message.id)!
    input.destination
      .prepare(
        `
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(id, sessionId, message.time_created, message.time_updated, serialized)
    const time = data.time as { completed?: number } | undefined
    if (data.role === "assistant" && data.finish !== undefined) {
      latestAssistant = { messageId: id, createdAt: message.time_created, finished: time?.completed !== undefined }
    }
  }
  if (!latestAssistant) throw new Error("actual-session selection lost its completed assistant turn")

  const expectedPartIds: string[] = []
  const eventualFullPartIds: string[] = []
  let latestTextSha256: string | undefined
  let transcriptBytes = 0
  for (const part of parts) {
    const data = JSON.parse(part.data) as Record<string, unknown>
    const serialized = JSON.stringify(data)
    payloadBytes += Buffer.byteLength(serialized)
    transcriptBytes += payloadSize(data)
    const id = partIds.get(part.id)!
    const messageId = messageIds.get(part.message_id)
    if (!messageId) throw new Error("actual-session part references an unknown message")
    input.destination
      .prepare(
        `
      INSERT INTO part (id, message_id, session_id, ordinal, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(id, messageId, sessionId, part.ordinal, part.time_created, part.time_updated, serialized)
    if (latestTurnMessageIds.has(messageId)) eventualFullPartIds.push(id)
    const retainedSurfaceMessage = messageId === latestUserMessageId || messageId === latestAssistant.messageId
    if (!retainedSurfaceMessage || data.type !== "text" || typeof data.text !== "string" || !data.text.trim()) continue
    expectedPartIds.push(id)
    if (messageId === latestAssistant.messageId) {
      const textSha256 = createHash("sha256").update(normalizeSemanticText(data.text)).digest("hex")
      latestTextSha256 = textSha256
    }
  }
  if (!latestTextSha256 || expectedPartIds.length === 0) {
    throw new Error("actual-session selection lost its renderable final surface")
  }
  return {
    session: {
      logicalSessionId: assignment.logicalSessionId,
      nativeSessionId: sessionId,
      workspaceId: assignment.workspaceId,
      title,
      createdAt: assignment.source.time_created,
    },
    readinessTarget: {
      logicalSessionId: assignment.logicalSessionId,
      sessionId,
      title,
      expectedMessageIds: [latestAssistant.messageId],
      expectedContentSha256: {},
      // Actual text can contain Markdown whose painted text intentionally does
      // not hash to the raw payload. Canonical part identity plus non-empty
      // paint remains exact without storing or normalizing private content.
      expectedTextPartSha256: {},
      expectedPartIds,
      eventualFullPartIds,
    },
    messageCount: messages.length,
    transcriptBytes,
    payloadBytes,
    contentDigestSha256: contentHash.digest("hex"),
  }
}

function updateContentHash(hash: ReturnType<typeof createHash>, kind: string, value: string) {
  hash.update(`${kind}:${Buffer.byteLength(value)}:`)
  hash.update(value)
}

function payloadSize(part: Record<string, unknown>) {
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    return Buffer.byteLength(part.text)
  }
  if (part.type === "tool") {
    const state = part.state as { input?: unknown; output?: string } | undefined
    return Buffer.byteLength(JSON.stringify(state?.input ?? null)) + Buffer.byteLength(state?.output ?? "")
  }
  return 0
}

function normalizeSemanticText(value: string) {
  return value.trim().replace(/\s+/gu, " ")
}

function canonicalId(prefix: string, identity: string) {
  return `${prefix}_actual_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`
}

function canonicalOrderedId(prefix: string, logicalSessionId: string, ordinal: number) {
  const suffix = createHash("sha256").update(`${logicalSessionId}:${ordinal}`).digest("hex").slice(0, 16)
  return `${prefix}_actual_${String(ordinal).padStart(6, "0")}_${suffix}`
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
