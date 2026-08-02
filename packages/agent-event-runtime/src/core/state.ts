export const RUNTIME_SNAPSHOT_VERSION = 1
export const PROJECTION_SNAPSHOT_VERSION = 1

export type RuntimeSnapshot<State = unknown> = {
  version: typeof RUNTIME_SNAPSHOT_VERSION
  harness: string
  threadId: string
  adapterState: State
}

export type ProjectionSnapshot<State = unknown> = {
  version: typeof PROJECTION_SNAPSHOT_VERSION
  projection: string
  state: State
}

export function assertRuntimeSnapshot<State>(snapshot: RuntimeSnapshot<State>): RuntimeSnapshot<State> {
  if (snapshot.version !== RUNTIME_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported RuntimeSnapshot version: ${String(snapshot.version)}`)
  }
  if (!snapshot.harness) throw new Error("RuntimeSnapshot.harness is required")
  if (!snapshot.threadId) throw new Error("RuntimeSnapshot.threadId is required")
  return cloneSnapshotValue(snapshot)
}

export function runtimeSnapshot<State>(input: Omit<RuntimeSnapshot<State>, "version">): RuntimeSnapshot<State> {
  if (!input.harness) throw new Error("RuntimeSnapshot.harness is required")
  if (!input.threadId) throw new Error("RuntimeSnapshot.threadId is required")
  return {
    version: RUNTIME_SNAPSHOT_VERSION,
    harness: input.harness,
    threadId: input.threadId,
    adapterState: cloneSnapshotValue(input.adapterState),
  }
}

export function projectionSnapshot<State>(projection: string, state: State): ProjectionSnapshot<State> {
  return { version: PROJECTION_SNAPSHOT_VERSION, projection, state: cloneSnapshotValue(state) }
}

/**
 * Snapshot state may contain structured-clone-safe values such as Date, Map,
 * BigInt, arrays, and circular references. If structuredClone is unavailable
 * for a value, the fallback intentionally constrains that value to JSON-safe
 * data: functions/symbols are dropped, BigInts become strings, and circular
 * references are marked instead of throwing.
 */
export function cloneSnapshotValue<T>(value: T): T {
  if (value === undefined || value === null) return value
  try {
    return structuredClone(value)
  } catch {
    const seen = new WeakSet<object>()
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString()
      if (typeof item === "function" || typeof item === "symbol") return undefined
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
      }
      return item
    })
    return (json === undefined ? undefined : JSON.parse(json)) as T
  }
}
