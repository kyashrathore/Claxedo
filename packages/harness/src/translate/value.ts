import { asRecord, asText, isRecord } from "@claxedo/agent-runtime-contract"

export { isRecord }
export const object = asRecord
export const text = asText

export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable]"
  }
}

export function optionLabels(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => text(item) ?? text(asRecord(item)?.label) ?? [])
}

export function boundKeyedMap<V>(map: Map<string, V>, max: number) {
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}

export const RETAINED_WIRE_KEYS_MAX = 256

export function own<V>(record: Record<string, V>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

export function boundKeyedRecord<V>(record: Record<string, V>, max: number): Record<string, V> {
  const entries = Object.entries(record)
  if (entries.length <= max) return record
  const bounded: Record<string, V> = {}
  for (const [key, value] of entries.slice(entries.length - max)) bounded[key] = value
  return bounded
}

export function boundList<T>(list: T[], max: number): T[] {
  const excess = list.length - max
  if (excess > 0) list.splice(0, excess)
  return list
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
