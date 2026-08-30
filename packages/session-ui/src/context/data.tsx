import type {
  AgentContentPart,
  AgentPresentationMessage,
  AgentPresentationProvider,
  AgentPresentationSession,
  AgentRuntimeStatus,
  AgentSnapshotFileDiff,
} from "@claxedo/agent-runtime-contract"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, AgentPresentationProvider>
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: AgentPresentationSession[]
  session_status: {
    [sessionID: string]: AgentRuntimeStatus
  }
  session_diff: {
    [sessionID: string]: AgentSnapshotFileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: AgentPresentationMessage[]
  }
  part: {
    [messageID: string]: AgentContentPart[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export type SubagentView = {
  parentSessionId: string
  subagentKey: string
  toolCallRole?: "spawn" | "interaction"
  mode?: "foreground" | "background"
  status: "pending" | "running" | "paused" | "interrupted" | "completed" | "failed" | "killed" | "unknown"
  label: string
  agentLabel: string
  description: string
  childSessionId?: string
  transcriptKind: "live" | "file" | "messages" | "none" | "unknown"
  resolution: "not-yet-bound" | "loading" | "ready" | "empty" | "unavailable"
  ambient: boolean
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    resolveSubagents?: (parentSessionId: string, toolCallId?: string) => SubagentView[]
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      resolveSubagents: props.resolveSubagents,
    }
  },
})
