import type { RuntimeBuild } from "./runtime-integrity"

export type CheckpointUnusableCause = "expired" | "runtime_outdated" | "runtime_modified" | "not_restorable"

/** The one line a person reads for each; the app keys its Start fresh control off the cause, never the text. */
export const CHECKPOINT_UNUSABLE: Readonly<Record<CheckpointUnusableCause, string>> = {
  expired: "This workspace's saved files expired after 30 days unused; choose Start fresh.",
  runtime_outdated: "This workspace was saved by a runtime that has since had a security fix; choose Start fresh.",
  runtime_modified: "This workspace's saved runtime was changed inside the machine; choose Start fresh.",
  not_restorable: "This workspace's saved files can't be restored here; choose Start fresh.",
}

/**
 * What this sandbox's object knows about a snapshot it took: the runtime build
 * and image environment of the container it came from. A snapshot id is a
 * bearer handle at the platform, so a restore is honored only for an id this
 * object recorded; destroying the sandbox forgets every record.
 */
export type SnapshotBinding = { build: RuntimeBuild; imageEnv: Record<string, string>; takenAt: number }

const SNAPSHOT_KEY_PREFIX = "claxedo.snapshot:"
/** A lease names one checkpoint, the newest; older records outlive it only as long as a stop and wake race can need them. */
const SNAPSHOT_BINDINGS_KEPT = 8

export type BindingStorage = {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(keys: string[]): Promise<unknown>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}

export async function recordSnapshot(storage: BindingStorage, snapshotId: string, binding: SnapshotBinding) {
  await storage.put(`${SNAPSHOT_KEY_PREFIX}${snapshotId}`, binding)
  const recorded = [...(await storage.list<SnapshotBinding>({ prefix: SNAPSHOT_KEY_PREFIX })).entries()]
  const stale = recorded.sort(([, a], [, b]) => b.takenAt - a.takenAt).slice(SNAPSHOT_BINDINGS_KEPT).map(([key]) => key)
  if (stale.length) await storage.delete(stale)
}

export function snapshotBinding(storage: BindingStorage, snapshotId: string) {
  return storage.get<SnapshotBinding>(`${SNAPSHOT_KEY_PREFIX}${snapshotId}`)
}

const MISSING_SNAPSHOT = /Snapshot "[^"]*" was not found/

/** A snapshot the platform no longer holds (expired, or never existed) refuses its start with this message and never falls back to the image. */
export function snapshotMissing(error: unknown) {
  return MISSING_SNAPSHOT.test(error instanceof Error ? error.message : String(error))
}
