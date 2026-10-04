import { claudeSdkAdapter } from "../translate/adapter"
import { translatorRuntime } from "../../../test-support/translator-runtime"

export function claudeRuntime() {
  return translatorRuntime({
    harness: "claude-sdk",
    threadId: "thread-1",
    adapter: claudeSdkAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
  })
}
