import type { AgentRuntimeEvent, ToolDisplay } from "../../contracts/agent-runtime-event"
import type { RuntimeProjection } from "../../core/projection"
import type { ProjectionSnapshot } from "../../core/state"
import { projectionSnapshot } from "../../core/state"
import { normalizeCompatEventWithDiagnostics, type CompatEnvelope, withDir } from "./normalize"
import { createOpencodeCompatProjectionState, type OpencodeCompatProjectionState } from "./state"
import type {
  EventMessageCompleted,
  EventMessagePartDelta,
  EventMessagePartUpdated,
  EventPermissionAsked,
  EventQuestionAsked,
  EventQuestionReplied,
  EventRuntimeDiagnostic,
  EventSessionAgent,
  EventSessionCompacted,
  EventSessionConfig,
  EventSessionDiff,
  EventSessionError,
  EventSessionIdle,
  EventSessionStatus,
  EventSessionUpdated,
  EventSessionUsage,
  EventTodoUpdated,
  OpenCodeCompatConfigOption,
  OpenCodeCompatPart,
  OpenCodeCompatSession,
  OpenCodeCompatSnapshotFileDiff,
  OpenCodeCompatStatus,
  OpenCodeCompatTodo,
  PermissionRequest,
  QuestionRequest,
} from "./types"

export type OpencodeCompatProjection = RuntimeProjection<CompatEnvelope, OpencodeCompatProjectionState> & {
  name: "opencode-compat"
  terminalizeOpenTools: (error: string) => CompatEnvelope[]
}

export type OpencodeCompatProjectionOptions = {
  sessionId: string
  directory: string
  assistantMessageId: string
  clock?: () => number
  initialSnapshot?: ProjectionSnapshot<OpencodeCompatProjectionState>
}

type CompatContext = OpencodeCompatProjectionState & {
  sessionId: string
  directory: string
  assistantMsgId: string
}

type ToolPart = Extract<OpenCodeCompatPart, { type: "tool" }>
type ToolStateStatus = ToolPart["state"]["status"]

function messagePartUpdated(part: OpenCodeCompatPart, time: number): EventMessagePartUpdated {
  return {
    id: `message.part.updated:${part.messageID}:${part.id}`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time,
    },
  }
}

function messagePartDelta(input: {
  sessionID: string
  messageID: string
  partID: string
  field: string
  delta: string
}): EventMessagePartDelta {
  return {
    id: `message.part.delta:${input.messageID}:${input.partID}`,
    type: "message.part.delta",
    properties: input,
  }
}

function messageCompleted(sessionID: string, messageID: string): EventMessageCompleted {
  return {
    type: "message.completed",
    properties: { sessionID, messageID },
  }
}

function permissionAsked(properties: PermissionRequest): EventPermissionAsked {
  return {
    id: `permission.asked:${properties.id}`,
    type: "permission.asked",
    properties,
  }
}

function questionAsked(properties: QuestionRequest): EventQuestionAsked {
  return {
    id: `question.asked:${properties.id}`,
    type: "question.asked",
    properties,
  }
}

function questionReplied(sessionID: string, requestID: string, answers: Array<Array<string>>): EventQuestionReplied {
  return {
    id: `question.replied:${requestID}`,
    type: "question.replied",
    properties: { sessionID, requestID, answers },
  }
}

function todoUpdated(sessionID: string, todos: OpenCodeCompatTodo[]): EventTodoUpdated {
  return {
    id: `todo.updated:${sessionID}`,
    type: "todo.updated",
    properties: { sessionID, todos },
  }
}

function sessionStatus(sessionID: string, status: OpenCodeCompatStatus): EventSessionStatus {
  return {
    id: `session.status:${sessionID}`,
    type: "session.status",
    properties: { sessionID, status },
  }
}

function sessionCompacted(sessionID: string): EventSessionCompacted {
  return {
    id: `session.compacted:${sessionID}`,
    type: "session.compacted",
    properties: { sessionID },
  }
}

function sessionDiff(sessionID: string, diff: OpenCodeCompatSnapshotFileDiff[]): EventSessionDiff {
  return {
    id: `session.diff:${sessionID}`,
    type: "session.diff",
    properties: { sessionID, diff },
  }
}

function sessionIdle(sessionID: string): EventSessionIdle {
  return {
    id: `session.idle:${sessionID}`,
    type: "session.idle",
    properties: { sessionID },
  }
}

function sessionError(message: string, sessionID?: string): EventSessionError {
  return {
    id: `session.error:${sessionID ?? "global"}`,
    type: "session.error",
    properties: {
      ...(sessionID ? { sessionID } : {}),
      error: {
        name: "UnknownError",
        data: { message },
      },
    },
  }
}

function sessionUpdated(info: OpenCodeCompatSession): EventSessionUpdated {
  return {
    id: `session.updated:${info.id}`,
    type: "session.updated",
    properties: { sessionID: info.id, info },
  }
}

function sessionAgent(sessionID: string, agentId: string): EventSessionAgent {
  return {
    type: "session.agent",
    properties: { sessionID, agentId },
  }
}

function sessionConfig(properties: EventSessionConfig["properties"]): EventSessionConfig {
  return {
    type: "session.config",
    properties,
  }
}

function sessionUsage(properties: EventSessionUsage["properties"]): EventSessionUsage {
  return {
    type: "session.usage",
    properties,
  }
}

function runtimeDiagnostic(properties: EventRuntimeDiagnostic["properties"]): EventRuntimeDiagnostic {
  return {
    id: `runtime.diagnostic:${String(properties.sessionID)}:${String(properties.code)}`,
    type: "runtime.diagnostic",
    properties,
  }
}

function projectionDiagnostic(properties: {
  sessionID: string
  phase: "ingest" | "terminalize"
  code: string
  message: string
  severity?: "warn" | "error"
  eventType?: string
  issues?: string[]
  raw?: unknown
}) {
  return runtimeDiagnostic({
    sessionID: properties.sessionID,
    projection: "opencode-compat",
    phase: properties.phase,
    code: properties.code,
    message: properties.message,
    severity: properties.severity ?? "warn",
    ...(properties.eventType ? { eventType: properties.eventType } : {}),
    ...(properties.issues?.length ? { issues: properties.issues } : {}),
    ...(properties.raw !== undefined ? { raw: properties.raw } : {}),
  })
}

function lossyCompatDiagnostic(ctx: CompatContext, eventType: string, message: string, raw: unknown) {
  return withDir(ctx.directory, projectionDiagnostic({
    sessionID: ctx.sessionId,
    phase: "ingest",
    code: "projection.opencode_compat.lossy_runtime_event",
    message,
    eventType,
    raw,
  }))
}

function buildSession(input: { id: string; directory: string; title: string; created: number; updated: number }) {
  return {
    id: input.id,
    slug: input.id,
    projectID: input.directory,
    directory: input.directory,
    title: input.title,
    version: "local",
    time: { created: input.created, updated: input.updated },
  }
}

function timestamp(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return fallback
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function recovering(message = "Recovering ACP client..."): Extract<OpenCodeCompatStatus, { type: "recovering" }> {
  return {
    type: "recovering",
    kind: "process_restart",
    message,
  }
}

function normalizeInputKeys(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = value
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    if (camel !== key) result[camel] = value
  }
  return result
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as Record<string, unknown>
}

function text(value: unknown) {
  if (typeof value !== "string") return undefined
  if (!value) return undefined
  return value
}

function scalar(value: unknown) {
  if (value == null) return undefined
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  return undefined
}

function mergeInput(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
) {
  if (!left) return right ?? {}
  if (!right) return left
  return { ...left, ...right }
}

function mergeMetadata(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
) {
  if (!left) return right ?? {}
  if (!right) return left
  const item = { ...left, ...right }
  const lhs = object(left.acp)
  const rhs = object(right.acp)
  if (lhs || rhs) item.acp = { ...lhs, ...rhs }
  return item
}

function mergeDisplay(
  left: ToolDisplay | undefined,
  right: ToolDisplay | undefined,
) {
  if (!left) return right ?? {}
  if (!right) return left
  return {
    ...left,
    ...right,
    input: mergeInput(left.input, right.input),
    files: right.files ?? left.files,
    locations: right.locations ?? left.locations,
  } satisfies ToolDisplay
}

function copyScalar(
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
  from: string,
  to = from,
) {
  const value = scalar(source?.[from])
  if (value != null) target[to] = value
}

function acpMetadataInput(metadata: Record<string, unknown>) {
  const acp = object(metadata.acp)
  if (!acp) return {}
  const rawInput = object(acp.rawInput)
  const input: Record<string, unknown> = {}

  for (const key of ["intent", "kind", "mode", "summary", "description", "command", "filePath", "path", "pattern", "query", "url", "sourcePath", "targetPath", "subagentType", "agentId", "durationMs"]) {
    copyScalar(input, acp, key)
  }
  copyScalar(input, acp, "title", "summary")
  copyScalar(input, acp, "rawToolName", "toolName")

  for (const key of ["command", "path", "pattern", "query", "url", "offset", "limit", "old_string", "new_string", "replace_all", "description", "prompt", "subagent_type", "subagentType", "task_id", "agentId"]) {
    copyScalar(input, rawInput, key)
  }
  copyScalar(input, rawInput, "file_path")
  copyScalar(input, rawInput, "file_path", "filePath")
  copyScalar(input, rawInput, "old_string", "oldString")
  copyScalar(input, rawInput, "new_string", "newString")
  copyScalar(input, rawInput, "subagent_type", "subagentType")
  copyScalar(input, rawInput, "task_id", "taskId")

  if (Array.isArray(acp.files)) input.files = acp.files
  if (Array.isArray(rawInput?.files)) input.files = rawInput.files

  return normalizeInputKeys(input)
}

function displayInput(display: ToolDisplay | undefined) {
  const input: Record<string, unknown> = {}
  for (const key of ["intent", "kind", "mode", "summary", "description", "command", "filePath", "path", "pattern", "query", "url", "sourcePath", "targetPath", "sessionId", "agentId", "durationMs"]) {
    copyScalar(input, display as Record<string, unknown> | undefined, key)
  }
  if (display?.subagentType !== undefined) input.subagentType = display.subagentType
  if (Array.isArray(display?.files)) input.files = display.files
  return normalizeInputKeys(mergeInput(input, display?.input))
}

function diff(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item) => {
    const row = object(item)
    if (!row) return false
    return "path" in row || "oldText" in row || "newText" in row
  })
}

function shell(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  if (typeof input.intent === "string") return input.intent === "shell"
  const acp = object(metadata.acp)
  return acp?.intent === "shell"
}

function stringifyProjectionValue(value: unknown): { value: string; issues: string[] } {
  const issues = new Set<string>()
  const seen = new WeakSet<object>()
  const result = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      issues.add("bigint")
      return item.toString()
    }
    if (typeof item === "function") {
      issues.add("function")
      return `[Function ${item.name || "anonymous"}]`
    }
    if (typeof item === "symbol") {
      issues.add("symbol")
      return String(item)
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) {
        issues.add("circular")
        return "[Circular]"
      }
      seen.add(item)
    }
    return item
  })
  if (result !== undefined) return { value: result, issues: [...issues] }
  return { value: String(value), issues: [...issues, "empty-json"] }
}

function output(
  value: unknown,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): { value: string; issues: string[] } {
  if (typeof value === "string") return { value, issues: [] }
  if (value == null) return { value: "", issues: [] }

  const row = object(value)
  if (row && shell(input, metadata)) {
    const stdout = text(row.stdout)
    const stderr = text(row.stderr)
    const list = [stdout, stderr].filter((item): item is string => !!item)
    if (list.length > 0) return { value: list.join("\n"), issues: [] }
  }

  if (diff(value)) return { value: "", issues: [] }

  if (row) {
    const body = text(row.content) ?? arrayContentText(row.content) ?? text(row.text) ?? text(row.body) ?? text(row.stdout) ?? text(row.stderr)
    if (body) return { value: body, issues: [] }
    const onlyScalars = Object.values(row).every((item) =>
      item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    )
    if (onlyScalars) return { value: "", issues: [] }
  }

  const body = arrayContentText(value)
  if (body !== undefined) return { value: body, issues: [] }

  return stringifyProjectionValue(value)
}

function arrayContentText(value: unknown) {
  if (!Array.isArray(value)) return
  const content = value.flatMap((item) => {
    if (typeof item === "string") return item
    const row = object(item)
    return text(row?.text) ?? text(row?.content) ?? []
  })
  if (content.length !== value.length) return
  return content.join("\n")
}

function compatToolStatus(status: Extract<AgentRuntimeEvent, { type: "tool-status" }>["status"]) {
  if (status === "failed") return "error" as const
  return status
}

function toolContentText(content: Extract<AgentRuntimeEvent, { type: "tool-content" }>["content"]) {
  if (content.type !== "content") return undefined
  const row = object(content.content)
  return text(row?.text)
}

function seqId(ctx: CompatContext, id: string): string {
  if (!ctx.partIdMap[id]) {
    const seq = Object.keys(ctx.partIdMap).length
    ctx.partIdMap[id] = `${String(seq).padStart(6, "0")}_${id}`
  }
  return ctx.partIdMap[id]
}

function seen(ctx: CompatContext, id: string): boolean {
  return !!ctx.partIdMap[id]
}

function partEvent(directory: string, part: OpenCodeCompatPart, time: number): CompatEnvelope {
  return withDir(directory, messagePartUpdated(part, time))
}

function dataUrl(mime: string, data: string) {
  if (data.startsWith("data:")) return data
  return `data:${mime};base64,${data}`
}

function extension(mime: string) {
  const subtype = mime.split("/")[1]?.split(";")[0]
  if (!subtype) return "bin"
  if (subtype === "jpeg") return "jpg"
  return subtype.replace(/[^a-z0-9]/gi, "") || "bin"
}

function filePart(input: {
  ctx: CompatContext
  id: string
  mime: string
  url: string
  filename?: string
  source?: Extract<OpenCodeCompatPart, { type: "file" }>["source"]
}): Extract<OpenCodeCompatPart, { type: "file" }> {
  return {
    id: input.id,
    sessionID: input.ctx.sessionId,
    messageID: input.ctx.assistantMsgId,
    type: "file",
    mime: input.mime,
    url: input.url,
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.source ? { source: input.source } : {}),
  }
}

function toolState(input: {
  status: ToolStateStatus
  tool: string
  stateInput: Record<string, unknown>
  metadata: Record<string, unknown>
  now: number
  output?: string
  error?: string
}): ToolPart["state"] {
  if (input.status === "pending") {
    return {
      status: "pending",
      input: input.stateInput,
      raw: JSON.stringify(input.stateInput),
    }
  }
  if (input.status === "completed") {
    return {
      status: "completed",
      input: input.stateInput,
      output: input.output ?? "",
      title: input.tool,
      metadata: input.metadata,
      time: { start: input.now, end: input.now },
    }
  }
  if (input.status === "error") {
    return {
      status: "error",
      input: input.stateInput,
      error: input.error ?? "tool failed",
      ...(Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
      time: { start: input.now, end: input.now },
    }
  }
  return {
    status: "running",
    input: input.stateInput,
    ...(Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
    time: { start: input.now },
  }
}

function toolPart(input: {
  ctx: CompatContext
  toolCallId: string
  tool: string
  stateInput: Record<string, unknown>
  status: ToolStateStatus
  metadata?: Record<string, unknown>
  now: number
  output?: string
  error?: string
}): ToolPart {
  return {
    id: seqId(input.ctx, input.toolCallId),
    sessionID: input.ctx.sessionId,
    messageID: input.ctx.assistantMsgId,
    type: "tool",
    callID: input.toolCallId,
    tool: input.tool,
    state: toolState({
      status: input.status,
      tool: input.tool,
      stateInput: input.stateInput,
      metadata: input.metadata ?? {},
      now: input.now,
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    }),
    ...(input.metadata && Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
  }
}

function toolEvent(input: Parameters<typeof toolPart>[0]) {
  return partEvent(input.ctx.directory, toolPart(input), input.now)
}

function splitLines(value: string) {
  if (!value) return []
  return value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n")
}

function lineStats(oldText: string | undefined, newText: string) {
  if (oldText === undefined) return { additions: splitLines(newText).length, deletions: 0 }
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const shared = new Map<string, number>()
  oldLines.forEach((line) => shared.set(line, (shared.get(line) ?? 0) + 1))
  const common = newLines.reduce((count, line) => {
    const remaining = shared.get(line) ?? 0
    if (remaining <= 0) return count
    shared.set(line, remaining - 1)
    return count + 1
  }, 0)
  return {
    additions: Math.max(0, newLines.length - common),
    deletions: Math.max(0, oldLines.length - common),
  }
}

function unifiedPatch(path: string, oldText: string | undefined, newText: string) {
  if (newText.startsWith("diff --git ") || newText.startsWith("@@ ")) return newText
  if (oldText === undefined) return undefined
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n")
}

function snapshotFileDiff(chunk: Extract<AgentRuntimeEvent, { type: "file-diff" }>): OpenCodeCompatSnapshotFileDiff {
  const stats = lineStats(chunk.oldText, chunk.newText)
  return {
    file: chunk.path,
    ...stats,
    status: chunk.oldText === undefined ? "added" : chunk.newText.length === 0 ? "deleted" : "modified",
    ...(unifiedPatch(chunk.path, chunk.oldText, chunk.newText) ? { patch: unifiedPatch(chunk.path, chunk.oldText, chunk.newText) } : {}),
  }
}

function deltaText(
  ctx: CompatContext,
  type: "text" | "reasoning",
  delta: string,
  now: () => number,
): CompatEnvelope[] {
  const seqKey = type === "text" ? "textPartSeq" : "reasoningPartSeq"
  const splitKey = type === "text" ? "splitText" : "splitReasoning"
  const partKey = () => `${ctx.assistantMsgId}-${type}${ctx[seqKey] > 0 ? `-${ctx[seqKey]}` : ""}`
  if (ctx[splitKey] && seen(ctx, partKey())) {
    ctx[seqKey] += 1
  }
  ctx[splitKey] = false
  const key = partKey()
  const fresh = !seen(ctx, key)
  const id = seqId(ctx, key)
  const base: OpenCodeCompatPart =
    type === "text"
      ? {
          id,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "text",
          text: fresh ? "" : ctx.accumulatedText,
        }
      : {
          id,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "reasoning",
          text: fresh ? "" : ctx.accumulatedThinkingText,
          time: { start: now() },
        }
  const eventTime = now()
  const events = fresh ? [partEvent(ctx.directory, base, eventTime)] : []
  events.push(
    withDir(
      ctx.directory,
      messagePartDelta({
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        partID: id,
        field: "text",
        delta,
      }),
    ),
  )
  if (type === "text") ctx.accumulatedText += delta
  else ctx.accumulatedThinkingText += delta
  return events
}

function normalizeLocationInput(
  tool: string,
  input: Record<string, unknown>,
  locations: Array<{ path: string; line?: number }>,
) {
  const first = locations[0]?.path
  if (!first) return input
  const intent = typeof input.intent === "string" ? input.intent : undefined
  if ((tool === "read" || tool === "lint" || intent === "read" || intent === "lint" || intent === "edit" || intent === "delete") && typeof input.filePath !== "string") {
    return {
      ...input,
      filePath: first,
    }
  }
  if ((tool === "list" || tool === "glob" || tool === "grep" || intent === "search" || intent === "list") && typeof input.path !== "string") {
    return {
      ...input,
      path: first,
    }
  }
  return input
}

function locationsFromList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const row = object(item)
    const path = text(row?.path)
    if (!path) return []
    return [{ path, ...(typeof row?.line === "number" ? { line: row.line } : {}) }]
  })
}

function locationsFromMetadata(metadata: Record<string, unknown>) {
  return locationsFromList(object(metadata.acp)?.locations)
}

function hydrateToolInput(
  tool: string,
  current: Record<string, unknown> | undefined,
  metadata: Record<string, unknown>,
  display?: ToolDisplay,
) {
  const input = mergeInput(mergeInput(acpMetadataInput(metadata), displayInput(display)), current)
  return normalizeLocationInput(tool, input, [...locationsFromList(display?.locations), ...locationsFromMetadata(metadata)])
}

function todos(chunk: Extract<AgentRuntimeEvent, { type: "todo-update" }>) {
  return chunk.todos.map((todo) => ({
    content: todo.description,
    status: todo.status,
    priority: todo.priority ?? "medium",
  }))
}

function questions(chunk: Extract<AgentRuntimeEvent, { type: "question" }>) {
  return chunk.questions.map((question, i) => ({
    question: question.text,
    header: question.text.slice(0, 30) || `Question ${i + 1}`,
    options: (question.options ?? []).map((label) => ({
      label,
      description: label,
    })),
    custom: !question.options?.length,
  }))
}

function questionAnswers(chunk: Extract<AgentRuntimeEvent, { type: "question-answered" }>) {
  return Object.keys(chunk.answers).sort().map((key) => {
    const answer = chunk.answers[key]
    if (Array.isArray(answer)) return answer.filter((value): value is string => typeof value === "string")
    return typeof answer === "string" ? [answer] : []
  })
}

function terminalizeOpenTools(ctx: CompatContext, error: string, now: () => number): CompatEnvelope[] {
  const endedAt = now()
  const events: CompatEnvelope[] = []
  for (const [toolCallId, status] of Object.entries(ctx.toolStatusByCallId)) {
    if (status !== "running" && status !== "pending") continue
    const tool = ctx.toolNamesByCallId[toolCallId] ?? toolCallId
    const metadata = ctx.toolMetadataByCallId[toolCallId] ?? {}
    const input = hydrateToolInput(tool, ctx.toolInputsByCallId[toolCallId], metadata, ctx.toolDisplaysByCallId[toolCallId])
    ctx.toolInputsByCallId[toolCallId] = input
    ctx.toolStatusByCallId[toolCallId] = "error"
    ctx.toolErrorsByCallId[toolCallId] = error
    events.push(toolEvent({
      ctx,
      toolCallId,
      tool,
      stateInput: input,
      status: "error",
      metadata,
      now: endedAt,
      error,
    }))
  }
  return events
}

function translateRuntimeEventToCompat(chunk: AgentRuntimeEvent, ctx: CompatContext, now: () => number): CompatEnvelope[] {
  const split = () => {
    ctx.splitText = true
    ctx.splitReasoning = true
  }

  switch (chunk.type) {
    case "session-status":
      if (chunk.status === "error") {
        return [withDir(ctx.directory, sessionError("session error", ctx.sessionId))]
      }
      if (chunk.status === "recovering") {
        return [withDir(ctx.directory, sessionStatus(ctx.sessionId, recovering()))]
      }
      return [withDir(ctx.directory, sessionStatus(ctx.sessionId, { type: chunk.status }))]

    case "session-compaction":
      return chunk.phase === "completed"
        ? [withDir(ctx.directory, sessionCompacted(ctx.sessionId))]
        : []

    case "harness-notice":
      return [withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: chunk.code,
        message: chunk.message,
        severity: chunk.severity ?? "info",
        details: chunk.details,
        raw: chunk.raw,
      }))]

    case "auth-status":
      return [withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: "runtime.auth_status",
        message: `Auth status: ${chunk.status}`,
        severity: chunk.status === "unauthenticated" ? "warn" : "info",
        auth: {
          status: chunk.status,
          authMode: chunk.authMode,
          planType: chunk.planType,
          metadata: chunk.metadata,
        },
        raw: chunk.raw,
      }))]

    case "rate-limit":
      return [withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: "runtime.rate_limit",
        message: chunk.status === "limited" ? "Rate limit reached" : "Rate limit updated",
        severity: chunk.status === "limited" ? "warn" : "info",
        rateLimit: {
          status: chunk.status,
          usedPercent: chunk.usedPercent,
          resetsAt: chunk.resetsAt,
          windowDurationMins: chunk.windowDurationMins,
          limitId: chunk.limitId,
          limitName: chunk.limitName,
          reason: chunk.reason,
          metadata: chunk.metadata,
        },
        raw: chunk.raw,
      }))]

    case "mcp-server-status":
      return [withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: "runtime.mcp_server_status",
        message: chunk.error ?? `MCP server ${chunk.serverName} is ${chunk.status}`,
        severity: chunk.status === "failed" || chunk.status === "cancelled" ? "warn" : "info",
        mcp: {
          serverName: chunk.serverName,
          status: chunk.status,
          error: chunk.error,
        },
        raw: chunk.raw,
      }))]

    case "text-delta":
      return deltaText(ctx, "text", chunk.delta, now)

    case "thinking-delta":
      return deltaText(ctx, "reasoning", chunk.delta, now)

    case "user-message-delta":
      return [lossyCompatDiagnostic(ctx, chunk.type, "OpenCode compatibility projection cannot represent streamed user message chunks", chunk)]

    case "proposed-plan-delta": {
      ctx.proposedPlanText += chunk.delta
      return deltaText(ctx, "text", chunk.delta, now)
    }

    case "proposed-plan-complete": {
      const delta = chunk.planMarkdown.startsWith(ctx.proposedPlanText)
        ? chunk.planMarkdown.slice(ctx.proposedPlanText.length)
        : ctx.proposedPlanText === chunk.planMarkdown
          ? ""
          : chunk.planMarkdown
      ctx.proposedPlanText = chunk.planMarkdown
      return delta ? deltaText(ctx, "text", delta, now) : []
    }

    case "tool-start": {
      split()
      const tool = chunk.toolName || chunk.toolCallId
      ctx.toolNamesByCallId[chunk.toolCallId] = tool
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      const display = mergeDisplay(ctx.toolDisplaysByCallId[chunk.toolCallId], chunk.display)
      const input = hydrateToolInput(tool, ctx.toolInputsByCallId[chunk.toolCallId], metadata, display)
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolDisplaysByCallId[chunk.toolCallId] = display
      const status = ctx.toolStatusByCallId[chunk.toolCallId]
      if (status === "completed" || status === "error") {
        return [
          withDir(ctx.directory, projectionDiagnostic({
            sessionID: ctx.sessionId,
            phase: "ingest",
            code: "projection.opencode_compat.tool_metadata_after_terminal",
            message: "OpenCode compatibility projection received tool metadata after a terminal update",
            eventType: chunk.type,
          })),
          toolEvent({
            ctx,
            toolCallId: chunk.toolCallId,
            tool,
            stateInput: input,
            status,
            metadata,
            now: now(),
            ...(status === "completed"
              ? { output: ctx.toolOutputsByCallId[chunk.toolCallId] ?? "" }
              : { error: ctx.toolErrorsByCallId[chunk.toolCallId] ?? "tool failed" }),
          }),
        ]
      }
      const nextStatus = ctx.toolStatusByCallId[chunk.toolCallId] ?? "running"
      ctx.toolStatusByCallId[chunk.toolCallId] = nextStatus
      return [toolEvent({
        ctx,
        toolCallId: chunk.toolCallId,
        tool,
        stateInput: input,
        status: nextStatus,
        metadata,
        now: now(),
      })]
    }

    case "tool-input": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const raw = object(chunk.input) ?? { raw: chunk.input }
      const next = Object.keys(raw).length > 0 ? normalizeInputKeys(raw) : undefined
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      const display = mergeDisplay(ctx.toolDisplaysByCallId[chunk.toolCallId], chunk.display)
      const input = hydrateToolInput(tool, mergeInput(ctx.toolInputsByCallId[chunk.toolCallId], next), metadata, display)
      if (Object.keys(input).length === 0 && Object.keys(metadata).length === 0) return []
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolDisplaysByCallId[chunk.toolCallId] = display
      ctx.toolStatusByCallId[chunk.toolCallId] = "running"
      return [toolEvent({
        ctx,
        toolCallId: chunk.toolCallId,
        tool,
        stateInput: input,
        status: "running",
        metadata,
        now: now(),
      })]
    }

    case "tool-status": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      const display = mergeDisplay(ctx.toolDisplaysByCallId[chunk.toolCallId], chunk.display)
      const input = hydrateToolInput(tool, ctx.toolInputsByCallId[chunk.toolCallId], metadata, display)
      const status = compatToolStatus(chunk.status)
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolDisplaysByCallId[chunk.toolCallId] = display
      ctx.toolStatusByCallId[chunk.toolCallId] = status
      return [toolEvent({
        ctx,
        toolCallId: chunk.toolCallId,
        tool,
        stateInput: input,
        status,
        metadata,
        now: now(),
        ...(status === "completed" ? { output: ctx.toolOutputsByCallId[chunk.toolCallId] ?? "" } : {}),
        ...(status === "error" ? { error: ctx.toolErrorsByCallId[chunk.toolCallId] ?? "tool failed" } : {}),
      })]
    }

    case "tool-content": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const metadata = mergeMetadata(
        ctx.toolMetadataByCallId[chunk.toolCallId],
        mergeMetadata(chunk.metadata, { acp: { content: [chunk.content] } }),
      )
      const display = mergeDisplay(ctx.toolDisplaysByCallId[chunk.toolCallId], chunk.display)
      const input = hydrateToolInput(tool, ctx.toolInputsByCallId[chunk.toolCallId], metadata, display)
      const status = ctx.toolStatusByCallId[chunk.toolCallId] ?? "running"
      const contentText = toolContentText(chunk.content)
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolDisplaysByCallId[chunk.toolCallId] = display
      const event = toolEvent({
        ctx,
        toolCallId: chunk.toolCallId,
        tool,
        stateInput: input,
        status,
        metadata,
        now: now(),
        ...(status === "completed" && contentText ? { output: contentText } : {}),
      })
      if (contentText || chunk.content.type === "diff" || chunk.content.type === "terminal") return [event]
      return [
        lossyCompatDiagnostic(ctx, chunk.type, "OpenCode compatibility projection preserved non-text ACP tool content in metadata only", chunk),
        event,
      ]
    }

    case "tool-output": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      const display = mergeDisplay(ctx.toolDisplaysByCallId[chunk.toolCallId], chunk.display)
      const input = hydrateToolInput(tool, ctx.toolInputsByCallId[chunk.toolCallId], metadata, display)
      const formatted = output(chunk.output, input, metadata)
      const previousStatus = ctx.toolStatusByCallId[chunk.toolCallId]
      if (previousStatus === "completed" || previousStatus === "error") {
        return [withDir(ctx.directory, projectionDiagnostic({
          sessionID: ctx.sessionId,
          phase: "ingest",
          code: "projection.opencode_compat.duplicate_terminal_tool_update",
          message: "OpenCode compatibility projection ignored a duplicate terminal tool update",
          eventType: chunk.type,
        }))]
      }
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolDisplaysByCallId[chunk.toolCallId] = display
      ctx.toolStatusByCallId[chunk.toolCallId] = "completed"
      ctx.toolOutputsByCallId[chunk.toolCallId] = formatted.value
      const endedAt = now()
      return [
        ...(formatted.issues.length ? [withDir(ctx.directory, projectionDiagnostic({
          sessionID: ctx.sessionId,
          phase: "ingest",
          code: "projection.opencode_compat.unserializable_output",
          message: "OpenCode compatibility projection sanitized unserializable tool output",
          eventType: chunk.type,
          issues: formatted.issues,
        }))] : []),
        toolEvent({
          ctx,
          toolCallId: chunk.toolCallId,
          tool,
          stateInput: input,
          status: "completed",
          metadata,
          now: endedAt,
          output: formatted.value,
        })]
    }

    case "tool-error": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      const display = mergeDisplay(ctx.toolDisplaysByCallId[chunk.toolCallId], chunk.display)
      const input = hydrateToolInput(tool, ctx.toolInputsByCallId[chunk.toolCallId], metadata, display)
      const previousStatus = ctx.toolStatusByCallId[chunk.toolCallId]
      if (previousStatus === "completed" || previousStatus === "error") {
        return [withDir(ctx.directory, projectionDiagnostic({
          sessionID: ctx.sessionId,
          phase: "ingest",
          code: "projection.opencode_compat.duplicate_terminal_tool_update",
          message: "OpenCode compatibility projection ignored a duplicate terminal tool update",
          eventType: chunk.type,
        }))]
      }
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolDisplaysByCallId[chunk.toolCallId] = display
      ctx.toolStatusByCallId[chunk.toolCallId] = "error"
      ctx.toolErrorsByCallId[chunk.toolCallId] = chunk.error
      const endedAt = now()
      return [toolEvent({
        ctx,
        toolCallId: chunk.toolCallId,
        tool,
        stateInput: input,
        status: "error",
        metadata,
        now: endedAt,
        error: chunk.error,
      })]
    }

    case "file-diff":
      split()
      return [withDir(ctx.directory, sessionDiff(ctx.sessionId, [snapshotFileDiff(chunk)]))]

    case "step-start":
      const completed = withDir(ctx.directory, messageCompleted(ctx.sessionId, ctx.assistantMsgId))
      ctx.assistantMsgId = chunk.newMessageId
      ctx.accumulatedText = ""
      ctx.accumulatedThinkingText = ""
      ctx.proposedPlanText = ""
      ctx.textPartSeq = 0
      ctx.reasoningPartSeq = 0
      ctx.splitText = false
      ctx.splitReasoning = false
      return [completed]

    case "finish":
      return [
        withDir(ctx.directory, messageCompleted(ctx.sessionId, ctx.assistantMsgId)),
        withDir(ctx.directory, sessionIdle(ctx.sessionId)),
      ]

    case "error":
      return [withDir(ctx.directory, sessionError(chunk.error, ctx.sessionId))]

    case "permission-request":
      return [withDir(ctx.directory, permissionAsked({
        id: chunk.requestId,
        sessionID: ctx.sessionId,
        permission: chunk.tool,
        patterns: chunk.paths,
        metadata: {},
        always: chunk.paths,
      }))]

    case "question":
      return [withDir(ctx.directory, questionAsked({
        id: chunk.requestId,
        sessionID: ctx.sessionId,
        questions: questions(chunk),
      }))]

    case "question-answered":
      return [withDir(ctx.directory, questionReplied(ctx.sessionId, chunk.requestId, questionAnswers(chunk)))]

    case "todo-update": {
      const list = todos(chunk)
      return [withDir(ctx.directory, todoUpdated(ctx.sessionId, list))]
    }

    case "image-delta":
      split()
      return [partEvent(ctx.directory, filePart({
        ctx,
        id: seqId(ctx, `${ctx.assistantMsgId}-image`),
        mime: chunk.mimeType,
        url: dataUrl(chunk.mimeType, chunk.data),
        filename: `image.${extension(chunk.mimeType)}`,
      }), now())]

    case "audio-delta":
      split()
      return [partEvent(ctx.directory, filePart({
        ctx,
        id: seqId(ctx, `${ctx.assistantMsgId}-audio`),
        mime: chunk.mimeType,
        url: dataUrl(chunk.mimeType, chunk.data),
        filename: `audio.${extension(chunk.mimeType)}`,
      }), now())]

    case "resource-link-delta":
      split()
      return [partEvent(ctx.directory, filePart({
        ctx,
        id: seqId(ctx, `${ctx.assistantMsgId}-resource-link`),
        mime: chunk.mimeType ?? "application/octet-stream",
        url: chunk.uri,
        filename: chunk.name,
      }), now())]

    case "thinking-audio-delta":
      split()
      return [lossyCompatDiagnostic(ctx, chunk.type, "OpenCode compatibility projection cannot represent thinking audio chunks", chunk)]

    case "thinking-resource-link-delta":
      split()
      return [lossyCompatDiagnostic(ctx, chunk.type, "OpenCode compatibility projection cannot represent thinking resource links", chunk)]

    case "resource-delta":
      split()
      return [lossyCompatDiagnostic(ctx, chunk.type, "OpenCode compatibility projection cannot represent non-text ACP resources", chunk)]

    case "tool-location": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const input = normalizeLocationInput(tool, ctx.toolInputsByCallId[chunk.toolCallId] ?? {}, chunk.locations)
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], {
        acp: { locations: chunk.locations },
      })
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      return [toolEvent({
        ctx,
        toolCallId: chunk.toolCallId,
        tool,
        stateInput: input,
        status: "running",
        metadata,
        now: now(),
      })]
    }

    case "tool-terminal": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const input = ctx.toolInputsByCallId[chunk.toolCallId] ?? {}
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], {
        acp: { terminalId: chunk.terminalId },
      })
      const status = ctx.toolStatusByCallId[chunk.toolCallId] ?? "running"
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      if (status === "completed" || status === "error") {
        return [toolEvent({
          ctx,
          toolCallId: chunk.toolCallId,
          tool,
          stateInput: input,
          status,
          metadata,
          now: now(),
          ...(status === "completed"
            ? { output: ctx.toolOutputsByCallId[chunk.toolCallId] ?? "" }
            : { error: ctx.toolErrorsByCallId[chunk.toolCallId] ?? "tool failed" }),
        })]
      }
      return [toolEvent({
        ctx,
        toolCallId: chunk.toolCallId,
        tool,
        stateInput: input,
        status,
        metadata,
        now: now(),
      })]
    }

    case "session-agent":
      return [withDir(ctx.directory, sessionAgent(ctx.sessionId, chunk.agentId))]

    case "config-update":
      return [withDir(ctx.directory, sessionConfig({
        sessionID: ctx.sessionId,
        options: chunk.options,
      }))]

    case "available-commands-update":
      return [lossyCompatDiagnostic(ctx, chunk.type, "OpenCode compatibility projection cannot represent ACP available command updates", chunk)]

    case "session-info": {
      const time = timestamp(chunk.updatedAt, now())
      return [withDir(ctx.directory, sessionUpdated(buildSession({
        id: ctx.sessionId,
        directory: ctx.directory,
        title: chunk.title ?? "",
        created: time,
        updated: time,
      })))]
    }

    case "session-title":
      const nowMs = now()
      return [withDir(ctx.directory, sessionUpdated(buildSession({
        id: ctx.sessionId,
        directory: ctx.directory,
        title: chunk.title,
        created: nowMs,
        updated: nowMs,
      })))]

    case "usage":
      return [withDir(ctx.directory, sessionUsage({
        sessionID: ctx.sessionId,
        contextSize: chunk.contextSize,
        contextUsed: chunk.contextUsed,
        ...(chunk.cost ? { cost: chunk.cost } : {}),
      }))]

    case "diagnostic":
      return [withDir(ctx.directory, runtimeDiagnostic({
        sessionID: ctx.sessionId,
        harness: chunk.harness,
        threadId: chunk.threadId,
        code: chunk.diagnostic.code,
        message: chunk.diagnostic.message,
        severity: chunk.diagnostic.severity,
        diagnostic: chunk.diagnostic,
        raw: chunk.raw,
      }))]

    case "subagent-updated":
      return []

    default: {
      const _exhaustive: never = chunk
      void _exhaustive
      return []
    }
  }
}

function syncState(ctx: CompatContext, state: OpencodeCompatProjectionState) {
  state.assistantMsgId = ctx.assistantMsgId
  state.accumulatedText = ctx.accumulatedText
  state.accumulatedThinkingText = ctx.accumulatedThinkingText
  state.proposedPlanText = ctx.proposedPlanText
  state.textPartSeq = ctx.textPartSeq
  state.reasoningPartSeq = ctx.reasoningPartSeq
  state.splitText = ctx.splitText
  state.splitReasoning = ctx.splitReasoning
}

function createContext(
  options: OpencodeCompatProjectionOptions,
  state: OpencodeCompatProjectionState,
): CompatContext {
  return {
    ...state,
    sessionId: options.sessionId,
    directory: options.directory,
    assistantMsgId: state.assistantMsgId ?? options.assistantMessageId,
  }
}

function projectionException(
  ctx: CompatContext,
  phase: "ingest" | "terminalize",
  eventType: string | undefined,
  error: unknown,
) {
  return withDir(ctx.directory, projectionDiagnostic({
    sessionID: ctx.sessionId,
    phase,
    code: "projection.opencode_compat.error",
    message: error instanceof Error ? error.message : String(error),
    severity: "error",
    ...(eventType ? { eventType } : {}),
  }))
}

function normalizeProjectionEvents(
  ctx: CompatContext,
  phase: "ingest" | "terminalize",
  eventType: string | undefined,
  events: CompatEnvelope[],
) {
  const normalized = events.map((event) => {
    const result = normalizeCompatEventWithDiagnostics(event.payload)
    return {
      envelope: { directory: event.directory, payload: result.event },
      issues: result.issues,
    }
  })
  const issues = [...new Set(normalized.flatMap((event) => event.issues))]
  if (issues.length === 0) return normalized.map((event) => event.envelope)
  return [
    withDir(ctx.directory, projectionDiagnostic({
      sessionID: ctx.sessionId,
      phase,
      code: "projection.opencode_compat.sanitized_event",
      message: "OpenCode compatibility projection sanitized non-JSON-safe compat event data",
      ...(eventType ? { eventType } : {}),
      issues,
    })),
    ...normalized.map((event) => event.envelope),
  ]
}

export function createOpencodeCompatProjection(options: OpencodeCompatProjectionOptions): OpencodeCompatProjection {
  let state = createOpencodeCompatProjectionState(options.initialSnapshot?.state)
  const now = options.clock ?? Date.now

  const run = (
    phase: "ingest" | "terminalize",
    eventType: string | undefined,
    project: (ctx: CompatContext) => CompatEnvelope[],
  ) => {
    const next = createOpencodeCompatProjectionState(state)
    const ctx = createContext(options, next)
    try {
      const events = normalizeProjectionEvents(ctx, phase, eventType, project(ctx))
      syncState(ctx, next)
      state = next
      return events
    } catch (error) {
      return [projectionException(createContext(options, state), phase, eventType, error)]
    }
  }

  return {
    name: "opencode-compat",
    ingest(event) {
      return run("ingest", event.type, (ctx) => translateRuntimeEventToCompat(event, ctx, now))
    },
    terminalizeOpenTools(error) {
      return run("terminalize", undefined, (ctx) => terminalizeOpenTools(ctx, error, now))
    },
    snapshot() {
      return projectionSnapshot("opencode-compat", state)
    },
  } satisfies OpencodeCompatProjection
}
