// target layer: account

import { asRecord, readField } from "@/lib/record"

/**
 * Reading Electron's preload bridge off the global scope.
 *
 * Three adapters need `api.account` — the operation bridge, the SSE stream
 * bridge, and the Solid-backed `AccountPort` — and each had written its own
 * `(globalThis as { api?: { account?: … } })` cast plus its own loop asserting
 * every member is a function. That is one fact about one host, so it is read
 * once, here, and the "is this bridge complete" question is answered by a type
 * predicate instead of one `as` per member at each adapter.
 */

/** The preload's `api.account`, as the untyped record a renderer actually has. */
export function preloadAccountBridge(scope: unknown = globalThis): Record<string, unknown> | undefined {
  return asRecord(readField(readField(scope, "api"), "account"))
}

/**
 * Narrow a preload bridge to `T` by requiring every named member to be a
 * function.
 *
 * All of them or none: a partial bridge is a preload that changed under a
 * renderer that did not, and calling the missing half would fail at the worst
 * moment rather than at startup.
 */
export function hasBridgeMembers<T>(
  bridge: Record<string, unknown> | undefined,
  members: readonly (keyof T & string)[],
): bridge is Record<string, unknown> & T {
  if (!bridge) return false
  return members.every((member) => typeof bridge[member] === "function")
}
