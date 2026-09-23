import type { HarnessId } from "@/platform/identity/session-ref"

export type SessionTransportCapabilities = {
  transport: HarnessId
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
  /** Coarse harness support. Session-scoped actions come from Goal capabilities. */
  goals?: boolean
  /**
   * The session authority's own answer to "may this reader prompt", which the
   * harness has no say in. The workspace-wide read names no session and so
   * carries no answer; the composer falls back to the workspace role there.
   */
  prompt?: boolean
}
