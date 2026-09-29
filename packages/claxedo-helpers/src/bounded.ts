/** Evicts the oldest entries until `map` holds at most `max`. */
export function boundKeyedMap<V>(map: Map<string, V>, max: number) {
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}

/** The record with its oldest entries dropped until at most `max` remain. */
export function boundKeyedRecord<V>(record: Record<string, V>, max: number): Record<string, V> {
  const entries = Object.entries(record)
  if (entries.length <= max) return record
  const bounded: Record<string, V> = {}
  for (const [key, value] of entries.slice(entries.length - max)) bounded[key] = value
  return bounded
}

/** Evicts the oldest entries until `list` holds at most `max`. */
export function boundList<T>(list: T[], max: number): T[] {
  const excess = list.length - max
  if (excess > 0) list.splice(0, excess)
  return list
}
