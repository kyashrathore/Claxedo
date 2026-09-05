import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { OpenCodeCorpus } from "./opencode-corpus"
import type { WorkspaceFixtureManifest } from "agent-app-benchmark/driver-sdk"
import { verifyWorkspaceFixtureManifest } from "agent-app-benchmark/workspace-fixture"
import type { SessionReadinessTarget } from "./agent-browser-observer"
import { initializeWorkspace, type MaterializedWorkspace } from "./workspace-fixture"
import { persistClaxedoCorpus, registerWorkspace } from "./fixture-registration"

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

export type MaterializedSession = {
  logicalSessionId: string
  nativeSessionId: string
  workspaceId: string
  title: string
  createdAt: number
  updatedAt: number
}

export type ClaxedoPublicMaterialization = {
  corpusDigestSha256: string
  eventSchemaDigestSha256: string
  mappingDigestSha256: string
  workspaceFixtureDigestSha256?: string
  sessionMapping: Readonly<Record<string, string>>
  readinessTargets: ReadonlyMap<
    string,
    SessionReadinessTarget & { logicalSessionId: string; workspaceDirectory: string }
  >
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
  workspaceFixtureManifest?: WorkspaceFixtureManifest
  expectedWorkspaceFixtureDigestSha256?: string
}): Promise<ClaxedoPublicMaterialization> {
  const manifest = JSON.parse(await readFile(input.corpusManifestPath, "utf8")) as CorpusManifest
  if (manifest.schemaVersion !== 1 || manifest.corpusDigestSha256 !== input.expectedCorpusDigestSha256) {
    throw new Error("Claxedo received a corpus manifest with the wrong digest")
  }
  if (manifest.sourceEventFormat.schemaDigestSha256 !== input.expectedEventSchemaDigestSha256) {
    throw new Error("Claxedo received an OpenCode event schema with the wrong digest")
  }
  const workspaceFixture = verifyRequestedWorkspaceFixture(input)
  await mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 })
  const workspaceRoot = await realpath(input.workspaceDirectory)
  const workspaces = new Map<string, MaterializedWorkspace>()
  for (const workspaceId of [...new Set(manifest.sessions.map((session) => session.workspaceId))].sort()) {
    const directory = path.join(workspaceRoot, workspaceId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const projectId = await initializeWorkspace(directory, workspaceId, workspaceFixture)
    await registerWorkspace({
      dataDirectory: input.dataDirectory,
      directory,
      projectId,
      projectName: `Benchmark ${workspaceId}`,
    })
    workspaces.set(workspaceId, { directory, projectId })
  }

  const database = new OpenCodeCorpus("recorded-events")
  const readinessTargets = new Map<
    string,
    SessionReadinessTarget & { logicalSessionId: string; workspaceDirectory: string }
  >()
  const materializedSessions: MaterializedSession[] = []
  let expectedMessageCount = 0
  let expectedTranscriptBytes = 0

  // Serial titles + created stamps are per-workspace, not global corpus index.
  // A global index left workspace-a as 53…42 then a gap to 21…1 under created_desc.
  const workspaceSessionOrdinal = new Map<string, number>()
  for (const session of manifest.sessions) {
    const workspace = workspaces.get(session.workspaceId)
    if (!workspace) throw new Error(`Claxedo has no workspace for ${session.logicalSessionId}`)
    const listIndex = workspaceSessionOrdinal.get(session.workspaceId) ?? 0
    workspaceSessionOrdinal.set(session.workspaceId, listIndex + 1)
    const parsed = await materializeSession({
      database,
      corpusDirectory: input.corpusDirectory,
      session,
      workspace,
      sessionIndex: listIndex,
    })
    readinessTargets.set(session.logicalSessionId, parsed.readinessTarget)
    materializedSessions.push(parsed.session)
    expectedMessageCount += parsed.messageCount
    expectedTranscriptBytes += parsed.transcriptBytes
  }

  const messageCount = database.messages.size
  const transcriptBytes = [...database.parts.values()].reduce(
    (sum, part) => sum + partPayloadBytes(part.data as CanonicalPart),
    0,
  )
  if (
    database.sessions.size !== manifest.sessions.length ||
    messageCount !== expectedMessageCount ||
    transcriptBytes !== expectedTranscriptBytes
  ) {
    throw new Error("Claxedo corpus readback does not match the public corpus")
  }

  await persistClaxedoCorpus({ dataDirectory: input.dataDirectory, corpus: database })
  const sessionMapping = Object.fromEntries(
    materializedSessions.map((session) => [session.logicalSessionId, session.nativeSessionId]),
  )
  return {
    corpusDigestSha256: manifest.corpusDigestSha256,
    eventSchemaDigestSha256: manifest.sourceEventFormat.schemaDigestSha256,
    mappingDigestSha256: createHash("sha256").update(canonicalJson(sessionMapping)).digest("hex"),
    ...(workspaceFixture ? { workspaceFixtureDigestSha256: workspaceFixture.manifestDigestSha256 } : {}),
    sessionMapping,
    readinessTargets,
    messageCount,
    transcriptBytes,
  }
}

async function materializeSession(input: {
  database: OpenCodeCorpus
  corpusDirectory: string
  session: ManifestSession
  workspace: MaterializedWorkspace
  sessionIndex: number
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
      // Authoritative display identity for the rail/page: per-workspace serial +
      // recent staggered times. Applied after corpus file digest verification.
      // created_desc then shows contiguous N…1 top→bottom inside one workspace.
      const displayTitle = distinctSyntheticSessionTitle(
        sessionInfo.title,
        input.sessionIndex,
        input.session.logicalSessionId,
      )
      const displayCreated = distinctSyntheticSessionCreatedAt(SYNTHETIC_SESSION_TIME_BASE_MS, input.sessionIndex)
      const displayUpdated = distinctSyntheticSessionUpdatedAt(SYNTHETIC_SESSION_TIME_BASE_MS + 100, input.sessionIndex)
      input.database.addSession({
        id: sessionInfo.id,
        projectId: input.workspace.projectId,
        directory: input.workspace.directory,
        title: displayTitle,
        created: displayCreated,
        updated: displayUpdated,
      })
      sessionInfo = {
        ...sessionInfo,
        title: displayTitle,
        time: { ...sessionInfo.time, created: displayCreated, updated: displayUpdated },
      }
    } else if (event.type === "message.updated.1") {
      if (!sessionInfo) throw new Error("Claxedo received a message before its session")
      const info = event.data.info as MessageInfo
      if (info.sessionID !== sessionInfo.id) throw new Error("Claxedo received a message for another session")
      const { id, sessionID: _, ...data } = info
      input.database.addMessage(id, sessionInfo.id, data)
      input.database.recordEvent({ id: event.id, type: "message.updated", properties: event.data })
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
      input.database.setPart(id, currentMessage.id, expectedSequence, data)
      input.database.recordEvent({ id: event.id, type: "message.part.updated", properties: event.data })
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
      updatedAt: sessionInfo.time.updated,
    },
    readinessTarget: {
      logicalSessionId: input.session.logicalSessionId,
      workspaceDirectory: input.workspace.directory,
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
    return (
      Buffer.byteLength(JSON.stringify(part.state?.input ?? null), "utf8") +
      Buffer.byteLength(part.state?.output ?? "", "utf8")
    )
  }
  return 0
}

function normalizeSemanticText(value: string): string {
  return value.trim().replace(/\s+/gu, " ")
}

/**
 * Recent base so rail relative labels are hours/days, not "2y" from 2023 corpus
 * event stamps. Index offsets still decide created_desc order.
 */
export const SYNTHETIC_SESSION_TIME_BASE_MS = Date.UTC(2026, 7, 28, 12, 0, 0)

/** Strip any prior serial and prefix the per-workspace 1-based list rank. */
export function distinctSyntheticSessionTitle(title: string, sessionIndex: number, logicalSessionId: string) {
  const stripped = title.trim().replace(/^\d+\.\s+/u, "")
  const stem = stripped || `Synthetic benchmark ${logicalSessionId}`
  return `${sessionIndex + 1}. ${stem}`
}

/** Distinct created times so created_desc order matches serial titles top→bottom. */
export function distinctSyntheticSessionCreatedAt(createdAt: number, sessionIndex: number) {
  return createdAt + (sessionIndex + 1) * 60_000
}

/** Guarantee updated_desc order even when corpus stamps identical updated times. */
export function distinctSyntheticSessionUpdatedAt(updatedAt: number, sessionIndex: number) {
  return updatedAt + (sessionIndex + 1) * 60_000
}

/** Contiguous per-workspace ranks for created_desc: newest/top = highest serial. */
export function workspaceListRanks(
  sessions: readonly { workspaceId: string; logicalSessionId: string }[],
): Map<string, number> {
  const ranks = new Map<string, number>()
  const ordinal = new Map<string, number>()
  for (const session of sessions) {
    const listIndex = ordinal.get(session.workspaceId) ?? 0
    ordinal.set(session.workspaceId, listIndex + 1)
    ranks.set(session.logicalSessionId, listIndex)
  }
  return ranks
}

function verifyRequestedWorkspaceFixture(input: {
  workspaceFixtureManifest?: WorkspaceFixtureManifest
  expectedWorkspaceFixtureDigestSha256?: string
}) {
  if (!input.workspaceFixtureManifest && !input.expectedWorkspaceFixtureDigestSha256) return
  if (!input.workspaceFixtureManifest || !input.expectedWorkspaceFixtureDigestSha256) {
    throw new Error("Claxedo workspace fixture manifest and digest must be supplied together")
  }
  const manifest = verifyWorkspaceFixtureManifest(input.workspaceFixtureManifest)
  if (manifest.manifestDigestSha256 !== input.expectedWorkspaceFixtureDigestSha256) {
    throw new Error("Claxedo received the wrong workspace fixture digest")
  }
  return manifest
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
