import type { SdkRuntimeTurnInput } from "../shared/sdk-runtime-driver"
import type { JsonRecord } from "../shared/sdk-runtime-driver"
import type { CodexAppServerProcess } from "./app-server-process"

export type CodexActiveThread = {
  sessionId: string
  agentSessionId: string
  directory: string
  model?: string
  effort?: string
  process: CodexAppServerProcess
  project: (method: string, payload: JsonRecord, frame: unknown) => void
  observeSubagent: SdkRuntimeTurnInput["observeSubagent"]
  /** Files a thread this turn started for a subagent as the turn's own. */
  adoptSubagent(threadId: string): void
}
