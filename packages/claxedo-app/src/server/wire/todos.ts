import { isRecord } from "@claxedo/helpers/guards"
import type { Todo } from "../types"

export function todosFromWire(value: unknown): Todo[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is Todo => isRecord(item) && typeof item.content === "string" && typeof item.status === "string")
}
