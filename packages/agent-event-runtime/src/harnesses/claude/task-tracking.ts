import { asRecord } from "@claxedo/helpers/guards"
import { text } from "../../value"

export type ClaudeTrackedTask = { id: string; description: string; status: string }

function task(value: unknown): ClaudeTrackedTask | undefined {
  const row = asRecord(value)
  const id = text(row?.id)
  const description = text(row?.subject)
  const status = text(row?.status)
  return id && description && status ? { id, description, status } : undefined
}

/** Apply successful native results, never proposed tool input or model prose. */
export function applyClaudeTaskResult(
  current: Record<string, ClaudeTrackedTask>,
  name: string,
  input: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): Record<string, ClaudeTrackedTask> | undefined {
  if (!result) return undefined
  if (name === "TaskCreate") {
    const created = asRecord(result.task)
    const id = text(created?.id)
    const description = text(created?.subject)
    // Native TaskCreate always creates a pending task; its output assigns the ID.
    if (id && description) return { ...current, [id]: { id, description, status: "pending" } }
  }
  if (name === "TaskList" && Array.isArray(result.tasks)) {
    const rows = result.tasks.map(task)
    if (rows.some((row) => !row)) return undefined
    return Object.fromEntries(rows.map((row) => [row!.id, row!]))
  }
  if (name === "TaskGet") {
    const row = task(result.task)
    if (row) return { ...current, [row.id]: row }
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
