import type {
  AgentContentPart,
  AgentQuestionInfo,
  AgentQuestionOption,
  AgentTodo,
} from "@claxedo/agent-runtime-contract"
import { asRecord, isRecord } from "@claxedo/agent-runtime-contract"
import type { SessionConfig, SessionHarness } from "../index"
import type { SubagentObservation } from "../subagent-admission"
import type { MessageRow, PermissionRow, QuestionRow, SessionRow } from "./memory"

/**
 * Parsers for rows a durable store wrote from this store's own state.
 *
 * They accept what the store can address — the identity fields it indexes by —
 * and pass the rest of the row through, so a row written by an older version is
 * rehydrated rather than dropped. A row without its identity is unusable and
 * the caller reports it as corruption.
 */
export function persistedSessionRow(value: unknown): SessionRow | undefined {
  const row = asRecord(value)
  const time = asRecord(row?.time)
  if (!row || typeof row.id !== "string" || typeof row.directory !== "string") return undefined
  if (typeof time?.created !== "number" || typeof time.updated !== "number") return undefined
  return { ...row, id: row.id, directory: row.directory, time: { ...time, created: time.created, updated: time.updated } }
}

export function persistedSessionConfig(value: unknown): SessionConfig | undefined {
  const row = asRecord(value)
  if (!row || !isPersistedHarness(row.harness)) return undefined
  return { ...row, harness: row.harness }
}

/** A stored harness selection: the pair the store routes on, unchanged. */
function isPersistedHarness(value: unknown): value is SessionHarness {
  return isRecord(value) && typeof value.id === "string" && typeof value.access === "string"
}

export function persistedMessageRow(value: unknown): MessageRow | undefined {
  const row = asRecord(value)
  const info = asRecord(row?.info)
  if (!row || !info || typeof info.id !== "string" || typeof info.role !== "string") return undefined
  if (typeof info.sessionID !== "string" || !Array.isArray(row.parts)) return undefined
  const parts = row.parts.filter(isPersistedContentPart)
  return { ...row, info: { ...info, id: info.id, role: info.role, sessionID: info.sessionID }, parts }
}

/**
 * A stored part keeps the identity every part variant shares. The variant's own
 * fields are not re-checked: these rows are this store's own serialization, and
 * rejecting a part over a field an older writer omitted would drop durable
 * transcript content that the runtime otherwise reads back fine.
 */
function isPersistedContentPart(value: unknown): value is AgentContentPart {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.type === "string"
    && typeof value.sessionID === "string"
    && typeof value.messageID === "string"
}

export function persistedPermissionRow(value: unknown): PermissionRow | undefined {
  const row = asRecord(value)
  if (!row || typeof row.id !== "string" || typeof row.sessionID !== "string") return undefined
  return {
    ...row,
    id: row.id,
    sessionID: row.sessionID,
    permission: typeof row.permission === "string" ? row.permission : "",
    patterns: stringList(row.patterns),
    always: stringList(row.always),
    metadata: asRecord(row.metadata) ?? {},
  }
}

export function persistedQuestionRow(value: unknown): QuestionRow | undefined {
  const row = asRecord(value)
  if (!row || typeof row.id !== "string" || typeof row.sessionID !== "string") return undefined
  if (!Array.isArray(row.questions)) return undefined
  return { ...row, id: row.id, sessionID: row.sessionID, questions: row.questions.flatMap((item) => persistedQuestionInfo(item) ?? []) }
}

function persistedQuestionInfo(value: unknown): AgentQuestionInfo | undefined {
  const row = asRecord(value)
  if (!row || typeof row.question !== "string" || typeof row.header !== "string") return undefined
  const options = Array.isArray(row.options) ? row.options.flatMap((item) => persistedQuestionOption(item) ?? []) : []
  return { ...row, question: row.question, header: row.header, options }
}

function persistedQuestionOption(value: unknown): AgentQuestionOption | undefined {
  const row = asRecord(value)
  if (!row || typeof row.label !== "string") return undefined
  return { label: row.label, description: typeof row.description === "string" ? row.description : "" }
}

export function persistedTodoRow(value: unknown): AgentTodo | undefined {
  const row = asRecord(value)
  if (!row || typeof row.content !== "string") return undefined
  return {
    content: row.content,
    status: typeof row.status === "string" ? row.status : "",
    priority: typeof row.priority === "string" ? row.priority : "",
  }
}

export function persistedSubagentObservation(value: unknown): SubagentObservation | undefined {
  return isPersistedSubagentObservation(value) ? value : undefined
}

/** A stored observation keeps the id the admission ledger dedupes on. */
function isPersistedSubagentObservation(value: unknown): value is SubagentObservation {
  return isRecord(value) && typeof value.observationId === "string"
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
