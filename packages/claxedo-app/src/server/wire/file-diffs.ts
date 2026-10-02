import { isRecord } from "@claxedo/helpers/guards"
import type { FileDiff } from "../types"

export function fileDiffsFromWire(value: unknown): FileDiff[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is FileDiff => isRecord(item) && typeof item.additions === "number" && typeof item.deletions === "number")
}
