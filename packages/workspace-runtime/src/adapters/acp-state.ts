import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk"
import type { AgentEvent } from "./index"
import { acpClient, findAcpRule, type AcpClient, type AcpIntent } from "./acp-registry"

type Spot = { path: string; line?: number | null }
type ToolStatus = "pending" | "running" | "completed" | "failed"

type ToolState = {
  id: string
  client: AcpClient
  status: ToolStatus
  title?: string
  firstTitle?: string
  kind?: ToolKind
  firstKind?: ToolKind
  name?: string
  rawInput?: Record<string, unknown>
  rawOutput?: unknown
  content: ToolCallContent[]
  locations: Spot[]
  terminalId?: string
  seenDiffs: string[]
  seenTerms: string[]
  seenSpots: string[]
}

export type SessionState = {
  client: AcpClient
  lastMessageId: string | null
  status: "idle" | "busy" | "error"
  turn: number
  tools: Record<string, ToolState>
}

export type ToolView = {
  toolName: string
  input?: Record<string, unknown>
  metadata: Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function str(value: unknown) {
  if (typeof value !== "string") return
  if (!value) return
  return value
}

function list(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
}

function parsed(raw: unknown) {
  const item = object(raw)
  const value = item?.parsed_cmd ?? item?.parsedCmd
  if (!Array.isArray(value)) return []
  return value.map(object).filter((item): item is Record<string, unknown> => !!item)
}

function name(raw: unknown) {
  const item = object(raw)
  return str(item?._toolName) ?? str(item?.toolName) ?? str(item?.tool) ?? str(item?.name)
}

function pathlike(value: string) {
  return (
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[^/\s]+\.[^/\s]+$/.test(value)
  )
}

function pathKey(item: Spot) {
  return `${item.path}:${item.line ?? ""}`
}

function diffKey(item: ToolCallContent) {
  if (item.type !== "diff") return ""
  return `${item.path}:${item.oldText ?? ""}:${item.newText}`
}

function termKey(item: ToolCallContent) {
  if (item.type !== "terminal") return ""
  return item.terminalId
}

function merge(left: Record<string, unknown> | undefined, right: unknown) {
  const next = object(right)
  if (!left) return next
  if (!next) return left
  return { ...left, ...next }
}

function uniqContent(left: ToolCallContent[], right: ToolCallContent[] | null | undefined) {
  const seen = new Set(
    left.map((item) => {
      if (item.type === "diff") return `diff:${diffKey(item)}`
      if (item.type === "terminal") return `terminal:${item.terminalId}`
      return `content:${JSON.stringify(item)}`
    }),
  )
  const next = [...left]
  for (const item of right ?? []) {
    const key =
      item.type === "diff"
        ? `diff:${diffKey(item)}`
        : item.type === "terminal"
          ? `terminal:${item.terminalId}`
          : `content:${JSON.stringify(item)}`
    if (seen.has(key)) continue
    seen.add(key)
    next.push(item)
  }
  return next
}

function uniqSpots(left: Spot[], right: Spot[] | null | undefined) {
  const seen = new Set(left.map(pathKey))
  const next = [...left]
  for (const item of right ?? []) {
    const key = pathKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(item)
  }
  return next
}

function firstPath(list: Array<{ path: string; line?: number | null }>) {
  return str(list[0]?.path)
}

function diffPath(content: ToolCallContent[]) {
  for (const item of content) {
    if (item.type === "diff" && item.path) return item.path
  }
}

function files(state: ToolState) {
  const out: string[] = []
  const add = (value?: string) => {
    if (!value || out.includes(value)) return
    out.push(value)
  }

  const raw = state.rawInput
  add(str(raw?.filePath))
  add(str(raw?.path))
  add(str(raw?.sourcePath))
  add(str(raw?.fromPath))
  add(str(raw?.oldPath))
  add(str(raw?.targetPath))
  add(str(raw?.toPath))
  add(str(raw?.newPath))
  for (const item of state.locations) add(item.path)
  for (const item of state.content) {
    if (item.type === "diff") add(item.path)
  }
  return out
}

function textBody(raw: unknown) {
  const item = object(raw)
  return str(item?.content) ?? str(item?.text) ?? str(item?.body)
}

function url(value: unknown) {
  const item = str(value)
  if (!item) return
  try {
    const next = new URL(item)
    if (!next.protocol.startsWith("http")) return
    return item
  } catch {
    return
  }
}

function session(raw: unknown) {
  const item = object(raw)
  return (
    str(item?.childSessionId) ??
    str(item?.child_session_id) ??
    str(item?.sessionId) ??
    str(item?.session_id) ??
    str(item?.sessionID)
  )
}

function lines(value: string | null | undefined) {
  if (!value) return 0
  return value.split("\n").length
}

function type(
  before: string | null | undefined,
  after: string | null | undefined,
) {
  if (!before && after) return "add" as const
  if (before && !after) return "delete" as const
  return "update" as const
}

function diffInfo(item: ToolCallContent) {
  if (item.type !== "diff" || !item.path) return
  return {
    file: item.path,
    before: item.oldText ?? "",
    after: item.newText,
    additions: lines(item.newText),
    deletions: lines(item.oldText),
  }
}

function filediff(content: ToolCallContent[]) {
  const item = content.flatMap((row) => {
    const next = diffInfo(row)
    return next ? [next] : []
  })
  if (item.length !== 1) return
  return item[0]
}

function patch(content: ToolCallContent[]) {
  return content.flatMap((row) => {
    if (row.type !== "diff") return []
    const next = diffInfo(row)
    if (!next) return []
    return [{
      filePath: next.file,
      relativePath: next.file,
      type: type(row.oldText ?? null, row.newText),
      diff: "",
      before: next.before,
      after: next.after,
      additions: next.additions,
      deletions: next.deletions,
    }]
  })
}

function shell(raw: unknown) {
  for (const item of parsed(raw)) {
    const cmd = str(item.cmd)
    if (cmd) return cmd
  }

  const row = object(raw)
  const direct = str(row?.command)
  if (direct) return direct
  const cmd = row?.command
  if (!Array.isArray(cmd)) return
  const list = cmd.filter((item): item is string => typeof item === "string")
  if (list.length === 0) return
  if (list.length >= 3 && list[1] === "-lc") return str(list[2])
  return list.join(" ")
}

function parseTitle(
  title: string,
  kind: ToolKind | undefined,
): { short: string; input?: Record<string, unknown> } {
  const idx = title.indexOf(" ")
  const head = (idx < 0 ? title : title.slice(0, idx)).toLowerCase().replace(/:+$/, "")
  const short = head === "terminal" ? "bash" : head
  if (idx < 0) return { short }
  const tail = title.slice(idx + 1).trim()
  if (!tail) return { short }

  if (kind === "execute") return { short, input: { command: tail, description: tail } }
  if ((kind === "read" || kind === "edit") && pathlike(tail)) return { short, input: { filePath: tail } }
  if (kind === "search" && pathlike(tail)) return { short, input: { pattern: tail } }
  if (kind === "fetch") return { short, input: { url: tail } }
  if (pathlike(tail)) return { short, input: { path: tail } }
  return { short }
}

function mode(title?: string) {
  const item = title?.trim().toLowerCase()
  if (item === "web search") return "web"
  if (item === "codebase search") return "codebase"
  if (item === "find") return "files"
}

function first(value: unknown) {
  if (!Array.isArray(value)) return
  return value.find((item): item is string => typeof item === "string" && !!item)
}

function intent(kind: ToolKind | undefined, title?: string, call?: string): AcpIntent {
  if (title?.trim().toLowerCase() === "read lints") return "lint"
  if (call?.toLowerCase() === "updatetodos" || call?.toLowerCase() === "todowrite") return "todos"
  if (call?.toLowerCase() === "task" || call?.toLowerCase() === "agent") return "task"
  if (call?.toLowerCase() === "exitplanmode") return "reasoning"
  if (kind === "execute") return "shell"
  if (kind === "read") return "read"
  if (kind === "edit") return "edit"
  if (kind === "fetch") return "fetch"
  if (kind === "move") return "move"
  if (kind === "delete") return "delete"
  if (kind === "think") return "reasoning"
  if (kind === "search") {
    if (mode(title) === "files") return "list"
    return "search"
  }
  return "generic"
}

function pick(state: ToolState) {
  const title = state.title ?? state.firstTitle ?? "Tool"
  const kind = state.kind ?? state.firstKind
  const rule = findAcpRule(state.client, title, state.name, kind)
  const base = parseTitle(title, kind)
  const raw = state.rawInput
  const body = textBody(state.rawOutput)
  const items = parsed(raw)
  const all = files(state)
  const file = all[0]
  const spot = firstPath(state.locations)
  const diff = diffPath(state.content)
  const call = state.name?.toLowerCase()
  let nextIntent = rule?.intent ?? intent(kind, title, call)
  const query = str(raw?.query) ?? str(raw?.q) ?? str(raw?.pattern) ?? str(object(raw?.action)?.query) ?? first(raw?.queries)
  const search = items.find((item) => item.type === "search")
  const list = items.find((item) => item.type === "list_files" || item.type === "glob")
  if (
    nextIntent === "generic" &&
    (
      (str(raw?.server) && (str(raw?.tool) || str(raw?.name) || str(raw?.uri))) ||
      call?.startsWith("mcp__") ||
      call === "mcp" ||
      call === "list_mcp_resources" ||
      call === "list_mcp_resource_templates" ||
      call === "read_mcp_resource"
    )
  ) nextIntent = "mcp"
  if (nextIntent === "search" && call === "find") nextIntent = "list"
  if (nextIntent === "generic" && call === "find") nextIntent = "list"
  if (nextIntent === "generic" && call === "codesearch") nextIntent = "search"
  if (nextIntent === "generic" && call === "websearch") nextIntent = "search"
  if (nextIntent === "generic" && call === "openpage") nextIntent = "fetch"
  // Upgrade search → list when parsed command proves it's a file listing
  // but only when no search command also exists (search wins over list)
  if (nextIntent === "search" && list && !search) nextIntent = "list"
  const nextMode =
    rule?.mode ??
    mode(title) ??
    ((call === "codesearch" && nextIntent === "search") ? "codebase" : undefined) ??
    ((call === "websearch" && nextIntent === "search") ? "web" : undefined) ??
    ((call === "find" && nextIntent === "list") ? "files" : undefined) ??
    (nextIntent === "list" && list ? (str(list.pattern) ? "glob" : "files") : undefined)
  const cmd = shell(raw) ?? str(base.input?.command)
  const urlValue = url(raw?.url) ?? url(base.input?.url) ?? url(raw?.uri)
  const sourcePath = str(raw?.sourcePath) ?? str(raw?.fromPath) ?? str(raw?.oldPath) ?? file
  const targetPath = str(raw?.targetPath) ?? str(raw?.toPath) ?? str(raw?.newPath) ?? str(raw?.destinationPath)
  const pattern = str(raw?.pattern) ?? str(search?.query) ?? str(list?.pattern) ?? str(base.input?.pattern)
  const path = str(raw?.path) ?? str(search?.path) ?? str(list?.path) ?? spot
  const filePath = str(raw?.filePath) ?? str(search?.path) ?? file ?? diff ?? str(base.input?.filePath)
  const stats = object(state.rawOutput)
  const hasDiff = state.content.some((item) => item.type === "diff")
  const child = session(raw) ?? session(state.rawOutput)
  const diffValue = filediff(state.content)
  const patchValue = patch(state.content)
  const shellMode = nextIntent === "shell" &&
      !cmd &&
      (
        !!textBody(state.rawOutput) ||
        !!str(stats?.stdout) ||
        !!str(stats?.stderr) ||
        typeof stats?.exitCode === "number"
      )
    ? "result"
    : undefined

  if (nextIntent === "fetch" && query && !urlValue) nextIntent = "search"

  let short = rule?.short ?? base.short
  const modeValue =
    nextMode ??
    shellMode ??
    ((nextIntent === "fetch" || nextIntent === "search") && urlValue ? "web" : undefined) ??
    (nextIntent === "search" && query ? "web" : undefined)
  const description = call === "task"
    ? (title.match(/^task:?\s*(.*)$/i)?.[1] || undefined)
    : undefined

  if (nextIntent === "shell") short = "bash"
  if (nextIntent === "task") short = "task"
  if (nextIntent === "todos") short = "todowrite"
  if (nextIntent === "search" && nextMode === "web" && query) short = "websearch"
  if (nextIntent === "search" && nextMode === "codebase" && query) short = "codesearch"
  if (nextIntent === "search" && pattern && path) short = "grep"
  if (nextIntent === "list" && list) short = str(list.pattern) ? "glob" : "list"
  if (nextIntent === "read") short = "read"
  if (nextIntent === "lint") short = "lint"
  if (nextIntent === "edit") short = "edit"
  if (nextIntent === "fetch" && modeValue === "web") short = "webfetch"

  const input = merge(raw, {
    summary: title,
    kind: kind ?? "other",
    intent: nextIntent,
    ...(modeValue ? { mode: modeValue } : {}),
    ...(cmd ? { command: cmd, description: cmd } : {}),
    ...(description ? { description } : {}),
    ...(query ? { query } : {}),
    ...(pattern ? { pattern } : {}),
    ...(urlValue ? { url: urlValue } : {}),
    ...(path ? { path } : {}),
    ...(filePath ? { filePath } : {}),
    ...(sourcePath && nextIntent === "move" ? { sourcePath, filePath: sourcePath } : {}),
    ...(targetPath ? { targetPath } : {}),
    ...(child && nextIntent === "task" ? { sessionId: child } : {}),
    ...(diffValue && nextIntent === "edit" ? { oldString: diffValue.before, newString: diffValue.after } : {}),
    ...(nextIntent === "edit" && modeValue === "write"
      ? { content: diffValue?.after ?? str(raw?.content) ?? str(raw?.newString) ?? "" }
      : {}),
    ...(all.length ? { files: all } : {}),
  })
  const metadata = {
    ...(child && nextIntent === "task" ? { sessionId: child } : {}),
    ...(diffValue ? { filediff: diffValue } : {}),
    ...(patchValue.length > 0 ? { files: patchValue } : {}),
    acp: {
      client: state.client,
      kind: kind ?? "other",
      intent: nextIntent,
      status: state.status,
      title,
      summary: title,
      ...(modeValue ? { mode: modeValue } : {}),
      ...(cmd ? { command: cmd } : {}),
      ...(description ? { description } : {}),
      ...(query ? { query } : {}),
      ...(pattern ? { pattern } : {}),
      ...(urlValue ? { url: urlValue } : {}),
      ...(path ? { path } : {}),
      ...(filePath ? { filePath } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(targetPath ? { targetPath } : {}),
      ...(child ? { childSessionId: child } : {}),
      ...(all.length ? { files: all } : {}),
      ...(state.locations.length ? { locations: state.locations.map((item) => ({ path: item.path, line: item.line ?? undefined })) } : {}),
      ...(state.terminalId ? { terminalId: state.terminalId } : {}),
      ...(hasDiff ? { hasDiff } : {}),
      ...(diffValue ? { filediff: diffValue } : {}),
      ...(patchValue.length > 0 ? { patch: patchValue } : {}),
      ...(state.content.length ? { content: state.content } : {}),
      ...(raw !== undefined ? { rawInput: raw } : {}),
      ...(state.rawOutput !== undefined ? { rawOutput: state.rawOutput } : {}),
      ...(body ? { body } : {}),
      ...(stats ? { stats } : {}),
      ...(state.name ? { rawToolName: state.name } : {}),
      ...(rule ? { extractor: rule.extractor } : {}),
    },
  }
  return { toolName: short || state.id, input, metadata } satisfies ToolView
}

function newTool(id: string, client: AcpClient): ToolState {
  return {
    id,
    client,
    status: "pending",
    content: [],
    locations: [],
    seenDiffs: [],
    seenTerms: [],
    seenSpots: [],
  }
}

export function createSessionState(client?: string): SessionState {
  return {
    client: acpClient(client),
    lastMessageId: null,
    status: "idle",
    turn: 0,
    tools: {},
  }
}

export function reduceTool(
  session: SessionState,
  id: string,
  update: {
    title?: string
    kind?: ToolKind
    status?: ToolStatus
    rawInput?: unknown
    rawOutput?: unknown
    content?: ToolCallContent[] | null
    locations?: Spot[] | null
  },
) {
  const prev = session.tools[id] ?? newTool(id, session.client)
  const title = update.title ?? prev.title ?? prev.firstTitle
  const kind = update.kind ?? prev.kind ?? prev.firstKind
  const rawInput = merge(prev.rawInput, update.rawInput)
  const content = uniqContent(prev.content, update.content)
  const locations = uniqSpots(prev.locations, update.locations)
  const terminal = content.find((item) => item.type === "terminal")
  const next: ToolState = {
    ...prev,
    status: update.status ?? prev.status,
    title,
    firstTitle: prev.firstTitle ?? update.title,
    kind,
    firstKind: prev.firstKind ?? update.kind,
    name: prev.name ?? name(rawInput),
    rawInput,
    rawOutput:
      update.rawOutput !== undefined
        ? update.rawOutput !== null
          ? update.rawOutput
          : prev.rawOutput ?? null
        : prev.rawOutput,
    content,
    locations,
    terminalId: terminal?.type === "terminal" ? terminal.terminalId : prev.terminalId,
  }
  session.tools[id] = next
  return next
}

export function viewTool(state: ToolState) {
  return pick(state)
}

export function drainContent(state: ToolState, content: ToolCallContent[] | null | undefined): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const item of content ?? []) {
    if (item.type === "diff") {
      const key = diffKey(item)
      if (!key || state.seenDiffs.includes(key)) continue
      state.seenDiffs.push(key)
      out.push({
        type: "file-diff",
        toolCallId: state.id,
        path: item.path,
        oldText: item.oldText ?? undefined,
        newText: item.newText,
      })
      continue
    }
    if (item.type !== "terminal") continue
    const key = termKey(item)
    if (!key || state.seenTerms.includes(key)) continue
    state.seenTerms.push(key)
    out.push({ type: "tool-terminal", toolCallId: state.id, terminalId: item.terminalId })
  }
  return out
}

export function drainSpots(state: ToolState, locations: Spot[] | null | undefined): AgentEvent[] {
  const next = (locations ?? []).flatMap((item) => {
    const key = pathKey(item)
    if (state.seenSpots.includes(key)) return []
    state.seenSpots.push(key)
    return [{ path: item.path, ...(item.line != null ? { line: item.line } : {}) }]
  })
  if (!next.length) return []
  return [{ type: "tool-location", toolCallId: state.id, locations: next }]
}
