import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { ToolDisplay } from "@claxedo/agent-runtime-contract"

export function normalizeInputKeys(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = value
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    if (camel !== key) result[camel] = value
  }
  return result
}

function scalar(value: unknown) {
  if (value == null) return undefined
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  return undefined
}

export function mergeInput(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
) {
  if (!left) return right ?? {}
  if (!right) return left
  return { ...left, ...right }
}

export function mergeMetadata(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
) {
  if (!left) return right ?? {}
  if (!right) return left
  const item = { ...left, ...right }
  const lhs = asRecord(left.acp)
  const rhs = asRecord(right.acp)
  if (lhs || rhs) item.acp = { ...lhs, ...rhs }
  return item
}

export function mergeDisplay(
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
  const acp = asRecord(metadata.acp)
  if (!acp) return {}
  const rawInput = asRecord(acp.rawInput)
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

export function normalizeLocationInput(
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
    const row = asRecord(item)
    const path = text(row?.path)
    if (!path) return []
    return [{ path, ...(typeof row?.line === "number" ? { line: row.line } : {}) }]
  })
}

function locationsFromMetadata(metadata: Record<string, unknown>) {
  return locationsFromList(asRecord(metadata.acp)?.locations)
}

export function hydrateToolInput(
  tool: string,
  current: Record<string, unknown> | undefined,
  metadata: Record<string, unknown>,
  display?: ToolDisplay,
) {
  const input = mergeInput(mergeInput(acpMetadataInput(metadata), displayInput(display)), current)
  return normalizeLocationInput(tool, input, [...locationsFromList(display?.locations), ...locationsFromMetadata(metadata)])
}
