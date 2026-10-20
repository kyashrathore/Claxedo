import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { isAgentContentPart, isAgentMessageInfo, type AgentContentPart, type AgentMessageInfo } from "@claxedo/agent-runtime-contract"
import { isFiniteNumber, isRecord, isString } from "@claxedo/helpers/guards"
import { readField, readFiniteNumber, readRecord, readString } from "@claxedo/helpers/readers"

export type ManifestSession = {
  logicalSessionId: string
  nativeSessionId: string
  workspaceId: string
  role: string
  transcriptBytes: number
  messageCount: number
  partCount: number
  eventCount: number
  file: string
  fileDigestSha256: string
}

export type CorpusManifest = {
  schemaVersion: number
  corpusId: string
  definitionDigestSha256: string
  sourceEventFormat: { id: string; schemaDigestSha256: string; sourceRevision: string }
  sessions: ManifestSession[]
  corpusDigestSha256: string
}

export type CorpusPartEvent = { part: AgentContentPart; time: number }
export type CorpusMessage = { info: AgentMessageInfo; parts: CorpusPartEvent[] }
export type CorpusTurn = { user: CorpusMessage; replies: CorpusMessage[] }

export type ReadinessTarget = {
  logicalSessionId: string
  sessionId: string
  workspaceId: string
  title: string
  latestTurnMessageIds: string[]
}

export type CorpusSession = {
  sessionId: string
  title: string
  createdAt: number
  turns: CorpusTurn[]
  target: ReadinessTarget
  messageCount: number
  transcriptBytes: number
}

const COMPLETED_PART_TYPES = new Set(["text", "reasoning", "tool", "patch", "step-start", "step-finish"])

const MANIFEST_SESSION_TEXTS = ["logicalSessionId", "nativeSessionId", "workspaceId", "role", "file", "fileDigestSha256"] as const satisfies ReadonlyArray<keyof ManifestSession>
const MANIFEST_SESSION_COUNTS = ["transcriptBytes", "messageCount", "partCount", "eventCount"] as const satisfies ReadonlyArray<keyof ManifestSession>

function isManifestSession(value: unknown): value is ManifestSession {
  return isRecord(value)
    && MANIFEST_SESSION_TEXTS.every((key) => isString(value[key]))
    && MANIFEST_SESSION_COUNTS.every((key) => isFiniteNumber(value[key]))
}

function isSourceEventFormat(value: unknown): value is CorpusManifest["sourceEventFormat"] {
  return isRecord(value) && isString(value.id) && isString(value.schemaDigestSha256) && isString(value.sourceRevision)
}

export function isCorpusManifest(value: unknown): value is CorpusManifest {
  return isRecord(value)
    && isFiniteNumber(value.schemaVersion)
    && isString(value.corpusId)
    && isString(value.definitionDigestSha256)
    && isString(value.corpusDigestSha256)
    && isSourceEventFormat(value.sourceEventFormat)
    && Array.isArray(value.sessions)
    && value.sessions.every(isManifestSession)
}

export async function readCorpusManifest(
  manifestPath: string,
  expected: { corpusDigestSha256: string; eventSchemaDigestSha256: string },
): Promise<CorpusManifest> {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
  if (!isCorpusManifest(manifest)) throw new Error("Claxedo received a malformed corpus manifest")
  if (manifest.schemaVersion !== 1 || manifest.corpusDigestSha256 !== expected.corpusDigestSha256) {
    throw new Error("Claxedo received a corpus manifest with the wrong digest")
  }
  if (manifest.sourceEventFormat.schemaDigestSha256 !== expected.eventSchemaDigestSha256) {
    throw new Error("Claxedo received an OpenCode event schema with the wrong digest")
  }
  return manifest
}

export function partPayloadBytes(part: any): number {
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") return Buffer.byteLength(part.text, "utf8")
  if (part.type === "tool") {
    return Buffer.byteLength(JSON.stringify(part.state?.input ?? null), "utf8") + Buffer.byteLength(part.state?.output ?? "", "utf8")
  }
  return 0
}

class SessionReader {
  info: Record<string, unknown> | undefined
  readonly messages: CorpusMessage[] = []
  transcriptBytes = 0
  sequence = 0

  constructor(readonly session: ManifestSession) {}

  accept(event: unknown) {
    if (readFiniteNumber(event, "seq") !== this.sequence || readString(event, "aggregateID") !== this.session.nativeSessionId) {
      throw new Error(`Claxedo rejected invalid event order for ${this.session.logicalSessionId}`)
    }
    this.sequence += 1
    const type = readString(event, "type")
    const data = readRecord(event, "data")
    if (type === "session.created.1") return this.acceptSession(readRecord(data, "info"))
    if (type === "message.updated.1") return this.acceptMessage(readField(data, "info"))
    if (type === "message.part.updated.1") return this.acceptPart(readField(data, "part"), Number(readField(data, "time")))
    throw new Error(`Claxedo rejected unknown OpenCode event type ${String(type)}`)
  }

  private acceptSession(info: Record<string, unknown> | undefined) {
    if (this.sequence !== 1 || info?.id !== this.session.nativeSessionId) throw new Error("Claxedo received a late or foreign session.created event")
    this.info = info
  }

  private acceptMessage(info: unknown) {
    if (!isAgentMessageInfo(info)) throw new Error(`Claxedo received a malformed message in ${this.session.logicalSessionId}`)
    if (!this.info || info.sessionID !== this.info.id) throw new Error("Claxedo received a message outside its session")
    this.messages.push({ info, parts: [] })
  }

  private acceptPart(part: unknown, time: number) {
    const message = this.messages.at(-1)
    if (!this.info || !message || !isAgentContentPart(part) || !COMPLETED_PART_TYPES.has(part.type) || part.sessionID !== this.info.id || part.messageID !== message.info.id) {
      throw new Error("Claxedo received an invalid completed part")
    }
    message.parts.push({ part, time })
    this.transcriptBytes += partPayloadBytes(part)
  }
}

export function groupTurns(messages: CorpusMessage[]): CorpusTurn[] {
  const turns: CorpusTurn[] = []
  for (const message of messages) {
    if (message.info.role === "user") turns.push({ user: message, replies: [] })
    else if (message.info.role === "assistant" && turns.length > 0) turns.at(-1)!.replies.push(message)
    else throw new Error(`Claxedo cannot place message ${message.info.id} in a turn`)
  }
  return turns
}

export async function readCorpusSession(corpusDirectory: string, session: ManifestSession): Promise<CorpusSession> {
  const root = path.resolve(corpusDirectory)
  const file = path.resolve(root, session.file)
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Claxedo corpus path escapes its root")
  const fileHash = createHash("sha256")
  const reader = new SessionReader(session)
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (line.length === 0) continue
    fileHash.update(`${line}\n`)
    reader.accept(JSON.parse(line))
  }
  if (fileHash.digest("hex") !== session.fileDigestSha256 || reader.sequence !== session.eventCount) {
    throw new Error(`Claxedo corpus file integrity failed for ${session.logicalSessionId}`)
  }
  const turns = groupTurns(reader.messages)
  const info = reader.info
  const latest = turns.at(-1)
  if (!info || !latest || latest.replies.length === 0 || reader.transcriptBytes !== session.transcriptBytes || reader.messages.length !== session.messageCount) {
    throw new Error(`Claxedo corpus semantics failed for ${session.logicalSessionId}`)
  }
  return {
    sessionId: String(info.id),
    title: String(info.title),
    createdAt: Number(readField(info.time, "created")),
    turns,
    target: {
      logicalSessionId: session.logicalSessionId,
      sessionId: String(info.id),
      workspaceId: session.workspaceId,
      title: String(info.title),
      latestTurnMessageIds: latest.replies.map((reply) => reply.info.id),
    },
    messageCount: reader.messages.length,
    transcriptBytes: reader.transcriptBytes,
  }
}
