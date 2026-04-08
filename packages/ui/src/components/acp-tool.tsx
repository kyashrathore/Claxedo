import { createMemo, For, Show } from "solid-js"
import { getFilename } from "@opencode-ai/util/path"
import { BasicTool } from "./basic-tool"
import { useI18n } from "../context/i18n"
import stripAnsi from "strip-ansi"

type Row = Record<string, unknown>

export interface AcpToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  output?: unknown
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
}

export type AcpInfo = {
  client?: string
  kind?: string
  intent: string
  status?: string
  mode?: string
  title?: string
  summary?: string
  rawName?: string
  command?: string
  filePath?: string
  path?: string
  pattern?: string
  query?: string
  url?: string
  sourcePath?: string
  targetPath?: string
  terminalId?: string
  hasDiff?: boolean
  body?: string
  stats?: Record<string, unknown>
  files: string[]
  locations: Array<{ path: string; line?: number }>
  content?: unknown
  rawInput?: unknown
  rawOutput?: unknown
}

function object(value: unknown): Row | undefined {
  const next = parse(value)
  if (!next || typeof next !== "object" || Array.isArray(next)) return
  return next as Row
}

function text(value: unknown) {
  if (typeof value !== "string") return
  if (!value) return
  return value
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value
  const item = value.trim()
  if (!item) return value
  if (item[0] !== "{" && item[0] !== "[") return value
  try {
    return JSON.parse(item)
  } catch {
    return value
  }
}

function bool(value: unknown) {
  if (typeof value !== "boolean") return
  return value
}

function list(value: unknown) {
  const next = parse(value)
  if (!Array.isArray(next)) return []
  return next
}

function locations(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const row = object(item)
    const path = text(row?.path)
    if (!path) return []
    const line = typeof row?.line === "number" ? row.line : undefined
    return [{ path, ...(line !== undefined ? { line } : {}) }]
  })
}

function filename(path?: string) {
  if (!path) return ""
  return getFilename(path)
}

function url(value: unknown) {
  const item = text(value)
  if (!item) return
  try {
    const next = new URL(item)
    if (!next.protocol.startsWith("http")) return
    return item
  } catch {
    return
  }
}

function uniq(items: string[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
}

function match(value?: string) {
  if (!value) return []
  return [...value.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)]
    .map((item) => item[0].replace(/[),.;:!?]+$/g, ""))
    .flatMap((item) => {
      const next = url(item)
      return next ? [next] : []
    })
}

function snippets(value: unknown): string[] {
  if (typeof value === "string") {
    if (!value) return []
    const next = parse(value)
    if (next !== value) return snippets(next)
    return [value]
  }
  if (Array.isArray(value)) return value.flatMap(snippets)
  const row = object(value)
  if (!row) return []
  const keys = [
    "formatted_output",
    "formattedOutput",
    "aggregated_output",
    "aggregatedOutput",
    "stdout",
    "stderr",
    "content",
    "text",
    "body",
    "message",
  ]
  return keys.flatMap((key) => snippets(row[key]))
}

function bodies(...values: unknown[]) {
  return uniq(values.flatMap(snippets).map((item) => item.trim()).filter(Boolean))
}

function add(value: unknown, out: string[]) {
  const next = url(value)
  if (next) out.push(next)
}

export type AcpDiff = {
  filePath: string
  relativePath: string
  type: "add" | "update" | "delete" | "move"
  diff: string
  before: string
  after: string
  additions: number
  deletions: number
  movePath?: string
}

function countLines(value: string) {
  if (!value) return 0
  return value.split("\n").length
}

function diffType(before: string, after: string): AcpDiff["type"] {
  if (!before && after) return "add"
  if (before && !after) return "delete"
  return "update"
}

function diffRow(value: unknown): AcpDiff | undefined {
  const row = object(value)
  const filePath = text(row?.filePath) ?? text(row?.file) ?? text(row?.path)
  if (!filePath) return
  const before = text(row?.before) ?? text(row?.oldText) ?? ""
  const after = text(row?.after) ?? text(row?.newText) ?? ""
  const diff = text(row?.diff) ?? ""
  const movePath = text(row?.movePath)
  const type = text(row?.type)
  return {
    filePath,
    relativePath: text(row?.relativePath) ?? filePath,
    type: type === "add" || type === "update" || type === "delete" || type === "move" ? type : diffType(before, after),
    diff,
    before,
    after,
    additions: typeof row?.additions === "number" ? row.additions : countLines(after),
    deletions: typeof row?.deletions === "number" ? row.deletions : countLines(before),
    ...(movePath ? { movePath } : {}),
  }
}

export function readAcpDiffs(input?: Row, metadata?: Row) {
  const acp = object(metadata?.acp)
  const out: AcpDiff[] = []
  const seen = new Set<string>()
  const push = (value: unknown) => {
    const next = diffRow(value)
    if (!next) return
    const key = `${next.filePath}:${next.before}:${next.after}:${next.type}:${next.movePath ?? ""}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(next)
  }

  push(metadata?.filediff)
  for (const item of list(metadata?.files)) push(item)
  for (const item of list(acp?.patch)) push(item)
  push(acp?.filediff)
  for (const item of list(acp?.content)) push(item)
  if (out.length > 0) return out

  const filePath = text(input?.filePath) ?? text(acp?.filePath)
  const before = text(input?.oldString)
  const after = text(input?.newString) ?? text(input?.content)
  if (!filePath || (before === undefined && after === undefined)) return []
  return [{
    filePath,
    relativePath: filePath,
    type: diffType(before ?? "", after ?? ""),
    diff: "",
    before: before ?? "",
    after: after ?? "",
    additions: countLines(after ?? ""),
    deletions: countLines(before ?? ""),
  }]
}

export function readAcpChildSessionId(input?: Row, metadata?: Row) {
  const acp = object(metadata?.acp)
  const rawInput = object(acp?.rawInput)
  const rawOutput = object(acp?.rawOutput)
  return (
    text(metadata?.sessionId) ??
    text(acp?.childSessionId) ??
    text(input?.sessionId) ??
    text(rawInput?.childSessionId) ??
    text(rawInput?.child_session_id) ??
    text(rawInput?.sessionId) ??
    text(rawInput?.session_id) ??
    text(rawInput?.sessionID) ??
    text(rawOutput?.childSessionId) ??
    text(rawOutput?.child_session_id) ??
    text(rawOutput?.sessionId) ??
    text(rawOutput?.session_id) ??
    text(rawOutput?.sessionID)
  )
}

export function readAcpLinks(input?: Row, metadata?: Row, value?: unknown) {
  const info = readAcpTool(input, metadata)
  if (!info) return []
  const out: string[] = []
  add(info.url, out)

  const raw = object(info.rawOutput)
  for (const key of ["url", "uri"]) add(raw?.[key], out)
  for (const item of list(raw?.links)) {
    const row = object(item)
    add(row?.url, out)
    add(row?.uri, out)
  }
  for (const item of list(raw?.results)) {
    const row = object(item)
    add(row?.url, out)
    add(row?.uri, out)
  }
  for (const item of list(raw?.resources)) {
    const row = object(item)
    add(row?.url, out)
    add(row?.uri, out)
  }
  for (const item of snippets(value).concat(snippets(info.body)).concat(snippets(info.rawOutput)).concat(snippets(info.content))) {
    out.push(...match(item))
  }
  return uniq(out)
}

export function readAcpBody(info: AcpInfo, value?: unknown) {
  const body = bodies(value, info.body, info.rawOutput).join("\n\n").trim()
  if (info.intent === "shell" && info.command) {
    const out = stripAnsi(body)
    return `$ ${info.command}${out ? `\n\n${out}` : ""}`
  }
  if (!body && info.intent === "lint") {
    const row = info.stats ?? object(info.rawOutput)
    if (typeof row?.totalDiagnostics === "number" && row.totalDiagnostics === 0) return "No lint issues"
  }
  if (!body && info.intent === "delete" && info.filePath) return `Deleted ${info.filePath}`
  if (!body && (info.intent === "list" || info.intent === "search") && info.files.length > 0) {
    return info.files.join("\n")
  }
  if (!body) return ""
  return stripAnsi(body)
}

export function readAcpError(value: unknown, metadata?: Row) {
  const body = snippets(value).join("\n\n").trim()
  if (body && body !== "[object Object]") return stripAnsi(body)
  const raw = object(object(metadata?.acp)?.rawOutput)
  const next = snippets(raw).join("\n\n").trim()
  if (next) return stripAnsi(next)
  if (typeof value === "string") return value
  return ""
}

export function describeAcpSubtitle(info: AcpInfo) {
  if (info.intent === "shell") {
    if (info.command) return info.command
    if (info.summary === "Terminal") return ""
    return info.summary ?? ""
  }
  if (info.intent === "fetch") return info.url ?? info.query ?? info.summary ?? ""
  if (info.intent === "move") {
    if (info.sourcePath && info.targetPath) {
      return `${filename(info.sourcePath)} -> ${filename(info.targetPath)}`
    }
    return info.sourcePath ?? info.targetPath ?? info.summary ?? ""
  }
  if (info.intent === "search") return info.query ?? info.pattern ?? info.summary ?? ""
  if (info.intent === "list") return info.path ?? info.files[0] ?? info.summary ?? ""
  if (info.intent === "mcp") {
    const raw = object(info.rawInput)
    const server = text(raw?.server)
    const tool = text(raw?.tool) ?? text(raw?.name)
    if (server && tool) return `${server} / ${tool}`
    return tool ?? server ?? info.summary ?? ""
  }
  if (info.intent === "delete") return info.filePath ?? info.files[0] ?? info.summary ?? ""
  if (info.intent === "lint") return info.filePath ?? info.files[0] ?? info.summary ?? ""
  if (info.intent === "image") return info.summary ?? ""
  if (info.intent === "computer") return info.summary ?? ""
  return info.filePath ?? info.path ?? info.files[0] ?? info.summary ?? ""
}

function count(value: number, label: string) {
  if (value === 1) return `${value} ${label}`
  if (label.endsWith("ch") || label.endsWith("sh") || label.endsWith("x") || label.endsWith("s")) return `${value} ${label}es`
  return `${value} ${label}s`
}

function stats(info: AcpInfo) {
  const row = info.stats ?? object(info.rawOutput)
  if (!row) return []
  const items: string[] = []
  if (typeof row.totalFiles === "number") items.push(count(row.totalFiles, "file"))
  if (typeof row.totalDiagnostics === "number") items.push(count(row.totalDiagnostics, "diagnostic"))
  if (typeof row.totalMatches === "number") items.push(count(row.totalMatches, "match"))
  if (typeof row.referenceCount === "number") items.push(count(row.referenceCount, "reference"))
  if (typeof row.resultCount === "number") items.push(count(row.resultCount, "result"))
  if (Array.isArray(row.resources)) items.push(count(row.resources.length, "resource"))
  if (typeof row.exitCode === "number") items.push(`exit=${row.exitCode}`)
  if (typeof row.durationMs === "number") items.push(row.durationMs >= 1000 ? `${(row.durationMs / 1000).toFixed(1)}s` : `${row.durationMs}ms`)
  if (row.isBackground === true) items.push("background")
  if (row.truncated === true) items.push("truncated")
  return items
}

export function describeAcpArgs(info: AcpInfo) {
  const items = stats(info)
  if (info.intent === "search" && info.path) items.push(`path=${info.path}`)
  if (info.intent === "list" && info.mode) items.push(`mode=${info.mode}`)
  if (info.intent === "fetch" && info.url) {
    try {
      items.push(`host=${new URL(info.url).host}`)
    } catch {}
  }
  if (info.intent === "move" && info.targetPath) items.push(`to=${info.targetPath}`)
  if (info.intent === "delete" && info.filePath) items.push(filename(info.filePath))
  if (info.intent === "lint" && info.filePath) items.push(filename(info.filePath))
  if (info.intent === "edit" && info.mode === "apply_patch" && info.files.length > 1) {
    items.push(count(info.files.length, "file"))
  }
  if (info.hasDiff) items.push("diff")
  return items
}

export function readAcpTool(input?: Row, metadata?: Row): AcpInfo | undefined {
  const acp = object(metadata?.acp)
  const raw = object(acp?.rawInput)
  let intent = text(input?.intent) ?? text(acp?.intent)
  const kind = text(input?.kind) ?? text(acp?.kind)
  if (!intent && !kind && !acp) return
  const rawName = text(acp?.rawToolName) ?? text(acp?.rawName)
  if (
    intent === "generic" &&
    (
      (raw && text(raw.server) && (text(raw.tool) || text(raw.name) || text(raw.uri))) ||
      rawName?.startsWith("mcp__") ||
      rawName === "mcp" ||
      rawName === "list_mcp_resources" ||
      rawName === "list_mcp_resource_templates" ||
      rawName === "read_mcp_resource"
    )
  ) intent = "mcp"
  if (intent === "generic" && rawName === "codesearch") intent = "search"
  if (intent === "generic" && rawName === "find") intent = "list"
  if (intent === "generic" && rawName === "websearch") intent = "search"
  if (intent === "generic" && rawName === "openpage") intent = "fetch"
  let mode = text(input?.mode) ?? text(acp?.mode)
  if (!mode && rawName === "codesearch") mode = "codebase"
  if (!mode && rawName === "websearch") mode = "web"
  if (!mode && rawName === "find") mode = "files"
  const files = list(input?.files ?? acp?.files).filter((item): item is string => typeof item === "string" && !!item)
  const item: AcpInfo = {
    client: text(acp?.client),
    kind,
    intent: intent ?? "generic",
    status: text(acp?.status),
    mode,
    title: text(acp?.title),
    summary: text(input?.summary) ?? text(acp?.summary) ?? text(acp?.title),
    rawName,
    command: text(input?.command) ?? text(acp?.command),
    filePath: text(input?.filePath) ?? text(acp?.filePath),
    path: text(input?.path) ?? text(acp?.path),
    pattern: text(input?.pattern) ?? text(acp?.pattern),
    query:
      text(input?.query) ??
      text(raw?.query) ??
      text(raw?.q) ??
      text(raw?.searchQuery) ??
      text(raw?.search_query) ??
      text(raw?.searchTerm) ??
      text(raw?.search_term) ??
      text(raw?.queryText) ??
      text(raw?.query_text) ??
      text(raw?.term) ??
      text(object(raw?.action)?.query) ??
      text(list(raw?.queries)[0]),
    url: url(input?.url) ?? url(acp?.url),
    sourcePath: text(input?.sourcePath) ?? text(acp?.sourcePath),
    targetPath: text(input?.targetPath) ?? text(acp?.targetPath),
    terminalId: text(acp?.terminalId) ?? text(metadata?.terminalId),
    hasDiff: bool(acp?.hasDiff) ?? bool(metadata?.hasDiff),
    body: text(acp?.body),
    stats: object(acp?.stats) ?? object(acp?.rawOutput),
    files,
    locations: locations(acp?.locations),
    content: acp?.content,
    rawInput: acp?.rawInput,
    rawOutput: acp?.rawOutput,
  }
  if (!item.mode && item.intent === "shell" && !item.command) {
    const raw = object(item.rawOutput)
    if (raw && (text(raw.stdout) || text(raw.stderr) || typeof raw.exitCode === "number")) item.mode = "result"
  }
  if (item.intent === "search" && !item.mode && item.rawName === "codesearch") item.mode = "codebase"
  if (item.intent === "search" && !item.mode && item.rawName === "websearch") item.mode = "web"
  if (item.intent === "list" && !item.mode && item.rawName === "find") item.mode = "files"
  if (item.intent === "fetch" && !item.url && item.query) {
    item.intent = "search"
    item.mode = item.mode ?? "web"
  }
  if (!item.filePath) item.filePath = item.locations[0]?.path
  if (!item.filePath) item.filePath = item.files[0]
  if (!item.path && (item.intent === "search" || item.intent === "list")) item.path = item.locations[0]?.path
  if (!item.path && item.intent === "list") item.path = item.files[0]
  return item
}

export function resolveAcpTool(tool: string, input?: Row, metadata?: Row) {
  const info = readAcpTool(input, metadata)
  if (!info) return
  if (info.intent === "shell") return "bash"
  if (info.intent === "read") return "read"
  if (info.intent === "lint") return "acp:lint"
  if (info.intent === "search" && info.mode === "web") return "websearch"
  if (info.intent === "search" && info.mode === "codebase") return "codesearch"
  if (info.intent === "search" && info.pattern && info.path) return "grep"
  if (info.intent === "list" && info.path) return info.mode === "glob" ? "glob" : "list"
  if (info.intent === "fetch") return "webfetch"
  if (info.intent === "task" || tool === "task") return "task"
  if (info.intent === "todos" || tool === "todowrite") return "todowrite"
  if (info.intent === "delete" && info.filePath) return "acp:delete"
  if (info.intent === "mcp") return "acp:mcp"
  if (info.intent === "image") return "acp:image"
  if (info.intent === "computer") return "acp:computer"
  if (info.intent === "edit") {
    if (info.mode === "apply_patch") return "acp:apply-patch"
    if (info.mode === "write") return "acp:write"
    if (info.filePath || info.hasDiff || readAcpDiffs(input, metadata).length > 0) return "edit"
    if (typeof input?.newString === "string") return "write"
  }
}

function title(i18n: ReturnType<typeof useI18n>, tool: string, info: AcpInfo) {
  if (info.intent === "shell") return i18n.t("ui.tool.shell")
  if (info.intent === "read") return i18n.t("ui.tool.read")
  if (info.intent === "lint") return info.summary ?? "Read Lints"
  if (info.intent === "search") {
    if (info.mode === "web") return info.summary ?? i18n.t("ui.tool.websearch")
    if (info.mode === "codebase") return info.summary ?? i18n.t("ui.tool.codesearch")
    if (info.pattern && info.path) return i18n.t("ui.tool.grep")
    return info.summary ?? i18n.t("ui.tool.grep")
  }
  if (info.intent === "list") {
    if (info.mode === "glob" && info.path) return i18n.t("ui.tool.glob")
    if (info.path) return i18n.t("ui.tool.list")
    return info.summary ?? i18n.t("ui.tool.list")
  }
  if (info.intent === "fetch") return i18n.t("ui.tool.webfetch")
  if (info.intent === "edit") {
    if (info.mode === "apply_patch") return "Apply Patch"
    if (info.mode === "write") return "Write"
    return "Edit"
  }
  if (info.intent === "move") return "Move"
  if (info.intent === "delete") return "Delete"
  if (info.intent === "reasoning") return "Thinking"
  if (info.intent === "task") return "Task"
  if (info.intent === "mcp") return "MCP Tool"
  if (info.intent === "image") return "Image"
  if (info.intent === "computer") return "Computer Use"
  if (info.intent === "question") return "Question"
  if (info.title) return info.title
  if (info.rawName) return info.rawName
  if (info.summary) return info.summary
  return i18n.t("ui.basicTool.called", { tool })
}

function output(info: AcpInfo, value?: unknown) {
  return readAcpBody(info, value)
}

// ---------------------------------------------------------------------------
// Dedicated ACP-native cards
// ---------------------------------------------------------------------------

/** Delete card: shows deleted filename, directory, and diff if available. */
export function AcpDeleteTool(props: AcpToolProps) {
  const info = createMemo(() => readAcpTool(props.input, props.metadata))
  const diffs = createMemo(() => readAcpDiffs(props.input, props.metadata))
  const trigger = createMemo(() => {
    const item = info()
    const file = item?.filePath
    return {
      title: "Delete",
      subtitle: file ? getFilename(file) : undefined,
      args: item ? describeAcpArgs(item) : [],
    }
  })
  const body = createMemo(() => {
    const item = info()
    if (!item) return typeof props.output === "string" ? props.output : ""
    return output(item, props.output)
  })

  return (
    <BasicTool
      {...props}
      icon="reset"
      trigger={trigger()}
    >
      <div data-component="tool-output" data-scrollable>
        <Show when={body()}>
          <pre data-slot="bash-pre">
            <code>{body()}</code>
          </pre>
        </Show>
        <Show when={!body() && diffs().length > 0}>
          <For each={diffs()}>
            {(item) => (
              <pre data-slot="bash-pre">
                <code>{item.filePath}</code>
              </pre>
            )}
          </For>
        </Show>
      </div>
    </BasicTool>
  )
}

/** MCP card: shows server name, tool/resource identity, and returned content. */
export function AcpMcpTool(props: AcpToolProps) {
  const i18n = useI18n()
  const info = createMemo(() => readAcpTool(props.input, props.metadata))
  const body = createMemo(() => {
    const item = info()
    if (!item) return typeof props.output === "string" ? props.output : ""
    return output(item, props.output)
  })
  const done = createMemo(() => props.status !== "pending" && props.status !== "running")
  const trigger = createMemo(() => {
    const item = info()
    const sub = item ? describeAcpSubtitle(item) : ""
    const args = item ? describeAcpArgs(item) : []
    if (!body() && args.length === 0 && done()) args.push("no output")
    return {
      title: "MCP Tool",
      subtitle: sub,
      args,
    }
  })

  return (
    <BasicTool
      {...props}
      icon="mcp"
      trigger={trigger()}
      hideDetails={!body()}
    >
      <Show when={body()}>
        <div data-component="tool-output" data-scrollable>
          <pre data-slot="bash-pre">
            <code>{body()}</code>
          </pre>
        </div>
      </Show>
    </BasicTool>
  )
}

export function AcpLintTool(props: AcpToolProps) {
  const info = createMemo(() => readAcpTool(props.input, props.metadata))
  const trigger = createMemo(() => {
    const item = info()
    return {
      title: item?.summary ?? "Read Lints",
      subtitle: item ? describeAcpSubtitle(item) : undefined,
      args: item ? describeAcpArgs(item) : [],
    }
  })
  const body = createMemo(() => {
    const item = info()
    if (!item) return typeof props.output === "string" ? props.output : ""
    return output(item, props.output)
  })

  return (
    <BasicTool
      {...props}
      icon="glasses"
      trigger={trigger()}
    >
      <Show when={body()}>
        <div data-component="tool-output" data-scrollable>
          <pre data-slot="bash-pre">
            <code>{body()}</code>
          </pre>
        </div>
      </Show>
    </BasicTool>
  )
}

/** Image card: shows prompt summary and generated images. */
export function AcpImageTool(props: AcpToolProps) {
  const info = createMemo(() => readAcpTool(props.input, props.metadata))
  const trigger = createMemo(() => {
    const item = info()
    return {
      title: "Image",
      subtitle: item?.summary ?? undefined,
      args: item ? describeAcpArgs(item) : [],
    }
  })
  const body = createMemo(() => {
    const item = info()
    if (!item) return typeof props.output === "string" ? props.output : ""
    return output(item, props.output)
  })

  return (
    <BasicTool
      {...props}
      icon="code"
      trigger={trigger()}
    >
      <Show when={body()}>
        <div data-component="tool-output" data-scrollable>
          <pre data-slot="bash-pre">
            <code>{body()}</code>
          </pre>
        </div>
      </Show>
    </BasicTool>
  )
}

/** Computer use card: shows action summary and screenshots. */
export function AcpComputerTool(props: AcpToolProps) {
  const info = createMemo(() => readAcpTool(props.input, props.metadata))
  const trigger = createMemo(() => {
    const item = info()
    return {
      title: "Computer Use",
      subtitle: item?.summary ?? undefined,
      args: item ? describeAcpArgs(item) : [],
    }
  })
  const body = createMemo(() => {
    const item = info()
    if (!item) return typeof props.output === "string" ? props.output : ""
    return output(item, props.output)
  })

  return (
    <BasicTool
      {...props}
      icon="window-cursor"
      trigger={trigger()}
    >
      <Show when={body()}>
        <div data-component="tool-output" data-scrollable>
          <pre data-slot="bash-pre">
            <code>{body()}</code>
          </pre>
        </div>
      </Show>
    </BasicTool>
  )
}

// ---------------------------------------------------------------------------
// Generic ACP fallback
// ---------------------------------------------------------------------------

export function AcpFallbackTool(props: AcpToolProps) {
  const i18n = useI18n()
  const info = createMemo(() => readAcpTool(props.input, props.metadata))
  const icon = createMemo(() => {
    const intent = info()?.intent
    if (intent === "shell") return "console"
    if (intent === "read") return "glasses"
    if (intent === "lint") return "glasses"
    if (intent === "search" || intent === "fetch") return "window-cursor"
    if (intent === "delete") return "reset"
    return "mcp"
  })
  const trigger = createMemo(() => {
    const item = info() ?? { intent: "generic", locations: [], files: [] }
    const main = title(i18n, props.tool, item)
    const sub = describeAcpSubtitle(item)
    return {
      title: main,
      subtitle: sub && sub !== main ? sub : undefined,
      args: describeAcpArgs(item),
    }
  })
  const body = createMemo(() => {
    const item = info()
    if (!item) return typeof props.output === "string" ? props.output : ""
    return output(item, props.output)
  })
  const files = createMemo(() => {
    const item = info()
    if (!item) return []
    const out = [...item.files]
    for (const row of item.locations) {
      if (!out.includes(row.path)) out.push(row.path)
    }
    return out
  })

  return (
    <BasicTool
      {...props}
      icon={icon()}
      trigger={trigger()}
      hideDetails={!body() && files().length === 0}
    >
      <Show when={body() || files().length}>
        <div data-component="tool-output" data-scrollable>
          <Show when={body()}>
            <pre data-slot="bash-pre">
              <code>{body()}</code>
            </pre>
          </Show>
          <Show when={files().length}>
            <div data-component="tool-loaded-file">
              <For each={files()}>
                {(item) => (
                  <div>{item}</div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </BasicTool>
  )
}
