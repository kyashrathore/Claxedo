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
}
