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

/**
 * A session row as this view needs one.
 *
 * `slug` and `version` are required on `AgentPresentationSession` and read
 * nowhere in this package; inventory-sourced rows carry neither, so demanding
 * them only forced the caller to assert. Complete rows still satisfy this.
 */
type DataSession =
  & Omit<AgentPresentationSession, "slug" | "version">
  & Partial<Pick<AgentPresentationSession, "slug" | "version">>

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: DataSession[]
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
    /**
     * A workspace-relative path to a URL the browser can fetch. Tool attachments that
     * stayed on disk carry only a path, so without this they have nothing to render.
     */
    fileUrl?: (path: string) => string | undefined
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
      fileUrl: props.fileUrl,
    }
  },
})
