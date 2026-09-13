import { canonicalToolName, isSubagentSpawnToolName, reconstructQuestionAnswers } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type {
  AgentRuntimeEvent,
  RuntimeToolAttachment,
  SubagentMode,
  SubagentStatus,
  SubagentToolCallRole,
  ToolDisplay,
} from "../../contracts/agent-runtime-event"
import { runtimeDiagnostic } from "../../contracts/diagnostics"
import type { HarnessEventAdapter, HarnessEventAdapterContext, HarnessEventAdapterResult } from "../../core/adapter"
import { toolDisplayFromInput } from "../tool-display"
import { imageAttachment } from "../tool-attachments"
import { hostSubagentBinding, hostSubagentObservation, isHostSubagentTool } from "../host-subagent"
import { optionLabels, pathFields, text } from "../../value"
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
}

export type ClaudeRequestUsage = {
  input: number | null
  output: number | null
  reasoning: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export type ClaudeSdkAdapterState = {
  tasks?: Record<string, ClaudeTrackedTask>
  blocksByIndex: Record<string, ClaudeBlockState>
  toolsById: Record<string, ClaudeBlockState>
  streamedAssistantTextByOwner: Record<string, string>
  reconciledAssistantTextByMessageId: Record<string, string>
  /** The session root reported by `init`; the only place a read path can be tested against a workspace. */
  cwd?: string
  lastKnownContextWindow?: number
  /**
   * Per-request usage snapshots for the current turn, keyed by API message id.
   * The turn's `result` usage is authoritative, but a turn that dies before
   * `result` (crash, kill, steer) would otherwise meter nothing — these
   * snapshots keep a provisional turn-cumulative observation flowing.
   */
  turnUsageByRequestId?: Record<string, ClaudeRequestUsage>
}

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

function parseJsonRecord(value: string) {
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
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

/**
 * Claude Code's Bash tool carries no numeric field for the exit status; a
 * non-zero run's result text starts with the code, "Exit code 1\n…", whether
 * or not the harness marked the result as an error.
 */
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

/**
 * Only base64 sources are mapped: across 1,543 local transcripts all 1,052
 * tool-result image blocks used `source.type === "base64"`, and a URL source
 * carries no `media_type` to filter or name the attachment by.
 */
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

/**
 * The read path names the image, and — when it sits under the session cwd —
 * lets the attachment travel as a location instead of 85 KB of base64.
 *
 * Only a lone image can be the file the input named. Several of them share nothing but
 * the call, and the workspace-file branch drops the bytes it carries by value, so a path
 * handed to each would leave every image pointing at one file with its own pixels gone.
 */
function resultAttachments(
  images: Array<{ mime: string; data: string }>,
  display: ToolDisplay,
  root: string | undefined,
): RuntimeToolAttachment[] {
  if (images.length !== 1) return images.map((image) => imageAttachment({ ...image, root }))
  const sourcePath = display.filePath ?? display.path
  const filename = sourcePath?.split(/[\\/]/).pop()
  return images.map((image) => imageAttachment({ ...image, filename, sourcePath, root }))
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

/**
 * The `question` renderer reads the answers from the part's metadata; the result text
 * repeats them as prose no reader parses. Only a completed call carries the record —
 * a declined prompt arrives as an error.
 */
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

/**
 * The user message carries no tool name, so a `create_subagent` result is
 * recognised by its self-identifying shape rather than by the call it answers.
 */
function claudeHostSubagentObservations(
  message: Record<string, unknown>,
  wrapperId: string,
  harnessExecutionId: string | undefined,
): ClaudeSubagentObservation[] {
  return toolResultBlocks(message).flatMap((tool) => {
    const binding = hostSubagentBinding(message.tool_use_result) ?? hostSubagentBinding(tool.text)
    if (!binding) return []
    return [hostSubagentObservation({
      observationId: `claude:host-subagent:${wrapperId}:${tool.toolCallId}`,
      ...(harnessExecutionId ? { harnessExecutionId } : {}),
      toolCallId: tool.toolCallId,
      binding,
    })]
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

/**
 * Invariant: the projection holds exactly one copy of an assistant message's
 * text. The harness delivers that text twice — as streamed `text_delta`s and
 * again as a cumulative snapshot on the completed message — so the snapshot may
 * only contribute what streaming has not already shown for that same message:
 * its tail when it continues the streamed text, nothing when it equals it, and
 * only the part past the common prefix when the two disagree. Emitting a
 * disagreeing snapshot whole is what showed replies twice.
 */
function reconcileAssistantSnapshot(shown: string, snapshot: string): { delta: string; divergedAt?: number } {
  if (snapshot.startsWith(shown)) return { delta: snapshot.slice(shown.length) }
  const shared = commonPrefixLength(shown, snapshot)
  return { delta: snapshot.slice(shared), divergedAt: shared }
}

export function claudeSubagentObservations(value: unknown, ledger: ClaudeTaskLedger): ClaudeSubagentObservation[] {
  const message = asRecord(value)
  if (!message) return []
  const harnessExecutionId = text(message.session_id)
  const wrapperId = text(message.uuid) ?? harnessExecutionId ?? "unknown"

  if (message.type === "assistant" && !claudeChildCorrelationKey(message)) {
    return assistantToolBlocks(message).flatMap(({ tool }) => {
      if (!isTaskTool(tool.toolName) || isHostSubagentTool(tool.toolName) || !tool.toolCallId) return []
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
    if (!agentId) return claudeHostSubagentObservations(message, wrapperId, harnessExecutionId)
    // `SDKUserMessage.tool_use_result` is one tool's Output, and `AgentOutput`
    // names no tool call, so the agent it reports can only be attributed when
    // the message carries a single tool_result block. Stamping every block of
    // a batched delivery gives one agent a spawn edge on each of its siblings'
    // rows. The turn's other terminals — `task_notification` and the turn-end
    // sweep — settle the rows this drops.
    const blocks = toolResultBlocks(message)
    const sole = blocks.length === 1 ? blocks[0] : undefined
    if (!sole) return []
    return [{
      observationId: `claude:agent-result:${wrapperId}:${sole.toolCallId}`,
      ...(harnessExecutionId ? { harnessExecutionId } : {}),
      toolCallId: sole.toolCallId,
      toolCallRole: "spawn" as const,
      status: result?.status === "completed" ? "completed" as const : "running" as const,
      ...(result?.status === "async_launched" ? { mode: "background" as const } : {}),
      providerId: agentId,
      providerKind: "claude-agent",
      transcript: { kind: "messages" as const },
    }]
  }

  if (message.type !== "system") return []

  // Every backgrounded Bash command, workflow and housekeeping chore is a task
  // too, and each one admitted here becomes a subagent row with its own chip and
  // child session. Only `task_started` says which is which — `subagent_type`
  // names a Task-tool subagent and `skip_transcript` an ambient chore — so every
  // later frame, which carries the task id alone, is routed by what the ledger
  // recorded rather than by fields it does not carry.
  switch (message.subtype) {
    case "task_started": {
      const taskId = text(message.task_id)
      if (!taskId) return []
      const toolUseId = text(message.tool_use_id)
      const record: ClaudeTaskRecord = {
        taskId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(harnessExecutionId ? { harnessExecutionId } : {}),
        isAgentTask: !!text(message.subagent_type),
        skipTranscript: message.skip_transcript === true,
      }
      ledger.start(record)
      if (!admittedTask(record)) return []
      return [taskObservation(message, wrapperId, {
        status: "running",
        description: text(message.description),
        subagentType: text(message.subagent_type),
      })]
    }
    case "task_progress":
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      return [taskObservation(message, wrapperId, {
        status: "running",
        description: text(message.description),
        subagentType: text(message.subagent_type),
      })]
    case "task_notification":
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      return [taskObservation(message, wrapperId, {
        status: message.status === "completed" ? "completed" : message.status === "failed" ? "failed" : "killed",
        description: text(message.summary),
      })]
    case "task_updated": {
      if (!admittedTask(ledger.get(text(message.task_id)))) return []
      const patch = asRecord(message.patch) ?? {}
      const status = taskStatus(patch.status)
      const mode = patch.is_backgrounded === true ? "background" as const : patch.is_backgrounded === false ? "foreground" as const : undefined
      // The rest of the patch — `end_time`, `total_paused_ms` — is task
      // bookkeeping no row renders, and an observation carrying none of the
      // three fields below is a revision the reader cannot act on.
      if (!status && !mode && !text(patch.description)) return []
      return [taskObservation(message, wrapperId, {
        ...(status ? { status } : {}),
        ...(mode ? { mode } : {}),
        description: text(patch.description),
      })]
    }
    // `SDKBackgroundTasksChangedMessage` replaces a set of live tasks, and the
    // SDK offers it so a missed bookend cannot wedge a stale running indicator.
    // Its members carry `task_id`/`task_type`/`description` and nothing that
    // identifies a Task subagent or its tool call, so it can only settle rows
    // the ledger already knows; read as edges it minted a row per live
    // background chore, each with a child session no nested message could reach.
    case "background_tasks_changed":
      return ledger
        .replaceLive(liveTaskIds(message))
        .flatMap((record) => admittedTask(record) ? [departedTaskObservation(record, wrapperId)] : [])
    default:
      return []
  }
}

function admittedTask(record: ClaudeTaskRecord | undefined) {
  return record?.isAgentTask && !record.skipTranscript ? record : undefined
}

function liveTaskIds(message: Record<string, unknown>) {
  const tasks = Array.isArray(message.tasks) ? message.tasks : []
  return tasks.flatMap((value) => text(asRecord(value)?.task_id) ?? [])
}

/**
 * The level reports a departure, never an outcome: the notification that would
 * have said `completed`, `failed` or `stopped` is exactly what a wedged row
 * never received. `interrupted` is what this runtime already calls a row whose
 * end was never reported, and it settles the child turn the same way a kill
 * does, so a notification arriving behind the level still states the truth.
 */
function departedTaskObservation(record: ClaudeTaskRecord, wrapperId: string): ClaudeSubagentObservation {
  return {
    observationId: `claude:background_tasks_changed:${wrapperId}:${record.taskId}`,
    ...(record.harnessExecutionId ? { harnessExecutionId: record.harnessExecutionId } : {}),
    stableCorrelationId: record.taskId,
    ...(record.toolUseId ? { toolCallId: record.toolUseId, toolCallRole: "spawn" as const } : {}),
    status: "interrupted",
    providerKind: "claude-agent",
    transcript: { kind: "messages" },
  }
}

function taskStatus(value: unknown): ClaudeSubagentObservation["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "killed" || value === "paused") return value
  return undefined
}

function taskObservation(
  message: Record<string, unknown>,
  observationId: string,
  update: Omit<ClaudeSubagentObservation, "observationId" | "harnessExecutionId" | "stableCorrelationId" | "toolCallId" | "toolCallRole" | "providerKind" | "transcript">,
): ClaudeSubagentObservation {
  const taskId = text(message.task_id)
  return {
    observationId: `claude:${text(message.subtype)}:${observationId}`,
    ...(text(message.session_id) ? { harnessExecutionId: text(message.session_id) } : {}),
    ...(taskId ? { stableCorrelationId: taskId } : {}),
    ...(text(message.tool_use_id)
      ? { toolCallId: text(message.tool_use_id), toolCallRole: "spawn" }
      : {}),
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

function requestUsage(message: Record<string, unknown>): { requestId: string; tokens: ClaudeRequestUsage; requestTotal: number } | undefined {
  const row = asRecord(message.message)
  if (!row) return undefined
  const requestId = text(row.id)
  const usage = asRecord(row.usage)
  if (!requestId || !usage) return undefined
  const tokens: ClaudeRequestUsage = {
    input: asFiniteNumber(usage.input_tokens) ?? null,
    output: asFiniteNumber(usage.output_tokens) ?? null,
    reasoning: asFiniteNumber(usage.thinking_tokens) ?? null,
    cacheRead: asFiniteNumber(usage.cache_read_input_tokens) ?? null,
    cacheWrite: asFiniteNumber(usage.cache_creation_input_tokens) ?? null,
  }
  if (![tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite].some((value) => value !== null && value > 0)) return undefined
  return {
    requestId,
    tokens,
    requestTotal: (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0),
  }
}

function addNullable(previous: number | null, value: number | null) {
  if (value === null) return previous
  return (previous ?? 0) + value
}

function sumRequestUsage(requests: Record<string, ClaudeRequestUsage>): ClaudeRequestUsage {
  const sum: ClaudeRequestUsage = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null }
  for (const tokens of Object.values(requests)) {
    sum.input = addNullable(sum.input, tokens.input)
    sum.output = addNullable(sum.output, tokens.output)
    sum.reasoning = addNullable(sum.reasoning, tokens.reasoning)
    sum.cacheRead = addNullable(sum.cacheRead, tokens.cacheRead)
    sum.cacheWrite = addNullable(sum.cacheWrite, tokens.cacheWrite)
  }
  return sum
}

function usageSnapshot(message: Record<string, unknown>, lastKnownContextWindow?: number) {
  const usage = asRecord(message.usage)
  if (!usage) return undefined
  const inputTokens =
    (asFiniteNumber(usage.input_tokens) ?? 0) +
    (asFiniteNumber(usage.cache_creation_input_tokens) ?? 0) +
    (asFiniteNumber(usage.cache_read_input_tokens) ?? 0)
  const outputTokens = asFiniteNumber(usage.output_tokens) ?? 0
  const totalTokens = asFiniteNumber(usage.total_tokens) ?? inputTokens + outputTokens
  const modelUsage = asRecord(message.modelUsage)
  const contextWindow = modelUsage
    ? Object.values(modelUsage).flatMap((value) => asFiniteNumber(asRecord(value)?.contextWindow) ?? [])[0]
    : undefined
  const contextSize = contextWindow ?? lastKnownContextWindow ?? totalTokens
  return {
    type: "usage",
    contextSize,
    contextUsed: Math.min(totalTokens, contextSize),
    observation: {
      kind: "cumulative",
      ...(text(message.session_id) ? { nativeSessionId: text(message.session_id) } : {}),
      tokens: {
        input: asFiniteNumber(usage.input_tokens) ?? null,
        output: asFiniteNumber(usage.output_tokens) ?? null,
        reasoning: asFiniteNumber(usage.thinking_tokens) ?? null,
        cache: {
          read: asFiniteNumber(usage.cache_read_input_tokens) ?? null,
          write: asFiniteNumber(usage.cache_creation_input_tokens) ?? null,
        },
      },
    },
  } satisfies AgentRuntimeEvent
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

function resultEvents(message: Record<string, unknown>, context: HarnessEventAdapterContext, lastKnownContextWindow?: number) {
  const usage = usageSnapshot(message, lastKnownContextWindow)
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

const CLAUDE_RATE_LIMIT_WINDOWS: Record<string, string> = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_opus: "weekly_opus",
}

/**
 * `resetsAt` arrives as Unix seconds. 1e12 ms is 2001, which no reset expressed
 * in seconds reaches and no reset expressed in milliseconds falls below.
 */
function rateLimitResetMs(value: unknown) {
  const reset = asFiniteNumber(value)
  if (reset === undefined) return null
  return Math.round(reset < 1e12 ? reset * 1000 : reset)
}

function claudeRateLimitEvent(info: Record<string, unknown>, account: string | null) {
  const utilization = asFiniteNumber(info.utilization)
  const limitId = text(info.rateLimitType)
  return {
    type: "rate-limit",
    status: text(info.status) === "rejected" ? "limited" : "ok",
    ...(utilization === undefined ? {} : { usedPercent: Math.min(100, Math.max(0, Math.round(utilization))) }),
    resetsAt: rateLimitResetMs(info.resetsAt),
    ...(limitId ? { limitId, limitName: CLAUDE_RATE_LIMIT_WINDOWS[limitId] ?? limitId } : {}),
    // A window is only storable against a harness and an account, and the
    // envelope names neither.
    metadata: { harness: "claude", account },
  } satisfies AgentRuntimeEvent
}

export function claudeSdkAdapter(initialTasks: ClaudeTrackedTask[] = [], account: string | null = null): HarnessEventAdapter<ClaudeSdkAdapterState> {
  return {
    name: "claude-sdk",
    createInitialState: () => ({ blocksByIndex: {}, toolsById: {}, streamedAssistantTextByOwner: {}, reconciledAssistantTextByMessageId: {}, tasks: Object.fromEntries(initialTasks.map((task) => [task.id, task])) }),
    translate({ state, event, context }) {
      const rawMessage = sdkMessage(event)

      if (event.method === "claude/can-use-tool") {
        const questions = questionFromToolUse(rawMessage, context)
        return questions.length ? questions : permissionFromToolUse(rawMessage, context)
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
                        [owner]: `${state.streamedAssistantTextByOwner[owner] ?? ""}${deltaText}`,
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
                  const nextBlock = {
                    ...block,
                    partialInputJson,
                    ...(parsedInput ? { input: parsedInput } : {}),
                  }
                  return {
                    state: {
                      ...state,
                      blocksByIndex: { ...state.blocksByIndex, [String(stream.index)]: nextBlock },
                    },
                    events: parsedInput ? toolInputEvents(nextBlock, parsedInput) : [],
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
                      [owner]: `${state.streamedAssistantTextByOwner[owner] ?? ""}${block.fallbackText}`,
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
            case "message_start":
            case "message_delta":
            case "message_stop":
              return []
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
              ...(result.images.length ? { attachments: resultAttachments(result.images, display, state.cwd) } : {}),
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
            return [
              { type: "session-status", status: "error" },
              { type: "error", error: [`Claude assistant message failed: ${message.error}`, explanation].filter(Boolean).join("\n") },
            ] satisfies AgentRuntimeEvent[]
          }
          const completeTools = assistantToolBlocks(rawMessage)
          const completeToolEvents = completeTools.flatMap(({ block, tool }): AgentRuntimeEvent[] => {
            if (!state.toolsById[tool.toolCallId]) {
              return toolStartEvents(block)
            }
            return Object.keys(tool.input ?? {}).length ? toolInputEvents(tool, tool.input ?? {}) : []
          })
          const toolsById = Object.fromEntries(completeTools.map(({ tool }) => [tool.toolCallId, tool]))
          const snapshot = assistantSnapshotText(rawMessage)
          const childOwned = !!claudeChildCorrelationKey(rawMessage)
          const messageId = text(message.message.id)
          const owner = claudeStreamOwner(rawMessage)
          const shown = `${(messageId ? state.reconciledAssistantTextByMessageId[messageId] : undefined) ?? ""}${state.streamedAssistantTextByOwner[owner] ?? ""}`
          const reconciliation = snapshot ? reconcileAssistantSnapshot(shown, snapshot) : undefined
          // Every assistant message carries its API request's usage. The turn's
          // `result` usage stays authoritative (it replaces this observation),
          // but accumulating per request means a turn that dies before `result`
          // still meters what it consumed. Child (subagent) messages are
          // skipped: their attribution belongs to the parent turn's result.
          const request = childOwned ? undefined : requestUsage(rawMessage)
          const turnUsageByRequestId = request
            ? { ...state.turnUsageByRequestId, [request.requestId]: request.tokens }
            : state.turnUsageByRequestId
          const provisionalUsage = request
            ? [{
                type: "usage" as const,
                contextSize: state.lastKnownContextWindow ?? request.requestTotal,
                contextUsed: Math.min(request.requestTotal, state.lastKnownContextWindow ?? request.requestTotal),
                observation: {
                  kind: "cumulative" as const,
                  ...(text(rawMessage.session_id) ? { nativeSessionId: text(rawMessage.session_id) } : {}),
                  tokens: (({ input, output, reasoning, cacheRead, cacheWrite }) => ({
                    input, output, reasoning,
                    cache: { read: cacheRead, write: cacheWrite },
                  }))(sumRequestUsage(turnUsageByRequestId ?? {})),
                },
              } satisfies AgentRuntimeEvent]
            : []
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
              ...(turnUsageByRequestId ? { turnUsageByRequestId } : {}),
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
              ...provisionalUsage,
            ],
          }
        }

        case "result": {
          const usage = usageSnapshot(rawMessage, state.lastKnownContextWindow)
          const nextContextWindow = usage?.contextSize ?? state.lastKnownContextWindow
          return {
            state: {
              ...state,
              blocksByIndex: {},
              toolsById: {},
              streamedAssistantTextByOwner: {},
              reconciledAssistantTextByMessageId: {},
              turnUsageByRequestId: {},
              ...(nextContextWindow ? { lastKnownContextWindow: nextContextWindow } : {}),
            },
            events: resultEvents(rawMessage, context, state.lastKnownContextWindow),
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

        case "rate_limit_event":
          return [claudeRateLimitEvent(asRecord(message.rate_limit_info) ?? {}, account)]

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
  // Claude Code 2.1.267 sends this after each model turn; the pinned SDK types
  // (0.3.220) predate it, so it is read off the raw message. It summarises a
  // turn already projected in full.
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
      // Task lifecycle is projected by claudeSubagentObservations. This frame
      // can precede the tool_result carrying stdout or the actual tool error;
      // it must not terminalize that tool call with an empty result or summary.
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
