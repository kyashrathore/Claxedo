import { createAgentEventRuntime } from "../../../translate/runtime"
import type { RuntimeSnapshot } from "../../../translate/snapshot"
import { claudeSdkAdapter, type ClaudeSdkAdapterState } from "../translate/adapter"

export function claudeRuntime(initialSnapshot?: RuntimeSnapshot<ClaudeSdkAdapterState>) {
  return createAgentEventRuntime({
    harness: "claude-sdk",
    threadId: "thread-1",
    adapter: claudeSdkAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
    ...(initialSnapshot ? { initialSnapshot } : {}),
  })
}
