/**
 * Build a record that covers every key a manifest enumerates.
 *
 * Assembling a total `Record<Key, Value>` by iteration is not expressible in
 * TypeScript: the object is partial on every line until the loop ends, and
 * there is no way to observe that the loop covered the key union. Neither
 * escape hatch helps — `Object.fromEntries` returns `{ [k: string]: Value }`,
 * which is NOT assignable to a record of named keys, and starting from `{} as
 * Record<Key, Value>` makes the same claim with worse locality.
 *
 * So the claim lives here, once, in a module whose entire job is to make it.
 * Totality is real but is guaranteed by the CALLER's manifest: pass a list that
 * enumerates the key union (`LOCALE_ENTRIES`, the metric registry) and the
 * result is total; pass a filtered list and it is not. Callers say which
 * manifest they trust in a comment at the call site.
 */
export function totalRecord<Key extends PropertyKey, Value, Source>(
  sources: readonly Source[],
  key: (source: Source) => Key,
  value: (source: Source) => Value,
): Record<Key, Value> {
  const table: Partial<Record<Key, Value>> = {}
  for (const source of sources) table[key(source)] = value(source)
  return table as Record<Key, Value>
}
