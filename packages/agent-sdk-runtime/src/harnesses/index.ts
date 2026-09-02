export { acp, type AcpFactoryOptions } from "../harness-factories/acp"
export { claude, type ClaudeFactoryOptions } from "../harness-factories/claude"
export { codex, type CodexFactoryOptions } from "../harness-factories/codex"
export { cursor, type CursorFactoryOptions } from "../harness-factories/cursor"
export { opencode, type OpenCodeFactoryOptions } from "../harness-factories/opencode"
export { pi, type PiFactoryOptions, type PiSessionPlacement } from "../harness-factories/pi"

export {
  createProcessLifecycle,
  terminateOnParentLoss,
  ProcessLifecycleDisposedError,
  type ActivityLease,
  type ProcessLifecycle,
  type ProcessLifecycleEvent,
  type ProcessLifecycleOptions,
  type ProcessLifecycleState,
  type StopReason,
} from "./shared/process-lifecycle"
