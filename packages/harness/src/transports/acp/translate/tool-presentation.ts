import { asText as str, type ToolDisplay, type ToolIntent } from "@claxedo/agent-runtime-contract"
import type { ToolState, Spot } from "./state"
import { toolFacts } from "./tool-facts"

export function toolLocation(item: Spot) {
  return { path: item.path, ...(item.line != null ? { line: item.line } : {}) }
}

function toolName(facts: ReturnType<typeof toolFacts>) {
  const { titleInput, intent, mode, shellMode, url, query, pattern, path, list } = facts
  let short = titleInput.short
  const modeValue =
    mode ??
    shellMode ??
    ((intent === "fetch" || intent === "search") && url ? "web" : undefined) ??
    (intent === "search" && query ? "web" : undefined)
  if (intent === "shell") short = "bash"
  if (intent === "search" && mode === "web" && query) short = "websearch"
  if (intent === "search" && mode === "codebase" && query) short = "codesearch"
  if (intent === "search" && pattern && path) short = "grep"
  if (intent === "list" && list) short = str(list.pattern) ? "glob" : "list"
  if (intent === "read") short = "read"
  if (intent === "edit") short = "edit"
  if (intent === "fetch" && modeValue === "web") short = "webfetch"

  return { short, modeValue }
}

function toolDetails(facts: ReturnType<typeof toolFacts>, modeValue: string | undefined) {
  const fields: ToolDisplay = {
    mode: modeValue,
    command: facts.cmd,
    query: facts.query,
    pattern: facts.pattern,
    url: facts.url,
    path: facts.path,
    filePath: facts.filePath,
    targetPath: facts.targetPath,
    files: facts.files.length ? facts.files : undefined,
  }
  return {
    kind: facts.kind ?? "other",
    intent: facts.intent,
    summary: facts.toolLabel,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value)),
  }
}

export function viewTool(state: ToolState) {
  const facts = toolFacts(state)
  const { short, modeValue } = toolName(facts)
  const { rawInput, sourcePath, diffValue, intent } = facts
  const details = toolDetails(facts, modeValue)
  const presentation = {
    ...details,
    ...(sourcePath ? { sourcePath } : {}),
    ...(state.locations.length ? { locations: state.locations.map(toolLocation) } : {}),
  }
  const input = {
    ...rawInput,
    ...details,
    ...(sourcePath && intent === "move" ? { sourcePath, filePath: sourcePath } : {}),
    ...(diffValue && intent === "edit" ? { oldString: diffValue.before, newString: diffValue.after } : {}),
  }
  const display = {
    ...presentation,
    ...(rawInput !== undefined ? { input: rawInput } : {}),
  } satisfies ToolDisplay
  const metadata = toolMetadata(state, facts, presentation)
  return { toolName: short || state.id, input, display, metadata }
}

function toolMetadata(
  state: ToolState,
  facts: ReturnType<typeof toolFacts>,
  presentation: ToolDisplay & { intent: ToolIntent },
) {
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
