import { isRecord } from "@claxedo/helpers/guards"
import type { Json } from "./types"

export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  return isRecord(value) && Object.values(value).every(isJson)
}
