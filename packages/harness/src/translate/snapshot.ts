import { cloneSnapshotValue } from "@claxedo/helpers"

const RUNTIME_SNAPSHOT_VERSION = 1

export type RuntimeSnapshot<State = unknown> = {
  version: typeof RUNTIME_SNAPSHOT_VERSION
  harness: string
  threadId: string
  adapterState: State
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
