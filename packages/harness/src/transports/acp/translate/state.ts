import { boundKeyedMap, boundList } from "../../../translate/value"
import { asRecord } from "@claxedo/helpers/guards"
import type { ToolCallContent, ToolKind } from "./types"
import { type AgentRuntimeEvent, type RuntimeToolStatus, asText as str } from "@claxedo/agent-runtime-contract"
import { diagnoseTranslation, type AcpDiagnostics } from "./diagnostics"
import { viewTool } from "./tool-presentation"

export type Spot = { path: string; line?: number | null }
export type ToolState = {
  id: string
  client: string
  status: RuntimeToolStatus
  title?: string
  firstTitle?: string
  kind?: ToolKind
  firstKind?: ToolKind
  name?: string
  meta?: Record<string, unknown>
  rawInput?: Record<string, unknown>
  rawOutput?: unknown
  content: ToolCallContent[]
  locations: Spot[]
  terminalId?: string
  seenDiffs: string[]
  seenTerms: string[]
  seenContent: string[]
  seenSpots: string[]
}

export const RETAINED_TOOLS_MAX = 256
export const RETAINED_MESSAGE_TEXTS_MAX = 256
export const RETAINED_TOOL_ITEMS_MAX = 256

export type SessionState = {
  client: string
  lastMessageId: string | null
  assistantTextByMessageId: Map<string, string>
  assistantThinkingByMessageId: Map<string, string>
  status: "idle" | "busy" | "error"
  turn: number
  tools: Map<string, ToolState>
}

function name(raw: unknown, meta?: unknown) {
  const item = asRecord(raw)
  const metadata = asRecord(meta)
  return str(metadata?.tool_name) ?? str(metadata?.toolName) ?? str(item?._toolName) ?? str(item?.toolName) ?? str(item?.tool) ?? str(item?.name)
}

function newTool(id: string, client: string): ToolState {
  return {
    id,
    client,
    status: "pending",
    content: [],
    locations: [],
    seenDiffs: [],
    seenTerms: [],
    seenContent: [],
    seenSpots: [],
  }
}

export function createAcpTranslatorState(client?: string): SessionState {
  return {
    client: client?.trim() || "acp",
    lastMessageId: null,
    assistantTextByMessageId: new Map(),
    assistantThinkingByMessageId: new Map(),
    status: "idle",
    turn: 0,
    tools: new Map(),
  }
}

type ToolChange = Partial<Pick<ToolState, "title" | "kind" | "status" | "meta" | "rawOutput">> & {
  rawInput?: unknown
  content?: ToolCallContent[] | null
  locations?: Spot[] | null
}

export function reduceTool(
  session: SessionState,
  id: string,
  update: ToolChange,
  diagnostics: AcpDiagnostics,
) {
  const prev = session.tools.get(id) ?? newTool(id, session.client)
  if (prev.status === "completed" && (update.status === "running" || update.status === "pending")) {
    diagnoseTranslation(diagnostics, "acp.impossible_state_transition", {
      agent: session.client,
      toolCallId: id,
      title: update.title ?? prev.title,
      kind: update.kind ?? prev.kind,
      reason: `${prev.status}_to_${update.status}`,
    })
  }
  const next = updatedTool(prev, update)
  session.tools.set(id, next)
  boundKeyedMap(session.tools, RETAINED_TOOLS_MAX)
  return next
}

function updatedTool(prev: ToolState, update: ToolChange): ToolState {
  const title = update.title ?? prev.title ?? prev.firstTitle
  const kind = update.kind ?? prev.kind ?? prev.firstKind
  const input = asRecord(update.rawInput)
  const rawInput = prev.rawInput && input ? { ...prev.rawInput, ...input } : input ?? prev.rawInput
  const content = boundList(mergeItems(prev.content, update.content, retainedContentKey), RETAINED_TOOL_ITEMS_MAX)
  const locations = boundList(mergeItems(prev.locations, update.locations, pathKey), RETAINED_TOOL_ITEMS_MAX)
  const terminal = content.find((item) => item.type === "terminal")
  return {
    ...prev,
    status: update.status ?? prev.status,
    title,
    firstTitle: prev.firstTitle ?? update.title,
    kind,
    firstKind: prev.firstKind ?? update.kind,
    name: prev.name ?? name(rawInput, update.meta ?? prev.meta),
    meta: update.meta ?? prev.meta,
    rawInput,
    rawOutput: update.rawOutput === undefined ? prev.rawOutput : update.rawOutput ?? prev.rawOutput ?? null,
    content,
    locations,
    terminalId: terminal?.type === "terminal" ? terminal.terminalId : prev.terminalId,
  } satisfies ToolState
}

const pathKey = (item: Spot): string => `${item.path}:${item.line ?? ""}`
const diffKey = (item: Extract<ToolCallContent, { type: "diff" }>): string =>
  `${item.path ?? ""}:${item.oldText ?? ""}:${item.newText ?? ""}`

let unserializableContentSeq = 0

function contentKey(item: ToolCallContent): string {
  try {
    return `${item.type}:${JSON.stringify(item)}`
  } catch {
    unserializableContentSeq += 1
    return `${item.type}:unserializable:${unserializableContentSeq}`
  }
}

function retainedContentKey(item: ToolCallContent): string {
  if (item.type === "diff") return `diff:${diffKey(item)}`
  if (item.type === "terminal") return `terminal:${item.terminalId}`
  return `content:${JSON.stringify(item)}`
}

function mergeItems<T>(left: T[], right: T[] | null | undefined, keyOf: (item: T) => string): T[] {
  const seen = new Set(left.map(keyOf))
  const next = [...left]
  for (const item of right ?? []) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(item)
  }
  return next
}

function remember(seen: string[], key: string): boolean {
  if (!key || seen.includes(key)) return false
  seen.push(key)
  boundList(seen, RETAINED_TOOL_ITEMS_MAX)
  return true
}

function toolContentEvents(state: ToolState, item: ToolCallContent): AgentRuntimeEvent[] {
  const key =
    item.type === "diff" ? diffKey(item) : item.type === "terminal" ? (item.terminalId ?? "") : contentKey(item)
  const seen = item.type === "diff" ? state.seenDiffs : item.type === "terminal" ? state.seenTerms : state.seenContent
  if (!remember(seen, key)) return []
  const tool = viewTool(state)
  const events: AgentRuntimeEvent[] = [
    { type: "tool-content", toolCallId: state.id, content: item, display: tool.display, metadata: tool.metadata },
  ]
  if (item.type === "diff")
    events.push({
      type: "file-diff",
      toolCallId: state.id,
      path: item.path ?? "",
      oldText: item.oldText ?? undefined,
      newText: item.newText ?? "",
    })
  if (item.type === "terminal" && item.terminalId)
    events.push({ type: "tool-terminal", toolCallId: state.id, terminalId: item.terminalId })
  return events
}

export function drainContent(state: ToolState, content: ToolCallContent[] | null | undefined): AgentRuntimeEvent[] {
  return (content ?? []).flatMap((item) => toolContentEvents(state, item))
}

export function drainSpots(state: ToolState, locations: Spot[] | null | undefined): AgentRuntimeEvent[] {
  const next = (locations ?? [])
    .filter((item) => remember(state.seenSpots, pathKey(item)))
    .map((item) => ({ path: item.path, ...(item.line != null ? { line: item.line } : {}) }))
  return next.length ? [{ type: "tool-location", toolCallId: state.id, locations: next }] : []
}

export interface TranslatorContext {
  state: SessionState
  diagnostics: AcpDiagnostics
  preserveUserMessageChunks?: boolean
}
