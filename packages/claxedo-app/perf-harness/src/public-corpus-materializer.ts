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
import { isRecord, numberField, recordField, recordsField, textField } from "./json-fields"

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

/** Read one session row of the corpus manifest. */
function parseManifestSession(value: Record<string, unknown>): ManifestSession {
  const logicalSessionId = textField(value, "logicalSessionId")
  const nativeSessionId = textField(value, "nativeSessionId")
  const workspaceId = textField(value, "workspaceId")
  const role = textField(value, "role")
  const file = textField(value, "file")
  const fileDigestSha256 = textField(value, "fileDigestSha256")
  const transcriptBytes = numberField(value, "transcriptBytes")
  const eventCount = numberField(value, "eventCount")
  if (
    logicalSessionId === undefined ||
    nativeSessionId === undefined ||
    workspaceId === undefined ||
    role === undefined ||
    file === undefined ||
    fileDigestSha256 === undefined ||
    transcriptBytes === undefined ||
    eventCount === undefined
  ) {
    throw new Error("Claxedo received a corpus manifest with an incomplete session")
  }
  return { logicalSessionId, nativeSessionId, workspaceId, role, transcriptBytes, eventCount, file, fileDigestSha256 }
}

/** Read the corpus manifest; the digest checks at the call site follow. */
function parseCorpusManifest(value: unknown): CorpusManifest {
  if (!isRecord(value)) throw new Error("Claxedo received a malformed corpus manifest")
  const corpusId = textField(value, "corpusId")
  const corpusDigestSha256 = textField(value, "corpusDigestSha256")
  const sourceEventFormat = recordField(value, "sourceEventFormat")
  const schemaDigestSha256 = sourceEventFormat && textField(sourceEventFormat, "schemaDigestSha256")
  const sessions = recordsField(value, "sessions")
  if (
    value.schemaVersion !== 1 ||
    corpusId === undefined ||
    corpusDigestSha256 === undefined ||
    schemaDigestSha256 === undefined ||
    schemaDigestSha256 === null ||
    !sessions
  ) {
    throw new Error("Claxedo received a malformed corpus manifest")
  }
  return {
    schemaVersion: 1,
    corpusId,
    corpusDigestSha256,
    sourceEventFormat: { schemaDigestSha256 },
    sessions: sessions.map(parseManifestSession),
  }
}

/**
 * Readers for the corpus's own record shapes.
 *
 * These types are declared here, so the corpus stream can be checked against
 * them here too. Each reader names the field that failed rather than letting an
 * assertion carry a malformed record into the database writes below.
 */
function parseSerializedEvent(value: unknown): SerializedEvent {
  const id = isRecord(value) ? textField(value, "id") : undefined
  const type = isRecord(value) ? textField(value, "type") : undefined
  const seq = isRecord(value) ? numberField(value, "seq") : undefined
  const aggregateID = isRecord(value) ? textField(value, "aggregateID") : undefined
  const data = isRecord(value) ? recordField(value, "data") : undefined
  if (
    id === undefined ||
    seq === undefined ||
    aggregateID === undefined ||
    data === undefined ||
    (type !== "session.created.1" && type !== "message.updated.1" && type !== "message.part.updated.1")
  ) {
    throw new Error("Claxedo rejected a malformed corpus event")
  }
  return { id, type, seq, aggregateID, data }
}

function parseSessionInfo(value: unknown): SessionInfo {
  if (!isRecord(value)) throw new Error("Claxedo received a malformed session.created payload")
  const id = textField(value, "id")
  const slug = textField(value, "slug")
  const title = textField(value, "title")
  const version = textField(value, "version")
  const time = recordField(value, "time")
  const created = time && numberField(time, "created")
  const updated = time && numberField(time, "updated")
  if (
    id === undefined ||
    slug === undefined ||
    title === undefined ||
    version === undefined ||
    created === undefined ||
    created === null ||
    updated === undefined ||
    updated === null
  ) {
    throw new Error("Claxedo received an incomplete session.created payload")
  }
  return { id, slug, title, version, time: { created, updated } }
}

function parseMessageInfo(value: unknown): MessageInfo {
  if (!isRecord(value)) throw new Error("Claxedo received a malformed message.updated payload")
  const id = textField(value, "id")
  const sessionID = textField(value, "sessionID")
  const role = textField(value, "role")
  const time = recordField(value, "time")
  const created = time && numberField(time, "created")
  if (
    id === undefined ||
    sessionID === undefined ||
    (role !== "user" && role !== "assistant") ||
    created === undefined ||
    created === null
  ) {
    throw new Error("Claxedo received an incomplete message.updated payload")
  }
  const completed = time ? numberField(time, "completed") : undefined
  return { ...value, id, sessionID, role, time: { created, ...(completed === undefined ? {} : { completed }) } }
}

const CANONICAL_PART_TYPES = ["text", "reasoning", "tool", "patch", "step-start", "step-finish"] as const

function parseCanonicalPart(value: unknown): CanonicalPart {
  if (!isRecord(value)) throw new Error("Claxedo received a malformed message.part.updated payload")
  const id = textField(value, "id")
  const sessionID = textField(value, "sessionID")
  const messageID = textField(value, "messageID")
  const type = CANONICAL_PART_TYPES.find((entry) => entry === value.type)
  if (id === undefined || sessionID === undefined || messageID === undefined || !type) {
    throw new Error("Claxedo received an invalid completed part")
  }
  return { ...value, id, sessionID, messageID, type }
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
  const manifest = parseCorpusManifest(JSON.parse(await readFile(input.corpusManifestPath, "utf8")))
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
    (sum, part) => sum + partPayloadBytes(partPayload(part.data)),
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
    const event = parseSerializedEvent(JSON.parse(line))
    if (event.seq !== expectedSequence || event.aggregateID !== input.session.nativeSessionId) {
      throw new Error(`Claxedo rejected invalid event order for ${input.session.logicalSessionId}`)
    }
    if (event.type === "session.created.1") {
      if (expectedSequence !== 0) throw new Error("Claxedo received a late session.created event")
      sessionInfo = parseSessionInfo(event.data.info)
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
      const info = parseMessageInfo(event.data.info)
      if (info.sessionID !== sessionInfo.id) throw new Error("Claxedo received a message for another session")
      const { id, sessionID: _, ...data } = info
      input.database.addMessage(id, sessionInfo.id, data)
      input.database.recordEvent({ id: event.id, type: "message.updated", properties: event.data })
      currentMessage = info
      messageCount += 1
    } else if (event.type === "message.part.updated.1") {
      if (!sessionInfo || !currentMessage) throw new Error("Claxedo received a part before its message")
      const part = parseCanonicalPart(event.data.part)
      if (part.sessionID !== sessionInfo.id || part.messageID !== currentMessage.id) {
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

/**
 * Size the payload of a part.
 *
 * Takes the payload fields it reads rather than a whole `CanonicalPart`. The
 * stored part records this is also called with have had `id`, `sessionID` and
 * `messageID` destructured off them, so the old `CanonicalPart` parameter was
 * describing a shape half its callers never had.
 */
function partPayloadBytes(part: Pick<CanonicalPart, "type" | "text" | "state">): number {
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

/** Read the payload fields {@link partPayloadBytes} needs off a stored part record. */
function partPayload(data: Record<string, unknown>): Pick<CanonicalPart, "type" | "text" | "state"> {
  const type = CANONICAL_PART_TYPES.find((entry) => entry === data.type)
  if (!type) throw new Error("Claxedo stored a part with an unknown type")
  const state = recordField(data, "state")
  return {
    type,
    text: textField(data, "text"),
    ...(state ? { state: { input: state.input, output: textField(state, "output") } } : {}),
  }
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
}): WorkspaceFixtureManifest | undefined {
  if (!input.workspaceFixtureManifest && !input.expectedWorkspaceFixtureDigestSha256) return undefined
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
