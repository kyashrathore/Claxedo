import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { codexSubagentActivity } from "./subagent-items"

type Input = Record<string, unknown> | undefined

const GENERIC_KEYS = ["command", "cwd", "path", "filePath", "query", "prompt", "toolName", "name", "processId", "processHandle", "stream"]

function present(input: Record<string, unknown>): Input {
  return Object.keys(input).length ? input : undefined
}

export function structuredInput(row: Record<string, unknown>): Input {
  const direct = asRecord(row.input)
  if (direct) return direct
  return present(Object.fromEntries(GENERIC_KEYS.flatMap((key) => row[key] === undefined ? [] : [[key, row[key]]])))
}

export function patchedFiles(row: Record<string, unknown>) {
  return (Array.isArray(row.changes) ? row.changes : []).flatMap((value) => {
    const change = asRecord(value)
    const filePath = text(change?.path)
    if (!filePath) return []
    const kind = asRecord(change?.kind)
    const movePath = text(kind?.move_path)
    return [{ filePath, type: movePath ? "move" : text(kind?.type) ?? "update", diff: text(change?.diff) ?? "", ...(movePath ? { movePath } : {}) }]
  })
}

function hookPromptInput(row: Record<string, unknown>): Input {
  const fragments = (Array.isArray(row.fragments) ? row.fragments : []).flatMap((value) => {
    const fragment = asRecord(value)
    return fragment ? [fragment] : []
  })
  const prompt = fragments.flatMap((fragment) => text(fragment.text) ?? []).join("\n\n")
  const hookRunIds = [...new Set(fragments.flatMap((fragment) => text(fragment.hookRunId) ?? []))]
  return prompt ? { prompt, hookRunIds } : undefined
}

function webSearchInput(row: Record<string, unknown>): Input {
  const action = asRecord(row.action)
  const queries = Array.isArray(action?.queries) ? action.queries.flatMap((value) => text(value) ?? []) : []
  const query = text(row.query) ?? text(action?.query) ?? (queries.length ? queries.join(" | ") : undefined)
  const url = text(action?.url)
  const pattern = text(action?.pattern)
  return present({ ...(query ? { query } : {}), ...(url ? { url } : {}), ...(pattern ? { pattern } : {}) })
}

function dynamicInput(row: Record<string, unknown>): Input {
  if (row.arguments === undefined || row.arguments === null) return structuredInput(row)
  return asRecord(row.arguments) ?? { arguments: row.arguments }
}

function mcpInput(row: Record<string, unknown>): Input {
  return Object.fromEntries(["server", "tool", "arguments", "pluginId"].flatMap((key) => row[key] === undefined ? [] : [[key, row[key]]]))
}

const ITEM_INPUTS: Readonly<Record<string, (row: Record<string, unknown>) => Input>> = {
  mcpToolCall: mcpInput,
  dynamicToolCall: dynamicInput,
  hookPrompt: hookPromptInput,
  webSearch: webSearchInput,
  fileChange: (row) => {
    const files = patchedFiles(row).map((change) => change.filePath)
    return files.length ? { files } : undefined
  },
  subAgentActivity: (row) => {
    const activity = codexSubagentActivity(row)
    return activity ? { agentThreadId: activity.agentThreadId, ...(activity.agentPath ? { agentPath: activity.agentPath } : {}) } : undefined
  },
  sleep: (row) => row.durationMs === undefined ? undefined : { durationMs: row.durationMs },
  imageGeneration: (row) => text(row.revisedPrompt) ? { prompt: text(row.revisedPrompt) } : undefined,
  enteredReviewMode: (row) => text(row.review) ? { review: text(row.review) } : undefined,
  exitedReviewMode: (row) => text(row.review) ? { review: text(row.review) } : undefined,
}

export function itemInput(row: Record<string, unknown>): Input {
  const type = text(row.type)
  return type && Object.hasOwn(ITEM_INPUTS, type) ? ITEM_INPUTS[type]!(row) : structuredInput(row)
}

export function itemMetadata(itemType: string, row: Record<string, unknown>): Record<string, unknown> {
  if (itemType !== "file_change") return { codex: { itemType } }
  return { codex: { itemType }, files: patchedFiles(row) }
}
