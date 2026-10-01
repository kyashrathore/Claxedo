import { asRecord } from "@claxedo/helpers/guards"
import { type ToolIntent, asText as str } from "@claxedo/agent-runtime-contract"
import type { ToolCallContent, ToolKind } from "./types"
import type { ToolState } from "./state"

type AcpIntent = ToolIntent

function parsed(raw: unknown) {
  const item = asRecord(raw)
  const value = item?.parsed_cmd ?? item?.parsedCmd
  if (!Array.isArray(value)) return []
  return value.map(asRecord).filter((item): item is Record<string, unknown> => !!item)
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

function firstPath(list: Array<{ path: string; line?: number | null }>) {
  return str(list[0]?.path)
}

function diffPath(content: ToolCallContent[]): string | undefined {
  for (const item of content) {
    if (item.type === "diff" && item.path) return item.path
  }
  return undefined
}

function files(state: ToolState): string[] {
  const rawPaths = ["filePath", "path", "sourcePath", "fromPath", "oldPath", "targetPath", "toPath", "newPath"].flatMap(
    (key) => str(state.rawInput?.[key]) ?? [],
  )
  return [
    ...new Set(
      [
        ...rawPaths,
        ...state.locations.map((item) => item.path),
        ...state.content.flatMap((item) => (item.type === "diff" && item.path ? [item.path] : [])),
      ].filter(Boolean),
    ),
  ]
}

function textBody(raw: unknown) {
  const item = asRecord(raw)
  return str(item?.content) ?? str(item?.text) ?? str(item?.body)
}

function url(value: unknown): string | undefined {
  const item = str(value)
  if (!item) return undefined
  try {
    const next = new URL(item)
    if (!next.protocol.startsWith("http")) return undefined
    return item
  } catch {
    return undefined
  }
}

function shell(raw: unknown): string | undefined {
  for (const item of parsed(raw)) {
    const cmd = str(item.cmd)
    if (cmd) return cmd
  }

  const row = asRecord(raw)
  const direct = str(row?.command)
  if (direct) return direct
  const cmd = row?.command
  if (!Array.isArray(cmd)) return undefined
  const list = cmd.filter((item): item is string => typeof item === "string")
  if (list.length === 0) return undefined
  if (list.length >= 3 && list[1] === "-lc") return str(list[2])
  return list.join(" ")
}

function parseTitle(toolLabel: string, kind: ToolKind | undefined): { short: string; input?: Record<string, unknown> } {
  const idx = toolLabel.indexOf(" ")
  const head = (idx < 0 ? toolLabel : toolLabel.slice(0, idx)).toLowerCase().replace(/:+$/, "")
  const short = head === "terminal" ? "bash" : head
  if (idx < 0) return { short }
  const tail = toolLabel.slice(idx + 1).trim()
  if (!tail) return { short }

  if (kind === "execute") return { short, input: { command: tail, description: tail } }
  if ((kind === "read" || kind === "edit") && pathlike(tail)) return { short, input: { filePath: tail } }
  if (kind === "search" && pathlike(tail)) return { short, input: { pattern: tail } }
  if (kind === "fetch") return { short, input: { url: tail } }
  if (pathlike(tail)) return { short, input: { path: tail } }
  return { short }
}

function mode(toolLabel?: string): "web" | "codebase" | "files" | undefined {
  const item = toolLabel?.trim().toLowerCase()
  if (item === "web search") return "web"
  if (item === "codebase search") return "codebase"
  if (item === "find") return "files"
  return undefined
}

function first(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  return value.find((item): item is string => typeof item === "string" && !!item)
}

function intent(kind: ToolKind | undefined, toolLabel?: string): AcpIntent {
  if (kind === "execute") return "shell"
  if (kind === "read") return "read"
  if (kind === "edit") return "edit"
  if (kind === "fetch") return "fetch"
  if (kind === "move") return "move"
  if (kind === "delete") return "delete"
  if (kind === "think") return "reasoning"
  if (kind === "switch_mode") return "switch_mode"
  if (kind === "search") {
    if (mode(toolLabel) === "files") return "list"
    return "search"
  }
  return "generic"
}

function resolvedIntent(
  state: ToolState,
  kind: ToolKind | undefined,
  toolLabel: string,
  list: Record<string, unknown> | undefined,
  search: Record<string, unknown> | undefined,
): ToolIntent {
  const next = intent(kind, toolLabel)
  const raw = state.rawInput
  const call = state.name?.toLowerCase()
  if (
    next === "generic" &&
    ((str(raw?.server) && (str(raw?.tool) || str(raw?.name) || str(raw?.uri))) ||
      call?.startsWith("mcp__") ||
      ["mcp", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(call ?? ""))
  )
    return "mcp"
  return next === "search" && list && !search ? "list" : next
}

function shellResult(output: unknown): boolean {
  const stats = asRecord(output)
  return !!textBody(output) || !!str(stats?.stdout) || !!str(stats?.stderr) || typeof stats?.exitCode === "number"
}

function toolPaths(
  state: ToolState,
  base: ReturnType<typeof parseTitle>,
  all: string[],
  search: Record<string, unknown> | undefined,
  list: Record<string, unknown> | undefined,
) {
  const raw = state.rawInput
  const file = all[0]
  return {
    sourcePath: str(raw?.sourcePath) ?? str(raw?.fromPath) ?? str(raw?.oldPath) ?? file,
    targetPath: str(raw?.targetPath) ?? str(raw?.toPath) ?? str(raw?.newPath) ?? str(raw?.destinationPath),
    pattern: str(raw?.pattern) ?? str(search?.query) ?? str(list?.pattern) ?? str(base.input?.pattern),
    path: str(raw?.path) ?? str(search?.path) ?? str(list?.path) ?? firstPath(state.locations),
    filePath: str(raw?.filePath) ?? str(search?.path) ?? file ?? diffPath(state.content) ?? str(base.input?.filePath),
  }
}

export function toolFacts(state: ToolState) {
  const toolLabel = state.title ?? state.firstTitle ?? "Tool"
  const kind = state.kind ?? state.firstKind
  const base = parseTitle(toolLabel, kind)
  const raw = state.rawInput
  const items = parsed(raw)
  const all = files(state)
  const query =
    str(raw?.query) ?? str(raw?.q) ?? str(raw?.pattern) ?? str(asRecord(raw?.action)?.query) ?? first(raw?.queries)
  const search = items.find((item) => item.type === "search")
  const list = items.find((item) => item.type === "list_files" || item.type === "glob")
  let nextIntent = resolvedIntent(state, kind, toolLabel, list, search)
  const nextMode =
    mode(toolLabel) ?? (nextIntent === "list" && list ? (str(list.pattern) ? "glob" : "files") : undefined)
  const cmd = shell(raw) ?? str(base.input?.command)
  const urlValue = url(raw?.url) ?? url(base.input?.url) ?? url(raw?.uri)
  const shellMode = nextIntent === "shell" && !cmd && shellResult(state.rawOutput) ? "result" : undefined
  if (nextIntent === "fetch" && query && !urlValue) nextIntent = "search"

  return {
    toolLabel,
    kind,
    base,
    raw,
    all,
    nextIntent,
    nextMode,
    cmd,
    urlValue,
    query,
    shellMode,
    list,
    ...toolPaths(state, base, all, search, list),
    ...toolDiffs(state.content),
  }
}

const lineCount = (value: string): number => (value ? value.split("\n").length : 0)

function toolDiffs(content: ToolCallContent[]) {
  const diffs = content.flatMap((item) => {
    if (item.type !== "diff" || !item.path || typeof item.newText !== "string") return []
    const before = typeof item.oldText === "string" ? item.oldText : ""
    return [
      {
        file: item.path,
        before,
        after: item.newText,
        additions: lineCount(item.newText),
        deletions: lineCount(before),
      },
    ]
  })
  return {
    hasDiff: content.some((item) => item.type === "diff"),
    diffValue: diffs.length === 1 ? diffs[0] : undefined,
    patchValue: diffs.map((item) => ({
      filePath: item.file,
      relativePath: item.file,
      type: !item.before && item.after ? "add" : item.before && !item.after ? "delete" : "update",
      diff: "",
      before: item.before,
      after: item.after,
      additions: item.additions,
      deletions: item.deletions,
    })),
  }
}
