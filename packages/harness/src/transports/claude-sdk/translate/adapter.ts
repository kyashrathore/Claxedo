import {
  canonicalToolName,
  isSubagentSpawnToolName,
  reconstructQuestionAnswers,
  USAGE_WINDOW_NAMES,
} from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { FirstTurnErrorClass } from "@claxedo/agent-runtime-contract"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentRuntimeEvent, AgentRuntimeEventOf, RuntimeTokenUsage, RuntimeToolAttachment, SubagentMode, SubagentStatus, SubagentToolCallRole, ToolDisplay } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapter, HarnessEventAdapterContext, HarnessEventAdapterResult } from "../../../translate/adapter"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import { imageAttachment } from "../../../translate/tool-attachments"
import { formatRateLimitReset } from "../../../translate/rate-limit-reset"
import { hostSubagentBinding, hostSubagentObservation, isHostSubagentTool } from "../../../translate/host-subagent"
import { optionLabels, own, pathFields, text } from "../../../translate/value"
import { parseJsonRecord, readPartialJsonRecord } from "./partial-json"
import { isClaudeQuestionDecline } from "./question-decline"
import { applyClaudeTaskResult, type ClaudeTrackedTask } from "./task-tracking"
import type { ClaudeTaskLedger, ClaudeTaskRecord } from "./task-ledger"

type ClaudeBlockState = {
  type: "text" | "thinking" | "tool"
  fallbackText?: string
  emittedText?: boolean
  toolCallId?: string
  toolName?: string
  input?: Record<string, unknown>
  partialInputJson?: string
  streamedInputJson?: string
}

export type ClaudeRequestUsage = {
  input: number | null
  output: number | null
  reasoning: number | null
  cacheRead: number | null
  cacheWrite: number | null
  cacheWrite1h: number | null
  model?: string
}

export type ClaudeSdkAdapterState = {
  tasks?: Record<string, ClaudeTrackedTask>
  blocksByIndex: Record<string, ClaudeBlockState>
  toolsById: Record<string, ClaudeBlockState>
  streamedAssistantTextByOwner: Record<string, string>
  reconciledAssistantTextByMessageId: Record<string, string>
  cwd?: string
  lastKnownContextWindow?: number
  requestUsageByOwner?: Record<string, Record<string, ClaudeRequestUsage>>
  streamingRequestByOwner?: Record<string, string>
  lastMainRequest?: string
  rejectedWindow?: { limitName?: string; resetsAt?: number | null }
}

export type ClaudeSubagentUsage = {
  parent_tool_use_id: string | null
  session_id?: string
  message: { id: string; usage: Record<string, unknown>; model?: string }
}

export const CLAUDE_SUBAGENT_USAGE_METHOD = "claude/subagent-usage"

export type ClaudeSubagentObservation = {
  observationId: string
  harnessExecutionId?: string
  stableCorrelationId?: string
  toolCallId?: string
  toolCallRole?: SubagentToolCallRole
  mode?: SubagentMode
  status?: SubagentStatus
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  subagentKey?: string
  childSessionId?: string
  transcript?: { kind: "messages" | "live" }
}

type ClaudeSdkSystemMessage = Extract<SDKMessage, { type: "system" }>

function assertNever(value: never): never {
  throw new Error(`Unhandled Claude SDK event: ${JSON.stringify(value)}`)
}

function payload(event: { payload: unknown }) {
  return asRecord(event.payload) ?? {}
}

function sdkMessage(event: { payload: unknown }) {
  return payload(event)
}

const sdkMessageTypes = {
  assistant: true,
  auth_status: true,
  conversation_reset: true,
  prompt_suggestion: true,
  rate_limit_event: true,
  result: true,
  stream_event: true,
  system: true,
  tool_progress: true,
  tool_use_summary: true,
  user: true,
} satisfies Record<SDKMessage["type"], true>

function isSdkMessage(message: Record<string, unknown>): message is SDKMessage {
  return typeof message.type === "string" && message.type in sdkMessageTypes
}

function diagnosticForEvent(input: {
  code: string
  message: string
  event: { source: string; method?: string; payload: unknown }
  severity?: "debug" | "info" | "warn" | "error"
  details?: Record<string, unknown>
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
      details: input.details,
    }),
  } satisfies AgentRuntimeEvent
}

function unmappedSdkEvent(input: {
  sdkEvent: string
  reason: string
  event: { source: string; method?: string; payload: unknown }
  severity?: "debug" | "info" | "warn" | "error"
}) {
  return [diagnosticForEvent({
    code: "claude_sdk.unmapped_event",
    message: `${input.sdkEvent}: ${input.reason}`,
    severity: input.severity ?? "info",
    event: input.event,
    details: { sdkEvent: input.sdkEvent, reason: input.reason },
  })]
}

function toolInput(value: unknown) {
  return asRecord(value) ?? {}
}

function isTaskTool(toolName: string) {
  return isSubagentSpawnToolName(toolName) || isHostSubagentTool(toolName)
}

function toolKind(toolName: string) {
  const normalized = toolName.toLowerCase()
  if (isTaskTool(toolName)) return "collab_agent_tool_call"
  if (normalized === "bash" || normalized.includes("shell") || normalized.includes("command")) return "command_execution"
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) return "file_change"
  if (normalized.includes("read") || normalized.includes("grep") || normalized.includes("glob")) return "file_read"
  return "dynamic_tool_call"
}

function toolDisplay(toolName: string, input: Record<string, unknown>) {
  return toolDisplayFromInput({
    kind: toolKind(toolName),
    toolName,
    ...(Object.keys(input).length ? { input } : {}),
  })
}

function toolStartEvents(block: Record<string, unknown>): AgentRuntimeEvent[] {
  const toolCallId = text(block.id)
  const toolName = text(block.name)
  if (!toolCallId || !toolName) return []
  const input = toolInput(block.input)
  const metadata = { claude: { itemType: toolKind(toolName) } }
  const display = toolDisplay(toolName, input)
  return [
    {
      type: "tool-start",
      toolCallId,
      toolName,
      kind: toolKind(toolName),
      display,
      metadata,
    },
    ...(Object.keys(input).length > 0
      ? [{ type: "tool-input", toolCallId, input, display, metadata } satisfies AgentRuntimeEvent]
      : []),
  ]
}

function toolInputEvents(tool: ClaudeBlockState, parsedInput: Record<string, unknown>) {
  if (!tool.toolCallId || !tool.toolName) return []
  return [{
    type: "tool-input",
    toolCallId: tool.toolCallId,
    input: parsedInput,
    display: toolDisplay(tool.toolName, parsedInput),
    metadata: { claude: { itemType: toolKind(tool.toolName) } },
  }] satisfies AgentRuntimeEvent[]
}

function exitCodeFromResultText(resultText: string) {
  const match = /^Exit code (\d+)(?:\s|$)/.exec(resultText)
  return match ? Number(match[1]) : undefined
}

function toolResultText(block: Record<string, unknown>) {
  const content = block.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((item) => text(item) ?? text(asRecord(item)?.text) ?? []).join("\n")
}

function toolResultImages(block: Record<string, unknown>): Array<{ mime: string; data: string }> {
  const content = block.content
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    const row = asRecord(item)
    if (row?.type !== "image") return []
    const source = asRecord(row.source)
    if (source?.type !== "base64") return []
    const mime = text(source.media_type)
    const data = text(source.data)
    if (!mime || !data) return []
    return [{ mime, data }]
  })
}

function resultAttachments(
  images: Array<{ mime: string; data: string }>,
  display: ToolDisplay,
): RuntimeToolAttachment[] {
  if (images.length !== 1) return images.map((image) => imageAttachment(image))
  const sourcePath = display.filePath ?? display.path
  const filename = sourcePath?.split(/[\\/]/).pop()
  return images.map((image) => imageAttachment({ ...image, filename, sourcePath }))
}

function toolResultBlocks(message: Record<string, unknown>) {
  const row = asRecord(message.message) ?? {}
  const content = Array.isArray(row.content) ? row.content : []
  return content.flatMap((item) => {
    const block = asRecord(item)
    if (!block || block.type !== "tool_result") return []
    const toolCallId = text(block.tool_use_id)
    if (!toolCallId) return []
    return [{
      toolCallId,
      block,
      text: toolResultText(block),
      images: toolResultImages(block),
      isError: block.is_error === true,
      structured: asRecord(message.tool_use_result),
    }]
  })
}

function assistantContent(message: Record<string, unknown>) {
  const row = asRecord(message.message) ?? {}
  return Array.isArray(row.content) ? row.content : []
}

function assistantSnapshotText(message: Record<string, unknown>) {
  return assistantContent(message).flatMap((item) => {
    const block = asRecord(item)
    if (!block || block.type !== "text") return []
    return text(block.text) ?? []
  }).join("")
}

function assistantToolBlocks(message: Record<string, unknown>) {
  return assistantContent(message).flatMap((item) => {
    const block = asRecord(item)
    if (!block || block.type !== "tool_use") return []
    const toolCallId = text(block.id)
    const toolName = text(block.name)
    if (!toolCallId || !toolName) return []
    return [{
      block,
      tool: {
        type: "tool" as const,
        toolCallId,
        toolName,
        input: toolInput(block.input),
      },
    }]
  })
}

function agentResultMetadata(result: Record<string, unknown> | undefined) {
  if (!result || !text(result.agentId)) return {}
  return {
    agentId: text(result.agentId),
    status: text(result.status),
    totalTokens: asFiniteNumber(result.totalTokens),
    totalToolUseCount: asFiniteNumber(result.totalToolUseCount),
    totalDurationMs: asFiniteNumber(result.totalDurationMs),
    usage: asRecord(result.usage),
    toolStats: asRecord(result.toolStats),
  }
}

function isQuestionTool(toolName: string) {
  return canonicalToolName(toolName) === "question"
}

function questionAnswerMetadata(input: Record<string, unknown>, result: Record<string, unknown> | undefined) {
  const answers = asRecord(result?.answers)
  if (!answers) return {}
  const questions = Array.isArray(input.questions) ? input.questions : []
  return {
    answers: reconstructQuestionAnswers(
      questions.map((item) => {
        const row = asRecord(item) ?? {}
        return {
          question: text(row.question) ?? "",
          optionLabels: optionLabels(row.options),
          multiple: row.multiSelect === true,
        }
      }),
      answers,
    ),
  }
}

function agentResultText(result: Record<string, unknown> | undefined, fallback: string) {
  if (!result) return fallback
  const content = Array.isArray(result.content) ? result.content : []
  return content.flatMap((item) => text(asRecord(item)?.text) ?? []).join("\n") || fallback
}

function claudeHostSubagentObservations(
  message: Record<string, unknown>,
  wrapperId: string,
  harnessExecutionId: string | undefined,
  ledger: ClaudeTaskLedger,
): ClaudeSubagentObservation[] {
  const blocks = toolResultBlocks(message)
  return blocks.flatMap((tool) => {
    if (!ledger.isHostSubagentCall(tool.toolCallId)) return []
    const binding = hostSubagentBinding(tool.block)
      ?? (blocks.length === 1 ? hostSubagentBinding(message.tool_use_result) : undefined)
    if (!binding) return []
    return [{
      ...hostSubagentObservation({
        observationId: `claude:host-subagent:${wrapperId}:${tool.toolCallId}`,
        ...(harnessExecutionId ? { harnessExecutionId } : {}),
        toolCallId: tool.toolCallId,
        binding,
      }),
      ...taskCall(tool.toolCallId, ledger),
    }]
  })
}

export function claudeChildCorrelationKey(value: unknown) {
  return text(asRecord(value)?.parent_tool_use_id)
}

function claudeStreamOwner(message: Record<string, unknown>) {
  return claudeChildCorrelationKey(message) ?? ""
}

function withoutKey(row: Record<string, string>, key: string) {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key))
}

function commonPrefixLength(shown: string, snapshot: string) {
  const limit = Math.min(shown.length, snapshot.length)
  let shared = 0
  while (shared < limit && shown[shared] === snapshot[shared]) shared += 1
  return shared
}

function reconcileAssistantSnapshot(shown: string, snapshot: string): { delta: string; divergedAt?: number } {
  if (snapshot.startsWith(shown)) return { delta: snapshot.slice(shown.length) }
  const shared = commonPrefixLength(shown, snapshot)
  return { delta: snapshot.slice(shared), divergedAt: shared }
}

export function foldNestedSubagentFrame(frame: unknown, ledger: ClaudeTaskLedger): unknown {
  const message = asRecord(frame)
  const owner = claudeChildCorrelationKey(message)
  if (!message || !owner) return frame
  const firstLevel = ledger.firstLevelSubagent(owner)
  if (message.type === "assistant") {
    for (const { tool } of assistantToolBlocks(message)) {
      if (isTaskTool(tool.toolName) && !isHostSubagentTool(tool.toolName)) ledger.nestSubagentCall(tool.toolCallId, firstLevel)
    }
  }
  return firstLevel === owner ? frame : { ...message, parent_tool_use_id: firstLevel }
}

export function claudeSubagentObservations(value: unknown, ledger: ClaudeTaskLedger): ClaudeSubagentObservation[] {
  const message = asRecord(value)
  if (!message) return []
  const harnessExecutionId = text(message.session_id)
  const wrapperId = text(message.uuid) ?? harnessExecutionId ?? "unknown"

  if (message.type === "assistant") {
    const fromParent = !claudeChildCorrelationKey(message)
    for (const { tool } of assistantToolBlocks(message)) {
      if (!isHostSubagentTool(tool.toolName)) continue
      ledger.startHostSubagentCall(tool.toolCallId)
      if (fromParent) ledger.startSpawnCall(tool.toolCallId)
    }
  }

  if (message.type === "assistant" && !claudeChildCorrelationKey(message)) {
    return assistantToolBlocks(message).flatMap(({ tool }) => {
      if (!isTaskTool(tool.toolName) || isHostSubagentTool(tool.toolName) || !tool.toolCallId) return []
      ledger.startSpawnCall(tool.toolCallId)
      return [{
        observationId: `claude:agent-tool:${wrapperId}:${tool.toolCallId}`,
        ...(harnessExecutionId ? { harnessExecutionId } : {}),
        toolCallId: tool.toolCallId,
        toolCallRole: "spawn" as const,
        mode: tool.input?.run_in_background === true ? "background" as const : "foreground" as const,
        status: "pending" as const,
        label: text(tool.input?.description) ?? "Subagent",
        ...(text(tool.input?.subagent_type) ? { subagentType: text(tool.input?.subagent_type) } : {}),
        ...(text(tool.input?.description) ?? text(tool.input?.prompt)
          ? { description: text(tool.input?.description) ?? text(tool.input?.prompt) }
          : {}),
        providerKind: "claude-agent",
        transcript: { kind: "messages" as const },
      }]
    })
  }

  if (message.type === "user") {
    const result = asRecord(message.tool_use_result)
    const agentId = text(result?.agentId)
    if (!agentId) return claudeHostSubagentObservations(message, wrapperId, harnessExecutionId, ledger)
    if (claudeChildCorrelationKey(message)) return []
    const blocks = toolResultBlocks(message)
    const sole = blocks.length === 1 ? blocks[0] : undefined
    if (!sole) return []
    return [{
      observationId: `claude:agent-result:${wrapperId}:${sole.toolCallId}`,
      ...(harnessExecutionId ? { harnessExecutionId } : {}),
      ...taskCall(sole.toolCallId, ledger),
      status: result?.status === "completed" || result?.status === "forked"
        ? "completed" as const
        : result?.status === "failed" || result?.status === "error"
          ? "failed" as const
          : "running" as const,
      ...(result?.status === "async_launched" ? { mode: "background" as const } : {}),
      providerId: agentId,
      providerKind: "claude-agent",
      transcript: { kind: "messages" as const },
    }]
  }

  if (message.type !== "system") return []

  switch (message.subtype) {
    case "task_started": {
      const taskId = text(message.task_id)
      if (!taskId) return []
      const toolUseId = text(message.tool_use_id)
      const nested = (toolUseId !== undefined && ledger.isNestedSubagentCall(toolUseId)) ||
        (asFiniteNumber(message.spawn_depth) ?? 0) > 1
      const record: ClaudeTaskRecord = {
        taskId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(harnessExecutionId ? { harnessExecutionId } : {}),
        isAgentTask: !!text(message.subagent_type),
        skipTranscript: message.skip_transcript === true,
        ...(nested ? { nested } : {}),
      }
      ledger.start(record)
      if (!admittedTask(record)) return []
      return [taskObservation(message, wrapperId, ledger, {
        status: "running",
        description: text(message.description),
        subagentType: text(message.subagent_type),
      })]
    }
    case "task_progress":
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      return [taskObservation(message, wrapperId, ledger, {
        status: "running",
        description: text(message.description),
        subagentType: text(message.subagent_type),
      })]
    case "task_notification":
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      return [taskObservation(message, wrapperId, ledger, {
        status: message.status === "completed" ? "completed" : message.status === "failed" ? "failed" : "killed",
        description: text(message.summary),
      })]
    case "task_updated": {
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      const patch = asRecord(message.patch) ?? {}
      const status = taskStatus(patch.status)
      const mode = patch.is_backgrounded === true ? "background" as const : patch.is_backgrounded === false ? "foreground" as const : undefined
      if (!status && !mode && !text(patch.description)) return []
      return [taskObservation(message, wrapperId, ledger, {
        ...(status ? { status } : {}),
        ...(mode ? { mode } : {}),
        description: text(patch.description),
      })]
    }
    case "background_tasks_changed":
      return ledger
        .replaceLive(liveTaskIds(message))
        .flatMap((record) => admittedTask(record) ? [departedTaskObservation(record, wrapperId, ledger)] : [])
    default:
      return []
  }
}

function admittedTask(record: ClaudeTaskRecord | undefined) {
  return record?.isAgentTask && !record.skipTranscript && !record.nested ? record : undefined
}

function liveTaskIds(message: Record<string, unknown>) {
  const tasks = Array.isArray(message.tasks) ? message.tasks : []
  return tasks.flatMap((value) => text(asRecord(value)?.task_id) ?? [])
}

function departedTaskObservation(record: ClaudeTaskRecord, wrapperId: string, ledger: ClaudeTaskLedger): ClaudeSubagentObservation {
  return {
    observationId: `claude:background_tasks_changed:${wrapperId}:${record.taskId}`,
    ...(record.harnessExecutionId ? { harnessExecutionId: record.harnessExecutionId } : {}),
    stableCorrelationId: record.taskId,
    ...taskCall(record.toolUseId, ledger),
    status: "interrupted",
    providerKind: "claude-agent",
    transcript: { kind: "messages" },
  }
}

function taskStatus(value: unknown): ClaudeSubagentObservation["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "killed" || value === "paused") return value
  return undefined
}

function taskCall(toolCallId: string | undefined, ledger: ClaudeTaskLedger): Pick<ClaudeSubagentObservation, "toolCallId" | "toolCallRole"> {
  if (!toolCallId) return {}
  return ledger.isSpawnCall(toolCallId) ? { toolCallId, toolCallRole: "spawn" } : { toolCallId }
}

function taskObservation(
  message: Record<string, unknown>,
  observationId: string,
  ledger: ClaudeTaskLedger,
  update: Omit<ClaudeSubagentObservation, "observationId" | "harnessExecutionId" | "stableCorrelationId" | "toolCallId" | "toolCallRole" | "providerKind" | "transcript">,
): ClaudeSubagentObservation {
  const taskId = text(message.task_id)
  return {
    observationId: `claude:${text(message.subtype)}:${observationId}`,
    ...(text(message.session_id) ? { harnessExecutionId: text(message.session_id) } : {}),
    ...(taskId ? { stableCorrelationId: taskId } : {}),
    ...taskCall(text(message.tool_use_id), ledger),
    ...(update.mode ? { mode: update.mode } : {}),
    ...(update.status ? { status: update.status } : {}),
    ...(update.subagentType ? { subagentType: update.subagentType } : {}),
    ...(update.description ? { description: update.description, label: update.description } : {}),
    providerKind: "claude-agent",
    transcript: { kind: "messages" },
  }
}

function slashCommandEvents(message: Record<string, unknown>) {
  const commands = Array.isArray(message.slash_commands)
    ? message.slash_commands.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  return commands.length
    ? [{
      type: "available-commands-update",
      commands: commands.map((command) => ({ name: command, description: command })),
    } satisfies AgentRuntimeEvent]
    : []
}

function requestUsage(usage: Record<string, unknown> | undefined, model: string | undefined): ClaudeRequestUsage | undefined {
  if (!usage) return undefined
  const tokens = {
    input: asFiniteNumber(usage.input_tokens) ?? null,
    output: asFiniteNumber(usage.output_tokens) ?? null,
    reasoning: asFiniteNumber(usage.thinking_tokens) ?? null,
    cacheRead: asFiniteNumber(usage.cache_read_input_tokens) ?? null,
    cacheWrite: asFiniteNumber(usage.cache_creation_input_tokens) ?? null,
    cacheWrite1h: asFiniteNumber(asRecord(usage.cache_creation)?.ephemeral_1h_input_tokens) ?? null,
  }
  if (!Object.values(tokens).some((value) => value !== null && value > 0)) return undefined
  return model ? { ...tokens, model } : tokens
}

function larger(previous: number | null, next: number | null) {
  if (previous === null) return next
  if (next === null) return previous
  return Math.max(previous, next)
}

function mergeRequestUsage(previous: ClaudeRequestUsage | undefined, next: ClaudeRequestUsage): ClaudeRequestUsage {
  if (!previous) return next
  return {
    input: larger(previous.input, next.input),
    output: larger(previous.output, next.output),
    reasoning: larger(previous.reasoning, next.reasoning),
    cacheRead: larger(previous.cacheRead, next.cacheRead),
    cacheWrite: larger(previous.cacheWrite, next.cacheWrite),
    cacheWrite1h: larger(previous.cacheWrite1h, next.cacheWrite1h),
    ...(previous.model ? { model: previous.model } : {}),
  }
}

function sameRequestUsage(left: ClaudeRequestUsage, right: ClaudeRequestUsage) {
  return left.input === right.input &&
    left.output === right.output &&
    left.reasoning === right.reasoning &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.cacheWrite1h === right.cacheWrite1h
}

function addNullable(previous: number | null, value: number | null) {
  if (value === null) return previous
  return (previous ?? 0) + value
}

function sumRequestUsage(requests: Record<string, ClaudeRequestUsage>): ClaudeRequestUsage {
  const sum: ClaudeRequestUsage = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null }
  for (const tokens of Object.values(requests)) {
    sum.input = addNullable(sum.input, tokens.input)
    sum.output = addNullable(sum.output, tokens.output)
    sum.reasoning = addNullable(sum.reasoning, tokens.reasoning)
    sum.cacheRead = addNullable(sum.cacheRead, tokens.cacheRead)
    sum.cacheWrite = addNullable(sum.cacheWrite, tokens.cacheWrite)
    sum.cacheWrite1h = addNullable(sum.cacheWrite1h, tokens.cacheWrite1h)
  }
  return sum
}

function runtimeTokenUsage(tokens: ClaudeRequestUsage): RuntimeTokenUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: {
      read: tokens.cacheRead,
      write: tokens.cacheWrite,
      ...(tokens.cacheWrite1h === null ? {} : { write1h: tokens.cacheWrite1h }),
    },
  }
}

function ownerRequests(state: ClaudeSdkAdapterState, owner: string) {
  return own(state.requestUsageByOwner ?? {}, owner) ?? {}
}

function modelScope(requests: Record<string, ClaudeRequestUsage>, owner: string, model: string | undefined) {
  if (Object.values(requests)[0]?.model === model) return owner || undefined
  return `${owner || "main"}@${model ?? "unknown"}`
}

function ownerUsageEvent(state: ClaudeSdkAdapterState, owner: string, request: ClaudeRequestUsage, nativeSessionId?: string) {
  const requestTotal = (request.input ?? 0) + (request.output ?? 0) + (request.cacheRead ?? 0) + (request.cacheWrite ?? 0)
  const contextSize = state.lastKnownContextWindow ?? requestTotal
  const requests = ownerRequests(state, owner)
  const scope = modelScope(requests, owner, request.model)
  const sameModel = Object.fromEntries(Object.entries(requests).filter(([, tokens]) => tokens.model === request.model))
  return {
    type: "usage",
    contextSize,
    contextUsed: Math.min(requestTotal, contextSize),
    observation: {
      kind: "cumulative",
      ...(scope ? { scope } : {}),
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(request.model ? { model: request.model } : {}),
      tokens: runtimeTokenUsage(sumRequestUsage(sameModel)),
    },
  } satisfies AgentRuntimeEvent
}

function meterRequest(
  state: ClaudeSdkAdapterState,
  owner: string,
  requestId: string,
  usage: Record<string, unknown> | undefined,
  nativeSessionId: string | undefined,
  model: string | undefined,
) {
  const tokens = requestUsage(usage, model)
  if (!tokens) return undefined
  const requests = ownerRequests(state, owner)
  const previous = own(requests, requestId)
  const merged = mergeRequestUsage(previous, tokens)
  if (previous && sameRequestUsage(previous, merged)) return undefined
  const requestUsageByOwner = { ...state.requestUsageByOwner, [owner]: { ...requests, [requestId]: merged } }
  return {
    requestUsageByOwner,
    event: ownerUsageEvent({ ...state, requestUsageByOwner }, owner, merged, nativeSessionId),
  }
}

function meteredResult(state: ClaudeSdkAdapterState, metered: ReturnType<typeof meterRequest>) {
  return metered
    ? { state: { ...state, requestUsageByOwner: metered.requestUsageByOwner }, events: [metered.event] }
    : []
}

function resultUsageEvent(state: ClaudeSdkAdapterState, nativeSessionId?: string) {
  const requests = ownerRequests(state, "")
  const latest = (state.lastMainRequest ? own(requests, state.lastMainRequest) : undefined) ?? Object.values(requests).at(-1)
  return latest ? ownerUsageEvent(state, "", latest, nativeSessionId) : undefined
}

function resultContextWindow(message: Record<string, unknown>) {
  const modelUsage = asRecord(message.modelUsage)
  return modelUsage
    ? Object.values(modelUsage).flatMap((value) => asFiniteNumber(asRecord(value)?.contextWindow) ?? [])[0]
    : undefined
}

function isInterruptedResult(message: Record<string, unknown>, errorMessage?: string) {
  const summary = [
    errorMessage,
    text(message.subtype),
    text(message.stop_reason),
    text(message.result),
  ].flatMap((item) => item ?? []).join(" ").toLowerCase()
  return ["request was aborted", "aborted", "cancelled", "canceled", "interrupted"].some((item) => summary.includes(item))
}

function resultEvents(
  message: Record<string, unknown>,
  context: HarnessEventAdapterContext,
  usage: AgentRuntimeEventOf<"usage"> | undefined,
) {
  const sessionId = text(message.session_id) ?? context.threadId
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((item): item is string => typeof item === "string")
    : []
  const errorMessage = errors[0] ?? text(message.error)
  const interrupted = isInterruptedResult(message, errorMessage)
  if (message.is_error === true && !interrupted) {
    return [
      ...(usage ? [usage] : []),
      { type: "session-status", status: "error" },
      { type: "error", error: errorMessage ?? "Claude turn failed" },
    ] satisfies AgentRuntimeEvent[]
  }
  if (interrupted) {
    return [
      ...(usage ? [usage] : []),
      { type: "session-status", status: "idle" },
      { type: "cancelled", sessionId },
    ] satisfies AgentRuntimeEvent[]
  }
  return [
    ...(usage ? [usage] : []),
    { type: "session-status", status: "idle" },
    { type: "finish", sessionId },
  ] satisfies AgentRuntimeEvent[]
}

function questionFromToolUse(message: Record<string, unknown>, context: HarnessEventAdapterContext) {
  const row = payload({ payload: message })
  const toolName = text(row.toolName) ?? text(row.name)
  if (toolName !== "AskUserQuestion") return []
  const input = asRecord(row.input)
  if (!Array.isArray(input?.questions)) return []
  const questions = input.questions.flatMap((value) => {
    const question = asRecord(value)
    const prompt = text(question?.question)
    if (!prompt) return []
    const options = optionLabels(question?.options)
    const optionDescriptions = Object.fromEntries((Array.isArray(question?.options) ? question.options : [])
      .flatMap((value) => {
        const option = asRecord(value)
        const label = text(option?.label)
        const description = text(option?.description)
        return label && description ? [[label, description]] : []
      }))
    return [{
      text: prompt,
      options,
      optionDescriptions,
      header: text(question?.header),
      multiple: question?.multiSelect === true,
      custom: true,
    }]
  })
  if (!questions.length) return []
  return [{
    type: "question",
    requestId: text(row.requestId) ?? context.createId("question"),
    questions,
  }] satisfies AgentRuntimeEvent[]
}

function pathsFromToolInput(input: Record<string, unknown>) {
  return pathFields(input, ["path", "file_path", "filePath", "cwd"])
}

function permissionFromToolUse(message: Record<string, unknown>, context: HarnessEventAdapterContext) {
  const row = payload({ payload: message })
  const toolName = text(row.toolName) ?? text(row.name)
  if (!toolName) return []
  const input = asRecord(row.input) ?? {}
  return [{
    type: "permission-request",
    requestId: text(row.requestId) ?? context.createId("permission"),
    tool: toolName,
    paths: pathsFromToolInput(input),
    details: { command: text(input.command), reason: text(input.description) },
  }] satisfies AgentRuntimeEvent[]
}

function rateLimitResetMs(value: unknown) {
  const reset = asFiniteNumber(value)
  if (reset === undefined) return null
  return Math.round(reset < 1e12 ? reset * 1000 : reset)
}

function assistantErrorClass(code: string, state: ClaudeSdkAdapterState): FirstTurnErrorClass | undefined {
  if (code !== "rate_limit") return undefined
  return state.rejectedWindow ? "usage_limit" : "rate_limit"
}

function windowLimitMessage(window: NonNullable<ClaudeSdkAdapterState["rejectedWindow"]>) {
  const name = window.limitName?.replaceAll("_", " ")
  return `You've reached your Claude ${name ? `${name} ` : "usage "}limit.${formatRateLimitReset(window.resetsAt)}`
}

function claudeRateLimitEvent(info: Record<string, unknown>) {
  const utilization = asFiniteNumber(info.utilization)
  const limitId = text(info.rateLimitType)
  const windows = USAGE_WINDOW_NAMES.claude
  return {
    type: "rate-limit",
    status: text(info.status) === "rejected" ? "limited" : "ok",
    ...(utilization === undefined ? {} : { usedPercent: Math.min(100, Math.max(0, Math.round(utilization))) }),
    resetsAt: rateLimitResetMs(info.resetsAt),
    ...(limitId ? { limitId, limitName: (windows && Object.hasOwn(windows, limitId) ? windows[limitId] : undefined) ?? limitId } : {}),
  } satisfies AgentRuntimeEvent
}

function claudeTranscriptTitle(entry: Record<string, unknown>): AgentRuntimeEvent[] {
  if (entry.type === "ai-title") {
    const title = text(entry.aiTitle)?.trim()
    return title ? [{ type: "session-title", title }] : []
  }
  if (entry.type === "custom-title") {
    const title = text(entry.customTitle)?.trim()
    return title ? [{ type: "session-title", title, titleSource: "user" }] : []
  }
  return []
}

export function claudeSdkAdapter(initialTasks: ClaudeTrackedTask[] = []): HarnessEventAdapter<ClaudeSdkAdapterState> {
  return {
    name: "claude-sdk",
    createInitialState: () => ({ blocksByIndex: {}, toolsById: {}, streamedAssistantTextByOwner: {}, reconciledAssistantTextByMessageId: {}, tasks: Object.fromEntries(initialTasks.map((task) => [task.id, task])) }),
    translate({ state, event, context }) {
      const rawMessage = sdkMessage(event)

      if (event.method === "claude/can-use-tool") {
        const questions = questionFromToolUse(rawMessage, context)
        return questions.length ? questions : permissionFromToolUse(rawMessage, context)
      }

      if (event.method === "claude/session-store") return claudeTranscriptTitle(rawMessage)

      if (event.method === CLAUDE_SUBAGENT_USAGE_METHOD) {
        const request = asRecord(rawMessage.message)
        const requestId = text(request?.id)
        if (!requestId) return []
        return meteredResult(state, meterRequest(state, claudeStreamOwner(rawMessage), requestId, asRecord(request?.usage), text(rawMessage.session_id), text(request?.model)))
      }

      if (!isSdkMessage(rawMessage)) {
        return unmappedSdkEvent({
          sdkEvent: `SDKMessage(${text(rawMessage.type) ?? "unknown"})`,
          reason: "payload is not a known Claude SDK message type",
          event,
          severity: "warn",
        })
      }

      const message = rawMessage

      switch (message.type) {
        case "stream_event": {
          const stream = message.event
          switch (stream.type) {
            case "content_block_start": {
              const index = String(stream.index)
              const block = stream.content_block
              switch (block.type) {
                case "text":
                  return {
                    state: {
                      ...state,
                      blocksByIndex: {
                        ...state.blocksByIndex,
                        [index]: { type: "text", fallbackText: text(block.text) },
                      },
                    },
                    events: [],
                  }
                case "thinking":
                  return {
                    state: {
                      ...state,
                      blocksByIndex: {
                        ...state.blocksByIndex,
                        [index]: { type: "thinking", fallbackText: text(block.thinking) },
                      },
                    },
                    events: [],
                  }
                case "tool_use":
                case "server_tool_use":
                case "mcp_tool_use": {
                  const blockRow = asRecord(block) ?? {}
                  const toolName = text(block.name)
                  const toolCallId = text(block.id)
                  if (!toolName || !toolCallId) return []
                  const input = toolInput(blockRow.input)
                  const nextTool = {
                    type: "tool" as const,
                    toolCallId,
                    toolName,
                    input,
                    partialInputJson: "",
                  }
                  return {
                    state: {
                      ...state,
                      blocksByIndex: { ...state.blocksByIndex, [index]: nextTool },
                      toolsById: { ...state.toolsById, [toolCallId]: nextTool },
                    },
                    events: toolStartEvents(blockRow),
                  }
                }
                case "redacted_thinking":
                  return unmappedSdkEvent({
                    sdkEvent: "SDKPartialAssistantMessage.content_block_start(redacted_thinking)",
                    reason: "redacted thinking cannot be represented as assistant thinking text",
                    event,
                  })
                case "web_search_tool_result":
                case "web_fetch_tool_result":
                case "advisor_tool_result":
                case "code_execution_tool_result":
                case "bash_code_execution_tool_result":
                case "text_editor_code_execution_tool_result":
                case "tool_search_tool_result":
                case "mcp_tool_result":
                case "container_upload":
                  return unmappedSdkEvent({
                    sdkEvent: `SDKPartialAssistantMessage.content_block_start(${block.type})`,
                    reason: "provider result block has no stable AgentRuntimeEvent mapping without a tool-use id",
                    event,
                  })
                case "compaction":
                  return unmappedSdkEvent({
                    sdkEvent: "SDKPartialAssistantMessage.content_block_start(compaction)",
                    reason: "streaming compaction content has no stable AgentRuntimeEvent mapping yet",
                    event,
                  })
                case "fallback":
                  return unmappedSdkEvent({
                    sdkEvent: "SDKPartialAssistantMessage.content_block_start(fallback)",
                    reason: "model fallback boundaries have no dedicated AgentRuntimeEvent equivalent",
                    event,
                  })
                default:
                  return assertNever(block)
              }
            }
            case "content_block_delta": {
              const row = stream.delta
              switch (row.type) {
                case "text_delta": {
                  const deltaText = text(row.text)
                  if (!deltaText) return []
                  const block = state.blocksByIndex[String(stream.index)]
                  const owner = claudeStreamOwner(rawMessage)
                  return {
                    state: {
                      ...state,
                      streamedAssistantTextByOwner: {
                        ...state.streamedAssistantTextByOwner,
                        [owner]: `${own(state.streamedAssistantTextByOwner, owner) ?? ""}${deltaText}`,
                      },
                      blocksByIndex: block
                        ? { ...state.blocksByIndex, [String(stream.index)]: { ...block, emittedText: true } }
                        : state.blocksByIndex,
                    },
                    events: [{ type: "text-delta", delta: deltaText }],
                  }
                }
                case "thinking_delta": {
                  const thinking = text(row.thinking)
                  if (!thinking) return []
                  const block = state.blocksByIndex[String(stream.index)]
                  return {
                    state: {
                      ...state,
                      blocksByIndex: block
                        ? { ...state.blocksByIndex, [String(stream.index)]: { ...block, emittedText: true } }
                        : state.blocksByIndex,
                    },
                    events: [{ type: "thinking-delta", delta: thinking }],
                  }
                }
                case "input_json_delta": {
                  const block = state.blocksByIndex[String(stream.index)]
                  const partial = text(row.partial_json)
                  if (!block || block.type !== "tool" || !partial) return []
                  const partialInputJson = `${block.partialInputJson ?? ""}${partial}`
                  const parsedInput = parseJsonRecord(partialInputJson)
                  const streamedInput = parsedInput ?? readPartialJsonRecord(partialInputJson)
                  const streamedInputJson = streamedInput && Object.keys(streamedInput).length > 0
                    ? JSON.stringify(streamedInput)
                    : undefined
                  const emit = streamedInput && streamedInputJson && streamedInputJson !== block.streamedInputJson
                  const nextBlock = {
                    ...block,
                    partialInputJson,
                    ...(parsedInput ? { input: parsedInput } : {}),
                    ...(emit ? { streamedInputJson } : {}),
                  }
                  return {
                    state: {
                      ...state,
                      blocksByIndex: { ...state.blocksByIndex, [String(stream.index)]: nextBlock },
                    },
                    events: emit ? toolInputEvents(nextBlock, streamedInput) : [],
                  }
                }
                case "citations_delta":
                case "signature_delta":
                case "compaction_delta":
                  return unmappedSdkEvent({
                    sdkEvent: `SDKPartialAssistantMessage.content_block_delta(${row.type})`,
                    reason: "delta type has no dedicated AgentRuntimeEvent equivalent",
                    event,
                  })
                default:
                  return assertNever(row)
              }
            }
            case "content_block_stop": {
              const index = String(stream.index)
              const block = state.blocksByIndex[index]
              if (block?.type === "text" && block.fallbackText && !block.emittedText) {
                const owner = claudeStreamOwner(rawMessage)
                return {
                  state: {
                    ...state,
                    streamedAssistantTextByOwner: {
                      ...state.streamedAssistantTextByOwner,
                      [owner]: `${own(state.streamedAssistantTextByOwner, owner) ?? ""}${block.fallbackText}`,
                    },
                    blocksByIndex: { ...state.blocksByIndex, [index]: { ...block, emittedText: true } },
                  },
                  events: [{ type: "text-delta", delta: block.fallbackText }],
                }
              }
              if (block?.type === "thinking" && block.fallbackText && !block.emittedText) {
                return {
                  state: {
                    ...state,
                    blocksByIndex: { ...state.blocksByIndex, [index]: { ...block, emittedText: true } },
                  },
                  events: [{ type: "thinking-delta", delta: block.fallbackText }],
                }
              }
              return []
            }
            case "message_start": {
              const owner = claudeStreamOwner(rawMessage)
              const requestId = text(stream.message.id)
              if (!requestId) return []
              const streaming = {
                ...state,
                streamingRequestByOwner: { ...state.streamingRequestByOwner, [owner]: requestId },
                ...(owner ? {} : { lastMainRequest: requestId }),
              }
              const metered = meterRequest(streaming, owner, requestId, asRecord(stream.message.usage), text(rawMessage.session_id), text(stream.message.model))
              return metered ? meteredResult(streaming, metered) : { state: streaming, events: [] }
            }
            case "message_delta": {
              const owner = claudeStreamOwner(rawMessage)
              const requestId = own(state.streamingRequestByOwner ?? {}, owner)
              if (!requestId) return []
              return meteredResult(state, meterRequest(state, owner, requestId, asRecord(stream.usage), text(rawMessage.session_id), undefined))
            }
            case "message_stop":
              return { state: { ...state, streamingRequestByOwner: withoutKey(state.streamingRequestByOwner ?? {}, claudeStreamOwner(rawMessage)) }, events: [] }
            default:
              return assertNever(stream)
          }
        }

        case "user": {
          const byToolId = Object.fromEntries(
            [...Object.values(state.blocksByIndex), ...Object.values(state.toolsById)].flatMap((block) =>
              block.type === "tool" && block.toolCallId ? [[block.toolCallId, block]] : [],
            ),
          )
          let tasks = state.tasks ?? {}
          let changedTasks = false
          const events = toolResultBlocks(rawMessage).flatMap((result): AgentRuntimeEvent[] => {
            const tool = byToolId[result.toolCallId]
            if (!tool?.toolName) return []
            const exitCode = toolKind(tool.toolName) === "command_execution" ? exitCodeFromResultText(result.text) : undefined
            const metadata = {
              ...(exitCode === undefined ? {} : { exitCode }),
              claude: {
                itemType: toolKind(tool.toolName),
                ...(isTaskTool(tool.toolName) ? { subagent: agentResultMetadata(result.structured) } : {}),
              },
            }
            const display = toolDisplay(tool.toolName, tool.input ?? {})
            if (result.isError) {
              const declined = isQuestionTool(tool.toolName) && isClaudeQuestionDecline(result.text)
              return [{
                type: "tool-error",
                toolCallId: result.toolCallId,
                error: result.text,
                display,
                metadata: { ...metadata, ...(declined ? { question: { declined: true } } : {}) },
              }]
            }
            const nextTasks = applyClaudeTaskResult(tasks, tool.toolName, tool.input ?? {}, result.structured)
            if (nextTasks) {
              tasks = nextTasks
              changedTasks = true
            }
            return [{
              type: "tool-output",
              toolCallId: result.toolCallId,
              output: isTaskTool(tool.toolName) ? agentResultText(result.structured, result.text) : result.text,
              ...(result.images.length ? { attachments: resultAttachments(result.images, display) } : {}),
              display,
              metadata: {
                ...metadata,
                ...(isQuestionTool(tool.toolName) ? questionAnswerMetadata(tool.input ?? {}, result.structured) : {}),
              },
            }]
          })
          if (!changedTasks) return events
          return { state: { ...state, tasks }, events: [...events, { type: "todo-update", todos: Object.values(tasks) } satisfies AgentRuntimeEvent] }
        }

        case "assistant": {
          if (message.error) {
            const explanation = assistantSnapshotText(rawMessage)
            const errorClass = assistantErrorClass(message.error, state)
            const head = errorClass === "usage_limit" && state.rejectedWindow
              ? windowLimitMessage(state.rejectedWindow)
              : `Claude assistant message failed: ${message.error}`
            return [
              { type: "session-status", status: "error" },
              {
                type: "error",
                error: [head, explanation].filter(Boolean).join("\n"),
                ...(errorClass ? { errorClass } : {}),
              },
            ] satisfies AgentRuntimeEvent[]
          }
          const completeTools = assistantToolBlocks(rawMessage)
          const completeToolEvents = completeTools.flatMap(({ block, tool }): AgentRuntimeEvent[] => {
            if (!own(state.toolsById, tool.toolCallId)) {
              return toolStartEvents(block)
            }
            return Object.keys(tool.input ?? {}).length ? toolInputEvents(tool, tool.input ?? {}) : []
          })
          const toolsById = Object.fromEntries(completeTools.map(({ tool }) => [tool.toolCallId, tool]))
          const snapshot = assistantSnapshotText(rawMessage)
          const messageId = text(message.message.id)
          const owner = claudeStreamOwner(rawMessage)
          const shown = `${(messageId ? own(state.reconciledAssistantTextByMessageId, messageId) : undefined) ?? ""}${own(state.streamedAssistantTextByOwner, owner) ?? ""}`
          const reconciliation = snapshot ? reconcileAssistantSnapshot(shown, snapshot) : undefined
          const metered = messageId
            ? meterRequest(state, owner, messageId, asRecord(message.message.usage), text(rawMessage.session_id), text(message.message.model))
            : undefined
          return {
            state: {
              ...state,
              toolsById: { ...state.toolsById, ...toolsById },
              ...(reconciliation
                ? {
                    streamedAssistantTextByOwner: withoutKey(state.streamedAssistantTextByOwner, owner),
                    ...(messageId
                      ? { reconciledAssistantTextByMessageId: { ...state.reconciledAssistantTextByMessageId, [messageId]: snapshot } }
                      : {}),
                  }
                : {}),
              ...(metered ? { requestUsageByOwner: metered.requestUsageByOwner } : {}),
            },
            events: [
              ...completeToolEvents,
              ...(reconciliation?.divergedAt === undefined ? [] : [diagnosticForEvent({
                code: "claude_sdk.assistant_snapshot_divergence",
                message: "assistant snapshot diverges from the streamed text; emitting only the unseen suffix",
                severity: "warn",
                event,
                details: {
                  ...(messageId ? { messageId } : {}),
                  divergedAt: reconciliation.divergedAt,
                  shownLength: shown.length,
                  snapshotLength: snapshot.length,
                },
              })]),
              ...(reconciliation?.delta ? [{ type: "text-delta", delta: reconciliation.delta } satisfies AgentRuntimeEvent] : []),
              ...(metered ? [metered.event] : []),
            ],
          }
        }

        case "result": {
          const lastKnownContextWindow = resultContextWindow(rawMessage) ?? state.lastKnownContextWindow
          const next = {
            ...state,
            blocksByIndex: {},
            toolsById: {},
            streamedAssistantTextByOwner: {},
            reconciledAssistantTextByMessageId: {},
            ...(lastKnownContextWindow ? { lastKnownContextWindow } : {}),
          }
          return {
            state: next,
            events: resultEvents(rawMessage, context, resultUsageEvent(next, text(rawMessage.session_id))),
          }
        }

        case "system":
          return translateSystemMessage(message, rawMessage, state, event)

        case "tool_progress":
          return [{ type: "tool-status", toolCallId: message.tool_use_id, status: "running" }]

        case "tool_use_summary":
          return message.summary ? [{ type: "diagnostic", diagnostic: runtimeDiagnostic({
            code: "claude_sdk.tool_use_summary",
            message: message.summary,
            severity: "info",
            source: event.source,
            method: event.method,
            raw: event.payload,
          }) }] : []

        case "auth_status":
          return message.error
            ? [
              { type: "session-status", status: "error" },
              { type: "error", error: message.error },
            ] satisfies AgentRuntimeEvent[]
            : unmappedSdkEvent({
              sdkEvent: "SDKAuthStatusMessage",
              reason: "authentication progress output has no dedicated AgentRuntimeEvent equivalent",
              event,
            })

        case "rate_limit_event": {
          const event = claudeRateLimitEvent(asRecord(message.rate_limit_info) ?? {})
          const { rejectedWindow: _, ...rest } = state
          const rejectedWindow = { ...(event.limitName ? { limitName: event.limitName } : {}), resetsAt: event.resetsAt }
          return { state: event.status === "limited" ? { ...rest, rejectedWindow } : rest, events: [event] }
        }

        case "prompt_suggestion":
          return unmappedSdkEvent({
            sdkEvent: "SDKPromptSuggestionMessage",
            reason: "prompt suggestions have no dedicated AgentRuntimeEvent equivalent",
            event,
          })

        case "conversation_reset":
          return unmappedSdkEvent({
            sdkEvent: "SDKConversationResetMessage",
            reason: "conversation reset has no dedicated AgentRuntimeEvent equivalent",
            event,
          })

        default:
          return assertNever(message)
      }
    },
  }
}

function translateSystemMessage(
  message: ClaudeSdkSystemMessage,
  rawMessage: Record<string, unknown>,
  state: ClaudeSdkAdapterState,
  event: { source: string; method?: string; payload: unknown },
): HarnessEventAdapterResult<ClaudeSdkAdapterState> | AgentRuntimeEvent[] {
  if (text(rawMessage.subtype) === "post_turn_summary") {
    const summary = text(rawMessage.summary)
    return summary
      ? [{
          type: "diagnostic",
          diagnostic: runtimeDiagnostic({
            code: "claude_sdk.post_turn_summary",
            message: summary,
            severity: "info",
            source: event.source,
            method: event.method,
            raw: event.payload,
          }),
        } satisfies AgentRuntimeEvent]
      : []
  }
  switch (message.subtype) {
    case "task_progress": {
      return {
        state,
        events: (text(rawMessage.summary)
            ? [{
              type: "diagnostic",
              diagnostic: runtimeDiagnostic({
                code: "claude_sdk.task_progress",
                message: text(rawMessage.summary)!,
                severity: "info",
                source: event.source,
                method: event.method,
                raw: event.payload,
              }),
            } satisfies AgentRuntimeEvent]
            : []),
      }
    }

    case "init": {
      const cwd = text(rawMessage.cwd)
      return {
        ...(cwd ? { state: { ...state, cwd } } : {}),
        events: [
          ...slashCommandEvents(rawMessage),
          ...unmappedSdkEvent({
            sdkEvent: "SDKSystemMessage(init)",
            reason: "model, tools, MCP server status, permission mode, and output style have no complete AgentRuntimeEvent mapping",
            event,
          }),
        ],
      }
    }

    case "compact_boundary":
      return unmappedSdkEvent({
        sdkEvent: "SDKCompactBoundaryMessage",
        reason: "compaction metadata has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "status":
      return message.status === "compacting"
        ? [{ type: "session-status", status: "busy" }]
        : []

    case "local_command_output":
      return message.content ? [{ type: "text-delta", delta: message.content }] : []

    case "hook_started":
    case "hook_progress":
    case "hook_response":
      return unmappedSdkEvent({
        sdkEvent: `SDKSystemMessage(${message.subtype})`,
        reason: "hook lifecycle output has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "task_started":
      return []

    case "task_notification":
      return []

    case "files_persisted":
      return unmappedSdkEvent({
        sdkEvent: "SDKFilesPersistedEvent",
        reason: "file persistence metadata has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "elicitation_complete":
      return unmappedSdkEvent({
        sdkEvent: "SDKElicitationCompleteMessage",
        reason: "MCP elicitation completion has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "commands_changed":
      return [{
        type: "available-commands-update",
        commands: message.commands.map((command) => ({
          name: command.name,
          description: command.description,
        })),
      }]

    case "permission_denied":
      return [{ type: "tool-error", toolCallId: message.tool_use_id, error: message.message }]

    case "api_retry":
    case "control_request_progress":
    case "informational":
    case "memory_recall":
    case "mirror_error":
    case "model_refusal_fallback":
    case "model_refusal_no_fallback":
    case "notification":
    case "plugin_install":
    case "session_state_changed":
    case "thinking_tokens":
    case "worker_shutting_down":
      return unmappedSdkEvent({
        sdkEvent: `SDKSystemMessage(${message.subtype})`,
        reason: "system metadata has no dedicated AgentRuntimeEvent equivalent",
        event,
      })

    case "background_tasks_changed":
    case "task_updated":
      return []

    default:
      return assertNever(message)
  }
}
