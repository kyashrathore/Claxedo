import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent, AgentRuntimeEventOf, RuntimeTokenUsage, RuntimeUsageObservation, SubagentStatus, SubagentToolCallRole } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic, asText as text } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter, HarnessEventAdapterContext } from "../../../translate/adapter"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import { contentBlockImages, imageUrlAttachment } from "../../../translate/tool-attachments"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, optionLabels, own, pathFields } from "../../../translate/value"
import type { ServerNotification, ServerRequest } from "./protocol"
import type { FirstTurnErrorClass } from "@claxedo/agent-runtime-contract"
import { codexMcpApproval } from "./mcp-elicitation"
import { formatRateLimitReset } from "../../../translate/rate-limit-reset"

type CodexAppServerProtocolEvent = ServerNotification | ServerRequest

export type CodexTurnUsageState = {
  turnId?: string
  model?: string
  scope?: string
  previousTotals?: Record<string, unknown>
  previousTotalsSignature?: string
  accumulated: {
    inputTokens: number | null
    cachedInputTokens: number | null
    outputTokens: number | null
    reasoningOutputTokens: number | null
  }
}

export type CodexAppServerAdapterState = {
  assistantTextByItemId: Record<string, string>
  toolOutputByCallId: Record<string, string>
  toolsByItemId: Record<string, {
    toolName: string
    input?: Record<string, unknown>
    itemType?: string
  }>
  turnUsageByThread?: Record<string, CodexTurnUsageState>
  reportedModels?: Record<string, string>
  lastLimitedRateLimitMessage?: string
}

function createCodexAppServerAdapterState(): CodexAppServerAdapterState {
  return { assistantTextByItemId: {}, toolOutputByCallId: {}, toolsByItemId: {} }
}

function pruneTurnState(state?: CodexAppServerAdapterState): CodexAppServerAdapterState {
  return {
    ...createCodexAppServerAdapterState(),
    ...(state?.lastLimitedRateLimitMessage
      ? { lastLimitedRateLimitMessage: state.lastLimitedRateLimitMessage }
      : {}),
  }
}

function endThreadTurn(
  state: CodexAppServerAdapterState,
  event: { payload: unknown },
  context: HarnessEventAdapterContext,
): CodexAppServerAdapterState {
  const threadId = threadOf(event, context)
  if (threadId === context.threadId) return pruneTurnState(state)
  const { [threadId]: _ended, ...turnUsageByThread } = state.turnUsageByThread ?? {}
  return { ...state, turnUsageByThread }
}

function payload(event: { payload: unknown }) {
  return asRecord(event.payload) ?? {}
}

function eventFields(event: { payload: unknown }) {
  return asRecord(event) ?? {}
}

function eventText(event: { payload: unknown }) {
  const row = payload(event)
  const fields = eventFields(event)
  return text(fields.textDelta) ?? text(row.delta) ?? text(row.text) ?? text(fields.message)
}

function item(event: { payload: unknown }) {
  return asRecord(payload(event).item)
}

export type CodexCollabAgentCall = {
  id: string
  tool: string
  toolCallRole: SubagentToolCallRole
  senderThreadId: string
  receiverThreadIds: string[]
  prompt?: string
  model?: string
  statuses: Record<string, SubagentStatus>
}

export function codexSubagentActivity(value: unknown) {
  const row = asRecord(value)
  if (row?.type !== "subAgentActivity") return undefined
  const id = text(row.id)
  const agentThreadId = text(row.agentThreadId)
  if (!id || !agentThreadId || (row.kind !== "started" && row.kind !== "completed")) return undefined
  return { id, agentThreadId, kind: row.kind, agentPath: text(row.agentPath) }
}

export function codexCollabAgentCall(value: unknown): CodexCollabAgentCall | undefined {
  const row = asRecord(value)
  if (row?.type !== "collabAgentToolCall") return undefined
  const id = text(row.id)
  const tool = text(row.tool)
  const senderThreadId = text(row.senderThreadId)
  if (!id || !tool || !senderThreadId || !Array.isArray(row.receiverThreadIds)) return undefined
  const receiverThreadIds = row.receiverThreadIds.filter((value): value is string => typeof value === "string" && value.length > 0)
  const agentsStates = asRecord(row.agentsStates) ?? {}
  return {
    id,
    tool,
    toolCallRole: tool === "spawnAgent" || tool === "spawn_agent" ? "spawn" : "interaction",
    senderThreadId,
    receiverThreadIds,
    ...(text(row.prompt) ? { prompt: text(row.prompt) } : {}),
    ...(text(row.model) ? { model: text(row.model) } : {}),
    statuses: Object.fromEntries(receiverThreadIds.flatMap((threadId) => {
      const status = codexCollabAgentStatus(asRecord(agentsStates[threadId])?.status)
      return status ? [[threadId, status]] : []
    })),
  }
}

export function codexCollabAgentStatus(value: unknown): SubagentStatus | undefined {
  const status = text(value)
  if (status === "pendingInit") return "pending"
  if (status === "running") return "running"
  if (status === "interrupted") return "interrupted"
  if (status === "completed") return "completed"
  if (status === "errored" || status === "notFound") return "failed"
  if (status === "shutdown") return "killed"
  return undefined
}

export function codexStartedSubagent(value: unknown) {
  const thread = asRecord(asRecord(value)?.thread)
  const id = text(thread?.id)
  const parentThreadId = text(thread?.parentThreadId)
  if (!id || !parentThreadId) return undefined
  const status = text(asRecord(thread?.status)?.type)
  return {
    id,
    parentThreadId,
    status: status === "active" ? "running" as const : status === "systemError" ? "failed" as const : "pending" as const,
    ...(text(thread?.agentNickname) ? { label: text(thread?.agentNickname) } : {}),
    ...(text(thread?.agentRole) ? { subagentType: text(thread?.agentRole) } : {}),
    ...(text(thread?.preview) ? { description: text(thread?.preview) } : {}),
  }
}

function itemId(event: { payload: unknown }, fallback: string) {
  return text(eventFields(event).itemId) ?? text(payload(event).itemId) ?? text(item(event)?.id) ?? fallback
}

function threadOf(event: { payload: unknown }, context: HarnessEventAdapterContext) {
  return text(payload(event).threadId) ?? context.threadId
}

function codexSessionId(event: { payload: unknown }, context: HarnessEventAdapterContext) {
  return text(payload(event).sessionId) ?? threadOf(event, context)
}

function normalizeItemType(raw: unknown) {
  const value = text(raw)
  if (!value) return "item"
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function canonicalItemType(raw: unknown) {
  const type = normalizeItemType(raw)
  if (type.includes("user message") || type === "user") return "user_message"
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message"
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning"
  if (type.includes("plan") || type.includes("todo")) return "plan"
  if (type.includes("command")) return "command_execution"
  if (type.includes("file change") || type.includes("patch") || type.includes("edit")) return "file_change"
  if (type.includes("mcp")) return "mcp_tool_call"
  if (type.includes("web search")) return "web_search"
  if (type.includes("image")) return "image_view"
  if (type.includes("error")) return "error"
  return "dynamic_tool_call"
}

function toolNameForItem(itemType: string, row: Record<string, unknown>) {
  if (codexSubagentActivity(row)) return "subagent"
  return text(row.tool) ?? text(row.toolName) ?? text(row.name) ?? text(row.title) ?? (
    itemType === "command_execution"
      ? "command"
      : itemType === "file_change"
        ? "file-change"
        : itemType === "web_search"
          ? "web-search"
          : row.type === "imageView"
            ? "view_image"
            : "tool"
  )
}

function structuredInput(row: Record<string, unknown>) {
  if (row.type === "mcpToolCall") {
    return Object.fromEntries(
      ["server", "tool", "arguments", "pluginId"].flatMap((key) => row[key] === undefined ? [] : [[key, row[key]]]),
    )
  }
  const direct = asRecord(row.input)
  if (direct) return direct
  const input = Object.fromEntries(
    ["command", "cwd", "path", "filePath", "query", "prompt", "toolName", "name", "processId", "processHandle", "stream"].flatMap((key) =>
      row[key] === undefined ? [] : [[key, row[key]]],
    ),
  )
  return Object.keys(input).length ? input : undefined
}

function toolDisplay(itemType: string, input: Record<string, unknown> | undefined, toolName?: string) {
  return toolDisplayFromInput({
    kind: itemType,
    ...(toolName ? { toolName } : {}),
    ...(input ? { input } : {}),
  })
}

function pathsFromPayload(row: Record<string, unknown>) {
  return pathFields(row, ["path", "filePath", "cwd"], ["paths", "scopes"])
}

function requestTool(method: string, row: Record<string, unknown>) {
  return text(row.tool) ?? text(row.toolName) ?? (
    method.includes("fileRead")
      ? "file-read"
      : method.includes("fileChange") || method.includes("applyPatch")
        ? "file-change"
        : method.includes("command") || method.includes("execCommand")
          ? "command"
          : "tool"
  )
}

function questions(row: Record<string, unknown>) {
  const raw = Array.isArray(row.questions) ? row.questions : []
  return raw.flatMap((question, i) => {
    const item = asRecord(question)
    if (!item) return []
    const prompt = text(item.question) ?? text(item.prompt) ?? text(item.text)
    if (!prompt) return []
    const options = optionLabels(item.options)
    const optionDescriptions = Object.fromEntries((Array.isArray(item.options) ? item.options : []).flatMap((value) => {
      const option = asRecord(value)
      const label = text(option?.label)
      const description = text(option?.description)
      return label && description ? [[label, description]] : []
    }))
    return [{
      text: prompt || `Question ${i + 1}`,
      header: text(item.header),
      optionDescriptions,
      ...(options.length ? { options } : {}),
    }]
  })
}

function todosFromPlan(row: Record<string, unknown>) {
  const plan = Array.isArray(row.plan) ? row.plan : []
  return plan.flatMap((step, i) => {
    const item = asRecord(step)
    if (!item) return []
    const description = text(item.step) ?? text(item.content) ?? text(item.description)
    if (!description) return []
    return [{
      id: String(i),
      description,
      status: item.status === "inProgress" ? "in_progress" : text(item.status) ?? "pending",
    }]
  })
}

type CodexUsageField = keyof CodexTurnUsageState["accumulated"]
type CodexUsageFields = CodexTurnUsageState["accumulated"]

function addNullable(previous: number | null, delta: number | undefined) {
  if (delta === undefined) return previous
  return (previous ?? 0) + delta
}

function disjointTokens(fields: CodexUsageFields): RuntimeTokenUsage {
  return {
    input: fields.inputTokens === null ? null : Math.max(0, fields.inputTokens - (fields.cachedInputTokens ?? 0)),
    output: fields.outputTokens === null ? null : Math.max(0, fields.outputTokens - (fields.reasoningOutputTokens ?? 0)),
    reasoning: fields.reasoningOutputTokens,
    cache: { read: fields.cachedInputTokens, write: null },
  }
}

type TokenUsageReport = {
  total?: Record<string, unknown>
  last: Record<string, unknown>
  totalsSignature?: string
  contextSize?: number
  contextUsed?: number
}

function tokenUsageReport(row: Record<string, unknown>): TokenUsageReport | undefined {
  const tokenUsage = asRecord(row.tokenUsage) ?? row
  const total = asRecord(tokenUsage.total)
  const last = asRecord(tokenUsage.last) ?? {}
  const contextSize = asFiniteNumber(tokenUsage.modelContextWindow) ?? asFiniteNumber(row.modelContextWindow)
  const contextUsed = asFiniteNumber(last.totalTokens) ?? asFiniteNumber(tokenUsage.totalTokens) ?? asFiniteNumber(total?.totalTokens)
  if (contextUsed === undefined && contextSize === undefined) return undefined
  return {
    ...(total ? { total, totalsSignature: JSON.stringify(total) } : {}),
    last,
    ...(contextSize === undefined ? {} : { contextSize }),
    ...(contextUsed === undefined ? {} : { contextUsed }),
  }
}

function reportGrowth(report: TokenUsageReport, previousTotals: Record<string, unknown> | undefined) {
  return (field: CodexUsageField) => {
    if (report.total && previousTotals) {
      const current = asFiniteNumber(report.total[field])
      const previous = asFiniteNumber(previousTotals[field])
      if (current !== undefined && previous !== undefined) return Math.max(0, current - previous)
    }
    return asFiniteNumber(report.last[field])
  }
}

function usageEvent(report: TokenUsageReport, observation?: RuntimeUsageObservation): AgentRuntimeEventOf<"usage"> {
  return {
    type: "usage",
    contextSize: report.contextSize ?? report.contextUsed ?? 0,
    contextUsed: report.contextUsed ?? report.contextSize ?? 0,
    ...(observation ? { observation } : {}),
  }
}

export type CodexThreadModel = (threadId: string) => string | undefined

function reportedModelKey(threadId: string, turnId?: string) {
  return turnId ? `${threadId}\0${turnId}` : threadId
}

export function codexReportedModel(method: string, payload: unknown): { threadId: string; turnId?: string; model: string } | undefined {
  const row = asRecord(payload) ?? {}
  const threadId = text(row.threadId)
  if (!threadId) return undefined
  if (method === "thread/settings/updated") {
    const model = text(asRecord(row.threadSettings)?.model)
    return model ? { threadId, model } : undefined
  }
  if (method === "model/rerouted") {
    const turnId = text(row.turnId)
    const model = text(row.toModel)
    return turnId && model ? { threadId, turnId, model } : undefined
  }
  return undefined
}

function recordReportedModel(state: CodexAppServerAdapterState, method: string, payload: unknown): CodexAppServerAdapterState {
  const reported = codexReportedModel(method, payload)
  if (!reported) return state
  return {
    ...state,
    reportedModels: boundKeyedRecord({ ...state.reportedModels, [reportedModelKey(reported.threadId, reported.turnId)]: reported.model }, RETAINED_WIRE_KEYS_MAX),
  }
}

function usage(
  row: Record<string, unknown>,
  previous: CodexTurnUsageState | undefined,
  threadId: string,
  servedModel: (turnId: string | undefined) => string | undefined,
): { event: AgentRuntimeEvent; turnUsage: CodexTurnUsageState } | undefined {
  const turnId = text(row.turnId)
  const sameTurn = previous?.turnId === turnId ? previous : undefined
  const report = tokenUsageReport(row)
  if (!report) return undefined
  if (report.totalsSignature !== undefined && report.totalsSignature === sameTurn?.previousTotalsSignature) {
    return { event: usageEvent(report), turnUsage: sameTurn }
  }
  const model = servedModel(turnId)
  const turnScope = turnId ? `${threadId}:${turnId}` : threadId
  const stream = sameTurn?.model === model ? sameTurn : undefined
  const scope = stream ? stream.scope ?? turnScope : sameTurn ? `${turnScope}@${model ?? "unknown"}` : turnScope
  const growth = reportGrowth(report, sameTurn?.previousTotals)
  const accumulated = {
    inputTokens: addNullable(stream?.accumulated.inputTokens ?? null, growth("inputTokens")),
    cachedInputTokens: addNullable(stream?.accumulated.cachedInputTokens ?? null, growth("cachedInputTokens")),
    outputTokens: addNullable(stream?.accumulated.outputTokens ?? null, growth("outputTokens")),
    reasoningOutputTokens: addNullable(stream?.accumulated.reasoningOutputTokens ?? null, growth("reasoningOutputTokens")),
  }
  return {
    event: usageEvent(report, {
      kind: "cumulative",
      scope,
      ...(threadId ? { nativeSessionId: threadId } : {}),
      ...(turnId ? { providerObservationId: turnId } : {}),
      ...(model ? { model } : {}),
      tokens: disjointTokens(accumulated),
    }),
    turnUsage: {
      ...(turnId ? { turnId } : {}),
      ...(model ? { model } : {}),
      scope,
      ...(report.total ? { previousTotals: report.total } : {}),
      ...(report.totalsSignature === undefined ? {} : { previousTotalsSignature: report.totalsSignature }),
      accumulated,
    },
  }
}

export function codexUsageGrowth(input: {
  payload: unknown
  previousTotal: Record<string, unknown> | undefined
  scope: string
  model?: string
}): { total?: Record<string, unknown>; event?: AgentRuntimeEventOf<"usage"> } {
  const row = asRecord(input.payload) ?? {}
  const report = tokenUsageReport(row)
  if (!report) return {}
  const growth = reportGrowth(report, input.previousTotal)
  const fields = {
    inputTokens: growth("inputTokens") ?? null,
    cachedInputTokens: growth("cachedInputTokens") ?? null,
    outputTokens: growth("outputTokens") ?? null,
    reasoningOutputTokens: growth("reasoningOutputTokens") ?? null,
  }
  const total = report.total ? { total: report.total } : {}
  if (!Object.values(fields).some((value) => value !== null && value > 0)) return total
  const threadId = text(row.threadId)
  const turnId = text(row.turnId)
  return {
    ...total,
    event: usageEvent(report, {
      kind: "delta",
      scope: input.scope,
      ...(threadId ? { nativeSessionId: threadId } : {}),
      providerObservationId: `${threadId ?? ""}:${turnId ?? ""}:${report.totalsSignature ?? JSON.stringify(report.last)}`,
      ...(input.model ? { model: input.model } : {}),
      tokens: disjointTokens(fields),
    }),
  }
}

function completionEvents(
  event: { payload: unknown },
  context: HarnessEventAdapterContext,
  lastLimitedRateLimitMessage?: string,
) {
  const row = payload(event)
  const turn = asRecord(row.turn) ?? row
  const status = text(turn.status)
  if (status === "failed" || status === "error") {
    return [
      { type: "session-status", status: "error" },
      turnErrorEvent(asRecord(turn.error), text(row.message), lastLimitedRateLimitMessage, "Codex turn failed"),
    ] satisfies AgentRuntimeEvent[]
  }
  if (status === "cancelled" || status === "interrupted") {
    return [
      { type: "session-status", status: "idle" },
      { type: "cancelled", sessionId: codexSessionId(event, context) },
    ] satisfies AgentRuntimeEvent[]
  }
  return [
    { type: "session-status", status: "idle" },
    { type: "finish", sessionId: codexSessionId(event, context) },
  ] satisfies AgentRuntimeEvent[]
}

function diagnosticForEvent(input: {
  code: string
  message: string
  severity?: "debug" | "info" | "warn" | "error"
  event: { source: string; method?: string; payload: unknown }
}) {
  return {
    type: "diagnostic",
    diagnostic: runtimeDiagnostic({
      code: input.code,
      message: input.message,
      severity: input.severity,
      source: input.event.source,
      method: input.event.method,
      raw: input.event.payload,
    }),
  } satisfies AgentRuntimeEvent
}

function unmappedCodexAppServerEvent(event: { source: string; method?: string; payload: unknown }) {
  const method = event.method ?? "unknown"
  return [diagnosticForEvent({
    code: "codex_app_server.unmapped_event",
    message: `${method}: Codex app-server method has no AgentRuntimeEvent mapping`,
    severity: "info",
    event,
  })]
}

function harnessNotice(input: {
  code: string
  message: string
  severity?: "debug" | "info" | "warn" | "error"
  details?: unknown
}) {
  return {
    type: "harness-notice",
    code: input.code,
    message: input.message,
    severity: input.severity ?? "info",
    ...(input.details !== undefined ? { details: input.details } : {}),
  } satisfies AgentRuntimeEvent
}

function base64Text(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  try {
    if (typeof globalThis.atob === "function") {
      return new TextDecoder().decode(Uint8Array.from(globalThis.atob(raw), (char) => char.charCodeAt(0)))
    }
    if (typeof Buffer !== "undefined") return Buffer.from(raw, "base64").toString("utf8")
  } catch {
    return undefined
  }
  return undefined
}

function textContent(value: string) {
  return {
    type: "content",
    content: { type: "text", text: value },
  } satisfies Extract<AgentRuntimeEvent, { type: "tool-content" }>["content"]
}

function ensureTool(input: {
  state: CodexAppServerAdapterState
  toolCallId: string
  itemType: string
  toolName?: string
  rawInput?: Record<string, unknown>
}) {
  const existing = own(input.state.toolsByItemId, input.toolCallId)
  const itemType = existing?.itemType ?? input.itemType
  const rawInput = existing?.input ?? input.rawInput
  const toolName = existing?.toolName ?? input.toolName ?? toolNameForItem(itemType, rawInput ?? {})
  const display = toolDisplay(itemType, rawInput, toolName)
  if (existing) {
    return {
      state: input.state,
      events: [] satisfies AgentRuntimeEvent[],
      itemType,
      rawInput,
      toolName,
      display,
    }
  }
  return {
    state: {
      ...input.state,
      toolsByItemId: boundKeyedRecord({
        ...input.state.toolsByItemId,
        ...input.state.toolsByItemId,
        [input.toolCallId]: {
          toolName,
          ...(rawInput ? { input: rawInput } : {}),
          itemType,
        },
      }, RETAINED_WIRE_KEYS_MAX),
    },
    events: [
      { type: "tool-start", toolCallId: input.toolCallId, toolName, kind: itemType, display, metadata: { codex: { itemType } } },
      ...(rawInput ? [{ type: "tool-input", toolCallId: input.toolCallId, input: rawInput, display, metadata: { codex: { itemType } } } satisfies AgentRuntimeEvent] : []),
    ] satisfies AgentRuntimeEvent[],
    itemType,
    rawInput,
    toolName,
    display,
  }
}

function appendToolText(input: {
  state: CodexAppServerAdapterState
  toolCallId: string
  itemType: string
  delta: string | undefined
  toolName?: string
  rawInput?: Record<string, unknown>
  metadata: Record<string, unknown>
}) {
  if (!input.delta) return { state: input.state, events: [] satisfies AgentRuntimeEvent[] }
  const ensured = ensureTool(input)
  const output = `${own(input.state.toolOutputByCallId, input.toolCallId) ?? ""}${input.delta}`
  return {
    state: {
      ...ensured.state,
      toolOutputByCallId: boundKeyedRecord({
        ...ensured.state.toolOutputByCallId,
        ...ensured.state.toolOutputByCallId,
        [input.toolCallId]: output,
      }, RETAINED_WIRE_KEYS_MAX),
    },
    events: [
      ...ensured.events,
      {
        type: "tool-content",
        toolCallId: input.toolCallId,
        content: textContent(output),
        display: ensured.display,
        metadata: input.metadata,
      },
    ] satisfies AgentRuntimeEvent[],
  }
}

function processExitEvents(input: {
  state: CodexAppServerAdapterState
  toolCallId: string
  row: Record<string, unknown>
  metadata: Record<string, unknown>
}) {
  const ensured = ensureTool({
    state: input.state,
    toolCallId: input.toolCallId,
    itemType: "command_execution",
    toolName: "process",
    rawInput: structuredInput(input.row),
  })
  const exitCode = asFiniteNumber(input.row.exitCode) ?? 0
  const bufferedOutput = [text(input.row.stdout), text(input.row.stderr)].filter((item): item is string => !!item).join("\n")
  const output = bufferedOutput || own(input.state.toolOutputByCallId, input.toolCallId) || ""
  return {
    state: {
      ...ensured.state,
      toolOutputByCallId: boundKeyedRecord({
        ...ensured.state.toolOutputByCallId,
        ...ensured.state.toolOutputByCallId,
        [input.toolCallId]: output,
      }, RETAINED_WIRE_KEYS_MAX),
    },
    events: [
      ...ensured.events,
      exitCode === 0
        ? { type: "tool-output", toolCallId: input.toolCallId, output, display: ensured.display, metadata: input.metadata }
        : { type: "tool-error", toolCallId: input.toolCallId, error: output || `Process exited with code ${exitCode}`, display: ensured.display, metadata: input.metadata },
    ] satisfies AgentRuntimeEvent[],
  }
}

function rateLimitEvent(row: Record<string, unknown>) {
  const rateLimits = asRecord(row.rateLimits) ?? {}
  const primary = asRecord(rateLimits.primary)
  const secondary = asRecord(rateLimits.secondary)
  const window = [primary, secondary]
    .filter((item): item is Record<string, unknown> => !!item)
    .sort((a, b) => (asFiniteNumber(b.usedPercent) ?? 0) - (asFiniteNumber(a.usedPercent) ?? 0))[0]
  return {
    type: "rate-limit",
    status: rateLimits.rateLimitReachedType ? "limited" : "ok",
    usedPercent: asFiniteNumber(window?.usedPercent),
    resetsAt: asFiniteNumber(window?.resetsAt) ?? null,
    windowDurationMins: asFiniteNumber(window?.windowDurationMins) ?? null,
    limitId: text(rateLimits.limitId) ?? null,
    limitName: text(rateLimits.limitName) ?? null,
    reason: text(rateLimits.rateLimitReachedType) ?? null,
    metadata: { codex: { rateLimits } },
  } satisfies AgentRuntimeEvent
}

function rateLimitErrorMessage(event: Extract<AgentRuntimeEvent, { type: "rate-limit" }>) {
  const reset = formatRateLimitReset(event.resetsAt, event.windowDurationMins)
  const reason = event.reason
  if (reason === "workspace_owner_credits_depleted" || reason === "workspace_member_credits_depleted") {
    return `You've reached your Codex credits limit.${reset}`
  }
  if (reason === "rate_limit_reached") {
    return `You've reached your Codex rate limit.${reset}`
  }
  if (reason === "workspace_owner_usage_limit_reached" || reason === "workspace_member_usage_limit_reached") {
    return `You've reached your Codex usage limit.${reset}`
  }
  if (event.limitName) {
    return `You've reached your ${event.limitName} limit.${reset}`
  }
  return `You've reached your Codex usage limit.${reset}`
}

function codexErrorInfoMessage(info: unknown) {
  if (info === "usageLimitExceeded") return "You've reached your Codex usage limit."
  if (info === "serverOverloaded") return "Codex is overloaded. Try again in a moment."
  if (info === "unauthorized") {
    return "Codex rejected the credential. Run `codex login` or sync a valid Codex credential, then retry."
  }
  if (info === "contextWindowExceeded") return "This turn exceeded the Codex context window."
  if (info === "cyberPolicy") return "Codex refused this request due to a safety policy."
  return undefined
}

const HTTP_FAILURE_INFO = ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]

function codexErrorInfoClass(info: unknown): FirstTurnErrorClass | undefined {
  if (info === "usageLimitExceeded") return "usage_limit"
  const variants = asRecord(info)
  const status = HTTP_FAILURE_INFO.map((name) => asRecord(variants?.[name])?.httpStatusCode).find((code) => code !== undefined)
  return status === 429 ? "rate_limit" : undefined
}

function turnErrorEvent(
  error: Record<string, unknown> | undefined,
  rowMessage: string | undefined,
  lastLimitedRateLimitMessage: string | undefined,
  fallback: string,
): AgentRuntimeEventOf<"error"> {
  const message = turnErrorMessage(error, lastLimitedRateLimitMessage) ?? rowMessage
  const errorClass = codexErrorInfoClass(error?.codexErrorInfo)
    ?? (lastLimitedRateLimitMessage && (message === undefined || message.startsWith(lastLimitedRateLimitMessage)) ? "usage_limit" : undefined)
  return {
    type: "error",
    error: message ?? lastLimitedRateLimitMessage ?? fallback,
    ...(errorClass ? { errorClass } : {}),
  }
}

function turnErrorMessage(error: Record<string, unknown> | undefined, lastLimitedRateLimitMessage?: string) {
  const message = text(error?.message) ?? text(asRecord(error?.message)?.message)
  const details = text(error?.additionalDetails)
  const fromInfo = codexErrorInfoMessage(error?.codexErrorInfo)
  const generic = !message || message.trim().toLowerCase() === "session error"
  const head = generic ? fromInfo ?? lastLimitedRateLimitMessage : message
  if (!head) return details
  if (details && !head.includes(details)) return `${head.replace(/\.$/, "")}. ${details}`
  return head
}

function threadStatusEvents(row: Record<string, unknown>) {
  const status = asRecord(row.status)
  const type = text(status?.type)
  if (type === "active") return [{ type: "session-status", status: "busy" }] satisfies AgentRuntimeEvent[]
  if (type === "idle" || type === "notLoaded") return [{ type: "session-status", status: "idle" }] satisfies AgentRuntimeEvent[]
  return []
}

function protocolEvent(event: { method?: string; payload: unknown }): CodexAppServerProtocolEvent {
  if (!event.method) throw new Error("Codex app-server event is missing a method")
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    method: event.method,
    params: payload(event),
    id: text(eventFields(event).requestId) ?? text(payload(event).requestId) ?? "",
  } as CodexAppServerProtocolEvent
}

export const CODEX_DESCENDANT_ERROR_METHOD = "codex/descendant-error"

export function codexAppServerAdapter(options: { threadModel?: CodexThreadModel } = {}): HarnessEventAdapter<CodexAppServerAdapterState> {
  return {
    name: "codex-app-server",
    createInitialState: createCodexAppServerAdapterState,
    translate({ state, event, context }) {
      if (event.method === CODEX_DESCENDANT_ERROR_METHOD) {
        const row = payload(event)
        return [diagnosticForEvent({
          code: "codex_app_server.descendant_error",
          message: turnErrorMessage(asRecord(row.error), undefined) ?? text(row.message) ?? "A nested Codex subagent failed",
          severity: "warn",
          event,
        })]
      }
      const message = protocolEvent(event)
      const method = message.method
      const row = payload(event)

      switch (message.method) {
        case "item/agentMessage/delta": {
          const delta = eventText(event)
          if (!delta) return []
          const id = itemId(event, "assistant")
          return {
            state: {
              ...state,
              assistantTextByItemId: boundKeyedRecord({
                ...state.assistantTextByItemId,
                ...state.assistantTextByItemId,
                [id]: `${own(state.assistantTextByItemId, id) ?? ""}${delta}`,
              }, RETAINED_WIRE_KEYS_MAX),
            },
            events: [{ type: "text-delta", delta }],
          }
        }

        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          const delta = eventText(event)
          return delta ? [{ type: "thinking-delta", delta }] : []
        }

        case "item/plan/delta": {
          const delta = eventText(event)
          return delta ? [{ type: "proposed-plan-delta", delta }] : []
        }

        case "item/completed": {
          const completedItem = item(event)
          if (!completedItem) return []
          if (codexSubagentActivity(completedItem)?.kind === "completed") return []
          if (completedItem.type === "contextCompaction") {
            return [{ type: "session-compaction", phase: "completed", metadata: { codex: row } }]
          }
          const id = itemId(event, context.createId("item"))
          const itemType = canonicalItemType(completedItem.type)
          if (itemType === "user_message") return []
          if (itemType === "plan") {
            const planMarkdown = text(completedItem.text) ?? text(completedItem.summary)
            return planMarkdown ? [{ type: "proposed-plan-complete", planMarkdown }] : []
          }
          if (itemType === "assistant_message") {
            const fullText = text(completedItem.text)
            const previous = own(state.assistantTextByItemId, id) ?? ""
            const delta = fullText?.startsWith(previous) ? fullText.slice(previous.length) : fullText
            if (!delta) return []
            return {
              state: {
                ...state,
                assistantTextByItemId: boundKeyedRecord({ ...state.assistantTextByItemId, [id]: fullText ?? previous }, RETAINED_WIRE_KEYS_MAX),
              },
              events: [{ type: "text-delta", delta }],
            }
          }
          if (itemType === "reasoning") {
            const content = [
              text(completedItem.text),
              text(completedItem.summary),
              ...(Array.isArray(completedItem.content) ? completedItem.content.flatMap((item) => text(item) ?? []) : []),
              ...(Array.isArray(completedItem.summary) ? completedItem.summary.flatMap((item) => text(item) ?? []) : []),
            ].flatMap((item) => item ?? []).join("\n")
            return content ? [{ type: "thinking-delta", delta: content }] : []
          }
          if (itemType === "error") {
            return [{ type: "error", error: text(completedItem.message) ?? text(completedItem.text) ?? "Codex item failed" }]
          }
          const existing = own(state.toolsByItemId, id)
          const output =
            completedItem.output ??
            completedItem.result ??
            completedItem.aggregatedOutput ??
            completedItem.text ??
            own(state.toolOutputByCallId, id) ??
            ""
          const exitCode = asFiniteNumber(completedItem.exitCode)
          const mcpFailed = itemType === "mcp_tool_call" && completedItem.status === "failed"
          const mcpResult = asRecord(completedItem.result)
          const mcpError = itemType === "mcp_tool_call"
            ? text(asRecord(completedItem.error)?.message) ?? (mcpFailed
              ? (Array.isArray(mcpResult?.content) ? mcpResult.content.flatMap((part) => text(asRecord(part)?.text) ?? []).join("\n") : "") || "MCP tool call failed"
              : undefined)
            : undefined
          const attachments = [
            ...(itemType === "image_view" && text(completedItem.path)
              ? [{ kind: "tool-file" as const, mime: "image/*", path: String(completedItem.path), filename: String(completedItem.path).split(/[\\/]/).pop() }]
              : []),
            ...contentBlockImages(mcpResult?.content),
            ...(Array.isArray(completedItem.contentItems) ? completedItem.contentItems : []).flatMap((item) =>
              asRecord(item)?.type === "inputImage" ? imageUrlAttachment(asRecord(item)?.imageUrl) : []),
          ]
          const commandStatus = itemType === "command_execution" ? text(completedItem.status) : undefined
          const completion = mcpError !== undefined
            ? { type: "tool-error" as const, toolCallId: id, error: mcpError }
            : commandStatus === "declined"
            ? { type: "tool-error" as const, toolCallId: id, error: "User declined the command" }
            : commandStatus === "failed"
            ? { type: "tool-error" as const, toolCallId: id, error: text(output) ?? `Process exited with code ${exitCode}` }
            : { type: "tool-output" as const, toolCallId: id, output, ...(attachments.length ? { attachments } : {}) }
          const completionMetadata = { ...(exitCode === undefined ? {} : { exitCode }), codex: { itemType } }
          if (!existing) {
            const toolName = toolNameForItem(itemType, completedItem)
            const input = structuredInput(completedItem)
            const display = toolDisplay(itemType, input, toolName)
            return {
              state: {
                ...state,
                toolsByItemId: boundKeyedRecord({ ...state.toolsByItemId, [id]: { toolName, input, itemType } }, RETAINED_WIRE_KEYS_MAX),
              },
              events: [
                { type: "tool-start", toolCallId: id, toolName, kind: itemType, display, metadata: { codex: { itemType } } },
                ...(input ? [{ type: "tool-input", toolCallId: id, input, display, metadata: { codex: { itemType } } } satisfies AgentRuntimeEvent] : []),
                { ...completion, display, metadata: completionMetadata },
              ],
            }
          }
          return [{ ...completion, display: toolDisplay(itemType, existing.input, existing.toolName), metadata: completionMetadata }]
        }

        case "item/started": {
          const startedItem = item(event) ?? row
          if (codexSubagentActivity(startedItem)?.kind === "completed") return []
          if (startedItem.type === "contextCompaction") {
            return [{ type: "session-compaction", phase: "started", metadata: { codex: row } }]
          }
          const id = itemId(event, context.createId("item"))
          const itemType = canonicalItemType(startedItem.type)
          if (itemType === "user_message" || itemType === "assistant_message" || itemType === "reasoning" || itemType === "plan") return []
          const toolName = toolNameForItem(itemType, startedItem)
          const input = structuredInput(startedItem)
          const display = toolDisplay(itemType, input, toolName)
          return {
            state: {
              ...state,
              toolsByItemId: boundKeyedRecord({ ...state.toolsByItemId, [id]: { toolName, input, itemType } }, RETAINED_WIRE_KEYS_MAX),
            },
            events: [
              { type: "tool-start", toolCallId: id, toolName, kind: itemType, display, metadata: { codex: { itemType } } },
              ...(input ? [{ type: "tool-input", toolCallId: id, input, display, metadata: { codex: { itemType } } } satisfies AgentRuntimeEvent] : []),
            ],
          }
        }

        case "turn/started":
          return [{ type: "session-status", status: "busy" }]

        case "turn/completed":
          return { state: endThreadTurn(state, event, context), events: completionEvents(event, context, state.lastLimitedRateLimitMessage) }

        case "thread/status/changed":
          return threadStatusEvents(row)

        case "thread/closed":
          return {
            state: endThreadTurn(state, event, context),
            events: [
              { type: "session-status", status: "idle" },
              { type: "finish", sessionId: codexSessionId(event, context) },
            ],
          }

        case "turn/plan/updated": {
          const todos = todosFromPlan(row)
          return todos.length ? [{ type: "todo-update", todos }] : []
        }

        case "turn/diff/updated": {
          const diff = text(row.diff)
          return diff ? [{ type: "file-diff", path: text(row.path) ?? "diff", newText: diff }] : []
        }

        case "thread/name/updated": {
          const title = text(row.threadName)
          return title ? [{ type: "session-title", title }] : []
        }

        case "thread/tokenUsage/updated": {
          const threadId = threadOf(event, context)
          const byThread = state.turnUsageByThread ?? {}
          const { [threadId]: _previous, ...otherThreads } = byThread
          const reported = state.reportedModels ?? {}
          const result = usage(row, own(byThread, threadId), threadId, (turnId) =>
            (turnId ? own(reported, reportedModelKey(threadId, turnId)) : undefined) ?? own(reported, threadId) ?? options.threadModel?.(threadId))
          if (!result) return []
          return {
            state: {
              ...state,
              turnUsageByThread: boundKeyedRecord({ ...otherThreads, [threadId]: result.turnUsage }, RETAINED_WIRE_KEYS_MAX),
            },
            events: [result.event],
          }
        }

        case "thread/compacted":
          return [{ type: "session-compaction", phase: "completed", metadata: { codex: row } }]

        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
        case "item/permissions/requestApproval":
        case "applyPatchApproval":
        case "execCommandApproval":
        case "item/tool/call":
          return [{
            type: "permission-request",
            requestId: text(message.id) ?? text(row.requestId) ?? context.createId("request"),
            tool: requestTool(method, row),
            paths: pathsFromPayload(row),
            details: { command: text(row.command), reason: text(row.reason) },
          }]

        case "item/tool/requestUserInput": {
          const list = questions(row)
          if (list.length === 0) return []
          return [{
            type: "question",
            requestId: text(message.id) ?? text(row.requestId) ?? context.createId("question"),
            questions: list,
          }]
        }

        case "account/updated":
          return [{
            type: "auth-status",
            status: row.authMode ? "authenticated" : "unknown",
            authMode: text(row.authMode) ?? null,
            planType: text(row.planType) ?? null,
            metadata: { codex: row },
          }]

        case "account/login/completed":
          return [
            {
              type: "auth-status",
              status: row.success === true ? "authenticated" : "unauthenticated",
              metadata: { codex: row },
            },
            ...(row.success === false
              ? [harnessNotice({
                code: "codex_app_server.account_login_failed",
                message: text(row.error) ?? "Codex account login failed",
                severity: "warn",
                details: row,
              })]
              : []),
          ]

        case "account/rateLimits/updated": {
          const event = rateLimitEvent(row)
          return {
            state: {
              ...state,
              lastLimitedRateLimitMessage: event.status === "limited" ? rateLimitErrorMessage(event) : undefined,
            },
            events: [event],
          }
        }

        case "mcpServer/startupStatus/updated":
          return [{
            type: "mcp-server-status",
            serverName: text(row.name) ?? "mcp",
            status: row.status === "ready" || row.status === "failed" || row.status === "cancelled" ? row.status : "starting",
            error: text(row.error) ?? null,
          }]

        case "mcpServer/oauthLogin/completed":
          return [harnessNotice({
            code: row.success === true ? "codex_app_server.mcp_oauth_login_completed" : "codex_app_server.mcp_oauth_login_failed",
            message: row.success === true
              ? `MCP server ${text(row.name) ?? "unknown"} OAuth login completed`
              : text(row.error) ?? `MCP server ${text(row.name) ?? "unknown"} OAuth login failed`,
            severity: row.success === true ? "info" : "warn",
            details: row,
          })]

        case "warning":
        case "guardianWarning":
          return [harnessNotice({
            code: `codex_app_server.${message.method.replace("/", "_")}`,
            message: text(row.message) ?? "Codex warning",
            severity: "warn",
            details: row,
          })]

        case "configWarning":
          return [harnessNotice({
            code: "codex_app_server.config_warning",
            message: text(row.summary) ?? "Codex config warning",
            severity: "warn",
            details: row,
          })]

        case "deprecationNotice":
          return [harnessNotice({
            code: "codex_app_server.deprecation_notice",
            message: text(row.summary) ?? "Codex deprecation notice",
            severity: "info",
            details: row,
          })]

        case "model/rerouted":
          return {
            state: recordReportedModel(state, method, row),
            events: [harnessNotice({
              code: "codex_app_server.model_rerouted",
              message: `Model rerouted from ${text(row.fromModel) ?? "unknown"} to ${text(row.toModel) ?? "unknown"}`,
              severity: "info",
              details: row,
            })],
          }

        case "thread/settings/updated":
          return { state: recordReportedModel(state, method, row), events: unmappedCodexAppServerEvent(event) }

        case "model/verification":
          return [harnessNotice({
            code: "codex_app_server.model_verification",
            message: "Codex model verification updated",
            severity: "info",
            details: row,
          })]

        case "windows/worldWritableWarning":
          return [harnessNotice({
            code: "codex_app_server.windows_world_writable_warning",
            message: text(row.message) ?? "Windows world-writable path warning",
            severity: "warn",
            details: row,
          })]

        case "error": {
          const failure = turnErrorEvent(asRecord(row.error), text(row.message), state.lastLimitedRateLimitMessage, "Codex provider error")
          if (row.willRetry === true) {
            return [diagnosticForEvent({ code: "codex_app_server.retryable_error", message: failure.error, severity: "warn", event })]
          }
          return [{ type: "session-status", status: "error" }, failure]
        }

        case "windowsSandbox/setupCompleted":
          return row.success === false
            ? [
              { type: "session-status", status: "error" },
              diagnosticForEvent({
                code: "codex_app_server.sandbox_setup_failed",
                message: text(row.error) ?? "Sandbox setup failed",
                severity: "warn",
                event,
              }),
            ]
            : []

        case "account/chatgptAuthTokens/refresh":
        case "app/list/updated":
        case "attestation/generate":
        case "externalAgentConfig/import/completed":
        case "fs/changed":
        case "fuzzyFileSearch/sessionCompleted":
        case "fuzzyFileSearch/sessionUpdated":
        case "remoteControl/status/changed":
        case "skills/changed":
        case "thread/archived":
        case "thread/goal/cleared":
        case "thread/goal/updated":
        case "thread/unarchived":
          return unmappedCodexAppServerEvent(event)

        case "thread/started":
          codexStartedSubagent(row)
          return []

        case "hook/completed":
        case "hook/started":
        case "item/autoApprovalReview/completed":
        case "item/autoApprovalReview/started":
          return unmappedCodexAppServerEvent(event)

        case "command/exec/outputDelta": {
          const id = text(row.processId) ?? context.createId("process")
          return appendToolText({
            state,
            toolCallId: id,
            itemType: "command_execution",
            toolName: "command",
            rawInput: structuredInput({ processId: id, stream: row.stream }),
            delta: base64Text(row.deltaBase64),
            metadata: { codex: { method, processId: id, stream: row.stream, capReached: row.capReached } },
          })
        }

        case "process/outputDelta": {
          const id = text(row.processHandle) ?? context.createId("process")
          return appendToolText({
            state,
            toolCallId: id,
            itemType: "command_execution",
            toolName: "process",
            rawInput: structuredInput({ processHandle: id, stream: row.stream }),
            delta: base64Text(row.deltaBase64),
            metadata: { codex: { method, processHandle: id, stream: row.stream, capReached: row.capReached } },
          })
        }

        case "item/commandExecution/outputDelta": {
          const id = itemId(event, context.createId("command"))
          return appendToolText({
            state,
            toolCallId: id,
            itemType: "command_execution",
            delta: text(row.delta),
            metadata: { codex: { method, threadId: row.threadId, turnId: row.turnId, itemId: id } },
          })
        }

        case "item/fileChange/outputDelta": {
          const id = itemId(event, context.createId("file-change"))
          return appendToolText({
            state,
            toolCallId: id,
            itemType: "file_change",
            delta: text(row.delta),
            metadata: { codex: { method, threadId: row.threadId, turnId: row.turnId, itemId: id } },
          })
        }

        case "item/mcpToolCall/progress": {
          const id = itemId(event, context.createId("mcp"))
          return appendToolText({
            state,
            toolCallId: id,
            itemType: "mcp_tool_call",
            delta: text(row.message),
            metadata: { codex: { method, threadId: row.threadId, turnId: row.turnId, itemId: id } },
          })
        }

        case "item/commandExecution/terminalInteraction": {
          const id = itemId(event, context.createId("command"))
          const ensured = ensureTool({
            state,
            toolCallId: id,
            itemType: "command_execution",
            rawInput: structuredInput(row),
          })
          const terminalId = text(row.processId)
          return terminalId
            ? {
              state: ensured.state,
              events: [
                ...ensured.events,
                { type: "tool-terminal", toolCallId: id, terminalId },
              ],
            }
            : { state: ensured.state, events: ensured.events }
        }

        case "item/fileChange/patchUpdated": {
          const id = itemId(event, context.createId("file-change"))
          const ensured = ensureTool({
            state,
            toolCallId: id,
            itemType: "file_change",
          })
          const diffs = Array.isArray(row.changes)
            ? row.changes.flatMap((change) => {
              const item = asRecord(change)
              const path = text(item?.path)
              const diff = text(item?.diff)
              if (!path || !diff) return []
              return [{ type: "file-diff", toolCallId: id, path, newText: diff } satisfies AgentRuntimeEvent]
            })
            : []
          return {
            state: ensured.state,
            events: [...ensured.events, ...diffs],
          }
        }

        case "process/exited": {
          const id = text(row.processHandle) ?? context.createId("process")
          const exitCode = asFiniteNumber(row.exitCode)
          return processExitEvents({
            state,
            toolCallId: id,
            row,
            metadata: {
              ...(exitCode === undefined ? {} : { exitCode }),
              codex: {
                method,
                processHandle: id,
                stdoutCapReached: row.stdoutCapReached,
                stderrCapReached: row.stderrCapReached,
              },
            },
          })
        }

        case "item/reasoning/summaryPartAdded":
        case "rawResponseItem/completed":
        case "serverRequest/resolved":
          return unmappedCodexAppServerEvent(event)

        case "mcpServer/elicitation/request": {
          const approval = codexMcpApproval(row)
          if (approval) return [{
            type: "permission-request",
            requestId: text(message.id) ?? text(row.requestId) ?? context.createId("request"),
            tool: approval.tool,
            paths: [],
            details: { reason: approval.reason },
            options: approval.options.map(({ id, label }) => ({ id, label })),
          }]
          return unmappedCodexAppServerEvent(event)
        }

        case "thread/realtime/closed":
        case "thread/realtime/error":
        case "thread/realtime/itemAdded":
        case "thread/realtime/outputAudio/delta":
        case "thread/realtime/sdp":
        case "thread/realtime/started":
        case "thread/realtime/transcript/delta":
        case "thread/realtime/transcript/done":
          return unmappedCodexAppServerEvent(event)

        default:
          return unmappedCodexAppServerEvent(event)
      }
    },
  }
}
