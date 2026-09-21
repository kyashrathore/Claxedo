import type { AgentMessageAuthor } from "./sessions"
import { isRecord } from "./values"
import { canonicalToolName } from "./tool-names"

/** Token accounting, reported identically by assistant messages and step-finish parts. */
export type AgentTokenUsage = {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** The provider/model pair a message was produced with. */
export type AgentModelRef = { providerID: string; modelID: string; variant?: string }

export type AgentMessageError = {
  name: string
  data: Record<string, unknown> & { message?: string }
}

export type AgentOutputFormat =
  { type: "text" } | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number }

export type AgentUserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  format?: AgentOutputFormat
  summary?: {
    title?: string
    body?: string
    diffs: AgentSnapshotFileDiff[]
  }
  agent: string
  model: AgentModelRef
  system?: string
  tools?: Record<string, boolean>
  claxedo?: { author: AgentMessageAuthor }
}

export type AgentAssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: AgentMessageError
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: AgentTokenUsage
  structured?: unknown
  variant?: string
  finish?: string
}

/** Message information rendered by transcript and navigation surfaces. */
export type AgentPresentationMessage = AgentUserMessage | AgentAssistantMessage

export type AgentMessageInfo = {
  id: string
  role: string
  sessionID: string
  parentID?: string
  time?: { created: number; completed?: number }
  providerID?: string
  modelID?: string
  model?: AgentModelRef
  agent?: string
  mode?: string
  path?: { cwd: string; root: string }
  cost?: number
  tokens?: AgentTokenUsage
  tools?: Record<string, boolean>
  system?: string
  variant?: string
  format?: unknown
  finish?: string
  error?: AgentMessageError
  claxedo?: { author: AgentMessageAuthor }
  harnessPayload?: unknown
  [key: string]: unknown
}

export type AgentMessage = {
  info: AgentMessageInfo
  parts: AgentContentPart[]
  harnessPayload?: unknown
}

type AgentPartBase<Type extends string> = {
  id: string
  sessionID: string
  messageID: string
  type: Type
}

export type AgentTextPart = AgentPartBase<"text"> & {
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: Record<string, unknown>
}

export type AgentReasoningPart = AgentPartBase<"reasoning"> & {
  text: string
  time: { start: number; end?: number }
  metadata?: Record<string, unknown>
}

export type AgentFilePartSourceText = {
  value: string
  start: number
  end: number
}

export type AgentFilePartRange = {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export type AgentFileSource = {
  type: "file"
  text: AgentFilePartSourceText
  path: string
}

export type AgentSymbolSource = {
  type: "symbol"
  text: AgentFilePartSourceText
  path: string
  range: AgentFilePartRange
  name: string
  kind: number
}

export type AgentResourceSource = {
  type: "resource"
  text: AgentFilePartSourceText
  clientName: string
  uri: string
}

export type AgentFilePartSource = AgentFileSource | AgentSymbolSource | AgentResourceSource

/**
 * Where a file part's bytes are when `url` does not carry them. A workspace
 * file is read by path when the view needs it; unretained bytes were dropped
 * at capture and only their size survives, so a view can say how large the
 * image was instead of rendering a broken one.
 */
export type AgentFileLocation =
  | { kind: "workspace-file"; path: string }
  | { kind: "unretained"; bytes: number }

export type AgentFilePart = AgentPartBase<"file"> & {
  mime: string
  filename?: string
  url: string
  location?: AgentFileLocation
  source?: AgentFilePartSource
}

export type AgentTextPartInput = Omit<AgentTextPart, "id" | "sessionID" | "messageID"> & { id?: string }
export type AgentFilePartInput = Omit<AgentFilePart, "id" | "sessionID" | "messageID"> & { id?: string }
export type AgentAgentPartInput = Omit<AgentAgentPart, "id" | "sessionID" | "messageID"> & { id?: string }

export type AgentToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | {
      status: "running"
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number }
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number; compacted?: number }
      attachments?: AgentFilePart[]
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }

export type AgentToolPart = AgentPartBase<"tool"> & {
  callID: string
  tool: string
  state: AgentToolState
  metadata?: Record<string, unknown>
}

/**
 * Whether a tool name spawns a subagent. Every harness spelling — Claude's `Agent`,
 * the runtime's own `create_subagent`, bare or MCP-prefixed — canonicalises to `task`,
 * so the alias table is the one place a new spelling is added. Both the event runtime's
 * tool-intent mapping and the transcript's grouping ask this question here, because a
 * name known to only one of them is a subagent that renders as a generic tool row.
 *
 * Callers pass the tool name as the part carries it; matching is case-insensitive
 * because only the client-presentation projection canonicalises case.
 */
export function isSubagentSpawnToolName(toolName: string) {
  return canonicalToolName(toolName) === "task"
}

export type AgentSubtaskPart = AgentPartBase<"subtask"> & {
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
}

export type AgentStepStartPart = AgentPartBase<"step-start"> & { snapshot?: string }

export type AgentStepFinishPart = AgentPartBase<"step-finish"> & {
  reason: string
  snapshot?: string
  cost: number
  tokens: AgentTokenUsage
}

export type AgentSnapshotPart = AgentPartBase<"snapshot"> & { snapshot: string }
export type AgentPatchPart = AgentPartBase<"patch"> & { hash: string; files: string[] }
export type AgentAgentPart = AgentPartBase<"agent"> & {
  name: string
  source?: { value: string; start: number; end: number }
}
export type AgentRetryPart = AgentPartBase<"retry"> & {
  attempt: number
  error: AgentMessageError
  time: { created: number }
}
export type AgentCompactionPart = AgentPartBase<"compaction"> & {
  auto: boolean
  overflow?: boolean
  tail_start_id?: string
}
export type AgentHandoffPart = AgentPartBase<"handoff"> & {
  from: { id: string; access: string; connection?: unknown }
  to: { id: string; access: string; connection?: unknown }
}

export type AgentContentPart =
  | AgentTextPart
  | AgentReasoningPart
  | AgentFilePart
  | AgentToolPart
  | AgentSubtaskPart
  | AgentStepStartPart
  | AgentStepFinishPart
  | AgentSnapshotPart
  | AgentPatchPart
  | AgentAgentPart
  | AgentRetryPart
  | AgentCompactionPart
  | AgentHandoffPart

export type AgentPromptResponse = {
  info: AgentAssistantMessage
  parts: AgentContentPart[]
}

export type AgentTodo = {
  /** Provider-issued task identity, retained for incremental native updates. */
  id?: string
  content: string
  status: string
  priority: string
}

export type AgentQuestionOption = {
  label: string
  description: string
}

export type AgentQuestionInfo = {
  question: string
  header: string
  options: AgentQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type AgentQuestionAnswer = string[]

export type AgentPermission = {
  id: string
  sessionID: string
  tool?: { messageID: string; callID: string }
  title?: string
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
  time?: { created?: number }
  harnessPayload?: unknown
}

export type AgentQuestion = {
  id: string
  sessionID: string
  questions: AgentQuestionInfo[]
  tool?: { messageID: string; callID: string }
  harnessPayload?: unknown
}

export type AgentCommand = { name: string; content?: string; description?: string; harnessPayload?: unknown }
// `id` is the executable identity the prompt's `agent` field resolves; `name`
// is the display label. Catalogs that split the two (OpenCode's `Agent.Info`
// does) must carry `id` — a submission keyed by the label is rejected.
export type AgentAgent = { name: string; id?: string; description?: string; mode?: string; harnessPayload?: unknown }
export type AgentConfigOption = {
  id: string
  name?: string
  type?: string
  category?: string
  currentValue?: unknown
  description?: string
  selectOptions?: Array<{
    id: string
    name?: string
    description?: string
    value?: unknown
    connected?: boolean
    harnessPayload?: unknown
  }>
  harnessPayload?: unknown
}

export type AgentSnapshotFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

/**
 * Runtime parsers for message content arriving from a harness.
 *
 * `AgentContentPart` is a closed, discriminated union, but a harness answers
 * over HTTP or a wire protocol with `unknown`. Without these, every adapter
 * that fetches a message list has to assert the union it cannot prove — which
 * is how a part with the wrong `type` reaches transcript rendering typed as
 * something it is not. Each parser checks exactly the fields its variant
 * declares and returns the value narrowed, so callers neither assert nor
 * reshape; the payload passes through unchanged.
 *
 * Parsers return `undefined` rather than throwing so the policy for a bad part
 * stays with the caller: an adapter bound to one session refuses the response,
 * a presentation surface can skip the part.
 */

function isStringField(container: Record<string, unknown>, key: string): boolean {
  return typeof container[key] === "string"
}

function optionalIs(container: Record<string, unknown>, key: string, check: (value: unknown) => boolean): boolean {
  return container[key] === undefined || check(container[key])
}

function isTokenUsage(value: unknown): value is AgentTokenUsage {
  if (!isRecord(value)) return false
  const cache = value.cache
  if (!isRecord(cache) || typeof cache.read !== "number" || typeof cache.write !== "number") return false
  if (typeof value.input !== "number" || typeof value.output !== "number" || typeof value.reasoning !== "number") return false
  return optionalIs(value, "total", (total) => typeof total === "number")
}

function isSpan(value: unknown): boolean {
  return isRecord(value) && typeof value.start === "number" && optionalIs(value, "end", (end) => typeof end === "number")
}

function isMessageError(value: unknown): value is AgentMessageError {
  return isRecord(value) && typeof value.name === "string" && isRecord(value.data)
}

/**
 * The schemes a file part's `url` may carry — the ones the projections mint
 * (`data:` inline bytes, `file:` locators, remote references) — plus anything
 * without a scheme, which a browser resolves as a relative reference. URL
 * parsing removes tab/CR/LF and trims leading C0/space before the scheme is
 * read, so ` java\tscript:` would name a scheme the raw string does not show.
 */
const FILE_PART_URL_SCHEMES = new Set(["data", "file", "http", "https"])

function isFilePartUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value.replace(/[\t\r\n]/g, "").trimStart())?.[1]
  return scheme === undefined || FILE_PART_URL_SCHEMES.has(scheme.toLowerCase())
}

/** A completed tool's attachments are themselves file parts. */
function isFilePartList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => isAgentContentPart(item) && item.type === "file")
}

function isToolState(value: unknown): value is AgentToolState {
  if (!isRecord(value) || !isRecord(value.input)) return false
  switch (value.status) {
    case "pending":
      return isStringField(value, "raw")
    case "running":
      return isSpan(value.time)
    case "completed":
      return isStringField(value, "output") && isStringField(value, "title") && isRecord(value.metadata) && isSpan(value.time)
        && optionalIs(value, "attachments", isFilePartList)
    case "error":
      return isStringField(value, "error") && isSpan(value.time)
    default:
      return false
  }
}

function isHandoffEnd(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.access === "string"
}

/** Does this part carry the identity every content part declares? */
function hasPartIdentity(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && isStringField(value, "id")
    && isStringField(value, "sessionID")
    && isStringField(value, "messageID")
    && isStringField(value, "type")
}

/** Does the variant named by `part.type` have the fields that variant declares? */
function hasVariantFields(part: Record<string, unknown>): boolean {
  switch (part.type) {
    case "text":
      return isStringField(part, "text")
    case "reasoning":
      return isStringField(part, "text") && isSpan(part.time)
    case "file":
      return isStringField(part, "mime") && isFilePartUrl(part.url)
    case "tool":
      return isStringField(part, "callID") && isStringField(part, "tool") && isToolState(part.state)
    case "subtask":
      return isStringField(part, "prompt") && isStringField(part, "description") && isStringField(part, "agent")
    case "step-start":
      return optionalIs(part, "snapshot", (snapshot) => typeof snapshot === "string")
    case "step-finish":
      return isStringField(part, "reason") && typeof part.cost === "number" && isTokenUsage(part.tokens)
    case "snapshot":
      return isStringField(part, "snapshot")
    case "patch":
      return isStringField(part, "hash")
        && Array.isArray(part.files) && part.files.every((file) => typeof file === "string")
    case "agent":
      return isStringField(part, "name")
    case "retry":
      return typeof part.attempt === "number" && isMessageError(part.error)
        && isRecord(part.time) && typeof part.time.created === "number"
    case "compaction":
      return typeof part.auto === "boolean"
    case "handoff":
      return isHandoffEnd(part.from) && isHandoffEnd(part.to)
    default:
      return false
  }
}

/** Is `value` one of the content parts the contract declares? */
export function isAgentContentPart(value: unknown): value is AgentContentPart {
  return hasPartIdentity(value) && hasVariantFields(value)
}

/** The content part `value` holds, or `undefined` when it is not one. */
export function parseAgentContentPart(value: unknown): AgentContentPart | undefined {
  return isAgentContentPart(value) ? value : undefined
}

/** Is `value` the identifying header every message carries? */
export function isAgentMessageInfo(value: unknown): value is AgentMessageInfo {
  return isRecord(value)
    && isStringField(value, "id")
    && isStringField(value, "role")
    && isStringField(value, "sessionID")
    && optionalIs(value, "parentID", (parentID) => typeof parentID === "string")
    && optionalIs(value, "tokens", isTokenUsage)
    && optionalIs(value, "error", isMessageError)
}

/** Is `value` a message — a valid header and a list of parts the contract declares? */
export function isAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value)
    && isAgentMessageInfo(value.info)
    && Array.isArray(value.parts)
    && value.parts.every(isAgentContentPart)
}

/** The message `value` holds, or `undefined` when it is not one. */
export function parseAgentMessage(value: unknown): AgentMessage | undefined {
  return isAgentMessage(value) ? value : undefined
}
