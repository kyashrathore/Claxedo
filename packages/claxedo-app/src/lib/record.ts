import { isRecord } from "@claxedo/helpers/guards"

export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

export function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === "string" ? field : undefined
}

export function readNullableString(value: unknown, key: string): string | null | undefined {
  const field = readField(value, key)
  if (field === null) return null
  return typeof field === "string" ? field : undefined
}

export function readFiniteNumber(value: unknown, key: string): number | undefined {
  const field = readField(value, key)
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  const field = readField(value, key)
  return typeof field === "boolean" ? field : undefined
}

export function readArray(value: unknown, key: string): unknown[] | undefined {
  const field = readField(value, key)
  return Array.isArray(field) ? field : undefined
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

export function onlyStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function readStringArray(value: unknown, key: string): string[] | undefined {
  const field = readArray(value, key)
  return field === undefined ? undefined : onlyStrings(field)
}
