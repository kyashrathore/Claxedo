import type { ToolDisplay, ToolIntent } from "@claxedo/agent-runtime-contract"
import { asText as str } from "@claxedo/agent-runtime-contract"
import type { ToolState, Spot } from "./state"
import { toolFacts } from "./tool-facts"

export type AcpToolMetadata = Record<string, unknown> & {
  acp: Record<string, unknown> & { intent: ToolIntent }
}

export type ToolView = {
  toolName: string
  input?: Record<string, unknown>
  display: ToolDisplay
  metadata: AcpToolMetadata
}

function toolLocations(locations: Spot[]) {
  return locations.map((item) => ({ path: item.path, ...(item.line != null ? { line: item.line } : {}) }))
}

export function viewTool(state: ToolState) {
  const facts = toolFacts(state)
  const { short, modeValue } = toolName(facts)
  return toolView(state, facts, short, modeValue)
}

function toolName(facts: ReturnType<typeof toolFacts>) {
  const { base, nextIntent, nextMode, shellMode, urlValue, query, pattern, path, list } = facts
  let short = base.short
  const modeValue =
    nextMode ??
    shellMode ??
    ((nextIntent === "fetch" || nextIntent === "search") && urlValue ? "web" : undefined) ??
    (nextIntent === "search" && query ? "web" : undefined)
  if (nextIntent === "shell") short = "bash"
  if (nextIntent === "search" && nextMode === "web" && query) short = "websearch"
  if (nextIntent === "search" && nextMode === "codebase" && query) short = "codesearch"
  if (nextIntent === "search" && pattern && path) short = "grep"
  if (nextIntent === "list" && list) short = str(list.pattern) ? "glob" : "list"
  if (nextIntent === "read") short = "read"
  if (nextIntent === "lint") short = "lint"
  if (nextIntent === "edit") short = "edit"
  if (nextIntent === "fetch" && modeValue === "web") short = "webfetch"

  return { short, modeValue }
}

function toolDetails(facts: ReturnType<typeof toolFacts>, modeValue: string | undefined) {
  const {
    toolLabel,
    kind,
    all,
    nextIntent,
    cmd,
    urlValue,
    targetPath,
    pattern,
    path,
    filePath,
    query,
  } = facts
  return {
    kind: kind ?? "other",
    intent: nextIntent,
    summary: toolLabel,
    ...(modeValue ? { mode: modeValue } : {}),
    ...(cmd ? { command: cmd } : {}),
    ...(query ? { query } : {}),
    ...(pattern ? { pattern } : {}),
    ...(urlValue ? { url: urlValue } : {}),
    ...(path ? { path } : {}),
    ...(filePath ? { filePath } : {}),
    ...(targetPath ? { targetPath } : {}),
    ...(all.length ? { files: all } : {}),
  }
}

function toolView(
  state: ToolState,
  facts: ReturnType<typeof toolFacts>,
  short: string,
  modeValue: string | undefined,
): ToolView {
  const { raw, cmd, sourcePath, diffValue, nextIntent } = facts
  const details = toolDetails(facts, modeValue)
  const presentation = {
    ...details,
    ...(sourcePath ? { sourcePath } : {}),
    ...(state.locations.length ? { locations: toolLocations(state.locations) } : {}),
  }
  const input = {
    ...raw,
    ...details,
    ...(cmd ? { description: cmd } : {}),
    ...(sourcePath && nextIntent === "move" ? { sourcePath, filePath: sourcePath } : {}),
    ...(diffValue && nextIntent === "edit" ? { oldString: diffValue.before, newString: diffValue.after } : {}),
  }
  const display = {
    ...presentation,
    ...(cmd ? { description: cmd } : {}),
    ...(raw !== undefined ? { input: raw } : {}),
  } satisfies ToolDisplay
  const metadata = toolMetadata(state, facts, presentation)
  return { toolName: short || state.id, input, display, metadata }
}

function toolMetadata(
  state: ToolState,
  facts: ReturnType<typeof toolFacts>,
  presentation: ToolDisplay & { intent: ToolIntent },
): AcpToolMetadata {
  const { toolLabel, diffValue, patchValue, hasDiff } = facts
  return {
    ...(diffValue ? { filediff: diffValue } : {}),
    ...(patchValue.length > 0 ? { files: patchValue } : {}),
    acp: {
      ...presentation,
      client: state.client,
      status: state.status,
      title: toolLabel,
      ...(state.terminalId ? { terminalId: state.terminalId } : {}),
      ...(hasDiff ? { hasDiff } : {}),
      ...(diffValue ? { filediff: diffValue } : {}),
      ...(patchValue.length > 0 ? { patch: patchValue } : {}),
      ...(state.name ? { rawToolName: state.name } : {}),
      toolCallId: state.id,
    },
  }
}
