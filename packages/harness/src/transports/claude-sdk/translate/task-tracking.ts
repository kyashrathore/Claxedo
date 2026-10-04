import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"

export type ClaudeTrackedTask = { id: string; description: string; status: string }

function task(value: unknown): ClaudeTrackedTask | undefined {
  const row = asRecord(value)
  const id = text(row?.id)
  const description = text(row?.subject)
  const status = text(row?.status)
  return id && description && status ? { id, description, status } : undefined
}

export function applyClaudeTaskResult(
  current: Record<string, ClaudeTrackedTask>,
  name: string,
  input: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): Record<string, ClaudeTrackedTask> | undefined {
  if (!result) return undefined
  const row = task(name === "TaskCreate" ? { ...asRecord(result.task), status: "pending" } : result.task)
  if ((name === "TaskCreate" || name === "TaskGet") && row) return { ...current, [row.id]: row }
  if (name === "TaskList" && Array.isArray(result.tasks)) {
    const rows = result.tasks.map(task)
    if (rows.some((row) => !row)) return undefined
    return Object.fromEntries(rows.map((row) => [row!.id, row!]))
  }
  if (name !== "TaskUpdate" || result.success !== true) return undefined
  const id = text(result.taskId)
  if (!id) return undefined
  const status = text(asRecord(result.statusChange)?.to)
  if (status === "deleted") {
    const next = { ...current }
    delete next[id]
    return next
  }
  const previous = current[id]
  if (!previous) return undefined
  const fields = Array.isArray(result.updatedFields) ? result.updatedFields : []
  const description = fields.includes("subject") ? text(input.subject) : undefined
  if (!status && !description) return undefined
  return { ...current, [id]: { ...previous, ...(status ? { status } : {}), ...(description ? { description } : {}) } }
}
