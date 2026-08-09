import type {
  AgentRuntimeEvent,
  SubagentStatus,
  SubagentToolCallRole,
} from "../../contracts/agent-runtime-event"
import { runtimeDiagnostic } from "../../contracts/diagnostics"
import type { HarnessEventAdapter, HarnessEventAdapterContext } from "../../core/adapter"
import { toolDisplayFromInput } from "../tool-display"
import { number, object, optionLabels, pathFields, text } from "../value"
import type { ServerNotification, ServerRequest } from "./protocol"

type CodexAppServerProtocolEvent = ServerNotification | ServerRequest

export type CodexAppServerAdapterState = {
  assistantTextByItemId: Record<string, string>
  toolOutputByCallId: Record<string, string>
  toolsByItemId: Record<string, {
    toolName: string
    input?: Record<string, unknown>
    itemType?: string
  }>
}

function createCodexAppServerAdapterState(): CodexAppServerAdapterState {
  return { assistantTextByItemId: {}, toolOutputByCallId: {}, toolsByItemId: {} }
}

function pruneTurnState() {
  return createCodexAppServerAdapterState()
}

function payload(event: { payload: unknown }) {
  return object(event.payload) ?? {}
}

function eventFields(event: { payload: unknown }) {
  return object(event) ?? {}
}

function eventText(event: { payload: unknown }) {
  const row = payload(event)
  const fields = eventFields(event)
  return text(fields.textDelta) ?? text(row.delta) ?? text(row.text) ?? text(fields.message)
}

function item(event: { payload: unknown }) {
  return object(payload(event).item)
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

export function codexCollabAgentCall(value: unknown): CodexCollabAgentCall | undefined {
  const row = object(value)
  if (row?.type !== "collabAgentToolCall") return
  const id = text(row.id)
  const tool = text(row.tool)
  const senderThreadId = text(row.senderThreadId)
  if (!id || !tool || !senderThreadId || !Array.isArray(row.receiverThreadIds)) return
  const receiverThreadIds = row.receiverThreadIds.filter((value): value is string => typeof value === "string" && value.length > 0)
  const agentsStates = object(row.agentsStates) ?? {}
  return {
    id,
    tool,
    toolCallRole: tool === "spawnAgent" || tool === "spawn_agent" ? "spawn" : "interaction",
    senderThreadId,
    receiverThreadIds,
    ...(text(row.prompt) ? { prompt: text(row.prompt) } : {}),
    ...(text(row.model) ? { model: text(row.model) } : {}),
    statuses: Object.fromEntries(receiverThreadIds.flatMap((threadId) => {
      const status = codexCollabAgentStatus(object(agentsStates[threadId])?.status)
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
}

export function codexStartedSubagent(value: unknown) {
  const thread = object(object(value)?.thread)
  const id = text(thread?.id)
  const parentThreadId = text(thread?.parentThreadId)
  if (!id || !parentThreadId) return
  const status = text(object(thread?.status)?.type)
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

function sessionId(event: { payload: unknown }, context: HarnessEventAdapterContext) {
  return text(payload(event).sessionId) ?? text(eventFields(event).threadId) ?? context.threadId
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
  return text(row.tool) ?? text(row.toolName) ?? text(row.name) ?? text(row.title) ?? (
    itemType === "command_execution"
      ? "command"
      : itemType === "file_change"
        ? "file-change"
        : itemType === "web_search"
          ? "web-search"
          : "tool"
  )
}

function structuredInput(row: Record<string, unknown>) {
  const direct = object(row.input)
  if (direct) return direct
  const input = Object.fromEntries(
    ["command", "cwd", "path", "filePath", "query", "prompt", "toolName", "name", "processId", "processHandle", "stream"].flatMap((key) =>
      row[key] === undefined ? [] : [[key, row[key]]],
    ),
  )
  return Object.keys(input).length ? input : undefined
}

function toolDisplay(itemType: string, input: Record<string, unknown> | undefined) {
  return toolDisplayFromInput({
    kind: itemType,
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
    const item = object(question)
    if (!item) return []
    const prompt = text(item.question) ?? text(item.prompt) ?? text(item.text)
    if (!prompt) return []
    const options = optionLabels(item.options)
    return [{
      text: prompt || `Question ${i + 1}`,
      ...(options.length ? { options } : {}),
    }]
  })
}

function todosFromPlan(row: Record<string, unknown>) {
  const plan = Array.isArray(row.plan) ? row.plan : []
  return plan.flatMap((step, i) => {
    const item = object(step)
    if (!item) return []
    const description = text(item.step) ?? text(item.content) ?? text(item.description)
    if (!description) return []
    return [{
      id: String(i),
      description,
      status: text(item.status) ?? "pending",
    }]
  })
}

function usage(row: Record<string, unknown>, nativeSessionId?: string): AgentRuntimeEvent | undefined {
  const tokenUsage = object(row.tokenUsage) ?? row
  const total = object(tokenUsage.total) ?? {}
  const last = object(tokenUsage.last) ?? {}
  const contextSize = number(tokenUsage.modelContextWindow) ?? number(row.modelContextWindow)
  const contextUsed = number(last.totalTokens) ?? number(tokenUsage.totalTokens) ?? number(total.totalTokens)
  if (contextUsed === undefined && contextSize === undefined) return undefined
  const inputTokens = number(last.inputTokens)
  const cachedInputTokens = number(last.cachedInputTokens)
  const outputTokens = number(last.outputTokens)
  const reasoningOutputTokens = number(last.reasoningOutputTokens)
  return {
    type: "usage",
    contextSize: contextSize ?? contextUsed ?? 0,
    contextUsed: contextUsed ?? contextSize ?? 0,
    observation: {
      kind: "cumulative",
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(text(row.turnId) ? { providerObservationId: text(row.turnId) } : {}),
      tokens: {
        input: inputTokens === undefined
          ? null
          : Math.max(0, inputTokens - (cachedInputTokens ?? 0)),
        output: outputTokens === undefined
          ? null
          : Math.max(0, outputTokens - (reasoningOutputTokens ?? 0)),
        reasoning: reasoningOutputTokens ?? null,
        cache: { read: cachedInputTokens ?? null, write: null },
      },
    },
  }
}

function completionEvents(event: { payload: unknown; threadId?: unknown }, context: HarnessEventAdapterContext) {
  const row = payload(event)
  const turn = object(row.turn) ?? row
  const status = text(turn.status)
  if (status === "failed" || status === "error") {
    const message = text(object(turn.error)?.message) ?? text(row.message) ?? "Codex turn failed"
    return [
      { type: "session-status", status: "error" },
      { type: "error", error: message },
    ] satisfies AgentRuntimeEvent[]
  }
  if (status === "cancelled" || status === "interrupted") {
    return [{ type: "session-status", status: "idle" }] satisfies AgentRuntimeEvent[]
  }
  return [
    { type: "session-status", status: "idle" },
    { type: "finish", sessionId: sessionId(event, context) },
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

function base64Text(value: unknown) {
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
  const existing = input.state.toolsByItemId[input.toolCallId]
  const itemType = existing?.itemType ?? input.itemType
  const rawInput = existing?.input ?? input.rawInput
  const toolName = existing?.toolName ?? input.toolName ?? toolNameForItem(itemType, rawInput ?? {})
  const display = toolDisplay(itemType, rawInput)
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
      toolsByItemId: {
        ...input.state.toolsByItemId,
        [input.toolCallId]: {
          toolName,
          ...(rawInput ? { input: rawInput } : {}),
          itemType,
        },
      },
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
  const output = `${input.state.toolOutputByCallId[input.toolCallId] ?? ""}${input.delta}`
  return {
    state: {
      ...ensured.state,
      toolOutputByCallId: {
        ...ensured.state.toolOutputByCallId,
        [input.toolCallId]: output,
      },
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
  const exitCode = number(input.row.exitCode) ?? 0
  const bufferedOutput = [text(input.row.stdout), text(input.row.stderr)].filter((item): item is string => !!item).join("\n")
  const output = bufferedOutput || input.state.toolOutputByCallId[input.toolCallId] || ""
  return {
    state: {
      ...ensured.state,
      toolOutputByCallId: {
        ...ensured.state.toolOutputByCallId,
        [input.toolCallId]: output,
      },
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
  const rateLimits = object(row.rateLimits) ?? {}
  const primary = object(rateLimits.primary)
  const secondary = object(rateLimits.secondary)
  const window = [primary, secondary]
    .filter((item): item is Record<string, unknown> => !!item)
    .sort((a, b) => (number(b.usedPercent) ?? 0) - (number(a.usedPercent) ?? 0))[0]
  return {
    type: "rate-limit",
    status: rateLimits.rateLimitReachedType ? "limited" : "ok",
    usedPercent: number(window?.usedPercent),
    resetsAt: number(window?.resetsAt) ?? null,
    windowDurationMins: number(window?.windowDurationMins) ?? null,
    limitId: text(rateLimits.limitId) ?? null,
    limitName: text(rateLimits.limitName) ?? null,
    reason: text(rateLimits.rateLimitReachedType) ?? null,
    metadata: { codex: { rateLimits } },
  } satisfies AgentRuntimeEvent
}

function threadStatusEvents(row: Record<string, unknown>) {
  const status = object(row.status)
  const type = text(status?.type)
  if (type === "active") return [{ type: "session-status", status: "busy" }] satisfies AgentRuntimeEvent[]
  if (type === "idle" || type === "notLoaded") return [{ type: "session-status", status: "idle" }] satisfies AgentRuntimeEvent[]
  if (type === "systemError") return [{ type: "session-status", status: "error" }] satisfies AgentRuntimeEvent[]
  return []
}

function protocolEvent(event: { method?: string; payload: unknown }): CodexAppServerProtocolEvent {
  if (!event.method) throw new Error("Codex app-server event is missing a method")
  // JSON-RPC framing stores `params` as RawHarnessEvent.payload; this is the single boundary into generated protocol types.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    method: event.method,
    params: payload(event),
    id: text(eventFields(event).requestId) ?? text(payload(event).requestId) ?? "",
  } as CodexAppServerProtocolEvent
}

export function codexAppServerAdapter(): HarnessEventAdapter<CodexAppServerAdapterState> {
  return {
    name: "codex-app-server",
    createInitialState: createCodexAppServerAdapterState,
    translate({ state, event, context }) {
      const message = protocolEvent(event)
      const method = message.method
      const row = payload(event)

      switch (message.method) {
        // Chat transcript: text, reasoning, and proposed-plan content that belongs in the assistant timeline.
        case "item/agentMessage/delta": {
          const delta = eventText(event)
          if (!delta) return []
          const id = itemId(event, "assistant")
          return {
            state: {
              ...state,
              assistantTextByItemId: {
                ...state.assistantTextByItemId,
                [id]: `${state.assistantTextByItemId[id] ?? ""}${delta}`,
              },
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
            const previous = state.assistantTextByItemId[id] ?? ""
            const delta = fullText?.startsWith(previous) ? fullText.slice(previous.length) : fullText
            if (!delta) return []
            return {
              state: {
                ...state,
                assistantTextByItemId: { ...state.assistantTextByItemId, [id]: fullText ?? previous },
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
          const existing = state.toolsByItemId[id]
          // Codex completes commands with every output field null in two different cases:
          // the command genuinely printed nothing, OR stdout already arrived via
          // `outputDelta` (which we accumulate in `toolOutputByCallId`). So fall back to
          // the streamed buffer first, then to empty — never to `row`, which is the raw
          // protocol payload and would dump the whole envelope into the output pane.
          const output =
            completedItem.output ??
            completedItem.result ??
            completedItem.aggregatedOutput ??
            completedItem.text ??
            state.toolOutputByCallId[id] ??
            ""
          if (!existing) {
            const toolName = toolNameForItem(itemType, completedItem)
            const input = structuredInput(completedItem)
            const display = toolDisplay(itemType, input)
            return {
              state: {
                ...state,
                toolsByItemId: { ...state.toolsByItemId, [id]: { toolName, input, itemType } },
              },
              events: [
                { type: "tool-start", toolCallId: id, toolName, kind: itemType, display, metadata: { codex: { itemType } } },
                ...(input ? [{ type: "tool-input", toolCallId: id, input, display, metadata: { codex: { itemType } } } satisfies AgentRuntimeEvent] : []),
                { type: "tool-output", toolCallId: id, output, display, metadata: { codex: { itemType } } },
              ],
            }
          }
          return [{ type: "tool-output", toolCallId: id, output, display: toolDisplay(itemType, existing.input), metadata: { codex: { itemType } } }]
        }

        case "item/started": {
          const startedItem = item(event) ?? row
          if (startedItem.type === "contextCompaction") {
            return [{ type: "session-compaction", phase: "started", metadata: { codex: row } }]
          }
          const id = itemId(event, context.createId("item"))
          const itemType = canonicalItemType(startedItem.type)
          if (itemType === "user_message" || itemType === "assistant_message" || itemType === "reasoning" || itemType === "plan") return []
          const toolName = toolNameForItem(itemType, startedItem)
          const input = structuredInput(startedItem)
          const display = toolDisplay(itemType, input)
          return {
            state: {
              ...state,
              toolsByItemId: { ...state.toolsByItemId, [id]: { toolName, input, itemType } },
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
          return { state: pruneTurnState(), events: completionEvents(event, context) }

        case "thread/status/changed":
          return threadStatusEvents(row)

        case "thread/closed":
          return {
            state: pruneTurnState(),
            events: [
              { type: "session-status", status: "idle" },
              { type: "finish", sessionId: sessionId(event, context) },
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
          const title = text(row.name) ?? text(row.title)
          return title ? [{ type: "session-title", title }] : []
        }

        case "thread/tokenUsage/updated": {
          const usageEvent = usage(row, sessionId(event, context))
          return usageEvent ? [usageEvent] : []
        }

        case "thread/compacted":
          return [{ type: "session-compaction", phase: "completed", metadata: { codex: row } }]

        // Interactive requests: app-server pauses the turn until the client answers.
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

        // Provider/session surfaces that are not message text but should be first-class runtime state.
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

        case "account/rateLimits/updated":
          return [rateLimitEvent(row)]

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
          return [harnessNotice({
            code: "codex_app_server.model_rerouted",
            message: `Model rerouted from ${text(row.fromModel) ?? "unknown"} to ${text(row.toModel) ?? "unknown"}`,
            severity: "info",
            details: row,
          })]

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
          const error = object(row.error)
          const detail = object(error?.message) ?? error
          const message = text(detail?.message) ?? text(error?.message) ?? text(row.message) ?? "Codex provider error"
          if (row.willRetry === true) {
            return [diagnosticForEvent({ code: "codex_app_server.retryable_error", message, severity: "warn", event })]
          }
          return [
            { type: "session-status", status: "error" },
            { type: "error", error: message },
          ]
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
        // App/global surfaces: useful for a full app shell, not part of a single chat timeline yet.
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
        case "thread/settings/updated":
        case "thread/unarchived":
          return unmappedCodexAppServerEvent(event)

        case "thread/started":
          codexStartedSubagent(row)
          return []

        // Hook and review lifecycle: chat-adjacent, but AgentRuntimeEvent has no hook/review surface yet.
        case "hook/completed":
        case "hook/started":
        case "item/autoApprovalReview/completed":
        case "item/autoApprovalReview/started":
          return unmappedCodexAppServerEvent(event)

        // Lower-level tool streams: live stdout/stderr, terminal, patch, and MCP progress for running tools.
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
              const item = object(change)
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
          return processExitEvents({
            state,
            toolCallId: id,
            row,
            metadata: {
              codex: {
                method,
                processHandle: id,
                exitCode: row.exitCode,
                stdoutCapReached: row.stdoutCapReached,
                stderrCapReached: row.stderrCapReached,
              },
            },
          })
        }

        // Message detail that is currently redundant with already-mapped item lifecycle.
        case "item/reasoning/summaryPartAdded":
        case "rawResponseItem/completed":
        case "serverRequest/resolved":
          return unmappedCodexAppServerEvent(event)

        // Elicitation is interactive, but AgentRuntimeEvent needs a URL/form-aware question shape first.
        case "mcpServer/elicitation/request":
          return unmappedCodexAppServerEvent(event)

        // Realtime surfaces: media/transcript channels are not part of the classic chat projection yet.
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
