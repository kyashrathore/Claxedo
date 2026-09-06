import { asRecord, asText, isRecord } from "@claxedo/agent-runtime-contract"

/** Harness payload readers. The structural guards live in the contract package. */
export { isRecord }
export const object = asRecord
export const text = asText

/** JSON text for diagnostics and error surfaces. Never throws on cycles or BigInt. */
export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable]"
  }
}

export function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function optionLabels(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => text(item) ?? text(object(item)?.label) ?? [])
}

export function pathFields(
  row: Record<string, unknown>,
  keys: string[],
  listKeys: string[] = [],
) {
  const paths = listKeys.flatMap((key) => {
    const value = row[key]
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === "string" && !!item)
  })
  for (const key of keys) {
    const value = text(row[key])
    if (value) paths.push(value)
  }
  return [...new Set(paths)]
}
